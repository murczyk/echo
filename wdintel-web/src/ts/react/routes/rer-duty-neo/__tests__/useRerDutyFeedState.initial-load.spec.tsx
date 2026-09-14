/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InboxMessage, InboxMessagesRsp } from '../../../../../Bindings';
import { minimalInboxMessage } from '../inbox-message-mocks';
import {
  createDutyFeedStateFixture,
  getDutyApiMocks,
  DutyFeedStateHarness as TestHarness,
  inboxRsp,
  rangeRsp,
  settleReactCommits as flushMicrotasks,
} from '../useRerDutyFeedState.test-utils';
import {
  DUTY_FEED_UNREAD_PREFETCH_MIN,
  DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  emptyFilter,
  feedIndicatorUnreadCount,
  feedLoadedUnreadCount,
  feedPendingNewerUnreadCount,
} from '../utils';

const fixture = createDutyFeedStateFixture();
const hoisted = getDutyApiMocks();
const { deferred, expectTailCountRequest, mountLoadedFeed, runNextRaf, startPoll } = fixture;

describe('useRerDutyFeedState — initial loading and reloads', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    ({ container, root } = fixture.setup());
  });

  afterEach(fixture.cleanup);
  it('runs a single get-inbox initial load per feed on mount', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(apiRef.current?.messageFeeds[0]?.items[0]?.[0]).toBe(1);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
  });

  it('notifies once when the first count after a successful load finds new mail', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[7, minimalInboxMessage({ timestamp: 700 })]], 7),
    );
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 1, firstElementTs: null });
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
      await flushMicrotasks();
    });

    await startPoll();

    expect(hoisted.fetchInboxCount).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIdNoninclusive: 7 }),
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.notifyDutyNewMessages).toHaveBeenCalledWith(
      'mf-0',
      1,
      hoisted.beginDutyNotificationPollCycle.mock.results.at(-1)?.value,
    );

    hoisted.notifyDutyNewMessages.mockClear();
    await startPoll();

    expect(hoisted.notifyDutyNewMessages).not.toHaveBeenCalled();
  });

  it('never turns the own-unit tag display into an inbox filter', async () => {
    const { apiRef } = await mountLoadedFeed();
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({ ...feed, onlyMyUnitTagsEnabled: true })),
      );
    });
    hoisted.fetchInboxMessages.mockClear();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));

    await act(async () => {
      await apiRef.current!.loadFeedInitialMessages('mf-0');
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxMessages.mock.calls[0][0].reportTagsOnlyThisUnit).toBeNull();
  });

  it('loads a direct-link target with an exact pagination cursor', async () => {
    const { apiRef } = await mountLoadedFeed();
    hoisted.fetchInboxMessages.mockClear();
    hoisted.fetchMessagesByIdsWithMetadata.mockClear();
    hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(1, 40));
    hoisted.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(42, 81));
    hoisted.fetchMessagesByIdsWithMetadata.mockResolvedValueOnce(
      inboxRsp([[41, minimalInboxMessage({ timestamp: 4100, messageUid: 'target-uid' })]]),
    );

    await act(async () => {
      apiRef.current!.setFeedInitialTarget('mf-0', {
        beforeIdNoninclusive: 41,
        messageIds: [41],
      });
      apiRef.current!.applyFilter('mf-0', apiRef.current!.messageFeeds[0].filter, true);
      await flushMicrotasks();
    });

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledWith(
      expect.objectContaining({ beforeIdNoninclusive: 41, loadLatest: false }),
    );
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIdNoninclusive: 41, loadLatest: false }),
    );
    expect(hoisted.fetchMessagesByIdsWithMetadata).toHaveBeenCalledWith(
      [41],
      expect.objectContaining({ beforeIdNoninclusive: 41, loadLatest: false }),
    );
    const loadedIds = apiRef.current!.messageFeeds[0].items.map(([id]) => id);
    expect(loadedIds).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(loadedIds.at(0)).toBe(21);
    expect(loadedIds.indexOf(41)).toBe(20);
    expect(loadedIds.at(-1)).toBe(60);
  });

  it('merges reference metadata loaded exclusively for a direct-link target', async () => {
    const setProfiles = vi.fn();
    const setGroupInfos = vi.fn();
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(
        <TestHarness apiRef={apiRef} setProfiles={setProfiles} setGroupInfos={setGroupInfos} />,
      );
      await flushMicrotasks();
    });
    hoisted.fetchInboxMessages.mockClear();
    hoisted.fetchMessagesByIdsWithMetadata.mockClear();
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(rangeRsp(1, 40))
      .mockResolvedValueOnce(rangeRsp(42, 81));
    const targetResponse = inboxRsp([
      [41, minimalInboxMessage({ timestamp: 4100, messageUid: 'target-uid' })],
    ]);
    targetResponse.callsigns = [{ callsign: 'TARGET', res: [], networkHints: [] }];
    targetResponse.signalProfiles = {
      'target-sender': { givenName: 'Target', familyName: null },
    };
    targetResponse.signalGroups = [
      {
        masterKey: 'target-group',
        name: 'Target group',
        ignoreOperativny: false,
        interseptionKind: 'rer',
        disableNetworkAssignment: false,
        groupStats: { activityLastDay: 0, activityLastWeek: 0 },
        adminData: null,
        areasOfResponsibility: null,
      },
    ];
    hoisted.fetchMessagesByIdsWithMetadata.mockResolvedValueOnce(targetResponse);

    await act(async () => {
      apiRef.current!.setFeedInitialTarget('mf-0', {
        beforeIdNoninclusive: 41,
        messageIds: [41],
      });
      apiRef.current!.applyFilter('mf-0', apiRef.current!.messageFeeds[0].filter, true);
      await flushMicrotasks();
    });

    expect(apiRef.current!.inboxCallsignInfoMap).toHaveProperty('target');
    const updateProfiles = setProfiles.mock.calls.at(-1)?.[0];
    const updateGroups = setGroupInfos.mock.calls.at(-1)?.[0];
    expect(updateProfiles({})).toEqual(targetResponse.signalProfiles);
    expect(updateGroups({})).toHaveProperty('target-group');
  });

  it('preserves a follow generation until cancellation', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
      await flushMicrotasks();
    });

    const firstGeneration = apiRef.current!.beginFollowTail('mf-0');
    expect(apiRef.current!.ensureFollowTail('mf-0')).toBe(firstGeneration);
    apiRef.current!.cancelFollowTail('mf-0');
    expect(apiRef.current!.ensureFollowTail('mf-0')).toBe(firstGeneration + 2);
  });

  it('reloads a settled empty feed through the initial-load effect', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([]))
      .mockResolvedValueOnce(inboxRsp([[7, minimalInboxMessage({ timestamp: 700 })]]));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);

    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([7]);
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
  });

  it('reloads all empty feeds without reloading non-empty feeds', async () => {
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', { ...emptyFilter(), groupsSelected: ['group-0'] }],
              ['mf-1', { ...emptyFilter(), groupsSelected: ['group-1'] }],
              ['mf-2', { ...emptyFilter(), groupsSelected: ['group-2'] }],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages.mockImplementation((request: any) => {
      const group = request.selectedGroups?.[0];
      if (group === 'group-0')
        return Promise.resolve(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]));
      if (group === 'group-1') return Promise.resolve(inboxRsp([]));
      if (group === 'group-2') return Promise.resolve(inboxRsp([]));
      throw new Error(`Unexpected group ${group}`);
    });
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxMessages.mockClear();
    hoisted.fetchInboxMessages.mockImplementation((request: any) => {
      const group = request.selectedGroups?.[0];
      if (group === 'group-1')
        return Promise.resolve(inboxRsp([[8, minimalInboxMessage({ timestamp: 800 })]]));
      if (group === 'group-2')
        return Promise.resolve(inboxRsp([[9, minimalInboxMessage({ timestamp: 900 })]]));
      throw new Error(`Unexpected reload group ${group}`);
    });

    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    expect(
      hoisted.fetchInboxMessages.mock.calls.map(([request]) => request.selectedGroups),
    ).toEqual(expect.arrayContaining([['group-1'], ['group-2']]));
    expect(apiRef.current?.messageFeeds.map((feed) => feed.items.map(([id]) => id))).toEqual([
      [1],
      [8],
      [9],
    ]);
    expect(apiRef.current?.messageFeeds.every((feed) => feed.loading === false)).toBe(true);
    expect(apiRef.current?.error).toBeNull();
  });

  it('reloads every feed with its current filter after an edit', async () => {
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', { ...emptyFilter(), freqsSelected: ['1.1'] }],
              ['mf-1', { ...emptyFilter(), unitsSelected: ['unit-1'] }],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages.mockImplementation((request: any) =>
      Promise.resolve(
        inboxRsp([[request.selectedFreqs ? 10 : 20, minimalInboxMessage({ timestamp: 100 })]]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxMessages.mockClear();

    await act(async () => apiRef.current?.reloadFeeds());
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledTimes(2);
    const requests = hoisted.fetchInboxMessages.mock.calls.map(([request]) => request);
    expect(requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ selectedFreqs: ['1.1'] })]),
    );
    expect(requests).toEqual(
      expect.arrayContaining([expect.objectContaining({ selectedUnits: ['unit-1'] })]),
    );
    expect(apiRef.current?.messageFeeds.map((feed) => feed.items.map(([id]) => id))).toEqual([
      [10],
      [20],
    ]);
  });

  it('refreshes edits without marking existing unread messages as read', async () => {
    window.history.replaceState(
      {},
      '',
      '/?state=' +
        encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              ['mf-0', { ...emptyFilter(), freqsSelected: ['1.1'] }],
              ['mf-1', { ...emptyFilter(), unitsSelected: ['unit-1'] }],
            ],
          }),
        ),
    );
    hoisted.fetchInboxMessages.mockImplementation((request: any) =>
      Promise.resolve(
        inboxRsp(
          request.selectedFreqs
            ? [
                [1, minimalInboxMessage({ timestamp: 100 })],
                [2, minimalInboxMessage({ timestamp: 200 })],
              ]
            : [
                [10, minimalInboxMessage({ timestamp: 1000 })],
                [11, minimalInboxMessage({ timestamp: 1100 })],
              ],
        ),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) =>
          feed.id === 'mf-0'
            ? { ...feed, readIds: new Set([1, 2]), unreadCount: 0 }
            : {
                ...feed,
                readIds: new Set([10]),
                windowedUnreadItems: new Map([
                  [11, 1100],
                  [99, 9900],
                ]),
                unreadCount: 3,
              },
        ),
      );
    });
    hoisted.fetchInboxMessages.mockImplementation((request: any) =>
      Promise.resolve(
        inboxRsp(
          request.selectedFreqs
            ? [
                [2, minimalInboxMessage({ timestamp: 50 })],
                [3, minimalInboxMessage({ timestamp: 300 })],
              ]
            : [
                [10, minimalInboxMessage({ timestamp: 1000 })],
                [11, minimalInboxMessage({ timestamp: 1100 })],
                [12, minimalInboxMessage({ timestamp: 1200 })],
              ],
        ),
      ),
    );

    await act(async () => apiRef.current?.reloadEditedFeeds());
    await act(async () => flushMicrotasks());

    const [editedFeed, untouchedFeed] = apiRef.current!.messageFeeds;
    expect(editedFeed.items.map(([id]) => id)).toEqual([2, 3]);
    expect(editedFeed.readIds).toEqual(new Set([1, 2]));
    expect(editedFeed.unreadCount).toBe(1);
    expect(untouchedFeed.readIds).toEqual(new Set([10]));
    expect(untouchedFeed.windowedUnreadItems).toEqual(new Map());
    expect(untouchedFeed.unresolvedUnreadIds).toEqual(new Set([99]));
    expect(untouchedFeed.unreadCount).toBe(3);
  });

  it('completes an edit refresh before requesting unread counts', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]))
      .mockResolvedValueOnce(inboxRsp([[1, minimalInboxMessage({ timestamp: 100 })]]));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEditedFeeds());
    await act(async () => flushMicrotasks());

    await act(async () => apiRef.current?.requestValidatedInboxCount('mf-0'));

    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
  });

  it('derives a new unread cursor when an edit moves the old tail earlier', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(
        inboxRsp([
          [1, minimalInboxMessage({ timestamp: 100 })],
          [3, minimalInboxMessage({ timestamp: 300 })],
        ]),
      )
      .mockResolvedValueOnce(
        inboxRsp([
          [3, minimalInboxMessage({ timestamp: 50 })],
          [1, minimalInboxMessage({ timestamp: 100 })],
        ]),
      );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEditedFeeds());
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxCount.mockClear();

    await act(async () => apiRef.current?.requestValidatedInboxCount('mf-0'));

    expect(hoisted.fetchInboxCount).toHaveBeenCalledWith(
      expect.objectContaining({ sinceIdNoninclusive: 1 }),
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('invalidates a stale empty-feed initial response during reload', async () => {
    const stale = deferred<InboxMessagesRsp>('stale');
    const fresh = deferred<InboxMessagesRsp>('fresh');
    hoisted.fetchInboxMessages
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    fresh.resolve(inboxRsp([[9, minimalInboxMessage({ timestamp: 900 })]]));
    await act(async () => flushMicrotasks());
    stale.resolve(inboxRsp([]));
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([9]);
    expect(apiRef.current?.error).toBeNull();
  });

  it('rebuilds unread ordering for a sort-mode change and ignores stale responses', async () => {
    const stale = deferred<InboxMessagesRsp>('stale sort-mode reload');
    const fresh = deferred<InboxMessagesRsp>('fresh sort-mode reload');
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () =>
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSTimestamp" />),
    );
    await act(async () => flushMicrotasks());
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set<number>([1]),
          windowedUnreadItems: new Map([
            [2, 200],
            [99, 9_900],
          ]),
          unreadCount: 2,
        })),
      );
    });
    hoisted.fetchInboxMessages
      .mockImplementationOnce(() => stale.promise)
      .mockImplementationOnce(() => fresh.promise);

    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSCreatedAt" />);
    });
    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());

    fresh.resolve(
      inboxRsp([
        [1, minimalInboxMessage({ timestamp: 300, createdAt: 2_000, createdAtOrder: 2_000_000 })],
        [2, minimalInboxMessage({ timestamp: 100, createdAt: 1_000, createdAtOrder: 1_000_000 })],
      ]),
    );
    await act(async () => flushMicrotasks());
    stale.resolve(inboxRsp([[99, minimalInboxMessage({ timestamp: 9_900 })]]));
    await act(async () => flushMicrotasks());

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.messageSortBy).toBe('IMSCreatedAt');
    expect(feed.items.map(([id]) => id)).toEqual([2, 1]);
    expect(feed.readIds).toEqual(new Set<number>([1]));
    expect(feed.windowedUnreadItems).toEqual(new Map());
    expect(feed.unresolvedUnreadIds).toEqual(new Set<number>([99]));
    expect(feed.unreadCount).toBe(2);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [1, minimalInboxMessage({ timestamp: 300, createdAt: 2_000, createdAtOrder: 2_000_000 })],
        [2, minimalInboxMessage({ timestamp: 100, createdAt: 1_000, createdAtOrder: 1_000_000 })],
      ]),
    );
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSTimestamp" />);
    });
    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());

    const interceptionFeed = apiRef.current!.messageFeeds[0];
    expect(interceptionFeed.messageSortBy).toBe('IMSTimestamp');
    expect(interceptionFeed.items.map(([id]) => id)).toEqual([2, 1]);
    expect(interceptionFeed.windowedUnreadItems).toEqual(new Map());
    expect(interceptionFeed.unresolvedUnreadIds).toEqual(new Set<number>([99]));
  });

  it('preserves buffered unread messages when reloading for a sort-mode change', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () =>
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSTimestamp" />),
    );
    await act(async () => flushMicrotasks());
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          items: [[2, minimalInboxMessage({ timestamp: 2_000, createdAt: 1_000 })]],
          pendingNewerItems: [[3, minimalInboxMessage({ timestamp: 1_000, createdAt: 2_000 })]],
          unreadCount: 2,
        })),
      );
    });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [2, minimalInboxMessage({ timestamp: 2_000, createdAt: 1_000, createdAtOrder: 1_000_000 })],
        [3, minimalInboxMessage({ timestamp: 1_000, createdAt: 2_000, createdAtOrder: 2_000_000 })],
      ]),
    );

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSCreatedAt" />);
    });
    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.messageSortBy).toBe('IMSCreatedAt');
    expect(feed.items.map(([id]) => id)).toEqual([2, 3]);
    expect(feed.pendingNewerItems).toEqual([]);
    expect(feed.windowedUnreadItems).toEqual(new Map());
    expect(feed.unresolvedUnreadIds).toEqual(new Set<number>());
    expect(feed.unresolvedUnreadCount).toBe(0);
    expect(feed.unreadCount).toBe(2);
  });

  it('does not double-count anonymous unread stock across basis changes (#3455)', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([[1, minimalInboxMessage({ timestamp: 1_000, createdAt: 2_000 })]]),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSTimestamp" />);
    });
    await act(async () => flushMicrotasks());
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set<number>(),
          unresolvedUnreadCount: 1,
          unreadCount: 2,
        })),
      );
    });
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [1, minimalInboxMessage({ timestamp: 1_000, createdAt: 2_000 })],
        [2, minimalInboxMessage({ timestamp: 2_000, createdAt: 1_000 })],
      ]),
    );

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSCreatedAt" />);
    });
    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());

    expect(apiRef.current!.messageFeeds[0]).toMatchObject({
      unresolvedUnreadCount: 0,
      unreadCount: 2,
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([2, 1]);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [1, minimalInboxMessage({ timestamp: 1_000, createdAt: 2_000 })],
        [2, minimalInboxMessage({ timestamp: 2_000, createdAt: 1_000 })],
      ]),
    );
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSTimestamp" />);
    });
    await act(async () => apiRef.current?.reloadFeedsPreservingUnread());
    await act(async () => flushMicrotasks());

    expect(apiRef.current!.messageFeeds[0]).toMatchObject({
      unresolvedUnreadCount: 0,
      unreadCount: 2,
    });
  });

  it('uses creation-order cursors for an initial saved creation preference', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp([
        [1, minimalInboxMessage({ timestamp: 100, createdAt: 2_000, createdAtOrder: 2_000_123 })],
        [2, minimalInboxMessage({ timestamp: 200, createdAt: 1_000, createdAtOrder: 1_000_456 })],
      ]),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} messageSortBy="IMSCreatedAt" />);
    });
    await act(async () => flushMicrotasks());

    expect(hoisted.fetchInboxMessages).toHaveBeenCalledWith(
      expect.objectContaining({ sortBy: 'IMSCreatedAt' }),
    );
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([2, 1]);
  });

  it('clears loading and surfaces an empty-feed reload failure', async () => {
    hoisted.fetchInboxMessages
      .mockResolvedValueOnce(inboxRsp([]))
      .mockRejectedValueOnce(new Error('empty feed reload failed'));
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () => apiRef.current?.reloadEmptyFeeds());
    await act(async () => flushMicrotasks());

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.error).toBe('empty feed reload failed');
  });

  it('sets error and clears loading when initial get-inbox fails', async () => {
    hoisted.fetchInboxMessages.mockRejectedValueOnce(new Error('network down'));

    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.error).toBe('network down');
    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items).toHaveLength(0);
  });

  it('keeps existing items visible while a filter reload is pending', async () => {
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([1]);

    let resolveReload: (value: InboxMessagesRsp) => void = () => {};
    hoisted.fetchInboxMessages.mockImplementationOnce(
      () =>
        new Promise<InboxMessagesRsp>((resolve) => {
          resolveReload = resolve;
        }),
    );

    await act(async () => {
      apiRef.current!.applyFilter('mf-0', { ...emptyFilter(), groupsSelected: ['g-1'] });
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(true);
    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([1]);

    await act(async () => {
      resolveReload(inboxRsp([[2, minimalInboxMessage({ timestamp: 200, text: 'reloaded' })]]));
      await flushMicrotasks();
    });

    expect(apiRef.current?.messageFeeds[0]?.loading).toBe(false);
    expect(apiRef.current?.messageFeeds[0]?.items.map(([id]) => id)).toEqual([2]);
  });

  it('windows initial messages to the newest fixed-size batch', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 5 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const ids = apiRef.current!.messageFeeds[0].items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(6);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 5);
    expect([...apiRef.current!.messageFeeds[0].readIds].sort((a, b) => a - b)[0]).toBe(6);
  });

  it('prepends older messages and trims the newest side of the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );

    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    const feed = apiRef.current!.messageFeeds[0];
    const ids = feed.items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(1);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(feed.readIds.has(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20)).toBe(true);
  });

  it('appends newer messages and trims the oldest side of the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );

    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { markAllReadAfterAppend: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    const ids = feed.items.map(([id]) => id);
    expect(ids).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(ids[0]).toBe(21);
    expect(ids.at(-1)).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20);
    expect(feed.readIds.has(1)).toBe(true);
    expect(feed.readIds.has(DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20)).toBe(true);
    expect(feed.windowedUnreadItems).toEqual(new Map());

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({
        feedId: 'mf-0',
        cursorId: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
  });

  it('#3360 preserves previous-window unread identity through a buffered newer flush', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () =>
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set([...feed.readIds].filter((id) => id !== 1)),
          unreadCount: 1,
        })),
      ),
    );
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => apiRef.current!.loadFeedNewerMessages('mf-0'));
    expect(apiRef.current!.messageFeeds[0].pendingNewerItems.map(([id]) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1),
    );
    await act(async () =>
      apiRef.current!.flushPendingNewerMessages('mf-0', {
        urgent: true,
        allowWindowTrim: true,
      }),
    );
    expect(apiRef.current!.messageFeeds[0].windowedUnreadItems.has(1)).toBe(false);
    expect(apiRef.current!.messageFeeds[0].readIds.has(1)).toBe(true);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => apiRef.current!.loadFeedOlderMessages('mf-0'));
    expect(apiRef.current!.messageFeeds[0].windowedUnreadItems).toEqual(
      new Map(Array.from({ length: 20 }, (_, index) => [index + 41, (index + 41) * 100])),
    );
    expect(apiRef.current!.messageFeeds[0].windowedUnreadItems.has(1)).toBe(false);
    expect(feedIndicatorUnreadCount(apiRef.current!.messageFeeds[0])).toBe(20);
  });

  it('#3360 retains unread IDs after safely flushing an oversized newer batch', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 50 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => apiRef.current!.loadFeedNewerMessages('mf-0'));
    expect(apiRef.current!.messageFeeds[0].pendingNewerItems).toHaveLength(50);
    await act(async () =>
      apiRef.current!.flushPendingNewerMessages('mf-0', {
        urgent: true,
        allowWindowTrim: true,
      }),
    );
    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items).toHaveLength(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(feed.windowedUnreadItems).toEqual(
      new Map(
        Array.from({ length: 10 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100,
        ]),
      ),
    );
    expect(feedIndicatorUnreadCount(feed)).toBe(50);
  });

  it('retains unread newest rows evicted by older-page prepends', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };
    await act(async () => root.render(<TestHarness apiRef={apiRef} />));
    await act(async () => flushMicrotasks());
    await act(async () =>
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({
          ...feed,
          readIds: new Set([...feed.readIds].filter((id) => id !== 40)),
        })),
      ),
    );
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index - 19,
          minimalInboxMessage({ timestamp: (index - 19) * 100 }),
        ]),
      ),
    );
    await act(async () => apiRef.current!.loadFeedOlderMessages('mf-0'));
    expect(apiRef.current!.messageFeeds[0].windowedUnreadItems).toEqual(new Map([[40, 4000]]));
    expect(feedIndicatorUnreadCount(apiRef.current!.messageFeeds[0])).toBe(1);
  });

  it('clears start exhaustion when newer append evicts older rows from the fixed window', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].hasReachedStart).toBe(true);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0', { markAllReadAfterAppend: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items[0][0]).toBe(21);
    expect(feed.hasReachedStart).toBe(false);

    hoisted.fetchInboxCount.mockResolvedValueOnce({ quantity: 0, firstElementTs: null });
    const countResult = await apiRef.current!.requestValidatedInboxCount('mf-0');
    expect(countResult).toEqual(
      expect.objectContaining({
        feedId: 'mf-0',
        cursorId: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
    expect(hoisted.fetchInboxCount.mock.calls.at(-1)?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: DUTY_FEED_MESSAGE_WINDOW_LIMIT + 20,
      }),
    );
  });

  it('#3360 keeps returning seen chunk messages read after flushing buffered newer messages', async () => {
    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: DUTY_FEED_MESSAGE_WINDOW_LIMIT }, (_, index) => [
          index + 21,
          minimalInboxMessage({ timestamp: (index + 21) * 100 }),
        ]),
      ),
    );
    const apiRef: React.MutableRefObject<ReturnType<typeof useRerDutyFeedState> | null> = {
      current: null,
    };

    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          index + 1,
          minimalInboxMessage({ timestamp: (index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
    });

    expect(apiRef.current!.messageFeeds[0].items.at(-1)?.[0]).toBe(DUTY_FEED_MESSAGE_WINDOW_LIMIT);
    expect(apiRef.current!.messageFeeds[0].readIds.has(60)).toBe(true);

    hoisted.fetchInboxMessages.mockResolvedValueOnce(
      inboxRsp(
        Array.from({ length: 20 }, (_, index) => [
          DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1,
          minimalInboxMessage({ timestamp: (DUTY_FEED_MESSAGE_WINDOW_LIMIT + index + 1) * 100 }),
        ]),
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedNewerMessages('mf-0');
    });
    expect(apiRef.current!.messageFeeds[0].pendingNewerItems).toHaveLength(20);
    await act(async () =>
      apiRef.current!.flushPendingNewerMessages('mf-0', {
        urgent: true,
        allowWindowTrim: true,
      }),
    );

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.items.map(([id]) => id).slice(-3)).toEqual([58, 59, 60]);
    expect(feed.unreadCount).toBe(0);
    expect(feed.readIds.has(60)).toBe(true);
  });
});
