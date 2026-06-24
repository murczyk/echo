import { useCallback, useEffect, useRef, useState } from 'react';

import type { CallsignInfoRes, CountStatsRsp, InboxMessage, MessageComment, User } from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/analysis';
import { buildInboxReq } from './helpers';
import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { isAnalysisInboxPageExhausted, toErrorMessage } from './use-analysis-data.shared';
import type { AnalysisAorEntry, AnalysisQueryState } from './types';
import { isNullOrUndefined } from '../../utils/misc';

type Params = {
  currentUserRef: React.MutableRefObject<User | null>;
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  setSummaryCallsignsInfo: React.Dispatch<React.SetStateAction<Record<string, CallsignInfoRes>>>;
  usersRef: React.MutableRefObject<Record<string, User | null>>;
  setUsers: React.Dispatch<React.SetStateAction<Record<string, User | null>>>;
};

export function useAnalysisMessageList({
  currentUserRef,
  loadMissingNetworksForMessages,
  newestFirst,
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  setSummaryCallsignsInfo,
  usersRef,
  setUsers,
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
  const messageCommentsRef = useRef(messageComments);
  const messageCommentsLoadVersionRef = useRef(0);
  const loadMoreMessagesRequestRef = useRef(0);

  useEffect(() => {
    messageCommentsRef.current = messageComments;
  }, [messageComments]);

  const invalidateMessagePaging = useCallback(() => {
    loadMoreMessagesRequestRef.current += 1;
    setMessagesPaging(false);
  }, []);

  const loadMessageComments = useCallback(
    async (loadedMessages: Array<[number, InboxMessage]>, forceReload = false) => {
      await loadMissingMessageCommentsForMessages(loadedMessages, {
        authUserName: currentUserRef.current?.name ?? null,
        currentUser: currentUserRef.current,
        messageComments: messageCommentsRef.current,
        messageCommentsLoadVersionRef,
        onError,
        onUnauthorized,
        setMessageComments,
        setUsers,
        users: usersRef.current,
      }, forceReload);
    },
    [currentUserRef, onError, onUnauthorized, setUsers, usersRef],
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
  }, [loadMessageComments, loadMissingNetworksForMessages, newestFirst, onError, onUnauthorized, optionsFreqValues, queryState, setSummaryCallsignsInfo]);

  const loadMoreMessages = useCallback(async () => {
    const inboxReq = buildInboxReq(queryState, optionsFreqValues, true);
    const lastMessage = messages.at(-1);
    if (isNullOrUndefined(inboxReq) || isNullOrUndefined(lastMessage)) return;

    const requestId = loadMoreMessagesRequestRef.current + 1;
    loadMoreMessagesRequestRef.current = requestId;
    const isStaleLoadMore = () => requestId !== loadMoreMessagesRequestRef.current;

    setMessagesPaging(true);
    try {
      const paginatedReq = newestFirst
        ? { ...inboxReq, beforeIdNoninclusive: lastMessage[0], newestFirst }
        : { ...inboxReq, sinceIdNoninclusive: lastMessage[0], newestFirst };
      const rsp = await fetchInboxMessages(paginatedReq);
      if (isStaleLoadMore()) return;
      const nextMessages = rsp.inboxItems ?? [];
      setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
      setMessages((current) => [...current, ...nextMessages]);
      await loadMissingNetworksForMessages(nextMessages);
      await loadMessageComments(nextMessages, false);
      if (nextMessages.length === 0 || isAnalysisInboxPageExhausted(nextMessages, rsp.pageLimit)) {
        setNoMoreToLoad(true);
      }
    } catch (loadError) {
      if (isStaleLoadMore()) return;
      if (!onUnauthorized(loadError)) {
        onError(toErrorMessage(loadError));
      }
    } finally {
      if (!isStaleLoadMore()) {
        setMessagesPaging(false);
      }
    }
  }, [loadMessageComments, loadMissingNetworksForMessages, messages, newestFirst, onError, onUnauthorized, optionsFreqValues, queryState, setSummaryCallsignsInfo]);

  return {
    aorEntries,
    counts,
    hasLoadedInitialMessages,
    invalidateMessagePaging,
    loadAllMessages,
    loadMessageComments,
    loadMoreMessages,
    messageComments,
    messageCommentsLoadVersionRef,
    messages,
    messagesLoading,
    messagesPaging,
    noMoreToLoad,
    nolimitShown,
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
