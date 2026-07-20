import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import type { SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import { fetchInboxCount, fetchInboxMessages } from '../../services/api/inbox';
import type { FeedColumnHandle } from './FeedColumn';
import { buildInboxReq, emptyFilter, findAllAdjacentFreqs, parseStateFromUrl } from './utils';
import type { MessageCursor, MessageFeedState } from './utils';
import { useRerDutyFeedCrud } from './useRerDutyFeedCrud';
import { notifyDutyNewMessages } from './notifications';
import { useRerDutyCallsignInfo } from './useRerDutyCallsignInfo';
import { useRerDutyReferenceData } from './useRerDutyReferenceData';
import { useRerDutyDirectionalLoads } from './useRerDutyDirectionalLoads';
import { useRerDutyShortState } from './useRerDutyShortState';
import { createEmptyFeedState, useRerDutyInitialLoad } from './useRerDutyInitialLoad';
import { buildFeedCountSignature } from './rerDutyFeedCount';
import { compareMessageTuple } from './utils';
import type { TailAvailability } from './types';

export type FeedStateDeps = {
  freqs: string[];
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  testEnabled: boolean;
  testSinceMs: number;
  testLimit: number;
  pollIntervalSec: number;
  /** When true, duty page must not auto-scroll / follow new messages (user prefs). */
  disableAutoScroll: boolean;
  onFeedRemoved?: (feedId: string) => void;
};

type ServerCountBaseline = {
  cursorId: number | null;
  quantity: number;
  requestSignature: string;
};
type ConfirmedTailPreview = { tailId: number; count: number; generation: number };

export function useRerDutyFeedState(deps: FeedStateDeps) {
  const { freqs, setProfiles, setGroupInfos } = deps;
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(() => {
    const state = parseStateFromUrl();
    return (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) =>
      createEmptyFeedState(id, filter),
    );
  });
  const [error, setError] = useState<string | null>(null);
  const messageFeedsRef = useRef(messageFeeds);
  const loadNewerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const invalidateFeedLoadsRef = useRef<(feedId: string) => void>(() => {});
  const countRequestPromiseByFeedIdRef = useRef<
    Record<
      string,
      Promise<{
        feedId: string;
        quantity: number;
        cursorId: number | null;
        hasItems: boolean;
        requestSignature: string;
      } | null>
    >
  >({});
  const tailCountRequestPromiseByFeedIdRef = useRef<Record<string, Promise<number | null>>>({});
  const tailPreviewPromiseByFeedIdRef = useRef<
    Record<string, Promise<ConfirmedTailPreview | null>>
  >({});
  const tailPreviewGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const [watchModeByFeedId, setWatchModeByFeedId] = useState<Record<string, boolean>>({});
  const [loadingNewerFeedIds, setLoadingNewerFeedIds] = useState<Set<string>>(new Set());
  const [arrowResultByFeedId, setArrowResultByFeedId] = useState<Record<string, string | null>>({});
  const columnRefsRef = useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loadGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const pendingReloadFeedIdsRef = useRef<Set<string>>(new Set());
  const pendingScrollToEndRef = useRef<Record<string, number>>({});
  const scheduledScrollToEndRef = useRef<Record<string, number>>({});
  const followTailByFeedIdRef = useRef<Record<string, boolean>>({});
  const followGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const physicallyAtBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const [tailAvailabilityByFeedId, setTailAvailabilityByFeedId] = useState<
    Record<string, TailAvailability>
  >({});
  const tailAvailabilityByFeedIdRef = useRef<Record<string, TailAvailability>>({});
  const [confirmedTailPreviewByFeedId, setConfirmedTailPreviewByFeedId] = useState<
    Record<string, ConfirmedTailPreview | undefined>
  >({});
  const confirmedTailPreviewByFeedIdRef = useRef<Record<string, ConfirmedTailPreview | undefined>>(
    {},
  );
  const nearBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const unreadCursorByFeedIdRef = useRef<Record<string, MessageCursor | null>>({});
  const newestExhaustedCursorByFeedIdRef = useRef<Record<string, number>>({});
  const lastServerCountByFeedIdRef = useRef<Record<string, ServerCountBaseline>>({});
  /** Pixel-level at-bottom state; used so poll only auto-scrolls when the scroller is actually at the bottom. */
  const atBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const {
    ready: shortStateReady,
    shortStateIdRef,
    persistStateToUrl,
  } = useRerDutyShortState({ messageFeeds, messageFeedsRef, setMessageFeeds, setError });

  const {
    inboxCallsignInfoMap,
    callsignInfoMap,
    mergeInboxCallsigns,
    mergeResolvedCallsigns,
    retainFeedIds,
  } = useRerDutyCallsignInfo();
  const { networkDisplayMap, networkMap, unitsMap } = useRerDutyReferenceData(messageFeeds);

  const showArrowResult = useCallback((feedId: string, message: string) => {
    const key = feedId;
    if (arrowResultTimeoutsRef.current[key]) clearTimeout(arrowResultTimeoutsRef.current[key]);
    setArrowResultByFeedId((prev) => ({ ...prev, [feedId]: message }));
    arrowResultTimeoutsRef.current[key] = setTimeout(() => {
      delete arrowResultTimeoutsRef.current[key];
      setArrowResultByFeedId((prev) =>
        prev[feedId] === message ? { ...prev, [feedId]: null } : prev,
      );
    }, 3000);
  }, []);

  const resetTailState = useCallback((feedId: string) => {
    tailPreviewGenerationByFeedIdRef.current[feedId] =
      (tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
    delete tailCountRequestPromiseByFeedIdRef.current[feedId];
    delete tailPreviewPromiseByFeedIdRef.current[feedId];
    delete confirmedTailPreviewByFeedIdRef.current[feedId];
    setConfirmedTailPreviewByFeedId((previous) => {
      if (!(feedId in previous)) return previous;
      const next = { ...previous };
      delete next[feedId];
      return next;
    });
    delete pendingScrollToEndRef.current[feedId];
    delete scheduledScrollToEndRef.current[feedId];
    tailAvailabilityByFeedIdRef.current[feedId] = 'unknown';
    setTailAvailabilityByFeedId((previous) => ({ ...previous, [feedId]: 'unknown' }));
  }, []);
  const setConfirmedTailPreview = useCallback(
    (feedId: string, preview: ConfirmedTailPreview | undefined) => {
      confirmedTailPreviewByFeedIdRef.current[feedId] = preview;
      setConfirmedTailPreviewByFeedId((previous) => {
        if (preview === undefined) {
          if (!(feedId in previous)) return previous;
          const next = { ...previous };
          delete next[feedId];
          return next;
        }
        const current = previous[feedId];
        return current?.tailId === preview.tailId && current.count === preview.count
          ? previous
          : { ...previous, [feedId]: preview };
      });
    },
    [],
  );
  const invalidateTailPreview = useCallback(
    (feedId: string) => {
      tailPreviewGenerationByFeedIdRef.current[feedId] =
        (tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
      delete tailPreviewPromiseByFeedIdRef.current[feedId];
      setConfirmedTailPreview(feedId, undefined);
    },
    [setConfirmedTailPreview],
  );
  const markFeedReloadRequested = useCallback(
    (feedId: string) => {
      loadGenerationByFeedIdRef.current = {
        ...loadGenerationByFeedIdRef.current,
        [feedId]: (loadGenerationByFeedIdRef.current[feedId] ?? 0) + 1,
      };
      delete unreadCursorByFeedIdRef.current[feedId];
      delete lastServerCountByFeedIdRef.current[feedId];
      resetTailState(feedId);
      followTailByFeedIdRef.current[feedId] = false;
      followGenerationByFeedIdRef.current[feedId] =
        (followGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
      invalidateFeedLoadsRef.current(feedId);
      pendingReloadFeedIdsRef.current = new Set([...pendingReloadFeedIdsRef.current, feedId]);
    },
    [resetTailState],
  );
  const reloadEmptyFeeds = useCallback(() => {
    const emptyFeedIds = Array.from(
      new Set(
        messageFeedsRef.current.filter((feed) => feed.items.length === 0).map((feed) => feed.id),
      ),
    );
    if (emptyFeedIds.length === 0) return;
    emptyFeedIds.forEach(markFeedReloadRequested);
    setMessageFeeds((previous) =>
      previous.map((feed) => (emptyFeedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const reloadFeeds = useCallback(() => {
    const feedIds = Array.from(new Set(messageFeedsRef.current.map((feed) => feed.id)));
    if (feedIds.length === 0) return;
    feedIds.forEach(markFeedReloadRequested);
    setMessageFeeds((previous) =>
      previous.map((feed) => (feedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const clearFeedUnreadBaselines = useCallback((feedId: string) => {
    delete unreadCursorByFeedIdRef.current[feedId];
    delete lastServerCountByFeedIdRef.current[feedId];
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
    pendingReloadFeedIdsRef.current = new Set(
      [...pendingReloadFeedIdsRef.current].filter((id) => id !== feedId),
    );
  }, []);
  const setFeedUnreadCursor = useCallback((feedId: string, cursor: MessageCursor | null) => {
    unreadCursorByFeedIdRef.current[feedId] = cursor;
  }, []);
  const advanceFeedReadCursor = useCallback(
    (
      feedId: string,
      cursor: MessageCursor,
      remainingUnreadCount: number,
      requestSignature: string,
    ) => {
      unreadCursorByFeedIdRef.current[feedId] = cursor;
      lastServerCountByFeedIdRef.current[feedId] = {
        cursorId: cursor.id,
        quantity: remainingUnreadCount,
        requestSignature,
      };
    },
    [],
  );
  const resetOrRewindFeedReadCursor = useCallback(
    (feedId: string, cursor: MessageCursor | null) => {
      unreadCursorByFeedIdRef.current[feedId] = cursor;
      delete lastServerCountByFeedIdRef.current[feedId];
    },
    [],
  );
  const beginFollowTail = useCallback((feedId: string) => {
    const generation = (followGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    followGenerationByFeedIdRef.current[feedId] = generation;
    followTailByFeedIdRef.current[feedId] = true;
    delete pendingScrollToEndRef.current[feedId];
    return generation;
  }, []);
  const ensureFollowTail = useCallback(
    (feedId: string) => {
      const generation = followGenerationByFeedIdRef.current[feedId];
      if (followTailByFeedIdRef.current[feedId] === true && generation !== undefined) {
        return generation;
      }
      return beginFollowTail(feedId);
    },
    [beginFollowTail],
  );
  const cancelFollowTail = useCallback((feedId: string) => {
    followGenerationByFeedIdRef.current[feedId] =
      (followGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
    followTailByFeedIdRef.current[feedId] = false;
    delete pendingScrollToEndRef.current[feedId];
  }, []);
  const isFollowTailValid = useCallback(
    (feedId: string, generation: number) =>
      followTailByFeedIdRef.current[feedId] === true &&
      followGenerationByFeedIdRef.current[feedId] === generation,
    [],
  );
  const setTailAvailability = useCallback((feedId: string, availability: TailAvailability) => {
    tailAvailabilityByFeedIdRef.current[feedId] = availability;
    setTailAvailabilityByFeedId((previous) =>
      previous[feedId] === availability ? previous : { ...previous, [feedId]: availability },
    );
  }, []);
  const getFeedLoadGeneration = useCallback(
    (feedId: string) => loadGenerationByFeedIdRef.current[feedId] ?? 0,
    [],
  );
  const buildReqForFeed = useCallback(
    (
      feed: MessageFeedState,
      opts: Omit<
        Parameters<typeof buildInboxReq>[0],
        | 'filter'
        | 'expandedFreqsSelected'
        | 'expandedFreqsDenied'
        | 'highlightSignals'
        | 'reportTagsOnlyThisUnit'
      >,
    ) => {
      const range = feed.adjacentFreqsRange ?? 0;
      const expandedSelected =
        range > 0 && freqs.length > 0
          ? [
              ...(feed.filter.freqsSelected ?? []),
              ...findAllAdjacentFreqs(freqs, feed.filter.freqsSelected ?? [], range),
            ]
          : undefined;
      const expandedDenied =
        range > 0 && freqs.length > 0
          ? [
              ...(feed.filter.freqsDenied ?? []),
              ...findAllAdjacentFreqs(freqs, feed.filter.freqsDenied ?? [], range),
            ]
          : undefined;
      return buildInboxReq({
        ...opts,
        filter: feed.filter,
        expandedFreqsSelected: expandedSelected,
        expandedFreqsDenied: expandedDenied,
        highlightSignals: feed.highlightSignalsEnabled ?? false,
        reportTagsOnlyThisUnit: feed.onlyMyUnitTagsEnabled ? true : null,
      });
    },
    [freqs],
  );
  const requestValidatedInboxCount = useCallback(
    (feedId: string) => {
      const existingPromise = countRequestPromiseByFeedIdRef.current[feedId];
      if (existingPromise) return existingPromise;
      const feed = messageFeedsRef.current.find((x) => x.id === feedId);
      if (!feed || feed.loading || pendingReloadFeedIdsRef.current.has(feedId)) {
        return Promise.resolve(null);
      }
      const requestGeneration = getFeedLoadGeneration(feedId);
      const cursor = unreadCursorByFeedIdRef.current[feedId] ?? null;
      const cursorId = cursor?.id ?? null;
      const requestSignature = buildFeedCountSignature(feed, freqs);
      const requestPromise = (async () => {
        const { quantity } = await fetchInboxCount(
          buildReqForFeed(feed, { sinceIdNoninclusive: cursorId, nolimit: true }),
        );
        const currentFeed = messageFeedsRef.current.find((x) => x.id === feedId);
        if (
          !currentFeed ||
          currentFeed.loading ||
          pendingReloadFeedIdsRef.current.has(feedId) ||
          getFeedLoadGeneration(feedId) !== requestGeneration ||
          unreadCursorByFeedIdRef.current[feedId]?.id !== cursor?.id ||
          unreadCursorByFeedIdRef.current[feedId]?.timestamp !== cursor?.timestamp ||
          buildFeedCountSignature(currentFeed, freqs) !== requestSignature
        ) {
          return null;
        }
        return {
          feedId,
          quantity,
          cursorId,
          hasItems: feed.items.length > 0,
          requestSignature,
        };
      })();
      countRequestPromiseByFeedIdRef.current[feedId] = requestPromise;
      requestPromise.then(
        () => {
          if (countRequestPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete countRequestPromiseByFeedIdRef.current[feedId];
          }
        },
        () => {
          if (countRequestPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete countRequestPromiseByFeedIdRef.current[feedId];
          }
        },
      );
      return requestPromise;
    },
    [buildReqForFeed, freqs, getFeedLoadGeneration],
  );
  const requestValidatedTailCount = useCallback(
    (feedId: string, tailId: number) => {
      const existingPromise = tailCountRequestPromiseByFeedIdRef.current[feedId];
      if (existingPromise) return existingPromise;
      const feed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
      if (!feed || feed.loading || feed.items.at(-1)?.[0] !== tailId) {
        return Promise.resolve(null);
      }
      const requestGeneration = getFeedLoadGeneration(feedId);
      const requestSignature = buildFeedCountSignature(feed, freqs);
      const requestPromise = (async () => {
        const { quantity } = await fetchInboxCount(
          buildReqForFeed(feed, { sinceIdNoninclusive: tailId, nolimit: true }),
        );
        const currentFeed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
        if (
          !currentFeed ||
          currentFeed.loading ||
          getFeedLoadGeneration(feedId) !== requestGeneration ||
          currentFeed.items.at(-1)?.[0] !== tailId ||
          buildFeedCountSignature(currentFeed, freqs) !== requestSignature
        ) {
          return null;
        }
        return quantity;
      })();
      tailCountRequestPromiseByFeedIdRef.current[feedId] = requestPromise;
      requestPromise.then(
        () => {
          if (tailCountRequestPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete tailCountRequestPromiseByFeedIdRef.current[feedId];
          }
        },
        () => {
          if (tailCountRequestPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete tailCountRequestPromiseByFeedIdRef.current[feedId];
          }
        },
      );
      return requestPromise;
    },
    [buildReqForFeed, freqs, getFeedLoadGeneration],
  );
  const requestValidatedTailPreview = useCallback(
    (feedId: string): Promise<ConfirmedTailPreview | null> => {
      const existingPromise = tailPreviewPromiseByFeedIdRef.current[feedId];
      if (existingPromise) return existingPromise;
      const feed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
      const tailId = feed?.items.at(-1)?.[0];
      if (!feed || feed.loading || pendingReloadFeedIdsRef.current.has(feedId) || tailId == null) {
        return Promise.resolve(null);
      }
      const requestGeneration = getFeedLoadGeneration(feedId);
      const previewGeneration = tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
      tailPreviewGenerationByFeedIdRef.current[feedId] = previewGeneration;
      const requestSignature = buildFeedCountSignature(feed, freqs);
      const requestPromise = (async () => {
        const count = await requestValidatedTailCount(feedId, tailId);
        const currentFeed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
        if (
          count === null ||
          !currentFeed ||
          getFeedLoadGeneration(feedId) !== requestGeneration ||
          currentFeed.items.at(-1)?.[0] !== tailId ||
          buildFeedCountSignature(currentFeed, freqs) !== requestSignature
        ) {
          return null;
        }
        return {
          tailId,
          count,
          generation: previewGeneration,
        };
      })();
      tailPreviewPromiseByFeedIdRef.current[feedId] = requestPromise;
      requestPromise
        .finally(() => {
          if (tailPreviewPromiseByFeedIdRef.current[feedId] === requestPromise) {
            delete tailPreviewPromiseByFeedIdRef.current[feedId];
          }
        })
        .catch(() => {});
      return requestPromise;
    },
    [buildReqForFeed, freqs, getFeedLoadGeneration, requestValidatedTailCount],
  );

  useEffect(() => {
    return () => {
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  const loadFeedInitialMessages = useRerDutyInitialLoad({
    messageFeeds,
    messageFeedsRef,
    setMessageFeeds,
    setError,
    buildReqForFeed,
    getFeedLoadGeneration,
    mergeInboxCallsigns,
    setProfiles,
    setGroupInfos,
    clearFeedUnreadBaselines,
    setFeedUnreadCursor,
  });

  const { loadFeedOlderMessages, loadFeedNewerMessages, invalidateFeedLoads, removeFeedLoads } =
    useRerDutyDirectionalLoads({
      messageFeeds,
      messageFeedsRef,
      setMessageFeeds,
      setError,
      loadingNewerFeedIds,
      setLoadingNewerFeedIds,
      buildReqForFeed,
      getFeedLoadGeneration,
      mergeInboxCallsigns,
      setProfiles,
      setGroupInfos,
      getFeedCountSignature: (feed) => buildFeedCountSignature(feed, freqs),
      advanceFeedReadCursor,
      newestExhaustedCursorByFeedIdRef,
      pendingScrollToEndRef,
      nearBottomByFeedIdRef,
      followTailByFeedIdRef,
      followGenerationByFeedIdRef,
      isFollowTailValid,
      setTailAvailability,
      getTailAvailability: (feedId) => tailAvailabilityByFeedIdRef.current[feedId] ?? 'unknown',
      invalidateTailPreview,
    });
  invalidateFeedLoadsRef.current = invalidateFeedLoads;

  useEffect(() => {
    messageFeeds.forEach((feed) => {
      if (feed.loading || pendingReloadFeedIdsRef.current.has(feed.id)) return;
      const currentCursor = unreadCursorByFeedIdRef.current[feed.id] ?? null;
      let earliestWindowedUnreadItem: MessageCursor | null = null;
      for (const [id, timestamp] of feed.windowedUnreadItems) {
        const item = { id, timestamp };
        if (
          earliestWindowedUnreadItem === null ||
          compareMessageTuple(item, earliestWindowedUnreadItem) < 0
        ) {
          earliestWindowedUnreadItem = item;
        }
      }
      const cursorIsUnsafe =
        currentCursor !== null &&
        earliestWindowedUnreadItem !== null &&
        compareMessageTuple(earliestWindowedUnreadItem, currentCursor) <= 0;
      let nextCursor: MessageCursor | null = cursorIsUnsafe ? null : currentCursor;
      for (const [id, message] of feed.items) {
        const itemCursor = { id, timestamp: message.timestamp };
        if (nextCursor != null && compareMessageTuple(itemCursor, nextCursor) <= 0) continue;
        if (
          earliestWindowedUnreadItem !== null &&
          compareMessageTuple(itemCursor, earliestWindowedUnreadItem) >= 0
        ) {
          break;
        }
        if (!feed.readIds.has(id)) break;
        nextCursor = itemCursor;
      }
      if (cursorIsUnsafe) {
        resetOrRewindFeedReadCursor(feed.id, nextCursor);
      }
      if (
        nextCursor != null &&
        !cursorIsUnsafe &&
        (currentCursor === null || compareMessageTuple(nextCursor, currentCursor) > 0)
      ) {
        advanceFeedReadCursor(
          feed.id,
          nextCursor,
          feed.unreadCount,
          buildFeedCountSignature(feed, freqs),
        );
      }
    });
  }, [advanceFeedReadCursor, freqs, messageFeeds, resetOrRewindFeedReadCursor]);

  useEffect(() => {
    retainFeedIds(messageFeeds.map((feed) => feed.id));
  }, [messageFeeds, retainFeedIds]);

  const pollCountThenLoadNewerIfNeeded = useCallback(async () => {
    if (!messageFeedsRef.current.length) return;
    await Promise.all(
      messageFeedsRef.current.map(async (feed) => {
        let entry: Awaited<ReturnType<typeof requestValidatedInboxCount>>;
        try {
          entry = await requestValidatedInboxCount(feed.id);
        } catch {
          return;
        }
        if (!entry || isNullOrUndefined(entry.quantity)) return;
        const { feedId } = entry;
        const currentFeed = messageFeedsRef.current.find((feed) => feed.id === feedId);
        if (!currentFeed || currentFeed.loading) return;
        if (currentFeed.items.length > 0) {
          const quantity = entry.quantity ?? 0;
          const nextUnread = Math.max(currentFeed.unreadCount, quantity);
          if (nextUnread !== currentFeed.unreadCount) {
            setMessageFeeds((prev) =>
              prev.map((f) => (f.id === feedId ? { ...f, unreadCount: nextUnread } : f)),
            );
          }
        }
        if (entry.quantity <= 0) {
          invalidateTailPreview(feedId);
          setTailAvailability(feedId, currentFeed.items.length > 0 ? 'exhausted' : 'unknown');
          lastServerCountByFeedIdRef.current[feedId] = {
            cursorId: entry.cursorId,
            quantity: 0,
            requestSignature: entry.requestSignature,
          };
          return;
        }
        const prevServerCount = lastServerCountByFeedIdRef.current[feedId];
        const nextCount = entry.quantity;
        const canCompareBaseline =
          prevServerCount?.cursorId === entry.cursorId &&
          prevServerCount?.requestSignature === entry.requestSignature;
        const startsFreshBaseline = !prevServerCount && entry.hasItems;
        const signatureChanged = Boolean(prevServerCount) && !canCompareBaseline && entry.hasItems;
        if (entry.hasItems) {
          const prevQuantity = prevServerCount?.quantity ?? 0;
          if (canCompareBaseline || startsFreshBaseline) {
            const newCount = Math.max(0, nextCount - prevQuantity);
            if (newCount > 0) {
              notifyDutyNewMessages(feedId, newCount);
            }
          } else if (signatureChanged) {
            notifyDutyNewMessages(feedId, nextCount);
          }
        }
        lastServerCountByFeedIdRef.current[feedId] = {
          cursorId: entry.cursorId,
          quantity: nextCount,
          requestSignature: entry.requestSignature,
        };
        let confirmedTailAvailable = tailAvailabilityByFeedIdRef.current[feedId] === 'available';
        if (nearBottomByFeedIdRef.current[feedId] !== true) {
          let preview: ConfirmedTailPreview | null;
          try {
            preview = await requestValidatedTailPreview(feedId);
          } catch {
            return;
          }
          if (!preview || tailPreviewGenerationByFeedIdRef.current[feedId] !== preview.generation)
            return;
          setConfirmedTailPreview(feedId, preview);
          setTailAvailability(feedId, preview.count > 0 ? 'available' : 'exhausted');
          return;
        }
        if (nearBottomByFeedIdRef.current[feedId] === true) {
          const loadedTailId = currentFeed.items.at(-1)?.[0];
          const exhaustedTail =
            loadedTailId != null &&
            newestExhaustedCursorByFeedIdRef.current[feedId] === loadedTailId;
          if (exhaustedTail) {
            const previousAvailability = tailAvailabilityByFeedIdRef.current[feedId] ?? 'exhausted';
            setTailAvailability(feedId, 'checking');
            let tailQuantity: number | null;
            try {
              tailQuantity = await requestValidatedTailCount(feedId, loadedTailId);
            } catch {
              setTailAvailability(
                feedId,
                previousAvailability === 'loading' ? 'available' : previousAvailability,
              );
              return;
            }
            if (tailQuantity === null) {
              setTailAvailability(feedId, previousAvailability);
              return;
            }
            if (tailQuantity <= 0) {
              setTailAvailability(feedId, 'exhausted');
              return;
            }
            confirmedTailAvailable = true;
            if (nearBottomByFeedIdRef.current[feedId] !== true) {
              delete newestExhaustedCursorByFeedIdRef.current[feedId];
              setTailAvailability(feedId, 'available');
              return;
            }
            delete newestExhaustedCursorByFeedIdRef.current[feedId];
          }
          if (nearBottomByFeedIdRef.current[feedId] !== true) return;
          const capturedFollowGeneration = followGenerationByFeedIdRef.current[feedId] ?? -1;
          const shouldFollow =
            !deps.disableAutoScroll &&
            physicallyAtBottomByFeedIdRef.current[feedId] === true &&
            isFollowTailValid(feedId, capturedFollowGeneration);
          await loadFeedNewerMessages(feedId, {
            scrollToEndAfterLoad: shouldFollow,
            skipIfNewestExhausted: true,
            showLoading: false,
            followGeneration: capturedFollowGeneration,
            confirmedTailAvailable,
          });
        }
      }),
    );
  }, [
    loadFeedNewerMessages,
    deps.disableAutoScroll,
    requestValidatedInboxCount,
    requestValidatedTailCount,
    requestValidatedTailPreview,
    isFollowTailValid,
    setConfirmedTailPreview,
    invalidateTailPreview,
  ]);

  const feedIds = useMemo(() => messageFeeds.map((w) => w.id).join(','), [messageFeeds]);
  const feedsNeedingLoadKey = useMemo(
    () =>
      messageFeeds
        .filter((w) => {
          if (!w.loading) return false;
          if (w.items.length === 0) return true;
          return pendingReloadFeedIdsRef.current.has(w.id);
        })
        .map(
          (w) =>
            `${w.id}:${loadGenerationByFeedIdRef.current[w.id] ?? 0}:${JSON.stringify(w.filter)}`,
        )
        .join(';'),
    [messageFeeds],
  );
  const loadFeedInitialMessagesRef = useRef(loadFeedInitialMessages);
  loadFeedInitialMessagesRef.current = loadFeedInitialMessages;
  /** Tracks auto-started reload requests so a pending manual fetch does not duplicate them. */
  const loadStartedKeysRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (shortStateIdRef.current && !shortStateReady) return;
    const needingLoad = messageFeeds.filter((w) => {
      if (!w.loading) return false;
      if (w.items.length === 0) return true;
      return pendingReloadFeedIdsRef.current.has(w.id);
    });
    const needingKeys = new Set(
      needingLoad.map(
        (w) =>
          `${w.id}:${loadGenerationByFeedIdRef.current[w.id] ?? 0}:${JSON.stringify(w.filter)}`,
      ),
    );
    const started = loadStartedKeysRef.current;
    [...started].forEach((key) => {
      if (!needingKeys.has(key)) started.delete(key);
    });
    needingLoad.forEach((w) => {
      const key = `${w.id}:${loadGenerationByFeedIdRef.current[w.id] ?? 0}:${JSON.stringify(w.filter)}`;
      if (!started.has(key)) {
        started.add(key);
        loadFeedInitialMessagesRef.current(w.id);
      }
    });
  }, [feedIds, feedsNeedingLoadKey, shortStateReady]);

  useEffect(() => {
    if (shortStateIdRef.current && !shortStateReady) return;
    const intervalMs = Math.max(1, Math.floor(deps.pollIntervalSec) || 1) * 1000;
    loadNewerRef.current = setInterval(() => {
      pollCountThenLoadNewerIfNeeded();
    }, intervalMs);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [deps.pollIntervalSec, pollCountThenLoadNewerIfNeeded, shortStateReady]);

  useEffect(() => {
    const pendingEntries = Object.entries(pendingScrollToEndRef.current).filter(
      ([feedId, generation]) => scheduledScrollToEndRef.current[feedId] !== generation,
    );
    if (pendingEntries.length === 0) return;
    const refs = columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        pendingEntries.forEach(([feedId, capturedGeneration]) => {
          if (scheduledScrollToEndRef.current[feedId] !== capturedGeneration) return;
          if (pendingScrollToEndRef.current[feedId] !== capturedGeneration) {
            delete scheduledScrollToEndRef.current[feedId];
            return;
          }
          if (!isFollowTailValid(feedId, capturedGeneration)) {
            delete scheduledScrollToEndRef.current[feedId];
            return;
          }
          delete pendingScrollToEndRef.current[feedId];
          delete scheduledScrollToEndRef.current[feedId];
          refs[feedId]?.scrollToEnd('auto');
        });
      });
    });
    pendingEntries.forEach(([feedId, generation]) => {
      scheduledScrollToEndRef.current[feedId] = generation;
    });
  }, [messageFeeds]);

  const crud = useRerDutyFeedCrud(
    messageFeeds,
    setMessageFeeds,
    persistStateToUrl,
    markFeedReloadRequested,
    (feedId) => {
      loadGenerationByFeedIdRef.current = {
        ...loadGenerationByFeedIdRef.current,
        [feedId]: (loadGenerationByFeedIdRef.current[feedId] ?? 0) + 1,
      };
      removeFeedLoads(feedId);
      clearFeedUnreadBaselines(feedId);
      resetTailState(feedId);
      [
        followTailByFeedIdRef,
        followGenerationByFeedIdRef,
        physicallyAtBottomByFeedIdRef,
        nearBottomByFeedIdRef,
        atBottomByFeedIdRef,
      ].forEach((ref) => delete ref.current[feedId]);
      setLoadingNewerFeedIds((previous) => {
        const next = new Set(previous);
        next.delete(feedId);
        return next;
      });
      deps.onFeedRemoved?.(feedId);
    },
  );

  return {
    messageFeedsRef,
    messageFeeds,
    setMessageFeeds,
    error,
    setError,
    shortStateReady,
    columnRefsRef,
    nearBottomByFeedIdRef,
    atBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId,
    confirmedTailPreviewByFeedId,
    beginFollowTail,
    ensureFollowTail,
    cancelFollowTail,
    loadFeedInitialMessages,
    reloadEmptyFeeds,
    reloadFeeds,
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    requestValidatedInboxCount,
    applyFilter: crud.applyFilter,
    toggleGroup: crud.toggleGroup,
    selectAllGroups: crud.selectAllGroups,
    createMessageFeed: crud.createMessageFeed,
    removeMessageFeed: crud.removeMessageFeed,
    buildReqForFeed,
    getFeedLoadGeneration,
    networkDisplayMap,
    networkMap,
    unitsMap,
    inboxCallsignInfoMap,
    callsignInfoMap,
    mergeResolvedCallsigns,
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedIds,
    setLoadingNewerFeedIds,
    arrowResultByFeedId,
    showArrowResult,
  };
}
