import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  CountStatsRsp,
  InboxMessage,
  MessageComment,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/analysis';
import { ANALYSIS_MESSAGES_PAGE_SIZE, buildInboxReq } from './helpers';
import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { isAnalysisInboxPageExhausted, toErrorMessage } from './use-analysis-data.shared';
import { useAnalysisMessageCounts } from './use-analysis-message-counts';
import type { AnalysisAorEntry, AnalysisMessagePageCursor, AnalysisQueryState } from './types';
import { isNullOrUndefined } from '../../utils/misc';

type Params = {
  deferInitialLoad: boolean;
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  setSummaryCallsignsInfo: React.Dispatch<React.SetStateAction<Record<string, CallsignInfoRes>>>;
};

const FIRST_PAGE_CURSOR: AnalysisMessagePageCursor = {
  beforeIdNoninclusive: null,
  sinceIdNoninclusive: null,
};

function transformPageMessages(
  messages: Array<[number, InboxMessage]>,
  cursor: AnalysisMessagePageCursor,
): Array<[number, InboxMessage]> {
  const limitedMessages = cursor.resultLimit ? messages.slice(0, cursor.resultLimit) : messages;
  return cursor.reverseResults ? [...limitedMessages].reverse() : limitedMessages;
}

export function useAnalysisMessageList({
  deferInitialLoad,
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
  const pageCursorsRef = useRef<AnalysisMessagePageCursor[]>([FIRST_PAGE_CURSOR]);
  const { messagesOverallCount, messagesTotalCount, messagesTotalLoading, refreshMessageCounts } =
    useAnalysisMessageCounts({
      deferInitialLoad,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
    });

  useEffect(() => {
    messageCommentsRef.current = messageComments;
  }, [messageComments]);

  const invalidateMessagePageRequests = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
  }, []);

  const invalidateMessagePaging = useCallback(() => {
    invalidateMessagePageRequests();
    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    setPageIndex(0);
  }, [invalidateMessagePageRequests]);

  const getCurrentMessagePageCursor = useCallback(
    () => pageCursorsRef.current[pageIndex] ?? FIRST_PAGE_CURSOR,
    [pageIndex],
  );

  const setCurrentMessagePage = useCallback(
    (cursor: AnalysisMessagePageCursor, nextPageIndex: number) => {
      pageCursorsRef.current = pageCursorsRef.current.slice(0, nextPageIndex + 1);
      pageCursorsRef.current[nextPageIndex] = cursor;
      setPageIndex(nextPageIndex);
    },
    [],
  );

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
    async (
      cursor: AnalysisMessagePageCursor,
      options: { keepCurrentOnEmpty?: boolean; targetPageIndex: number },
    ) => {
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
          newestFirst: cursor.requestNewestFirst ?? newestFirst,
        };
        const rsp = await fetchInboxMessages(paginatedReq);
        if (isStale()) return null;
        const pageMessages = transformPageMessages(rsp.inboxItems ?? [], cursor);
        if (options.keepCurrentOnEmpty && pageMessages.length === 0) {
          setNoMoreToLoad(true);
          return pageMessages;
        }
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
        setMessages(pageMessages);
        setPageIndex(options.targetPageIndex);
        await loadMissingNetworksForMessages(pageMessages);
        if (isStale()) return null;
        await loadMessageComments(pageMessages, false);
        if (isStale()) return null;
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

    const nextCursor: AnalysisMessagePageCursor = newestFirst
      ? { beforeIdNoninclusive: lastMessage[0], sinceIdNoninclusive: null }
      : { beforeIdNoninclusive: null, sinceIdNoninclusive: lastMessage[0] };

    const fetched = await fetchPage(nextCursor, {
      keepCurrentOnEmpty: true,
      targetPageIndex: pageIndex + 1,
    });
    if (fetched === null || fetched.length === 0) return;

    pageCursorsRef.current = pageCursorsRef.current.slice(0, pageIndex + 1);
    pageCursorsRef.current[pageIndex + 1] = nextCursor;
  }, [fetchPage, messages, newestFirst, pageIndex]);

  const loadPrevPage = useCallback(async () => {
    if (pageIndex === 0) return;
    let prevCursor = pageCursorsRef.current[pageIndex - 1];
    if (isNullOrUndefined(prevCursor)) {
      const firstMessage = messages.at(0);
      if (isNullOrUndefined(firstMessage)) return;

      prevCursor = newestFirst
        ? {
            beforeIdNoninclusive: null,
            sinceIdNoninclusive: firstMessage[0],
            requestNewestFirst: false,
            reverseResults: true,
          }
        : {
            beforeIdNoninclusive: firstMessage[0],
            sinceIdNoninclusive: null,
            requestNewestFirst: false,
            reverseResults: true,
          };
    }

    const fetched = await fetchPage(prevCursor, { targetPageIndex: pageIndex - 1 });
    if (fetched === null) return;

    pageCursorsRef.current[pageIndex - 1] = prevCursor;
  }, [fetchPage, messages, newestFirst, pageIndex]);

  const loadFirstPage = useCallback(async () => {
    if (pageIndex === 0) return;
    const fetched = await fetchPage(FIRST_PAGE_CURSOR, { targetPageIndex: 0 });
    if (fetched === null) return;

    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
  }, [fetchPage, pageIndex]);

  const loadLastPage = useCallback(async () => {
    if (isNullOrUndefined(messagesTotalCount) || messagesTotalCount === 0) return;
    const lastPageIndex = Math.max(
      0,
      Math.ceil(messagesTotalCount / ANALYSIS_MESSAGES_PAGE_SIZE) - 1,
    );
    if (pageIndex === lastPageIndex) return;

    const lastPageSize = messagesTotalCount % ANALYSIS_MESSAGES_PAGE_SIZE;
    const lastPageCursor: AnalysisMessagePageCursor = {
      ...FIRST_PAGE_CURSOR,
      requestNewestFirst: !newestFirst,
      reverseResults: true,
      resultLimit: lastPageSize || ANALYSIS_MESSAGES_PAGE_SIZE,
    };
    const fetched = await fetchPage(lastPageCursor, { targetPageIndex: lastPageIndex });
    if (fetched === null) return;

    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    pageCursorsRef.current[lastPageIndex] = lastPageCursor;
    setNoMoreToLoad(true);
  }, [fetchPage, messagesTotalCount, newestFirst, pageIndex]);

  return {
    aorEntries,
    counts,
    getCurrentMessagePageCursor,
    hasLoadedInitialMessages,
    invalidateMessagePageRequests,
    invalidateMessagePaging,
    loadAllMessages,
    loadFirstPage,
    loadLastPage,
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
    refreshMessageCounts,
    setAorEntries,
    setCurrentMessagePage,
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
