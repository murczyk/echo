/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MessengersMessageItem, MessengersMessagesListRsp } from '../../../../../Bindings';

const apiMock = vi.hoisted(() => ({
  listMessengersChatMembers: vi.fn(),
  listMessengersMessages: vi.fn(),
}));
vi.mock('../../../services/api/analysis-messengers', () => apiMock);

import { HttpRequestError } from '../../../services/api/client';
import { MESSENGER_PAGE_SIZE } from '../messenger-chat-window';
import { senderName, useMessengerChat } from '../use-messenger-chat';

type State = ReturnType<typeof useMessengerChat>;

const message = (id: string): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt: 0,
  text: id,
  isOutgoing: null,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
});
const rsp = (
  ids: string[],
  olderCursor: string | null,
  newerCursor: string | null,
): MessengersMessagesListRsp => ({ items: ids.map(message), olderCursor, newerCursor });

describe('useMessengerChat', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: State;

  function Probe({
    anchor = null,
    refreshToken = 0,
  }: {
    anchor?: string | null;
    refreshToken?: number;
  }) {
    latest = useMessengerChat({
      accountId: 'a1',
      chatId: 'c1',
      anchorMessageId: anchor,
      refreshToken,
    });
    return null;
  }
  const ids = () => latest.messages.map((m) => m.id);
  const mount = (anchor: string | null = null) =>
    act(async () => root.render(<Probe anchor={anchor} />));
  // The header refresh button bumps the token.
  const refresh = (token: number, anchor: string | null = null) =>
    act(async () => root.render(<Probe anchor={anchor} refreshToken={token} />));

  beforeEach(() => {
    apiMock.listMessengersChatMembers.mockReset().mockResolvedValue({ items: [] });
    apiMock.listMessengersMessages.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('loads the newest page oldest-first when there is no anchor', async () => {
    apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['c', 'b', 'a'], 'o', 'n'));
    await mount();
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: 'a1',
        chatId: 'c1',
        cursor: null,
        aroundMessageId: null,
      }),
      expect.anything(),
    );
    expect(ids()).toEqual(['a', 'b', 'c']);
    expect(latest.loading).toBe(false);
    expect(latest.hasMoreAbove).toBe(true);
    expect(latest.hasMoreBelow).toBe(false);
  });

  it('opens around the anchor and keeps loading below', async () => {
    apiMock.listMessengersMessages.mockResolvedValueOnce(
      rsp(
        Array.from({ length: MESSENGER_PAGE_SIZE }, (_, i) => `m${MESSENGER_PAGE_SIZE - i}`),
        'o',
        'n',
      ),
    );
    await mount('m10');
    expect(apiMock.listMessengersMessages).toHaveBeenCalledWith(
      expect.objectContaining({ aroundMessageId: 'm10' }),
      expect.anything(),
    );
    expect(latest.hasMoreBelow).toBe(true);
  });

  it('falls back to the newest page when the anchor is not visible any more', async () => {
    apiMock.listMessengersMessages
      .mockRejectedValueOnce(new HttpRequestError(404, 'Not found'))
      .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n'));
    await mount('gone');
    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ aroundMessageId: null }),
      expect.anything(),
    );
    expect(ids()).toEqual(['a', 'b']);
    expect(latest.error).toBeNull();
  });

  it('reports other anchor failures as an error', async () => {
    apiMock.listMessengersMessages.mockRejectedValueOnce(new HttpRequestError(500, 'boom'));
    await mount('x');
    expect(latest.error).toBe('boom');
    expect(latest.loading).toBe(false);
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
  });

  it('retries a failed first load', async () => {
    apiMock.listMessengersMessages
      .mockRejectedValueOnce(new HttpRequestError(500, 'boom'))
      .mockResolvedValueOnce(rsp(['a'], null, 'n'));
    await mount();
    await act(async () => latest.retry());
    expect(latest.error).toBeNull();
    expect(ids()).toEqual(['a']);
  });

  it('still shows messages when the members request fails', async () => {
    apiMock.listMessengersChatMembers.mockRejectedValueOnce(new Error('nope'));
    apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['a'], null, 'n'));
    await mount();
    expect(ids()).toEqual(['a']);
    expect(latest.memberById.size).toBe(0);
  });

  it('indexes members by id', async () => {
    apiMock.listMessengersChatMembers.mockResolvedValueOnce({
      items: [{ id: 'm1', externalId: '7' }],
    });
    apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['a'], null, 'n'));
    await mount();
    expect(latest.memberById.get('m1')?.externalId).toBe('7');
  });

  it('prepends older messages with the older cursor', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce(rsp(['d', 'c'], 'o1', 'n1'))
      .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n2'));
    await mount();
    await act(async () => latest.loadOlder());
    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'o1', direction: 'Older' }),
      expect.anything(),
    );
    expect(ids()).toEqual(['a', 'b', 'c', 'd']);
    expect(latest.hasMoreAbove).toBe(false);
  });

  it('appends newer messages with the newer cursor', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce(
        rsp(
          Array.from({ length: MESSENGER_PAGE_SIZE }, (_, i) => `m${MESSENGER_PAGE_SIZE - i}`),
          'o',
          'n1',
        ),
      )
      .mockResolvedValueOnce(rsp(['x'], 'o2', 'n2'));
    await mount('m10');
    await act(async () => latest.loadNewer());
    expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ cursor: 'n1', direction: 'Newer' }),
      expect.anything(),
    );
    expect(ids().at(-1)).toBe('x');
    expect(latest.hasMoreBelow).toBe(false);
  });

  it('does not request when there is nothing in that direction', async () => {
    apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['a'], null, 'n'));
    await mount();
    await act(async () => latest.loadOlder());
    await act(async () => latest.loadNewer());
    // The newest page still carries a newer cursor, but it is already the chat end.
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
  });

  it('does not start a second request in the same direction while one is running', async () => {
    let resolve!: (value: MessengersMessagesListRsp) => void;
    apiMock.listMessengersMessages
      .mockResolvedValueOnce(rsp(['b'], 'o1', 'n1'))
      .mockReturnValueOnce(new Promise((r) => (resolve = r)));
    await mount();
    await act(async () => {
      void latest.loadOlder();
      void latest.loadOlder();
    });
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(2);
    expect(latest.loadingAbove).toBe(true);
    await act(async () => resolve(rsp(['a'], null, 'n0')));
    expect(latest.loadingAbove).toBe(false);
  });

  it('stops paging after a failure until the error is cleared', async () => {
    apiMock.listMessengersMessages
      .mockResolvedValueOnce(rsp(['b'], 'o1', 'n1'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(rsp(['a'], null, 'n0'));
    await mount();
    await act(async () => latest.loadOlder());
    expect(latest.pagingError).toBe('offline');
    await act(async () => latest.loadOlder());
    expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(2);
    await act(async () => latest.clearPagingError());
    await act(async () => latest.loadOlder());
    expect(ids()).toEqual(['a', 'b']);
  });

  const fullPage = () =>
    rsp(
      Array.from({ length: MESSENGER_PAGE_SIZE }, (_, i) => `m${MESSENGER_PAGE_SIZE - i}`),
      'o',
      'n1',
    );

  const fullPageIds = () => Array.from({ length: MESSENGER_PAGE_SIZE }, (_, i) => `s${i}`);

  describe('go to the end', () => {
    it('replaces the window with the newest page and drops a page request in flight', async () => {
      let resolveOlder!: (value: MessengersMessagesListRsp) => void;
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockReturnValueOnce(new Promise((r) => (resolveOlder = r)))
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'));
      await mount('m10');
      expect(latest.hasMoreBelow).toBe(true);
      await act(async () => {
        void latest.loadOlder();
      });
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToEnd();
      });
      expect(ok).toBe(true);
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: null, aroundMessageId: null }),
        expect.anything(),
      );
      expect(ids()).toEqual(['y', 'z']);
      expect(latest.hasMoreBelow).toBe(false);
      await act(async () => resolveOlder(rsp(['stale'], null, 'n0')));
      expect(ids()).toEqual(['y', 'z']);
    });

    it('fetches what arrived since when the newest page is already loaded', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n1'))
        .mockResolvedValueOnce(rsp(['c'], 'o2', 'n2'));
      await mount();
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToEnd();
      });
      expect(ok).toBe(true);
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'n1', direction: 'Newer' }),
        expect.anything(),
      );
      expect(ids()).toEqual(['a', 'b', 'c']);
      expect(latest.hasMoreBelow).toBe(false);
    });

    it('keeps the window when nothing new arrived', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n1'))
        .mockResolvedValueOnce(rsp([], null, 'n1'));
      await mount();
      await act(async () => void (await latest.goToEnd()));
      expect(ids()).toEqual(['a', 'b']);
      expect(latest.hasMoreBelow).toBe(false);
    });

    it('reports a failure, so the view does not scroll to a stale end', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n1'))
        .mockRejectedValueOnce(new Error('offline'));
      await mount();
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToEnd();
      });
      expect(ok).toBe(false);
      expect(latest.pagingError).toBe('offline');
      expect(latest.jumpingToEnd).toBe(false);
      expect(ids()).toEqual(['a', 'b']);
    });

    it('shows the jump as running until the request is done', async () => {
      let resolve!: (value: MessengersMessagesListRsp) => void;
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n1'))
        .mockReturnValueOnce(new Promise((r) => (resolve = r)));
      await mount();
      await act(async () => {
        void latest.goToEnd();
      });
      expect(latest.jumpingToEnd).toBe(true);
      await act(async () => resolve(rsp([], null, 'n1')));
      expect(latest.jumpingToEnd).toBe(false);
    });
  });

  describe('go to the start', () => {
    it('replaces the window with the first page and continues downwards from its newer cursor', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'))
        .mockResolvedValueOnce(rsp(fullPageIds(), null, 'n1'))
        .mockResolvedValueOnce(rsp(['x'], 'o2', 'n2'));
      await mount();
      expect(latest.hasMoreAbove).toBe(true);
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToStart();
      });
      expect(ok).toBe(true);
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: null, direction: 'Oldest', aroundMessageId: null }),
        expect.anything(),
      );
      expect(latest.hasMoreAbove).toBe(false);
      expect(latest.hasMoreBelow).toBe(true);
      expect(latest.jumpingToStart).toBe(false);

      await act(async () => latest.loadNewer());
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'n1', direction: 'Newer' }),
        expect.anything(),
      );
      expect(ids().at(-1)).toBe('x');
    });

    it('asks for nothing when the start of the chat is already loaded', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['b', 'a'], null, 'n'));
      await mount();
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToStart();
      });
      expect(ok).toBe(true);
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
    });

    it('reports a failed request, so the view does not scroll, and keeps the window', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], 'o1', 'n'))
        .mockRejectedValueOnce(new Error('offline'));
      await mount();
      let ok: boolean | undefined;
      await act(async () => {
        ok = await latest.goToStart();
      });
      expect(ok).toBe(false);
      expect(latest.pagingError).toBe('offline');
      expect(ids()).toEqual(['a', 'b']);
    });
  });

  // The latest request that replaces the window wins, whatever order the responses come in.
  describe('overlapping window replacements', () => {
    const deferred = () => {
      let resolve!: (value: MessengersMessagesListRsp) => void;
      let reject!: (reason: unknown) => void;
      const promise = new Promise<MessengersMessagesListRsp>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      return { promise, resolve, reject };
    };
    const signalOf = (call: number): AbortSignal =>
      apiMock.listMessengersMessages.mock.calls[call][1].signal;

    it('drops a jump that is answered after a newer go to the end', async () => {
      const jump = deferred();
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockReturnValueOnce(jump.promise)
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'));
      await mount('m10');
      let jumped!: Promise<MessengersMessageItem[] | null>;
      await act(async () => {
        jumped = latest.loadAroundMessage('j1');
      });
      await act(async () => void (await latest.goToEnd()));
      expect(ids()).toEqual(['y', 'z']);
      expect(signalOf(1).aborted).toBe(true);
      await act(async () => jump.resolve(rsp(['j1'], 'o', 'n')));
      expect(await jumped).toBeNull();
      expect(ids()).toEqual(['y', 'z']);
      expect(latest.jumpingToUnread).toBe(false);
    });

    it('drops a go to the start that is answered after a newer jump', async () => {
      const start = deferred();
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'))
        .mockReturnValueOnce(start.promise)
        .mockResolvedValueOnce(rsp(['j1', 'j0'], 'o', 'n'));
      await mount();
      let started!: Promise<boolean>;
      await act(async () => {
        started = latest.goToStart();
      });
      await act(async () => void (await latest.loadAroundMessage('j1')));
      expect(ids()).toEqual(['j0', 'j1']);
      await act(async () => start.resolve(rsp(fullPageIds(), null, 'n1')));
      expect(await started).toBe(false);
      expect(ids()).toEqual(['j0', 'j1']);
      expect(latest.jumpingToStart).toBe(false);
    });

    it('drops a page request that started on the old window after the jump began', async () => {
      const jump = deferred();
      const older = deferred();
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockReturnValueOnce(jump.promise)
        .mockReturnValueOnce(older.promise);
      await mount('m10');
      await act(async () => void latest.loadAroundMessage('j1'));
      await act(async () => latest.loadOlder());
      await act(async () => jump.resolve(rsp(['j1', 'j0'], 'p', 'q')));
      expect(ids()).toEqual(['j0', 'j1']);
      await act(async () => older.resolve(rsp(['stale'], null, 'n0')));
      expect(ids()).toEqual(['j0', 'j1']);
      expect(latest.loadingAbove).toBe(false);
    });

    it('does not report the error of a request that was replaced', async () => {
      const jump = deferred();
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockReturnValueOnce(jump.promise)
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'));
      await mount('m10');
      let jumped!: Promise<MessengersMessageItem[] | null>;
      await act(async () => {
        jumped = latest.loadAroundMessage('j1');
      });
      await act(async () => void (await latest.goToEnd()));
      await act(async () => jump.reject(new Error('late')));
      expect(await jumped).toBeNull();
      expect(latest.pagingError).toBeNull();
    });

    it('aborts the request that was replaced', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockImplementationOnce(
          (_req, { signal }: { signal: AbortSignal }) =>
            new Promise((_, reject) =>
              signal.addEventListener('abort', () =>
                reject(new DOMException('aborted', 'AbortError')),
              ),
            ),
        )
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'));
      await mount('m10');
      let jumped!: Promise<MessengersMessageItem[] | null>;
      await act(async () => {
        jumped = latest.loadAroundMessage('j1');
      });
      await act(async () => void (await latest.goToEnd()));
      expect(await jumped).toBeNull();
      expect(latest.pagingError).toBeNull();
      expect(ids()).toEqual(['y', 'z']);
    });

    it('keeps the old window when the newer request fails and the older one lands', async () => {
      const jump = deferred();
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockReturnValueOnce(jump.promise)
        .mockRejectedValueOnce(new Error('offline'));
      await mount('m10');
      const before = ids();
      await act(async () => void latest.loadAroundMessage('j1'));
      await act(async () => void (await latest.goToEnd()));
      expect(latest.pagingError).toBe('offline');
      await act(async () => jump.resolve(rsp(['j1'], 'o', 'n')));
      expect(ids()).toEqual(before);
      expect(latest.pagingError).toBe('offline');
    });

    it('lets a jump that nothing replaced replace the window', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockResolvedValueOnce(rsp(['j1', 'j0'], 'o', 'n'));
      await mount('m10');
      let items: MessengersMessageItem[] | null = null;
      await act(async () => {
        items = await latest.loadAroundMessage('j1');
      });
      expect(items!.map((m) => m.id)).toEqual(['j0', 'j1']);
      expect(ids()).toEqual(['j0', 'j1']);
    });
  });

  describe('header refresh', () => {
    it('appends what arrived since and reloads the members when the chat end is loaded', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b', 'a'], null, 'n1'))
        .mockResolvedValueOnce(rsp(['c'], 'o2', 'n2'));
      await mount();
      expect(apiMock.listMessengersChatMembers).toHaveBeenCalledTimes(1);
      await refresh(1);
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: 'n1', direction: 'Newer' }),
        expect.anything(),
      );
      expect(ids()).toEqual(['a', 'b', 'c']);
      expect(apiMock.listMessengersChatMembers).toHaveBeenCalledTimes(2);
      expect(latest.refreshing).toBe(false);
    });

    it('replaces a window that does not reach the chat end with the newest page', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(fullPage())
        .mockResolvedValueOnce(rsp(['z', 'y'], 'o9', 'n9'));
      await mount('m10');
      expect(latest.hasMoreBelow).toBe(true);
      await refresh(1, 'm10');
      expect(apiMock.listMessengersMessages).toHaveBeenLastCalledWith(
        expect.objectContaining({ cursor: null, aroundMessageId: null }),
        expect.anything(),
      );
      expect(ids()).toEqual(['y', 'z']);
    });

    it('does nothing for the same token', async () => {
      apiMock.listMessengersMessages.mockResolvedValueOnce(rsp(['a'], null, 'n1'));
      await mount();
      await refresh(0);
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(1);
      expect(apiMock.listMessengersChatMembers).toHaveBeenCalledTimes(1);
    });

    it('loads a chat that failed to load again', async () => {
      apiMock.listMessengersMessages
        .mockRejectedValueOnce(new HttpRequestError(500, 'boom'))
        .mockResolvedValueOnce(rsp(['a'], null, 'n1'));
      await mount();
      expect(latest.error).toBe('boom');
      await refresh(1);
      expect(latest.error).toBeNull();
      expect(ids()).toEqual(['a']);
    });

    it('reports refreshing until both requests are done', async () => {
      let resolveMessages!: (value: MessengersMessagesListRsp) => void;
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['a'], null, 'n1'))
        .mockReturnValueOnce(new Promise((r) => (resolveMessages = r)));
      await mount();
      await refresh(1);
      expect(latest.refreshing).toBe(true);
      await act(async () => resolveMessages(rsp(['b'], null, 'n2')));
      expect(latest.refreshing).toBe(false);
    });

    it('refreshes after a failed page request instead of doing nothing', async () => {
      apiMock.listMessengersMessages
        .mockResolvedValueOnce(rsp(['b'], 'o1', 'n1'))
        .mockRejectedValueOnce(new Error('offline'))
        .mockResolvedValueOnce(rsp(['z'], null, 'n9'));
      await mount();
      await act(async () => latest.loadOlder());
      expect(latest.pagingError).toBe('offline');
      await refresh(1);
      expect(apiMock.listMessengersMessages).toHaveBeenCalledTimes(3);
      expect(ids()).toEqual(['z']);
      expect(latest.pagingError).toBeNull();
    });
  });
});

describe('senderName', () => {
  const member = (patch: object) =>
    ({
      externalId: '7',
      firstName: null,
      lastName: null,
      username: null,
      phone: null,
      ...patch,
    }) as never;

  it('prefers the full name, then username, phone and external id', () => {
    expect(senderName(member({ firstName: 'Ivan', lastName: 'P', username: 'ip' }))).toBe('Ivan P');
    expect(senderName(member({ lastName: 'P' }))).toBe('P');
    expect(senderName(member({ username: 'ip', phone: '+1' }))).toBe('ip');
    expect(senderName(member({ phone: '+1' }))).toBe('+1');
    expect(senderName(member({}))).toBe('7');
  });
});
