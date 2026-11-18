import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { MessengersChatMemberItem, MessengersMessageItem } from '../../../../Bindings';
import { HttpRequestError, isAbortError } from '../../services/api/client';
import {
  listMessengersChatMembers,
  listMessengersMessages,
} from '../../services/api/analysis-messengers';
import {
  MESSENGER_PAGE_SIZE,
  aroundPage,
  aroundSentAtPage,
  appendNewer,
  hasMoreAbove,
  hasMoreBelow,
  newestPage,
  oldestPage,
  prependOlder,
  windowMessages,
  type MessengerChatPage,
} from './messenger-chat-window';
import { toErrorMessage } from './use-analysis-data.shared';

type Args = {
  accountId: string;
  chatId: string;
  // Message to open the analysis messenger chat at (from the URL). An unknown one falls back to the newest page.
  anchorMessageId: string | null;
  // The read span the chat had when it was opened, only for a chat that is to open at its first unread message (not
  // for a link to a message or a place, and not for a chat read to its end or never read). null opens at the newest page.
  unreadSpan?: { oldest: number; newest: number } | null;
  // Bumped by the header refresh button: fetches fresh messages and members of the open chat.
  refreshToken?: number;
};

type Loaded = { pages: MessengerChatPage[]; error: null } | { pages: null; error: string };

const isNotFound = (error: unknown) => error instanceof HttpRequestError && error.status === 404;

type FirstPages = {
  pages: MessengerChatPage[];
  // The message the chat opens at (the first unread one), or null for "the newest page".
  landingId: string | null;
};

async function loadFirstPages(args: Args, signal: AbortSignal): Promise<FirstPages> {
  const base = {
    accountId: args.accountId,
    chatId: args.chatId,
    cursor: null,
    limit: MESSENGER_PAGE_SIZE,
    direction: null,
    aroundSentAt: null,
    query: null,
    searchMode: null,
  };
  const newest = async () =>
    newestPage(await listMessengersMessages({ ...base, aroundMessageId: null }, { signal }));
  if (args.anchorMessageId == null && args.unreadSpan != null) {
    const { oldest, newest: readUpTo } = args.unreadSpan;
    const around = async (sentAt: number) =>
      aroundSentAtPage(
        await listMessengersMessages(
          { ...base, aroundMessageId: null, aroundSentAt: sentAt },
          { signal },
        ),
        sentAt,
        MESSENGER_PAGE_SIZE,
      );
    try {
      // The first message sent after what was read; failing that the newest of the history before it.
      const afterSpan = await around(readUpTo);
      const firstNew = afterSpan.items.find((item) => item.sentAt > readUpTo);
      if (firstNew != null) return { pages: [afterSpan], landingId: firstNew.id };
      const history = await around(oldest - 1);
      const newestOld = history.items.filter((item) => item.sentAt < oldest).at(-1);
      // Counts that disagree with the messages leave the chat at its end.
      return newestOld != null
        ? { pages: [history], landingId: newestOld.id }
        : { pages: [afterSpan], landingId: null };
    } catch (reason) {
      // Finding the first unread message is a convenience: a chat that cannot be opened there still opens at its end.
      if (isAbortError(reason)) throw reason;
    }
  }
  if (args.anchorMessageId == null) return { pages: [await newest()], landingId: null };
  try {
    const anchor = args.anchorMessageId;
    const rsp = await listMessengersMessages({ ...base, aroundMessageId: anchor }, { signal });
    return { pages: [aroundPage(rsp, anchor, MESSENGER_PAGE_SIZE)], landingId: null };
  } catch (reason) {
    if (!isNotFound(reason)) throw reason;
    return { pages: [await newest()], landingId: null };
  }
}

export function senderName(member: MessengersChatMemberItem): string {
  const fullName = [member.firstName, member.lastName].filter(Boolean).join(' ');
  return fullName || member.username || member.phone || member.externalId;
}

