/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessagesReq, InboxMessagesRsp } from '../../../../../Bindings';
import { useDutySearch } from '../useDutySearch';
import { buildInboxReq, emptyFilter, type MessageFeedState, type MessageItem } from '../utils';
import { minimalInboxMessage, mockImageMediaEntry } from '../inbox-message-mocks';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  count: vi.fn(),
  matching: vi.fn(),
}));
vi.mock('../../../services/api/inbox-messages', () => ({
  fetchInboxMessages: api.list,
  fetchInboxCount: api.count,
}));
vi.mock('../../../services/api/analysis', () => ({
  fetchMessagesByIdsMatchingFilters: api.matching,
}));

type Dependencies = Parameters<typeof useDutySearch>[0];
type Search = ReturnType<typeof useDutySearch>;
let search: Search;
function Harness({ dependencies }: { dependencies: Dependencies }) {
  search = useDutySearch(dependencies);
  return null;
}

function item(id: number, text = `needle ${id}`): MessageItem {
  return [id, minimalInboxMessage({ text, createdAt: id * 1000, createdAtOrder: id * 1000000 })];
}
function response(items: MessageItem[]) {
  return {
    inboxItems: items,
    pageLimit: 2,
    callsigns: [],
    signalProfiles: {},
    signalGroups: [],
    freqPelengsSummary: null,
  };
}

