import { useCallback, useEffect, useRef, useState } from 'react';

import type { MessengersMessageItem, MessengersMessagesListRsp } from '../../../../Bindings';
import { isAbortError } from '../../services/api/client';
import { listMessengersMessages } from '../../services/api/analysis-messengers';
import { CHAT_SEARCH_MIN_LENGTH } from './messenger-chat-search';
import { toErrorMessage } from './use-analysis-data.shared';

const SEARCH_DEBOUNCE_MS = 300;
const SEARCH_PAGE_SIZE = 20;

type SearchState = {
  hits: MessengersMessageItem[];
  // Where the next, older page of hits starts; null when there are no more.
  cursor: string | null;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
};

const IDLE: SearchState = {
  hits: [],
  cursor: null,
  loading: false,
  loadingMore: false,
  error: null,
};

// Full-text search in one chat (`messages/list` with `query`): hits newest first, older ones by `loadMore`.
export function useMessengerChatSearch(args: { accountId: string; chatId: string; text: string }) {
  const { accountId, chatId } = args;
  const query = args.text.trim();
  const active = query.length >= CHAT_SEARCH_MIN_LENGTH;
  const [state, setState] = useState<SearchState>(IDLE);
  const controllerRef = useRef<AbortController | null>(null);

  const fetchPage = useCallback(
    (cursor: string | null, signal: AbortSignal): Promise<MessengersMessagesListRsp> =>
      listMessengersMessages(
        {
          accountId,
          chatId,
          cursor,
          limit: SEARCH_PAGE_SIZE,
          direction: null,
          aroundMessageId: null,
          aroundSentAt: null,
          query,
          // The first mode of the analysis search ("Гнучкий пошук"); the reader is not asked to choose.
          searchMode: 'Fuzzy',
        },
        { signal },
      ),
    [accountId, chatId, query],
  );

  useEffect(() => {
    if (!active) {
      setState(IDLE);
      return;
    }
    const controller = new AbortController();
    controllerRef.current = controller;
    setState({ ...IDLE, loading: true });
    const timer = window.setTimeout(() => {
      fetchPage(null, controller.signal)
        .then((rsp) => setState({ ...IDLE, hits: rsp.items, cursor: rsp.olderCursor }))
        .catch((reason: unknown) => {
          if (!isAbortError(reason)) setState({ ...IDLE, error: toErrorMessage(reason) });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [active, fetchPage]);

  const { cursor, loading, loadingMore } = state;
  const loadMore = useCallback(async () => {
    const controller = controllerRef.current;
    if (controller == null || cursor == null || loading || loadingMore) return;
    // A retry after a failed page starts without its error.
    setState((current) => ({ ...current, loadingMore: true, error: null }));
    try {
      const rsp = await fetchPage(cursor, controller.signal);
      setState((current) => ({
        ...current,
        hits: [...current.hits, ...rsp.items],
        cursor: rsp.olderCursor,
        loadingMore: false,
      }));
    } catch (reason) {
      if (!isAbortError(reason)) {
        setState((current) => ({ ...current, loadingMore: false, error: toErrorMessage(reason) }));
      }
    }
  }, [cursor, fetchPage, loading, loadingMore]);

  return { ...state, active, loadMore };
}
