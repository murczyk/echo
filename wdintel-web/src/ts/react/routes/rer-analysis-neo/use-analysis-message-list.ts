import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  CountStatsRsp,
  InboxMessage,
  MessageComment,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/analysis';
import { buildInboxReq } from './helpers';
import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { isAnalysisInboxPageExhausted, toErrorMessage } from './use-analysis-data.shared';
import { useAnalysisMessageCounts } from './use-analysis-message-counts';
import type { AnalysisAorEntry, AnalysisQueryState } from './types';
import { isNullOrUndefined } from '../../utils/misc';

type Params = {
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  setSummaryCallsignsInfo: React.Dispatch<React.SetStateAction<Record<string, CallsignInfoRes>>>;
};

type PageCursor = {
  beforeIdNoninclusive: number | null;
  sinceIdNoninclusive: number | null;
};

const FIRST_PAGE_CURSOR: PageCursor = { beforeIdNoninclusive: null, sinceIdNoninclusive: null };

export function useAnalysisMessageList({
  loadMissingNetworksForMessages,
  newestFirst,
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  setSummaryCallsignsInfo,
}: Params) {
  const [counts, setCounts] = useState<CountStatsRsp | null>(null);
  const [aorEntries, setAorEntries] = useState<AnalysisAorEntry[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasLoadedInitialMessages, setHasLoadedInitialMessages] = useState(false);
  const [messagesPaging, setMessagesPaging] = useState(false);
  const [messages, setMessages] = useState<Array<[number, InboxMessage]>>([]);
  const [messageComments, setMessageComments] = useState<Record<number, MessageComment[]>>({});
  const [noMoreToLoad, setNoMoreToLoad] = useState(false);
  const [nolimitShown, setNolimitShown] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const messageCommentsRef = useRef(messageComments);
  const messageCommentsLoadVersionRef = useRef(0);
  const loadMoreMessagesRequestRef = useRef(0);
  const pageCursorsRef = useRef<PageCursor[]>([FIRST_PAGE_CURSOR]);
  const { messagesOverallCount, messagesTotalCount, messagesTotalLoading, reloadMessageCounts } =
    useAnalysisMessageCounts({
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
    });

  useEffect(() => {
    messageCommentsRef.current = messageComments;
  }, [messageComments]);

  const invalidateMessagePaging = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    setPageIndex(0);
    reloadMessageCounts();
  }, [reloadMessageCounts]);

  const loadMessageComments = useCallback(
    async (loadedMessages: Array<[number, InboxMessage]>, forceReload = false) => {
      await loadMissingMessageCommentsForMessages(
        loadedMessages,
        {
          messageComments: messageCommentsRef.current,
          messageCommentsLoadVersionRef,
          onError,
          onUnauthorized,
          setMessageComments,
        },
        forceReload,
      );
    },
    [onError, onUnauthorized],
  );

  const loadAllMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, optionsFreqValues, true);
    if (isNullOrUndefined(inboxReq)) return;

    setMessagesPaging(true);
    try {
      const rsp = await fetchInboxMessages({ ...inboxReq, nolimit: true, newestFirst });
      setMessages(rsp.inboxItems ?? []);
      setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
      await loadMissingNetworksForMessages(rsp.inboxItems ?? []);
      await loadMessageComments(rsp.inboxItems ?? [], false);
      setNolimitShown(true);
      setNoMoreToLoad(isAnalysisInboxPageExhausted(rsp.inboxItems, rsp.pageLimit));
    } catch (loadError) {
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      setMessagesPaging(false);
    }
  }, [
    loadMessageComments,
    loadMissingNetworksForMessages,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
    setSummaryCallsignsInfo,
  ]);

  const fetchPage = useCallback(
    async (cursor: PageCursor) => {
      const inboxReq = buildInboxReq(queryState, optionsFreqValues, true);
      if (isNullOrUndefined(inboxReq)) return null;

      const requestId = loadMoreMessagesRequestRef.current + 1;
      loadMoreMessagesRequestRef.current = requestId;
      const isStale = () => requestId !== loadMoreMessagesRequestRef.current;

      setMessagesPaging(true);
      try {
        const paginatedReq = {
          ...inboxReq,
          beforeIdNoninclusive: cursor.beforeIdNoninclusive,
          sinceIdNoninclusive: cursor.sinceIdNoninclusive,
          newestFirst,
        };
        const rsp = await fetchInboxMessages(paginatedReq);
        if (isStale()) return null;
        const pageMessages = rsp.inboxItems ?? [];
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
        setMessages(pageMessages);
        await loadMissingNetworksForMessages(pageMessages);
        await loadMessageComments(pageMessages, false);
        setNoMoreToLoad(isAnalysisInboxPageExhausted(pageMessages, rsp.pageLimit));
        return pageMessages;
      } catch (loadError) {
        if (isStale()) return null;
        if (!onUnauthorized(loadError)) {
          onError(toErrorMessage(loadError));
        }
        return null;
      } finally {
        if (!isStale()) {
          setMessagesPaging(false);
        }
      }
    },
    [
      loadMessageComments,
      loadMissingNetworksForMessages,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      setSummaryCallsignsInfo,
    ],
  );

  const loadNextPage = useCallback(async () => {
    const lastMessage = messages.at(-1);
    if (isNullOrUndefined(lastMessage)) return;

    const nextCursor: PageCursor = newestFirst
      ? { beforeIdNoninclusive: lastMessage[0], sinceIdNoninclusive: null }
      : { beforeIdNoninclusive: null, sinceIdNoninclusive: lastMessage[0] };

    const fetched = await fetchPage(nextCursor);
    if (fetched === null) return;

    pageCursorsRef.current = [...pageCursorsRef.current.slice(0, pageIndex + 1), nextCursor];
    setPageIndex((current) => current + 1);
  }, [fetchPage, messages, newestFirst, pageIndex]);

  const loadPrevPage = useCallback(async () => {
    if (pageIndex === 0) return;
    const prevCursor = pageCursorsRef.current[pageIndex - 1];
    if (isNullOrUndefined(prevCursor)) return;

    const fetched = await fetchPage(prevCursor);
    if (fetched === null) return;

    setPageIndex((current) => current - 1);
  }, [fetchPage, pageIndex]);

  return {
    aorEntries,
    counts,
    hasLoadedInitialMessages,
    invalidateMessagePaging,
    loadAllMessages,
    loadMessageComments,
    loadNextPage,
    loadPrevPage,
    messageComments,
    messageCommentsLoadVersionRef,
    messages,
    messagesLoading,
    messagesOverallCount,
    messagesPaging,
    messagesTotalCount,
    messagesTotalLoading,
    noMoreToLoad,
    nolimitShown,
    pageIndex,
    setAorEntries,
    setCounts,
    setHasLoadedInitialMessages,
    setMessageComments,
    setMessages,
    setMessagesLoading,
    setMessagesPaging,
    setNoMoreToLoad,
    setNolimitShown,
  };
}
