import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  CallsignInfoRes,
  CountStatsRsp,
  InboxMessage,
  InboxMessagesRsp,
  MessageComment,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { fetchAnalysisCallsignInfos, fetchInboxMessages } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import {
  ANALYSIS_MESSAGES_PAGE_SIZE,
  ANALYSIS_MESSAGE_WINDOW_LIMIT,
  buildInboxReq,
} from './helpers';
import { loadMissingMessageCommentsForMessages } from './use-analysis-data.comments';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { isAnalysisInboxPageExhausted, toErrorMessage } from './use-analysis-data.shared';
import { useAnalysisMessageCounts } from './use-analysis-message-counts';
import { mergeSignalProfiles } from './use-analysis-data.reload';
import type { AnalysisAorEntry, AnalysisMessagePageCursor, AnalysisQueryState } from './types';
import { isNullOrUndefined } from '../../utils/misc';
import { mergeMessageWindow } from '../shared/message-feed/windowing';

type Params = {
  deferInitialLoad: boolean;
  messageWindowLimit?: number;
  focusedTargetMessageIndex?: number | null;
  focusedHasMoreEarlier?: boolean;
  focusedHasMoreLater?: boolean;
  focusedMessageId?: number | null;
  focusedMessageActive?: boolean;
  loadMissingNetworksForMessages: (messageItems: Array<[number, InboxMessage]>) => Promise<void>;
  newestFirst: boolean;
  onError: (message: string) => void;
  onUnauthorized: (error: unknown) => boolean;
  optionsFreqValues: string[];
  queryState: AnalysisQueryState;
  setGroupInfos: React.Dispatch<React.SetStateAction<Record<string, SignalGroupEntry>>>;
  setProfiles: React.Dispatch<React.SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setSummaryCallsignsInfo: React.Dispatch<React.SetStateAction<Record<string, CallsignInfoRes>>>;
};

const FIRST_PAGE_CURSOR: AnalysisMessagePageCursor = {
  beforeIdNoninclusive: null,
  sinceIdNoninclusive: null,
};

type FocusedLoadScope = {
  targetMessageId: number | null;
  queryState: AnalysisQueryState;
  generation: number;
};

function isCurrentFocusedLoadScope(
  scope: FocusedLoadScope | null,
  focusedMessageActive: boolean,
  focusedMessageId: number | null,
  queryState: AnalysisQueryState,
  generation: number,
): boolean {
  return (
    focusedMessageActive &&
    scope != null &&
    scope.targetMessageId === focusedMessageId &&
    scope.queryState === queryState &&
    scope.generation === generation
  );
}

function transformPageMessages(
  messages: Array<[number, InboxMessage]>,
  cursor: AnalysisMessagePageCursor,
): Array<[number, InboxMessage]> {
  const limitedMessages = cursor.resultLimit ? messages.slice(0, cursor.resultLimit) : messages;
  return cursor.reverseResults ? [...limitedMessages].reverse() : limitedMessages;
}