describe('#3571 independent Duty search concurrency and membership', () => {
  let root: Root;
  let container: HTMLDivElement;
  let dependencies: Dependencies;
  let messages: MessageItem[];
  const column = () => search.columnFor(dependencies.messageFeeds[0])!;
  const render = async () =>
    act(async () => {
      root.render(<Harness dependencies={dependencies} />);
    });
  const tick = async () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  const open = async (query = 'needle') => {
    await act(async () => {
      column().onOpen();
    });
    await act(async () => {
      column().onChange({ search: query });
    });
    await tick();
  };
  const refresh = async () =>
    act(async () => {
      column().onRefresh();
    });
  beforeEach(async () => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    const feed = { id: 'a', filter: emptyFilter(), historySinceMs: 100000 } as MessageFeedState;
    dependencies = {
      messageFeeds: [feed],
      enabled: true,
      buildReqForFeed: (feed, opts) =>
        buildInboxReq({ filter: feed.filter, sinceDateInclusiveMs: feed.historySinceMs, ...opts }),
      navigate: vi.fn(),
      cancelNavigation: vi.fn(),
      onError: vi.fn(),
      setProfiles: vi.fn(),
    };
    messages = [item(1), item(2), item(3), item(4), item(5)];
    const matches = (req: InboxMessagesReq) =>
      messages.filter(([, message]) => message.text?.includes(req.search ?? ''));
    api.list.mockImplementation(async (req: InboxMessagesReq) =>
      response(
        matches(req)
          .filter(
            ([id]) =>
              (!req.beforeIdNoninclusive || id < req.beforeIdNoninclusive) &&
              (!req.sinceIdNoninclusive || id > req.sinceIdNoninclusive),
          )
          .slice()
          .reverse()
          .slice(0, 2),
      ),
    );
    api.count.mockImplementation(async (req) => ({
      quantity: matches(req).length,
      firstElementTs: null,
    }));
    api.matching.mockImplementation(async (ids: number[], req) =>
      matches(req).filter(([id]) => ids.includes(id)),
    );
    await render();
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  it('keeps total and older cursor independent of loaded length and adaptive feed history', async () => {
    await open();
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    expect(column().state.total).toBe(5);
    expect(api.list.mock.calls[0][0]).toMatchObject({
      sinceDateInclusiveMs: null,
      sortBy: 'IMSCreatedAt',
    });
    expect(api.count.mock.calls[0][0].tillDateInclusiveMs).toBeTypeOf('number');
    await act(async () => {
      column().onLoadOlder();
    });
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2]);
    expect(column().state.total).toBe(5);
    expect(column().state.hasMore).toBe(true);
    await act(async () => {
      column().onLoadOlder();
    });
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2, 1]);
    expect(column().state.hasMore).toBe(false);
    expect(dependencies.messageFeeds[0].filter.search).toBeFalsy();
  });

  it('#3571 merges sender profiles from search pages and refresh bridges into the existing cache', async () => {
    let profiles: InboxMessagesRsp['signalProfiles'] = {
      existing: { givenName: 'Existing', familyName: null },
    };
    vi.mocked(dependencies.setProfiles).mockImplementation((update) => {
      profiles = typeof update === 'function' ? update(profiles) : update;
    });
    const list = api.list.getMockImplementation()!;
    api.list.mockImplementation(async (req: InboxMessagesReq) => {
      const result = await list(req);
      return {
        ...result,
        signalProfiles: Object.fromEntries(
          result.inboxItems.map(([id]: MessageItem) => [
            `sender-${id}`,
            { givenName: `Sender ${id}`, familyName: null },
          ]),
        ),
      };
    });

    await open();
    expect(profiles['sender-5']?.givenName).toBe('Sender 5');
    await act(async () => column().onLoadOlder());
    expect(profiles['sender-2']?.givenName).toBe('Sender 2');
    messages = Array.from({ length: 12 }, (_, index) => item(index + 1));
    await refresh();
    expect(profiles['sender-12']?.givenName).toBe('Sender 12');
    expect(profiles['sender-7']?.givenName).toBe('Sender 7');
    expect(profiles.existing?.givenName).toBe('Existing');
  });

  it('closes mobile search after selection without canceling landing and retains its list state', async () => {
    dependencies = { ...dependencies, closeOnSelect: true };
    await render();
    await open();
    const selected = column().state.items[0];
    await act(async () => column().onScroll(60, [{ id: selected[0], offset: -10 }]));
    vi.mocked(dependencies.cancelNavigation).mockClear();
    await act(async () => column().onSelect(selected));
    expect(column().open).toBe(false);
    expect(dependencies.navigate).toHaveBeenCalledWith('a', String(selected[0]), selected);
    expect(dependencies.cancelNavigation).not.toHaveBeenCalled();
    await act(async () => column().onOpen());
    expect(column().state).toMatchObject({
      search: 'needle',
      selectedId: selected[0],
      scrollTop: 60,
      anchors: [{ id: selected[0], offset: -10 }],
    });
    expect(column().state.items).toContainEqual(selected);
  });

  it.each(['a', 'b', null])(
    'clears only selection and cancels only the same feed pending navigation (%s)',
    async (navigatingFeedId) => {
      await open();
      await act(async () => {
        column().onSelect(column().state.items[0]);
        column().onScroll(60, [{ id: 4, offset: -10 }]);
      });
      const before = { ...column().state };
      dependencies = { ...dependencies, navigatingFeedId };
      await render();
      vi.mocked(dependencies.cancelNavigation).mockClear();
      await act(async () => search.clearSelection('a'));
      expect(column().state).toEqual({ ...before, selectedId: null });
      expect(dependencies.cancelNavigation).toHaveBeenCalledTimes(navigatingFeedId === 'a' ? 1 : 0);
    },
  );

  it('#3571 suspends an automatically hidden editor search without losing its selection or landing', async () => {
    await open();
    await act(async () => {
      column().onSelect(column().state.items[0]);
      column().onScroll(120, [{ id: 5, offset: -12 }]);
    });
    const cached = column().state;
    const requests = api.list.mock.calls.length;
    vi.mocked(dependencies.cancelNavigation).mockClear();
    await act(async () => column().onVisibilityChange?.(false));
    await refresh();
    expect(api.list).toHaveBeenCalledTimes(requests);
    expect(column().open).toBe(true);
    expect(column().state).toBe(cached);
    expect(dependencies.cancelNavigation).not.toHaveBeenCalled();
    await act(async () => column().onVisibilityChange?.(true));
    await tick();
    expect(api.list).toHaveBeenCalledTimes(requests);
    expect(column().state).toMatchObject({
      search: 'needle',
      selectedId: 5,
      scrollTop: 120,
      anchors: [{ id: 5, offset: -12 }],
    });
    expect(dependencies.navigate).toHaveBeenCalledOnce();
  });

  it('#3571 keeps cached results through inbox changes, polling, focus and reopening until manual refresh', async () => {
    await open();
    const calls = api.list.mock.calls.length;
    await act(async () => {
      window.dispatchEvent(new Event('echo-duty-poll'));
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(api.list).toHaveBeenCalledTimes(calls);
    messages.push(item(6));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [6] } }));
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(api.list).toHaveBeenCalledTimes(calls);
    expect(api.count).toHaveBeenCalledTimes(1);
    expect(api.matching).not.toHaveBeenCalled();
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    expect(column().state.total).toBe(5);
    await act(async () => column().onClose());
    await act(async () => column().onOpen());
    await tick();
    expect(api.list).toHaveBeenCalledTimes(calls);
    await refresh();
    expect(api.list.mock.calls.length).toBeGreaterThan(calls);
    expect(column().state.items.map(([id]) => id)).toContain(6);
    expect(column().state.total).toBe(6);
  });

  it('#3571 does not queue automatic refreshes during a manual request or initial debounce', async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => column().onOpen());
    await act(async () => column().onChange({ search: 'needle' }));
    await refresh();
    expect(column().state.loading).toBe(true);
    await act(async () => {
      window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [6] } }));
    });
    await tick();
    await act(async () => release(response([item(5), item(4)])));
    await tick();
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.count).toHaveBeenCalledOnce();
    expect(column().state.loading).toBe(false);
  });

  it.each([{ search: 'needle' }, { searchMode: 'Fuzzy' as const }])(
    '#3571 keeps the first search loading when unchanged query settings are submitted (%j)',
    async (changes) => {
      let release!: (value: ReturnType<typeof response>) => void;
      api.list.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            release = resolve;
          }),
      );
      await open();
      const signal = api.list.mock.calls[0][1].signal;
      expect(column().state.loading).toBe(true);
      await act(async () => column().onChange(changes));
      await tick();
      expect(signal.aborted).toBe(false);
      expect(column().state.loading).toBe(true);
      await act(async () => release(response([item(5), item(4)])));
      expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
      expect(api.list).toHaveBeenCalledOnce();
      await act(async () => column().onSelect(column().state.items[0]));
      const cached = column().state;
      vi.mocked(dependencies.cancelNavigation).mockClear();
      await act(async () => column().onChange(changes));
      await tick();
      expect(column().state).toBe(cached);
      expect(dependencies.cancelNavigation).not.toHaveBeenCalled();
      expect(api.list).toHaveBeenCalledOnce();
    },
  );

  it('#3571 keeps attachment OCR search membership and counts unchanged until manual refresh', async () => {
    let ocr = 'needle in attachment';
    const matches = (): MessageItem[] =>
      ocr.includes('needle')
        ? [
            [
              6,
              minimalInboxMessage({
                text: 'Image attachment',
                media: [mockImageMediaEntry({ ocr })],
              }),
            ],
          ]
        : [];
    api.list.mockImplementation(async () => response(matches()));
    api.count.mockImplementation(async () => ({
      quantity: matches().length,
      firstElementTs: null,
    }));
    api.matching.mockImplementation(async () => matches());
    await open();
    const notifyAttachmentChanged = async () =>
      act(async () => {
        window.dispatchEvent(
          new CustomEvent('echo-inbox-changed', {
            detail: { events: [{ messageId: 6, origin: null, intelligenceReport: false }] },
          }),
        );
        await vi.advanceTimersByTimeAsync(10000);
      });

    ocr = 'replacement attachment text';
    await notifyAttachmentChanged();
    expect(api.list).toHaveBeenCalledOnce();
    expect(api.count).toHaveBeenCalledOnce();
    expect(api.matching).not.toHaveBeenCalled();
    expect(column().state.total).toBe(1);
    expect(column().state.items[0][1].media[0].ocr).toBe('needle in attachment');
    await refresh();
    expect(column().state.items).toEqual([]);
    expect(column().state.total).toBe(0);

    ocr = 'needle in updated attachment';
    await notifyAttachmentChanged();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(api.count).toHaveBeenCalledTimes(2);
    expect(column().state.items).toEqual([]);
    expect(column().state.total).toBe(0);
    await refresh();
    expect(column().state.items.map(([id]) => id)).toEqual([6]);
    expect(column().state.items[0][1].media[0].ocr).toBe(ocr);
    expect(column().state.total).toBe(1);
  });

  it('#3571 cancels a hidden manual refresh without leaving cached results loading on restore', async () => {
    await open();
    let release!: (value: ReturnType<typeof response>) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await refresh();
    const signal = api.list.mock.calls.at(-1)![1].signal;
    expect(column().state.loading).toBe(true);
    await act(async () => column().onVisibilityChange?.(false));
    expect(signal.aborted).toBe(true);
    expect(column().state.loading).toBe(false);
    await act(async () => release(response([item(6), item(5)])));
    await act(async () => column().onVisibilityChange?.(true));
    await tick();
    expect(api.list).toHaveBeenCalledTimes(2);
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    await refresh();
    expect(api.list).toHaveBeenCalledTimes(3);
  });

  it('discards a late response after query replacement and cancels hidden requests', async () => {
    let release!: (value: ReturnType<typeof response>) => void;
    api.list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await open('old');
    const oldSignal = api.list.mock.calls[0][1].signal;
    await act(async () => {
      column().onChange({ search: 'needle' });
    });
    expect(oldSignal.aborted).toBe(true);
    await tick();
    vi.mocked(dependencies.setProfiles).mockClear();
    await act(async () => {
      release({
        ...response([item(99, 'old')]),
        signalProfiles: { stale: { givenName: 'Stale', familyName: null } },
      });
    });
    expect(dependencies.setProfiles).not.toHaveBeenCalled();
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    await act(async () => {
      column().onClose();
    });
    const calls = api.list.mock.calls.length;
    await refresh();
    await tick();
    expect(api.list).toHaveBeenCalledTimes(calls);
    await act(async () => {
      column().onOpen();
    });
    expect(column().state.search).toBe('needle');
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    expect(dependencies.navigate).not.toHaveBeenCalled();
  });

  it('removes edited nonmatches and deletions using server membership, preserving selection only while valid', async () => {
    await open();
    await act(async () => {
      column().onSelect(column().state.items[0]);
    });
    messages = [item(1), item(2), item(3), item(5, 'edited away')];
    await refresh();
    expect(api.matching).toHaveBeenCalled();
    expect(column().state.items.map(([id]) => id)).toEqual([3, 2]);
    expect(column().state.selectedId).toBe(null);
    expect(column().state.total).toBe(3);
  });

  it('bridges a burst larger than one page without moving historical rows until new results are requested', async () => {
    await open();
    await act(async () => {
      column().onScroll(100, [{ id: 4, offset: 10 }]);
    });
    messages = Array.from({ length: 12 }, (_, index) => item(index + 1));
    await refresh();
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    expect(column().state.pendingItems.map(([id]) => id)).toEqual([12, 11, 10, 9, 8, 7, 6]);
    expect(column().state.total).toBe(12);
    expect(column().state.anchors).toEqual([{ id: 4, offset: 10 }]);
    await act(async () => {
      column().onShowNew();
      column().onLoadOlder();
    });
    expect(column().state.items.map(([id]) => id)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2]);
    expect(new Set(column().state.items.map(([id]) => id)).size).toBe(11);
  });

  it('#3571 replaces stale row anchors when new matches arrive at the top of the list', async () => {
    await open();
    await act(async () => {
      column().onScroll(0, [{ id: 4, offset: -24 }]);
    });
    messages.push(item(6));

    await refresh();

    expect(column().state.scrollTop).toBe(0);
    expect(column().state.items.map(([id]) => id)).toEqual([6, 5, 4]);
    expect(column().state.anchors).toEqual([]);
    expect(column().state.pendingItems).toEqual([]);
  });

  it('discovers an edited new match inside loaded history without skipping it at the next older cursor', async () => {
    messages = [item(1), item(2), item(3, 'other text'), item(4), item(5)];
    await open();
    await act(async () => {
      column().onLoadOlder();
    });
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 2, 1]);
    await act(async () => {
      column().onScroll(100, [{ id: 2, offset: 0 }]);
    });
    messages = [item(1), item(2), item(3), item(4), item(5)];
    await act(async () => {
      window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [3] } }));
    });
    await refresh();
    expect(column().state.pendingItems.map(([id]) => id)).toEqual([3]);
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 2, 1]);
    expect(column().state.total).toBe(5);
    await act(async () => {
      column().onShowNew();
    });
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2, 1]);
  });

  it('invalidates another filter scope and closes on an applied keyword without background requests', async () => {
    await open();
    dependencies = {
      ...dependencies,
      messageFeeds: [
        { ...dependencies.messageFeeds[0], filter: { ...emptyFilter(), groupsSelected: ['b'] } },
      ],
    };
    await render();
    expect(column().state.items).toEqual([]);
    expect(column().state.search).toBe('needle');
    await tick();
    dependencies = {
      ...dependencies,
      messageFeeds: [
        { ...dependencies.messageFeeds[0], filter: { ...emptyFilter(), search: 'keyword' } },
      ],
    };
    await render();
    expect(column().open).toBe(false);
    expect(column().blocked).toBe(true);
    const calls = api.list.mock.calls.length;
    await refresh();
    await act(async () => {
      column().onOpen();
    });
    await tick();
    expect(api.list).toHaveBeenCalledTimes(calls);
    dependencies = {
      ...dependencies,
      messageFeeds: [{ ...dependencies.messageFeeds[0], filter: emptyFilter() }],
    };
    await render();
    expect(column().open).toBe(false);
    expect(column().blocked).toBe(false);
  });

  it('retains cached rows on refresh failure and retries failed older paging at the same cursor', async () => {
    await open();
    api.list.mockRejectedValueOnce(new Error('offline'));
    await act(async () => {
      column().onLoadOlder();
    });
    expect(column().state.error).toBeTruthy();
    expect(dependencies.onError).toHaveBeenCalledWith(
      expect.stringContaining('Показано попередні результати'),
      expect.any(Function),
    );
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    await act(async () => {
      vi.mocked(dependencies.onError).mock.calls.at(-1)![1]();
    });
    expect(api.list.mock.calls.at(-1)![0].beforeIdNoninclusive).toBe(4);
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2]);
    expect(column().state.error).toBe(null);
  });

  it('#3571 retries the current failed search from an earlier snackbar for the same query', async () => {
    await open();
    api.list.mockRejectedValueOnce(new Error('offline'));
    await refresh();
    const retry = vi.mocked(dependencies.onError).mock.calls.at(-1)![1];
    api.list.mockRejectedValueOnce(new Error('offline again'));
    await refresh();
    const requests = api.list.mock.calls.length;
    await act(async () => retry());
    expect(api.list.mock.calls.length).toBeGreaterThan(requests);
    expect(column().state.error).toBe(null);
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    await act(async () => column().onChange({ search: 'replacement' }));
    api.list.mockRejectedValueOnce(new Error('replacement failed'));
    await tick();
    const replacementRequests = api.list.mock.calls.length;
    await act(async () => retry());
    expect(api.list).toHaveBeenCalledTimes(replacementRequests);
    expect(column().state.error).toBeTruthy();
  });

  it.each(['reopen', 'inbox change'] as const)(
    '#3571 discovers historical edits on manual refresh after %s',
    async (mode) => {
      messages = Array.from({ length: 50 }, (_, index) =>
        item(550 + index, 550 + index === 570 ? 'other text' : `needle ${550 + index}`),
      );
      api.list.mockImplementation(async (req: InboxMessagesReq) => ({
        ...response(
          messages
            .filter(
              ([id, message]) =>
                message.text?.includes(req.search ?? '') &&
                (!req.beforeIdNoninclusive || id < req.beforeIdNoninclusive) &&
                (!req.sinceIdNoninclusive || id > req.sinceIdNoninclusive),
            )
            .slice()
            .reverse()
            .slice(0, 20),
        ),
        pageLimit: 20,
      }));
      await open();
      await act(async () => column().onLoadOlder());
      const cachedIds = column().state.items.map(([id]) => id);
      expect(cachedIds).toHaveLength(40);
      expect(cachedIds.at(-1)).toBe(559);
      expect(cachedIds).not.toContain(570);
      await act(async () => {
        column().onSelect(column().state.items.find(([id]) => id === 575)!);
        column().onScroll(400, [{ id: 575, offset: -10 }]);
      });
      if (mode === 'reopen') await act(async () => column().onClose());
      messages = messages.map(([id, message]) => (id === 570 ? item(id) : [id, message]));
      if (mode === 'reopen') {
        const calls = [
          api.list.mock.calls.length,
          api.count.mock.calls.length,
          api.matching.mock.calls.length,
        ];
        await refresh();
        await tick();
        expect([
          api.list.mock.calls.length,
          api.count.mock.calls.length,
          api.matching.mock.calls.length,
        ]).toEqual(calls);
        await act(async () => column().onOpen());
        await tick();
        expect(api.list).toHaveBeenCalledTimes(calls[0]);
      } else {
        await act(async () => {
          window.dispatchEvent(
            new CustomEvent('echo-inbox-changed', { detail: { messageIds: [570] } }),
          );
        });
      }
      expect(column().state.total).toBe(49);
      await refresh();
      expect(column().state.total).toBe(50);
      expect(column().state.pendingItems.map(([id]) => id)).toEqual([570]);
      expect(column().state.items.map(([id]) => id)).toEqual(cachedIds);
      expect(column().state.selectedId).toBe(575);
      expect(column().state.anchors).toEqual([{ id: 575, offset: -10 }]);
      expect(dependencies.navigate).toHaveBeenCalledTimes(1);
      await act(async () => {
        column().onShowNew();
        column().onLoadOlder();
      });
      expect(column().state.items.map(([id]) => id)).toEqual(
        Array.from({ length: 50 }, (_, index) => 599 - index),
      );
      expect(column().state.hasMore).toBe(false);
    },
  );

  it('#3571 keeps an initial historical change event from skipping unloaded result pages', async () => {
    await act(async () => column().onOpen());
    await act(async () => column().onChange({ search: 'needle' }));
    await act(async () => {
      window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [1] } }));
    });
    expect(api.list).not.toHaveBeenCalled();
    await tick();
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4]);
    expect(column().state.total).toBe(5);
    expect(column().state.hasMore).toBe(true);
    await act(async () => column().onLoadOlder());
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2]);
    await act(async () => column().onLoadOlder());
    expect(column().state.items.map(([id]) => id)).toEqual([5, 4, 3, 2, 1]);
    expect(column().state.hasMore).toBe(false);
  });
});