// Messages and members of one analysis messenger chat. Mount it with a `key` per chat: a new chat means a new hook.
export function useMessengerChat(args: Args) {
  const { accountId, chatId } = args;
  const [attempt, setAttempt] = useState(0);
  const [loaded, setLoaded] = useState<(Loaded & { attempt: number }) | null>(null);
  const [landingId, setLandingId] = useState<string | null>(null);
  // Changes whenever a jump replaces the loaded window (to the start, to the end, to the unread, a refresh): a window that only
  // grew by a page keeps its key. What is tracked as seen must not be carried from one window into another.
  const [windowKey, setWindowKey] = useState(0);
  const [members, setMembers] = useState<readonly MessengersChatMemberItem[]>([]);
  const [loadingAbove, setLoadingAbove] = useState(false);
  const [loadingBelow, setLoadingBelow] = useState(false);
  // True while "go to the end" fetches the newest page or fresh messages.
  const [jumpingToEnd, setJumpingToEnd] = useState(false);
  const [jumpingToStart, setJumpingToStart] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  // True while the header refresh is fetching, it stays disabled meanwhile.
  const [refreshing, setRefreshing] = useState(false);
  const pagesRef = useRef<MessengerChatPage[] | null>(null);
  const busyRef = useRef({ above: false, below: false });
  const controllerRef = useRef<AbortController | null>(null);
  // Bumped when a request to replace the window starts and again when it lands, so a request that is in flight is dropped.
  const epochRef = useRef(0);
  // The URL anchor only matters for the first load; later retries start from it as well.
  const initialArgs = useRef(args);

  const setPages = useCallback((pages: MessengerChatPage[]) => {
    pagesRef.current = pages;
    setLoaded((current) => ({ pages, error: null, attempt: current?.attempt ?? 0 }));
  }, []);

  // The request that is to replace the window (a jump, "go to start/end", a refresh). Claiming a new one aborts the previous
  // one and makes it stale: its response must not put the feed back on a place the reader has left.
  const replacementRef = useRef<AbortController | null>(null);
  const claimReplacement = useCallback(() => {
    const chatSignal = controllerRef.current?.signal;
    if (chatSignal == null) return null;
    replacementRef.current?.abort();
    const controller = new AbortController();
    replacementRef.current = controller;
    return {
      epoch: ++epochRef.current,
      signal: AbortSignal.any([chatSignal, controller.signal]),
    };
  }, []);
  // Bumps the epoch again: a page request that started on the old window after the claim is dropped too.
  const replaceWindow = useCallback(
    (page: MessengerChatPage) => {
      epochRef.current += 1;
      setWindowKey((key) => key + 1);
      setPages([page]);
      setPagingError(null);
    },
    [setPages],
  );

  // Members only decorate messages, so their failure never blocks the feed.
  const loadMembers = useCallback(
    (signal: AbortSignal) =>
      listMessengersChatMembers({ accountId, chatId }, { signal })
        .then((rsp) => setMembers(rsp.items))
        .catch(() => undefined),
    [accountId, chatId],
  );

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    pagesRef.current = null;
    epochRef.current += 1;
    busyRef.current = { above: false, below: false };
    loadFirstPages(initialArgs.current, controller.signal)
      .then(({ pages, landingId: landing }) => {
        pagesRef.current = pages;
        setLandingId(landing);
        setLoaded({ pages, error: null, attempt });
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        setLoaded({ pages: null, error: toErrorMessage(reason), attempt });
      });
    loadMembers(controller.signal);
    return () => controller.abort();
  }, [accountId, chatId, attempt, loadMembers]);

  // Resolves to false when a request failed, so callers can skip what depends on it.
  const page = useCallback(
    async (direction: 'above' | 'below'): Promise<boolean> => {
      const pages = pagesRef.current;
      const signal = controllerRef.current?.signal;
      const busy = busyRef.current;
      if (pages == null || signal == null || busy[direction] || pagingError != null) return false;
      const cursor =
        direction === 'above' ? pages[0].olderCursor : pages[pages.length - 1].newerCursor;
      if (cursor == null) return true;
      busy[direction] = true;
      const epoch = epochRef.current;
      (direction === 'above' ? setLoadingAbove : setLoadingBelow)(true);
      try {
        const rsp = await listMessengersMessages(
          {
            accountId,
            chatId,
            cursor,
            limit: MESSENGER_PAGE_SIZE,
            direction: direction === 'above' ? 'Older' : 'Newer',
            aroundMessageId: null,
            aroundSentAt: null,
            query: null,
            searchMode: null,
          },
          { signal },
        );
        const current = pagesRef.current;
        if (current == null || epoch !== epochRef.current) return false;
        setPages(
          direction === 'above'
            ? prependOlder(current, rsp)
            : appendNewer(current, rsp, MESSENGER_PAGE_SIZE),
        );
        return true;
      } catch (reason) {
        if (!isAbortError(reason)) setPagingError(toErrorMessage(reason));
        return false;
      } finally {
        busy[direction] = false;
        (direction === 'above' ? setLoadingAbove : setLoadingBelow)(false);
      }
    },
    [accountId, chatId, pagingError, setPages],
  );

  // The feed asks for edge pages; there is nothing to ask for at the end of the chat. Only "go to the
  // end" fetches below the newest page, and only on purpose.
  const loadOlder = useCallback(() => {
    if (pagesRef.current != null && hasMoreAbove(pagesRef.current)) void page('above');
  }, [page]);
  const loadNewer = useCallback(() => {
    if (pagesRef.current != null && hasMoreBelow(pagesRef.current)) void page('below');
  }, [page]);

  // The newest page replaces the window. Resolves to false when the request failed.
  const loadNewestPage = useCallback(async (): Promise<boolean> => {
    const claim = claimReplacement();
    if (claim == null) return false;
    const { epoch, signal } = claim;
    try {
      const rsp = await listMessengersMessages(
        {
          accountId,
          chatId,
          cursor: null,
          limit: MESSENGER_PAGE_SIZE,
          direction: null,
          aroundMessageId: null,
          aroundSentAt: null,
          query: null,
          searchMode: null,
        },
        { signal },
      );
      if (epoch !== epochRef.current) return false;
      replaceWindow(newestPage(rsp));
      return true;
    } catch (reason) {
      if (!isAbortError(reason) && epoch === epochRef.current)
        setPagingError(toErrorMessage(reason));
      return false;
    }
  }, [accountId, chatId, claimReplacement, replaceWindow]);

  // The first page of the chat replaces the window. Resolves to false when the request failed.
  const loadOldestPage = useCallback(async (): Promise<boolean> => {
    const claim = claimReplacement();
    if (claim == null) return false;
    const { epoch, signal } = claim;
    try {
      const rsp = await listMessengersMessages(
        {
          accountId,
          chatId,
          cursor: null,
          limit: MESSENGER_PAGE_SIZE,
          direction: 'Oldest',
          aroundMessageId: null,
          aroundSentAt: null,
          query: null,
          searchMode: null,
        },
        { signal },
      );
      if (epoch !== epochRef.current) return false;
      replaceWindow(oldestPage(rsp, MESSENGER_PAGE_SIZE));
      return true;
    } catch (reason) {
      if (!isAbortError(reason) && epoch === epochRef.current)
        setPagingError(toErrorMessage(reason));
      return false;
    }
  }, [accountId, chatId, claimReplacement, replaceWindow]);

  // "Go to the start": jump to the first page, or, when it is already loaded, there is nothing to fetch.
  // Resolves to false when the request failed, so the view does not scroll to a stale start.
  const goToStart = useCallback(async (): Promise<boolean> => {
    const pages = pagesRef.current;
    if (pages == null || jumpingToStart) return false;
    if (!hasMoreAbove(pages)) return true;
    setJumpingToStart(true);
    try {
      return await loadOldestPage();
    } finally {
      setJumpingToStart(false);
    }
  }, [jumpingToStart, loadOldestPage]);

  // "Go to the end": jump to the newest page, or, when it is already loaded, fetch what arrived since.
  // Resolves to false when the request failed, so the view does not scroll to a stale end.
  const goToEnd = useCallback(async (): Promise<boolean> => {
    const pages = pagesRef.current;
    if (pages == null || jumpingToEnd) return false;
    setJumpingToEnd(true);
    try {
      return hasMoreBelow(pages) ? await loadNewestPage() : await page('below');
    } finally {
      setJumpingToEnd(false);
    }
  }, [jumpingToEnd, loadNewestPage, page]);

  // "Go to unread", a date, a search hit: the page around a sent time (`around_sent_at`) or a message replaces the
  // window. Resolves to the messages of that page, oldest first, or to null when the request failed. A message that is
  // not there (404) resolves to an empty list and leaves the window as it was.
  const [jumpingToUnread, setJumpingToUnread] = useState(false);
  const loadAround = useCallback(
    async (
      around: { sentAt: number } | { messageId: string },
    ): Promise<MessengersMessageItem[] | null> => {
      // Not claimed while a jump runs: claiming aborts the one before.
      const claim = jumpingToUnread ? null : claimReplacement();
      if (claim == null) return null;
      const { epoch, signal } = claim;
      setJumpingToUnread(true);
      try {
        const rsp = await listMessengersMessages(
          {
            accountId,
            chatId,
            cursor: null,
            limit: MESSENGER_PAGE_SIZE,
            direction: null,
            aroundMessageId: 'messageId' in around ? around.messageId : null,
            aroundSentAt: 'sentAt' in around ? around.sentAt : null,
            query: null,
            searchMode: null,
          },
          { signal },
        );
        if (epoch !== epochRef.current) return null;
        const page =
          'messageId' in around
            ? aroundPage(rsp, around.messageId, MESSENGER_PAGE_SIZE)
            : aroundSentAtPage(rsp, around.sentAt, MESSENGER_PAGE_SIZE);
        replaceWindow(page);
        return page.items;
      } catch (reason) {
        if (epoch !== epochRef.current) return null;
        if ('messageId' in around && isNotFound(reason)) return [];
        if (!isAbortError(reason)) setPagingError(toErrorMessage(reason));
        return null;
      } finally {
        setJumpingToUnread(false);
      }
    },
    [accountId, chatId, claimReplacement, jumpingToUnread, replaceWindow],
  );
  const loadAroundSentAt = useCallback((sentAt: number) => loadAround({ sentAt }), [loadAround]);
  const loadAroundMessage = useCallback(
    (messageId: string) => loadAround({ messageId }),
    [loadAround],
  );

  const retry = useCallback(() => {
    setPagingError(null);
    setLoaded(null);
    setAttempt((value) => value + 1);
  }, []);

  // The header refresh: the newest page replaces a window that does not reach the end, otherwise
  // what arrived since is appended. A chat that has not loaded yet is simply loaded again.
  const refreshToken = args.refreshToken ?? 0;
  const seenRefreshToken = useRef(refreshToken);
  useEffect(() => {
    if (seenRefreshToken.current === refreshToken) return;
    seenRefreshToken.current = refreshToken;
    const pages = pagesRef.current;
    if (pages == null) {
      retry();
      return;
    }
    const signal = controllerRef.current?.signal;
    setRefreshing(true);
    void Promise.all([
      signal == null ? undefined : loadMembers(signal),
      // After a failed page request `page` refuses to run, the newest page also clears that error.
      hasMoreBelow(pages) || pagingError != null ? loadNewestPage() : page('below'),
    ]).finally(() => setRefreshing(false));
  }, [refreshToken, retry, loadMembers, loadNewestPage, page, pagingError]);

  const pages = loaded?.pages ?? null;
  const messages = useMemo<MessengersMessageItem[]>(
    () => (pages == null ? [] : windowMessages(pages)),
    [pages],
  );
  const memberById = useMemo(
    () => new Map(members.map((member) => [member.id, member])),
    [members],
  );

  return {
    messages,
    memberById,
    loading: loaded == null,
    refreshing,
    error: loaded?.error ?? null,
    pagingError,
    clearPagingError: () => setPagingError(null),
    hasMoreAbove: pages != null && hasMoreAbove(pages),
    hasMoreBelow: pages != null && hasMoreBelow(pages),
    loadingAbove,
    loadingBelow,
    loadOlder,
    loadNewer,
    goToEnd,
    jumpingToEnd,
    goToStart,
    jumpingToStart,
    landingId,
    windowKey,
    loadAroundSentAt,
    loadAroundMessage,
    jumpingToUnread,
    retry,
  };
}