export function useAnalysisMessageList({
  deferInitialLoad,
  messageWindowLimit = ANALYSIS_MESSAGE_WINDOW_LIMIT,
  focusedHasMoreEarlier: initialFocusedHasMoreEarlier = false,
  focusedHasMoreLater: initialFocusedHasMoreLater = false,
  focusedMessageId = null,
  focusedMessageActive = false,
  focusedTargetMessageIndex = null,
  loadMissingNetworksForMessages,
  newestFirst,
  onError,
  onUnauthorized,
  optionsFreqValues,
  queryState,
  setGroupInfos,
  setProfiles,
  setSummaryCallsignsInfo,
}: Params) {
  const [counts, setCounts] = useState<Partial<CountStatsRsp> | null>(null);
  const [aorEntries, setAorEntries] = useState<AnalysisAorEntry[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [hasLoadedInitialMessages, setHasLoadedInitialMessages] = useState(false);
  const [messagesPaging, setMessagesPaging] = useState(false);
  const [messages, setMessageState] = useState<Array<[number, InboxMessage]>>([]);
  const [messageComments, setMessageComments] = useState<Record<number, MessageComment[]>>({});
  const [noMoreToLoad, setNoMoreToLoad] = useState(false);
  const [focusedHasMoreEarlier, setFocusedHasMoreEarlier] = useState(initialFocusedHasMoreEarlier);
  const [focusedHasMoreLater, setFocusedHasMoreLater] = useState(initialFocusedHasMoreLater);
  const [focusedLoadingEarlier, setFocusedLoadingEarlier] = useState(false);
  const [focusedLoadingLater, setFocusedLoadingLater] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [firstLoadedMessageIndex, setFirstLoadedMessageIndex] = useState(0);
  const [loadingBeforeWindow, setLoadingBeforeWindow] = useState(false);
  const [loadingAfterWindow, setLoadingAfterWindow] = useState(false);
  const highestVisitedPageRef = useRef(0);
  const messageCommentsRef = useRef(messageComments);
  const messagesRef = useRef(messages);
  const messageCommentsLoadVersionRef = useRef(0);
  const loadMoreMessagesRequestRef = useRef(0);
  const focusedLoadGenerationRef = useRef(0);
  const focusedMessageIdRef = useRef(focusedMessageId);
  const focusedMessageActiveRef = useRef(focusedMessageActive);
  const focusedQueryStateRef = useRef(queryState);
  const focusedLoadingDirectionsRef = useRef<Record<'earlier' | 'later', FocusedLoadScope | null>>({
    earlier: null,
    later: null,
  });
  const pageCursorsRef = useRef<AnalysisMessagePageCursor[]>([FIRST_PAGE_CURSOR]);
  const callsignEnrichmentGenerationRef = useRef(0);
  const unscopedCallsignsRef = useRef(new Set<string>());
  const callsignEnrichmentInFlightRef = useRef(new Map<string, number>());
  focusedMessageIdRef.current = focusedMessageId;
  focusedMessageActiveRef.current = focusedMessageActive;
  focusedQueryStateRef.current = queryState;
  messagesRef.current = messages;
  const {
    messagesOverallCount,
    messagesTotalCount,
    messagesTotalLoading,
    refreshMessageCounts,
    scheduleOverallMessageCountRefresh,
  } = useAnalysisMessageCounts({
    deferInitialLoad: deferInitialLoad || focusedMessageActive,
    newestFirst,
    onError,
    onUnauthorized,
    optionsFreqValues,
    queryState,
  });

  const mergeMessageReferences = useCallback(
    (rsp: Pick<InboxMessagesRsp, 'signalGroups' | 'signalProfiles'>) => {
      setGroupInfos((current) => ({
        ...current,
        ...Object.fromEntries((rsp.signalGroups ?? []).map((group) => [group.masterKey, group])),
      }));
      setProfiles((current) => mergeSignalProfiles(current, rsp.signalProfiles ?? {}));
    },
    [setGroupInfos, setProfiles],
  );

  useEffect(() => {
    messageCommentsRef.current = messageComments;
  }, [messageComments]);

  const setMessages: React.Dispatch<React.SetStateAction<Array<[number, InboxMessage]>>> =
    useCallback(
      (action) => {
        const current = messagesRef.current;
        const next = typeof action === 'function' ? action(current) : action;
        const addedAtStart = current.length > 0 && next[0]?.[0] !== current[0]?.[0];
        const edge = addedAtStart ? 'above' : 'below';
        const result = mergeMessageWindow([], next, edge, {
          limit: messageWindowLimit,
          getId: ([id]) => id,
        });
        const displayedResult =
          focusedMessageActive && newestFirst ? [...result.items].reverse() : result.items;
        const targetLocalIndex = displayedResult.findIndex(([id]) => id === focusedMessageId);
        messagesRef.current = result.items;
        setMessageState(result.items);
        if (focusedMessageActive && result.removedItems.length > 0) {
          if (edge === 'below') setFocusedHasMoreEarlier(true);
          else setFocusedHasMoreLater(true);
        }
        if (focusedMessageActive && focusedTargetMessageIndex != null && targetLocalIndex >= 0) {
          setFirstLoadedMessageIndex(Math.max(0, focusedTargetMessageIndex - targetLocalIndex));
        } else if (edge === 'below' && result.removedItems.length > 0) {
          setFirstLoadedMessageIndex((index) => index + result.removedItems.length);
        }
      },
      [
        focusedMessageActive,
        focusedMessageId,
        focusedTargetMessageIndex,
        messageWindowLimit,
        newestFirst,
      ],
    );

  useEffect(() => {
    loadMoreMessagesRequestRef.current += 1;
    const earlierLoading = isCurrentFocusedLoadScope(
      focusedLoadingDirectionsRef.current.earlier,
      focusedMessageActive,
      focusedMessageId,
      queryState,
      focusedLoadGenerationRef.current,
    );
    const laterLoading = isCurrentFocusedLoadScope(
      focusedLoadingDirectionsRef.current.later,
      focusedMessageActive,
      focusedMessageId,
      queryState,
      focusedLoadGenerationRef.current,
    );
    if (!earlierLoading) focusedLoadingDirectionsRef.current.earlier = null;
    if (!laterLoading) focusedLoadingDirectionsRef.current.later = null;
    setFocusedHasMoreEarlier(focusedMessageActive ? initialFocusedHasMoreEarlier : true);
    setFocusedHasMoreLater(focusedMessageActive ? initialFocusedHasMoreLater : true);
    setFocusedLoadingEarlier(earlierLoading);
    setFocusedLoadingLater(laterLoading);
    setMessagesPaging(earlierLoading || laterLoading);
  }, [
    focusedMessageActive,
    focusedMessageId,
    initialFocusedHasMoreEarlier,
    initialFocusedHasMoreLater,
    queryState,
  ]);

  const displayedMessages = useMemo(() => {
    return focusedMessageActive && newestFirst ? [...messages].reverse() : messages;
  }, [focusedMessageActive, messages, newestFirst]);

  const invalidateCallsignEnrichment = useCallback(() => {
    callsignEnrichmentGenerationRef.current += 1;
    unscopedCallsignsRef.current.clear();
    callsignEnrichmentInFlightRef.current.clear();
  }, []);

  const invalidateMessagePageRequests = useCallback(() => {
    invalidateCallsignEnrichment();
    loadMoreMessagesRequestRef.current += 1;
    focusedLoadGenerationRef.current += 1;
    focusedLoadingDirectionsRef.current = { earlier: null, later: null };
    setFocusedLoadingEarlier(false);
    setFocusedLoadingLater(false);
    setMessagesPaging(false);
    setLoadingBeforeWindow(false);
    setLoadingAfterWindow(false);
  }, [invalidateCallsignEnrichment]);

  const invalidateMessagePaging = useCallback(() => {
    invalidateMessagePageRequests();
    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    highestVisitedPageRef.current = 0;
    setFirstLoadedMessageIndex(0);
    setPageIndex(0);
  }, [invalidateMessagePageRequests]);

  const enrichCallsignsForMessages = useCallback(
    async (messageItems: Array<[number, InboxMessage]>) => {
      const callsigns = messageItems.flatMap(([, message]) => {
        const markedCallsigns = (message.textMarked ?? []).flatMap((node) =>
          typeof node === 'string'
            ? []
            : 'CNCallsignC' in node
              ? [node.CNCallsignC.text]
              : // A located position keeps the callsign token it replaced.
                'CNPositionC' in node && node.CNPositionC.callsign
                ? [node.CNPositionC.callsign]
                : [],
        );
        return (markedCallsigns.length > 0 ? markedCallsigns : message.callsigns).map((callsign) =>
          callsign.trim(),
        );
      });
      const keys = Array.from(
        new Set(callsigns.map(normalizeCallsignLookupValue).filter((key) => key !== '')),
      ).filter(
        (key) =>
          !unscopedCallsignsRef.current.has(key) && !callsignEnrichmentInFlightRef.current.has(key),
      );
      if (keys.length === 0) return;
      const generation = callsignEnrichmentGenerationRef.current;
      keys.forEach((key) => callsignEnrichmentInFlightRef.current.set(key, generation));
      try {
        const infos = await fetchAnalysisCallsignInfos(keys);
        if (generation !== callsignEnrichmentGenerationRef.current) return;
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, infos));
        keys.forEach((key) => unscopedCallsignsRef.current.add(key));
      } catch (error) {
        if (!isAbortError(error)) {
          if (!onUnauthorized(error)) onError(toErrorMessage(error));
        }
      } finally {
        keys.forEach((key) => {
          if (callsignEnrichmentInFlightRef.current.get(key) === generation) {
            callsignEnrichmentInFlightRef.current.delete(key);
          }
        });
      }
    },
    [onError, onUnauthorized, setSummaryCallsignsInfo],
  );

  useEffect(() => {
    void enrichCallsignsForMessages(messages);
  }, [enrichCallsignsForMessages, messages]);

  const getCurrentMessagePageCursor = useCallback(
    () => pageCursorsRef.current[pageIndex] ?? FIRST_PAGE_CURSOR,
    [pageIndex],
  );

  const replaceCurrentMessagePage = useCallback(
    (pageMessages: Array<[number, InboxMessage]>) => {
      setMessageState((current) => {
        const pageStart = Math.max(
          0,
          pageIndex * ANALYSIS_MESSAGES_PAGE_SIZE - firstLoadedMessageIndex,
        );
        const refreshedIds = new Set(pageMessages.map(([messageId]) => messageId));
        const retainedBefore = current
          .slice(0, pageStart)
          .filter(([messageId]) => !refreshedIds.has(messageId));
        const retainedAfter = current
          .slice(pageStart + ANALYSIS_MESSAGES_PAGE_SIZE)
          .filter(([messageId]) => !refreshedIds.has(messageId));
        return mergeMessageWindow(
          [],
          [...retainedBefore, ...pageMessages, ...retainedAfter],
          'below',
          {
            limit: messageWindowLimit,
            getId: ([id]) => id,
          },
        ).items;
      });
    },
    [firstLoadedMessageIndex, messageWindowLimit, pageIndex],
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

  const fetchPage = useCallback(
    async (
      cursor: AnalysisMessagePageCursor,
      options: {
        mode?: 'above' | 'below';
        keepCurrentOnEmpty?: boolean;
        markNoMoreOnEmpty?: boolean;
        targetPageIndex: number;
      },
    ) => {
      const inboxReq = buildInboxReq(queryState, optionsFreqValues, true);
      if (isNullOrUndefined(inboxReq)) return null;

      const requestId = loadMoreMessagesRequestRef.current + 1;
      loadMoreMessagesRequestRef.current = requestId;
      const isStale = () => requestId !== loadMoreMessagesRequestRef.current;

      setMessagesPaging(true);
      if (options.mode === 'above') setLoadingBeforeWindow(true);
      if (options.mode === 'below') setLoadingAfterWindow(true);
      try {
        const paginatedReq = {
          ...inboxReq,
          beforeIdNoninclusive: cursor.beforeIdNoninclusive,
          sinceIdNoninclusive: cursor.sinceIdNoninclusive,
          newestFirst: cursor.requestNewestFirst ?? newestFirst,
        };
        const rsp = await fetchInboxMessages(paginatedReq);
        if (isStale()) return null;
        mergeMessageReferences(rsp);
        const pageMessages = transformPageMessages(rsp.inboxItems ?? [], cursor);
        if (options.keepCurrentOnEmpty && pageMessages.length === 0) {
          if (options.markNoMoreOnEmpty) setNoMoreToLoad(true);
          return pageMessages;
        }
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
        if (options.mode) {
          const merged = mergeMessageWindow(messages, pageMessages, options.mode, {
            limit: messageWindowLimit,
            getId: ([id]) => id,
          });
          setMessageState(merged.items);
          if (options.mode === 'below') {
            setFirstLoadedMessageIndex(firstLoadedMessageIndex + merged.removedItems.length);
            setPageIndex(options.targetPageIndex);
            highestVisitedPageRef.current = Math.max(
              highestVisitedPageRef.current,
              options.targetPageIndex,
            );
          } else {
            setFirstLoadedMessageIndex(
              Math.max(0, firstLoadedMessageIndex - merged.addedItems.length),
            );
            if (merged.removedItems.length > 0) {
              setPageIndex(
                Math.max(
                  options.targetPageIndex,
                  pageIndex - Math.ceil(merged.removedItems.length / ANALYSIS_MESSAGES_PAGE_SIZE),
                ),
              );
            }
          }
        } else {
          setMessageState(
            mergeMessageWindow([], pageMessages, 'below', {
              limit: messageWindowLimit,
              getId: ([id]) => id,
            }).items,
          );
          setFirstLoadedMessageIndex(options.targetPageIndex * ANALYSIS_MESSAGES_PAGE_SIZE);
          setPageIndex(options.targetPageIndex);
          highestVisitedPageRef.current = Math.max(
            highestVisitedPageRef.current,
            options.targetPageIndex,
          );
        }
        await loadMissingNetworksForMessages(pageMessages);
        if (isStale()) return null;
        await loadMessageComments(pageMessages, false);
        if (isStale()) return null;
        if (options.mode !== 'above')
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
          setLoadingBeforeWindow(false);
          setLoadingAfterWindow(false);
        }
      }
    },
    [
      loadMessageComments,
      loadMissingNetworksForMessages,
      firstLoadedMessageIndex,
      messageWindowLimit,
      mergeMessageReferences,
      messages,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      pageIndex,
      queryState,
      setSummaryCallsignsInfo,
    ],
  );

  const loadNextMessages = useCallback(
    async (append: boolean) => {
      const lastMessage = messages.at(-1);
      if (isNullOrUndefined(lastMessage)) return false;

      const nextCursor: AnalysisMessagePageCursor = newestFirst
        ? { beforeIdNoninclusive: lastMessage[0], sinceIdNoninclusive: null }
        : { beforeIdNoninclusive: null, sinceIdNoninclusive: lastMessage[0] };

      const fetched = await fetchPage(nextCursor, {
        mode: append ? 'below' : undefined,
        keepCurrentOnEmpty: true,
        markNoMoreOnEmpty: true,
        targetPageIndex: pageIndex + 1,
      });
      if (fetched === null || fetched.length === 0) return false;

      pageCursorsRef.current[pageIndex + 1] = nextCursor;
      return true;
    },
    [fetchPage, messages, newestFirst, pageIndex],
  );

  const loadNextPage = useCallback(() => loadNextMessages(false), [loadNextMessages]);

  const loadMoreMessages = useCallback(() => loadNextMessages(true), [loadNextMessages]);

  const loadPreviousMessages = useCallback(async () => {
    if (firstLoadedMessageIndex === 0 || messages.length === 0) return false;
    const firstMessageId = messages[0][0];
    const previousPageIndex = Math.max(
      0,
      Math.floor((firstLoadedMessageIndex - 1) / ANALYSIS_MESSAGES_PAGE_SIZE),
    );
    const previousCursor: AnalysisMessagePageCursor = {
      beforeIdNoninclusive: newestFirst ? null : firstMessageId,
      sinceIdNoninclusive: newestFirst ? firstMessageId : null,
      requestNewestFirst: !newestFirst,
      reverseResults: true,
    };
    const fetched = await fetchPage(previousCursor, {
      mode: 'above',
      keepCurrentOnEmpty: true,
      targetPageIndex: previousPageIndex,
    });
    return fetched !== null && fetched.length > 0;
  }, [fetchPage, firstLoadedMessageIndex, messages, newestFirst]);

  const loadFocusedMessages = useCallback(
    async (direction: 'earlier' | 'later') => {
      if (
        !focusedMessageActive ||
        isCurrentFocusedLoadScope(
          focusedLoadingDirectionsRef.current[direction],
          focusedMessageActive,
          focusedMessageId,
          queryState,
          focusedLoadGenerationRef.current,
        )
      )
        return false;
      const boundaryMessage = direction === 'earlier' ? messages.at(0) : messages.at(-1);
      if (isNullOrUndefined(boundaryMessage)) return false;
      const inboxReq = buildInboxReq(queryState, optionsFreqValues, true);
      if (isNullOrUndefined(inboxReq)) return false;

      const requestScope: FocusedLoadScope = {
        targetMessageId: focusedMessageId,
        queryState,
        generation: focusedLoadGenerationRef.current,
      };
      const isStale = () =>
        requestScope.generation !== focusedLoadGenerationRef.current ||
        focusedMessageIdRef.current !== requestScope.targetMessageId ||
        !focusedMessageActiveRef.current ||
        focusedQueryStateRef.current !== requestScope.queryState;
      focusedLoadingDirectionsRef.current[direction] = requestScope;
      if (direction === 'earlier') setFocusedLoadingEarlier(true);
      else setFocusedLoadingLater(true);
      setMessagesPaging(true);
      try {
        const rsp = await fetchInboxMessages({
          ...inboxReq,
          beforeIdNoninclusive: direction === 'earlier' ? boundaryMessage[0] : null,
          sinceIdNoninclusive: direction === 'later' ? boundaryMessage[0] : null,
          newestFirst: direction === 'earlier',
        });
        if (isStale()) return false;
        mergeMessageReferences(rsp);
        const responseMessages = rsp.inboxItems ?? [];
        const pageMessages =
          direction === 'earlier' ? [...responseMessages].reverse() : responseMessages;
        setSummaryCallsignsInfo((current) => mergeAnalysisCallsignInfoMap(current, rsp.callsigns));
        await loadMissingNetworksForMessages(pageMessages);
        if (isStale()) return false;
        await loadMessageComments(pageMessages, false);
        if (isStale()) return false;
        const hasMore = !isAnalysisInboxPageExhausted(responseMessages, rsp.pageLimit);
        const currentMessages = messagesRef.current;
        const displayedCurrent = newestFirst ? [...currentMessages].reverse() : currentMessages;
        const displayedIncoming = newestFirst ? [...pageMessages].reverse() : pageMessages;
        const edge = (direction === 'earlier') === newestFirst ? 'below' : 'above';
        const merged = mergeMessageWindow(displayedCurrent, displayedIncoming, edge, {
          limit: messageWindowLimit,
          getId: ([id]) => id,
        });
        if (merged.items !== displayedCurrent) {
          const nextMessages = newestFirst ? [...merged.items].reverse() : merged.items;
          messagesRef.current = nextMessages;
          setMessageState(nextMessages);
        }
        if (edge === 'above') {
          setFirstLoadedMessageIndex((index) => Math.max(0, index - merged.addedItems.length));
        } else {
          setFirstLoadedMessageIndex((index) => index + merged.removedItems.length);
        }
        if (merged.removedItems.length > 0) {
          if (direction === 'earlier') setFocusedHasMoreLater(true);
          else setFocusedHasMoreEarlier(true);
        }
        if (direction === 'earlier') setFocusedHasMoreEarlier(hasMore);
        else setFocusedHasMoreLater(hasMore);
        return pageMessages.length > 0;
      } catch (loadError) {
        if (isStale()) return false;
        if (!onUnauthorized(loadError)) onError(toErrorMessage(loadError));
        return false;
      } finally {
        if (!isStale()) {
          if (focusedLoadingDirectionsRef.current[direction] === requestScope) {
            focusedLoadingDirectionsRef.current[direction] = null;
          }
          if (direction === 'earlier') setFocusedLoadingEarlier(false);
          else setFocusedLoadingLater(false);
          if (
            focusedLoadingDirectionsRef.current.earlier == null &&
            focusedLoadingDirectionsRef.current.later == null
          ) {
            setMessagesPaging(false);
          }
        }
      }
    },
    [
      focusedMessageActive,
      focusedMessageId,
      loadMessageComments,
      loadMissingNetworksForMessages,
      mergeMessageReferences,
      messageWindowLimit,
      messages,
      newestFirst,
      onError,
      onUnauthorized,
      optionsFreqValues,
      queryState,
      setSummaryCallsignsInfo,
    ],
  );

  const loadFocusedEarlier = useCallback(
    () => loadFocusedMessages('earlier'),
    [loadFocusedMessages],
  );
  const loadFocusedLater = useCallback(() => loadFocusedMessages('later'), [loadFocusedMessages]);

  const currentFocusedLoadingEarlier =
    focusedLoadingEarlier &&
    isCurrentFocusedLoadScope(
      focusedLoadingDirectionsRef.current.earlier,
      focusedMessageActive,
      focusedMessageId,
      queryState,
      focusedLoadGenerationRef.current,
    );
  const currentFocusedLoadingLater =
    focusedLoadingLater &&
    isCurrentFocusedLoadScope(
      focusedLoadingDirectionsRef.current.later,
      focusedMessageActive,
      focusedMessageId,
      queryState,
      focusedLoadGenerationRef.current,
    );

  const loadPrevPage = useCallback(
    async (targetPageIndex = pageIndex - 1) => {
      if (targetPageIndex < 0 || targetPageIndex >= pageIndex) return false;
      let prevCursor = pageCursorsRef.current[targetPageIndex];
      if (isNullOrUndefined(prevCursor)) {
        const firstMessage = messages.at(0);
        if (isNullOrUndefined(firstMessage)) return false;

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

      const fetched = await fetchPage(prevCursor, { targetPageIndex, keepCurrentOnEmpty: true });
      if (fetched === null || fetched.length === 0) return false;

      pageCursorsRef.current[targetPageIndex] = prevCursor;
      return true;
    },
    [fetchPage, messages, newestFirst, pageIndex],
  );

  const loadFirstPage = useCallback(async () => {
    if (pageIndex === 0) return false;
    const fetched = await fetchPage(FIRST_PAGE_CURSOR, {
      targetPageIndex: 0,
      keepCurrentOnEmpty: true,
    });
    if (fetched === null || fetched.length === 0) return false;

    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    return true;
  }, [fetchPage, pageIndex]);

  const loadLastPage = useCallback(async () => {
    if (isNullOrUndefined(messagesTotalCount) || messagesTotalCount === 0) return false;
    const lastPageIndex = Math.max(
      0,
      Math.ceil(messagesTotalCount / ANALYSIS_MESSAGES_PAGE_SIZE) - 1,
    );
    if (pageIndex === lastPageIndex) return false;

    const lastPageSize = messagesTotalCount % ANALYSIS_MESSAGES_PAGE_SIZE;
    const lastPageCursor: AnalysisMessagePageCursor = {
      ...FIRST_PAGE_CURSOR,
      requestNewestFirst: !newestFirst,
      reverseResults: true,
      resultLimit: lastPageSize || ANALYSIS_MESSAGES_PAGE_SIZE,
    };
    const fetched = await fetchPage(lastPageCursor, {
      targetPageIndex: lastPageIndex,
      keepCurrentOnEmpty: true,
    });
    if (fetched === null || fetched.length === 0) return false;

    pageCursorsRef.current = [FIRST_PAGE_CURSOR];
    pageCursorsRef.current[lastPageIndex] = lastPageCursor;
    setNoMoreToLoad(true);
    return true;
  }, [fetchPage, messagesTotalCount, newestFirst, pageIndex]);

  return {
    aorEntries,
    counts,
    getCurrentMessagePageCursor,
    hasLoadedInitialMessages,
    firstLoadedMessageIndex,
    hasMoreBeforeWindow: firstLoadedMessageIndex > 0,
    hasMoreAfterWindow: pageIndex < highestVisitedPageRef.current || !noMoreToLoad,
    loadingBeforeWindow,
    loadingAfterWindow,
    invalidateMessagePageRequests,
    invalidateMessagePaging,
    loadFirstPage,
    loadFocusedEarlier,
    loadFocusedLater,
    loadLastPage,
    loadMessageComments,
    loadMoreMessages,
    loadPreviousMessages,
    loadNextPage,
    loadPrevPage,
    messageComments,
    messageCommentsLoadVersionRef,
    messages: displayedMessages,
    messagesLoading,
    messagesOverallCount,
    messagesPaging,
    messagesTotalCount,
    messagesTotalLoading,
    focusedHasMoreEarlier,
    focusedHasMoreLater,
    focusedLoadingEarlier: currentFocusedLoadingEarlier,
    focusedLoadingLater: currentFocusedLoadingLater,
    noMoreToLoad,
    pageIndex,
    refreshMessageCounts,
    replaceCurrentMessagePage,
    scheduleOverallMessageCountRefresh,
    setAorEntries,
    setCounts,
    setHasLoadedInitialMessages,
    setMessageComments,
    setMessages,
    setMessagesLoading,
    setMessagesPaging,
    setNoMoreToLoad,
  };
}
