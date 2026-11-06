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
  appendNewer,
  hasMoreAbove,
  hasMoreBelow,
  newestPage,
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
};

type Loaded = { pages: MessengerChatPage[]; error: null } | { pages: null; error: string };

const isNotFound = (error: unknown) => error instanceof HttpRequestError && error.status === 404;

async function loadFirstPages(args: Args, signal: AbortSignal): Promise<MessengerChatPage[]> {
  const base = {
    accountId: args.accountId,
    chatId: args.chatId,
    cursor: null,
    limit: MESSENGER_PAGE_SIZE,
    direction: null,
  };
  const newest = async () =>
    newestPage(await listMessengersMessages({ ...base, aroundMessageId: null }, { signal }));
  if (args.anchorMessageId == null) return [await newest()];
  try {
    const anchor = args.anchorMessageId;
    const rsp = await listMessengersMessages({ ...base, aroundMessageId: anchor }, { signal });
    return [aroundPage(rsp, anchor, MESSENGER_PAGE_SIZE)];
  } catch (reason) {
    if (!isNotFound(reason)) throw reason;
    return [await newest()];
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
  const [members, setMembers] = useState<readonly MessengersChatMemberItem[]>([]);
  const [loadingAbove, setLoadingAbove] = useState(false);
  const [loadingBelow, setLoadingBelow] = useState(false);
  // True while "go to the end" fetches the newest page or fresh messages.
  const [jumpingToEnd, setJumpingToEnd] = useState(false);
  const [pagingError, setPagingError] = useState<string | null>(null);
  const pagesRef = useRef<MessengerChatPage[] | null>(null);
  const busyRef = useRef({ above: false, below: false });
  const controllerRef = useRef<AbortController | null>(null);
  // Bumped when the window is replaced, so a page request that was in flight is dropped.
  const epochRef = useRef(0);
  // The URL anchor only matters for the first load; later retries start from it as well.
  const initialArgs = useRef(args);

  const setPages = useCallback((pages: MessengerChatPage[]) => {
    pagesRef.current = pages;
    setLoaded((current) => ({ pages, error: null, attempt: current?.attempt ?? 0 }));
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    controllerRef.current = controller;
    pagesRef.current = null;
    epochRef.current += 1;
    busyRef.current = { above: false, below: false };
    loadFirstPages(initialArgs.current, controller.signal)
      .then((pages) => {
        pagesRef.current = pages;
        setLoaded({ pages, error: null, attempt });
      })
      .catch((reason: unknown) => {
        if (isAbortError(reason)) return;
        setLoaded({ pages: null, error: toErrorMessage(reason), attempt });
      });
    // Members only decorate messages, so their failure never blocks the feed.
    listMessengersChatMembers({ accountId, chatId }, { signal: controller.signal })
      .then((rsp) => setMembers(rsp.items))
      .catch(() => undefined);
    return () => controller.abort();
  }, [accountId, chatId, attempt]);

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
    const signal = controllerRef.current?.signal;
    if (signal == null) return false;
    try {
      const rsp = await listMessengersMessages(
        {
          accountId,
          chatId,
          cursor: null,
          limit: MESSENGER_PAGE_SIZE,
          direction: null,
          aroundMessageId: null,
        },
        { signal },
      );
      epochRef.current += 1;
      setPages([newestPage(rsp)]);
      setPagingError(null);
      return true;
    } catch (reason) {
      if (!isAbortError(reason)) setPagingError(toErrorMessage(reason));
      return false;
    }
  }, [accountId, chatId, setPages]);

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

  const retry = useCallback(() => {
    setPagingError(null);
    setLoaded(null);
    setAttempt((value) => value + 1);
  }, []);

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
    retry,
  };
}
