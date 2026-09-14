import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isNullOrUndefined } from '../../utils/misc';

import type { SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import { fetchInboxCount, fetchInboxMessages } from '../../services/api/inbox';
import type { FeedColumnHandle } from './FeedColumn';
import {
  buildInboxReq,
  emptyFilter,
  DUTY_FEED_UNREAD_PREFETCH_MIN,
  feedLoadedUnreadCount,
  feedPendingNewerUnreadCount,
  feedNewerSinceId,
  findAllAdjacentFreqs,
  parseStateFromUrl,
} from './utils';
import type { MessageCursor, MessageFeedState } from './utils';
import { useRerDutyFeedCrud } from './useRerDutyFeedCrud';
import {
  beginDutyNotificationPollCycle,
  cancelDutyNotificationPollCycle,
  endDutyNotificationPollCycle,
  notifyDutyNewMessages,
  registerDutyNotificationPreview,
  recordLastSuccessfulDutyCountCheck,
  removeLastSuccessfulDutyCountCheck,
} from './notifications';
import type { DutyNotificationPollCycle } from './notifications';
import { useRerDutyCallsignInfo } from './useRerDutyCallsignInfo';
import { useRerDutyReferenceData } from './useRerDutyReferenceData';
import { useRerDutyDirectionalLoads } from './useRerDutyDirectionalLoads';
import { useRerDutyShortState } from './useRerDutyShortState';
import { createEmptyFeedState, useRerDutyInitialLoad } from './useRerDutyInitialLoad';
import { buildFeedCountSignature } from './rerDutyFeedCount';
import { compareMessageTuple, messageOrderCursor, messageOrderTimestamp } from './utils';
import { loadDutyNotificationPreview } from './dutyNotificationPreview';
import type { TailAvailability } from './types';
import { beginDutyScrollDebugActivity, recordDutyScrollDebugEvent } from './duty-scroll-debug';
import { useRerDutyDeferredLanding, useRerDutyNavigation } from './useRerDutyNavigation';
import { useRerDutyPollingErrors } from './useRerDutyPollingErrors';
import { useRerDutyPollingLifecycle } from './useRerDutyPollingLifecycle';
import { useRerDutyInitialLoadTrigger } from './useRerDutyInitialLoadTrigger';
import { useRerDutyTailPollRequests } from './useRerDutyTailPollRequests';
import { useRerDutyPollingCoordinator } from './useRerDutyPollingCoordinator';
import { useRerDutyPollingFeedWork } from './useRerDutyPollingFeedWork';
import {
  DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
  withDutyFeedRequestDeadline,
} from './dutyFeedRequestDeadline';

export type FeedStateDeps = {
  freqs: string[];
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  pollIntervalSec: number;
  /** When true, duty page must not auto-scroll / follow new messages (user prefs). */
  disableAutoScroll: boolean;
  messageSortBy?: 'IMSTimestamp' | 'IMSCreatedAt';
  onFeedRemoved?: (feedId: string) => void;
};

type ServerCountBaseline = {
  cursorId: number | null;
  quantity: number;
  requestSignature: string;
};
type ConfirmedTailPreview = { tailId: number; count: number; generation: number };

function getDutyPollIntervalMs(pollIntervalSec: number): number {
  return Math.max(1, Math.floor(pollIntervalSec) || 1) * 1000;
}

export function useRerDutyFeedState(deps: FeedStateDeps) {
  const { freqs, setProfiles, setGroupInfos } = deps;
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(() => {
    const state = parseStateFromUrl();
    return (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) =>
      createEmptyFeedState(id, filter),
    );
  });
  const {
    error,
    errorNotificationVersion,
    setError,
    reportPollingFailure,
    clearPollingFailure,
    authenticationFailedRef,
  } = useRerDutyPollingErrors();
  const messageFeedsRef = useRef(messageFeeds);
  const loadNewerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const countPollRerunRequestedRef = useRef(false);
  const pollLifecycleMountedRef = useRef(true);
  const pollLifecycleGenerationRef = useRef(0);
  const pollNotificationCyclesRef = useRef<Set<DutyNotificationPollCycle>>(new Set());
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
  const pollIntervalMs = getDutyPollIntervalMs(deps.pollIntervalSec);
  const [watchModeByFeedId, setWatchModeByFeedId] = useState<Record<string, boolean>>({});
  const [loadingNewerFeedIds, setLoadingNewerFeedIds] = useState<Set<string>>(new Set());
  const [arrowResultByFeedId, setArrowResultByFeedId] = useState<Record<string, string | null>>({});
  const columnRefsRef = useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loadGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const pendingReloadFeedIdsRef = useRef<Set<string>>(new Set());
  const editReloadFeedIdsRef = useRef<Set<string>>(new Set());
  const resetTailRequestsRef = useRef<(feedId: string) => void>(() => {});
  const navigation = useRerDutyNavigation();
  const {
    pendingScrollToEndRef,
    scheduledScrollToEndRef,
    followTailByFeedIdRef,
    followGenerationByFeedIdRef,
    beginFollowTail,
    ensureFollowTail,
    beginExplicitNavigation,
    cancelFollowTail,
    isFollowTailValid,
    isExplicitNavigationCurrent,
    registerExplicitLanding,
    registerExplicitLoading,
    isExplicitNavigationLoading,
    cancelExplicitNavigation,
    registerExplicitScheduledWork,
    clearExplicitScheduledWork,
    getExplicitScrollNavigation,
  } = navigation;
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
    resetTailRequestsRef.current(feedId);
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
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
      recordDutyScrollDebugEvent(
        feedId,
        'counter:preview',
        preview
          ? `tail=${preview.tailId}; count=${preview.count}; generation=${preview.generation}`
          : 'cleared',
      );
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
      resetTailRequestsRef.current(feedId);
      setConfirmedTailPreview(feedId, undefined);
    },
    [setConfirmedTailPreview],
  );
  const markFeedReloadRequested = useCallback(
    (feedId: string, preserveUnread = false) => {
      if (!preserveUnread) editReloadFeedIdsRef.current.delete(feedId);
      loadGenerationByFeedIdRef.current = {
        ...loadGenerationByFeedIdRef.current,
        [feedId]: (loadGenerationByFeedIdRef.current[feedId] ?? 0) + 1,
      };
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
    emptyFeedIds.forEach((feedId) => markFeedReloadRequested(feedId));
    setMessageFeeds((previous) =>
      previous.map((feed) => (emptyFeedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const reloadFeeds = useCallback(() => {
    const feedIds = Array.from(new Set(messageFeedsRef.current.map((feed) => feed.id)));
    if (feedIds.length === 0) return;
    feedIds.forEach((feedId) => markFeedReloadRequested(feedId));
    setMessageFeeds((previous) =>
      previous.map((feed) => (feedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const reloadEditedFeeds = useCallback(() => {
    const feedIds = Array.from(new Set(messageFeedsRef.current.map((feed) => feed.id)));
    if (feedIds.length === 0) return;
    feedIds.forEach((feedId) => {
      markFeedReloadRequested(feedId, true);
      editReloadFeedIdsRef.current.add(feedId);
    });
    setMessageFeeds((previous) =>
      previous.map((feed) => (feedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const reloadFeedsPreservingUnread = useCallback(() => {
    const feedIds = Array.from(new Set(messageFeedsRef.current.map((feed) => feed.id)));
    if (feedIds.length === 0) return;
    feedIds.forEach((feedId) => {
      markFeedReloadRequested(feedId, true);
      editReloadFeedIdsRef.current.add(feedId);
    });
    setMessageFeeds((previous) =>
      previous.map((feed) => (feedIds.includes(feed.id) ? { ...feed, loading: true } : feed)),
    );
  }, [markFeedReloadRequested]);
  const completeFeedReload = useCallback((feedId: string) => {
    pendingReloadFeedIdsRef.current = new Set(
      [...pendingReloadFeedIdsRef.current].filter((id) => id !== feedId),
    );
  }, []);
  const clearFeedUnreadBaselines = useCallback(
    (feedId: string) => {
      delete unreadCursorByFeedIdRef.current[feedId];
      delete lastServerCountByFeedIdRef.current[feedId];
      delete newestExhaustedCursorByFeedIdRef.current[feedId];
      completeFeedReload(feedId);
    },
    [completeFeedReload],
  );
  const setFeedUnreadCursor = useCallback((feedId: string, cursor: MessageCursor | null) => {
    unreadCursorByFeedIdRef.current[feedId] = cursor;
  }, []);
  const installFeedUnreadCursorAndBaseline = useCallback(
    (feed: MessageFeedState, cursor: MessageCursor | null) => {
      unreadCursorByFeedIdRef.current[feed.id] = cursor;
      lastServerCountByFeedIdRef.current[feed.id] = {
        cursorId: cursor?.id ?? null,
        quantity: 0,
        requestSignature: buildFeedCountSignature(feed, freqs),
      };
    },
    [freqs],
  );
  const recoverFeedUnreadBaselineAfterFailedLoad = useCallback(
    (feed: MessageFeedState, fallbackCursor: MessageCursor | null) => {
      const cursor = unreadCursorByFeedIdRef.current[feed.id] ?? null;
      const baseline = lastServerCountByFeedIdRef.current[feed.id];
      const requestSignature = buildFeedCountSignature(feed, freqs);
      const canPreserveBaseline =
        baseline?.cursorId === (cursor?.id ?? null) &&
        baseline.requestSignature === requestSignature;

      if (!canPreserveBaseline) {
        delete unreadCursorByFeedIdRef.current[feed.id];
        delete lastServerCountByFeedIdRef.current[feed.id];
        if (fallbackCursor) installFeedUnreadCursorAndBaseline(feed, fallbackCursor);
      }
      completeFeedReload(feed.id);
    },
    [completeFeedReload, freqs, installFeedUnreadCursorAndBaseline],
  );
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
  const setTailAvailability = useCallback((feedId: string, availability: TailAvailability) => {
    const previousAvailability = tailAvailabilityByFeedIdRef.current[feedId] ?? 'unknown';
    if (previousAvailability !== availability) {
      recordDutyScrollDebugEvent(
        feedId,
        'tail-availability',
        `${previousAvailability}→${availability}`,
      );
    }
    tailAvailabilityByFeedIdRef.current[feedId] = availability;
    setTailAvailabilityByFeedId((previous) =>
      previous[feedId] === availability ? previous : { ...previous, [feedId]: availability },
    );
  }, []);
  /** Explicit landing may acknowledge only the boundary it physically reached. */
  const catchUpFeedUnreadToTail = useCallback(
    (feedId: string, confirmedTarget?: MessageCursor) => {
      const feed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
      if (!feed) return;
      const target =
        confirmedTarget ??
        (feed.items.at(-1)
          ? {
              id: feed.items.at(-1)![0],
              timestamp: messageOrderTimestamp(feed.items.at(-1)![1], feed.messageSortBy) ?? null,
            }
          : null);
      if (target != null) {
        const readThroughTarget = (id: number, timestamp: number | null) =>
          compareMessageTuple({ id, timestamp }, target) <= 0;
        const remainingUnreadCount =
          feed.items.filter(
            ([id, message]) =>
              !feed.readIds.has(id) &&
              !readThroughTarget(id, messageOrderTimestamp(message, feed.messageSortBy) ?? null),
          ).length +
          [...feed.windowedUnreadItems.entries()].filter(
            ([id, timestamp]) => !readThroughTarget(id, timestamp),
          ).length +
          (feed.pendingNewerItems ?? []).filter(([id]) => !feed.readIds.has(id)).length;
        advanceFeedReadCursor(
          feedId,
          target,
          remainingUnreadCount,
          buildFeedCountSignature(feed, freqs),
        );
      } else {
        resetOrRewindFeedReadCursor(feedId, null);
      }
      invalidateTailPreview(feedId);
      setMessageFeeds((previous) =>
        previous.map((candidate) => {
          if (candidate.id !== feedId || !target) return candidate;
          const throughTarget = (id: number, timestamp: number | null) =>
            compareMessageTuple({ id, timestamp }, target) <= 0;
          const readIds = new Set(candidate.readIds);
          candidate.items.forEach(([id, message]) => {
            if (
              throughTarget(id, messageOrderTimestamp(message, candidate.messageSortBy) ?? null)
            ) {
              readIds.add(id);
            }
          });
          const windowedUnreadItems = new Map(candidate.windowedUnreadItems);
          windowedUnreadItems.forEach((timestamp, id) => {
            if (throughTarget(id, timestamp)) windowedUnreadItems.delete(id);
          });
          const loadedTail = candidate.items.at(-1);
          const reachedLoadedTail =
            loadedTail != null &&
            (candidate.pendingNewerItems?.length ?? 0) === 0 &&
            compareMessageTuple(
              {
                id: loadedTail[0],
                timestamp: messageOrderTimestamp(loadedTail[1], candidate.messageSortBy) ?? null,
              },
              target,
            ) === 0;
          const unresolvedUnreadIds = reachedLoadedTail
            ? new Set<number>()
            : new Set(candidate.unresolvedUnreadIds);
          if (!reachedLoadedTail) readIds.forEach((id) => unresolvedUnreadIds.delete(id));
          const unresolvedUnreadCount = reachedLoadedTail
            ? 0
            : (candidate.unresolvedUnreadCount ?? 0);
          const loadedIds = new Set(candidate.items.map(([id]) => id));
          const loadedUnreadIds = new Set(
            candidate.items.filter(([id]) => !readIds.has(id)).map(([id]) => id),
          );
          const pendingUnreadIds = new Set(
            (candidate.pendingNewerItems ?? [])
              .filter(([id]) => !readIds.has(id))
              .map(([id]) => id),
          );
          const windowedUnreadCount = [...windowedUnreadItems.keys()].filter(
            (id) => !loadedIds.has(id) && !pendingUnreadIds.has(id),
          ).length;
          const unreadCount =
            loadedUnreadIds.size +
            windowedUnreadCount +
            [...unresolvedUnreadIds].filter(
              (id) => !loadedUnreadIds.has(id) && !pendingUnreadIds.has(id),
            ).length +
            unresolvedUnreadCount +
            pendingUnreadIds.size;
          return {
            ...candidate,
            readIds,
            windowedUnreadItems,
            unresolvedUnreadIds,
            unresolvedUnreadCount,
            unreadCount,
          };
        }),
      );
    },
    [
      advanceFeedReadCursor,
      freqs,
      invalidateTailPreview,
      resetOrRewindFeedReadCursor,
      setTailAvailability,
    ],
  );
  /** Near-bottom catch-up: keep preview count in step with appended pages instead of clearing. */
  const noteNewerAppendForTailPreview = useCallback(
    (
      feedId: string,
      previousTailId: number,
      newTailId: number | null,
      addedCount: number,
      options?: { keepLoadedTail?: boolean },
    ) => {
      const nearBottom = nearBottomByFeedIdRef.current[feedId] === true;
      const current = confirmedTailPreviewByFeedIdRef.current[feedId];
      if (nearBottom && current?.tailId === previousTailId && addedCount > 0) {
        // Buffered pending stays beyond the loaded tail — keep preview count/tail as-is so
        // feedIndicatorUnreadCount's matching-preview branch (which already covers pending)
        // does not dip by the buffered page size.
        if (options?.keepLoadedTail === true) {
          return;
        }
        const remaining = Math.max(0, current.count - addedCount);
        if (newTailId == null) {
          invalidateTailPreview(feedId);
          return;
        }
        setConfirmedTailPreview(feedId, {
          tailId: newTailId,
          count: remaining,
          generation: current.generation,
        });
        setTailAvailability(feedId, remaining > 0 ? 'available' : 'unknown');
        return;
      }
      invalidateTailPreview(feedId);
    },
    [invalidateTailPreview, setConfirmedTailPreview, setTailAvailability],
  );
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
        sortBy: deps.messageSortBy,
        filter: feed.filter,
        expandedFreqsSelected: expandedSelected,
        expandedFreqsDenied: expandedDenied,
        highlightSignals: feed.highlightSignalsEnabled ?? false,
      });
    },
    [deps.messageSortBy, freqs],
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
        const finishDebugActivity = beginDutyScrollDebugActivity(
          feedId,
          'unreadCount',
          `cursor=${cursorId ?? '—'}; loadedTail=${feed.items.at(-1)?.[0] ?? '—'}`,
        );
        let quantity: number;
        try {
          ({ quantity } = await withDutyFeedRequestDeadline(
            DUTY_FEED_BACKGROUND_REQUEST_DEADLINE_MS,
            (signal) =>
              fetchInboxCount(
                buildReqForFeed(feed, { sinceIdNoninclusive: cursorId, nolimit: true }),
                { signal },
              ),
          ));
          finishDebugActivity(`ok; quantity=${quantity}`);
        } catch (error) {
          finishDebugActivity(`error; ${error instanceof Error ? error.message : String(error)}`);
          throw error;
        }
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
          recordDutyScrollDebugEvent(feedId, 'counter:discard', 'unread count became stale');
          return null;
        }
        recordDutyScrollDebugEvent(
          feedId,
          'counter:accept',
          `unread=${quantity}; cursor=${cursorId ?? '—'}`,
        );
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
  const tailPolling = useRerDutyTailPollRequests({
    messageFeedsRef,
    pendingReloadFeedIdsRef,
    getFeedLoadGeneration,
    buildReqForFeed,
    getFeedCountSignature: (feed) => buildFeedCountSignature(feed, freqs),
  });
  const { startFeedWork, forgetFeedWork } = useRerDutyPollingFeedWork();
  resetTailRequestsRef.current = tailPolling.resetTailRequests;

  useEffect(() => {
    return () => {
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  const feedInitialTargetByFeedIdRef = useRef<
    Record<string, { beforeIdNoninclusive: number; messageIds: number[] } | undefined>
  >({});
  const setFeedInitialTarget = useCallback(
    (feedId: string, target: { beforeIdNoninclusive: number; messageIds: number[] }) => {
      feedInitialTargetByFeedIdRef.current[feedId] = target;
    },
    [],
  );

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
    completeFeedReload,
    setFeedUnreadCursor,
    feedInitialTargetByFeedIdRef,
    installFeedUnreadCursorAndBaseline,
    recoverFeedUnreadBaselineAfterFailedLoad,
  });

  const {
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    invalidateFeedLoads,
    removeFeedLoads,
  } = useRerDutyDirectionalLoads({
    disableAutoScroll: deps.disableAutoScroll,
    messageFeeds,
    messageFeedsRef,
    setMessageFeeds,
    setError,
    reportPollingFailure,
    clearPollingFailure,
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
    physicallyAtBottomByFeedIdRef,
    followTailByFeedIdRef,
    followGenerationByFeedIdRef,
    isFollowTailValid,
    isExplicitNavigationLoading,
    setTailAvailability,
    getTailAvailability: (feedId) => tailAvailabilityByFeedIdRef.current[feedId] ?? 'unknown',
    invalidateTailPreview,
    noteNewerAppendForTailPreview,
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
        const itemCursor = {
          id,
          timestamp: messageOrderTimestamp(message, feed.messageSortBy) ?? null,
        };
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
      const loadedTail = feed.items.at(-1);
      const loadedFullyRead =
        loadedTail != null && feed.items.every(([id]) => feed.readIds.has(id));
      const hasBlockingWindowedUnread =
        earliestWindowedUnreadItem !== null &&
        loadedTail != null &&
        compareMessageTuple(
          earliestWindowedUnreadItem,
          messageOrderCursor(loadedTail[0], loadedTail[1], feed.messageSortBy),
        ) <= 0;
      if (loadedFullyRead && !hasBlockingWindowedUnread) {
        nextCursor = messageOrderCursor(loadedTail[0], loadedTail[1], feed.messageSortBy);
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

  const runPollCycle = useCallback(async () => {
    if (authenticationFailedRef.current) return;
    const lifecycleGeneration = pollLifecycleGenerationRef.current;
    const isLifecycleCurrent = () =>
      !authenticationFailedRef.current &&
      pollLifecycleMountedRef.current &&
      pollLifecycleGenerationRef.current === lifecycleGeneration;
    const run = async () => {
      if (!isLifecycleCurrent()) return;
      const participatingFeeds = [...messageFeedsRef.current];
      const eligibleFeeds = participatingFeeds.filter(
        (feed) =>
          !feed.loading &&
          !pendingReloadFeedIdsRef.current.has(feed.id) &&
          !countRequestPromiseByFeedIdRef.current[feed.id],
      );
      if (!eligibleFeeds.length) return;
      const cycle = beginDutyNotificationPollCycle();
      pollNotificationCyclesRef.current.add(cycle);
      const countTasks = eligibleFeeds.map(async (feed) => {
        let entry: Awaited<ReturnType<typeof requestValidatedInboxCount>>;
        let feedId: string | null = null;
        let currentFeed: (typeof messageFeedsRef.current)[number] | undefined;
        try {
          entry = await requestValidatedInboxCount(feed.id);
          if (!isLifecycleCurrent()) return;
          clearPollingFailure(`${feed.id}:count`);
        } catch (error) {
          if (!isLifecycleCurrent()) return;
          reportPollingFailure(`${feed.id}:count`, error);
          return;
        }
        if (!isLifecycleCurrent()) return;
        if (!entry || isNullOrUndefined(entry.quantity)) return;
        feedId = entry.feedId;
        if (!isLifecycleCurrent()) return;
        recordLastSuccessfulDutyCountCheck(feedId);
        currentFeed = messageFeedsRef.current.find((feed) => feed.id === feedId);
        if (!currentFeed || currentFeed.loading) return;
        const prevServerCount = lastServerCountByFeedIdRef.current[feedId];
        const canCompareBaseline =
          prevServerCount?.cursorId === entry.cursorId &&
          prevServerCount?.requestSignature === entry.requestSignature;
        if (canCompareBaseline && entry.quantity > prevServerCount.quantity) {
          const totalNew = entry.quantity - prevServerCount.quantity;
          const previewCursorId = unreadCursorByFeedIdRef.current[feedId]?.id ?? null;
          const previewGeneration = loadGenerationByFeedIdRef.current[feedId] ?? 0;
          const previewRequest = buildReqForFeed(currentFeed, {
            sinceIdNoninclusive: previewCursorId,
            loadLatest: true,
          });
          if (typeof registerDutyNotificationPreview === 'function') {
            registerDutyNotificationPreview(cycle, feedId, () =>
              loadDutyNotificationPreview(previewRequest, currentFeed.messageSortBy, () => {
                const live = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
                return (
                  isLifecycleCurrent() &&
                  live != null &&
                  (loadGenerationByFeedIdRef.current[feedId] ?? 0) === previewGeneration &&
                  buildFeedCountSignature(live, freqs) === entry.requestSignature
                );
              }),
            );
          }
          notifyDutyNewMessages(feedId, totalNew, cycle);
        }
        // Every successful comparable generation establishes a silent baseline. A failed
        // request never reaches here, so recovery compares against the last known count.
        lastServerCountByFeedIdRef.current[feedId] = {
          cursorId: entry.cursorId,
          quantity: entry.quantity,
          requestSignature: entry.requestSignature,
        };
        if (currentFeed.items.length === 0) {
          if (entry.quantity > 0) {
            markFeedReloadRequested(feedId);
            setMessageFeeds((previous) =>
              previous.map((feed) => (feed.id === feedId ? { ...feed, loading: true } : feed)),
            );
          }
          return;
        }
        if (!entry || !currentFeed || feedId === null) return;
        const runTailWork = async () => {
          const currentFeed = messageFeedsRef.current.find((feed) => feed.id === feedId);
          if (
            !currentFeed ||
            currentFeed.loading ||
            pendingReloadFeedIdsRef.current.has(feedId) ||
            buildFeedCountSignature(currentFeed, freqs) !== entry.requestSignature
          ) {
            return;
          }
          const currentBaseline = lastServerCountByFeedIdRef.current[feedId];
          if (
            (unreadCursorByFeedIdRef.current[feedId]?.id ?? null) !== entry.cursorId ||
            currentBaseline?.cursorId !== entry.cursorId ||
            currentBaseline.requestSignature !== entry.requestSignature ||
            currentBaseline.quantity !== entry.quantity
          ) {
            return;
          }
          const quantity = entry.quantity ?? 0;
          const loadedTailId = currentFeed.items.at(-1)?.[0] ?? null;
          const exhaustedAtTail =
            loadedTailId != null &&
            newestExhaustedCursorByFeedIdRef.current[feedId] === loadedTailId;
          const nearBottom = nearBottomByFeedIdRef.current[feedId] === true;
          // Inbox count is assist-only near the tail: never write the badge from it while
          // near-bottom. Scrolled-up polls may still seed beyond-tail pending.
          if (!nearBottom) {
            setMessageFeeds((prev) =>
              prev.map((f) => {
                if (f.id !== feedId) return f;
                const baseline = lastServerCountByFeedIdRef.current[feedId];
                if (
                  (unreadCursorByFeedIdRef.current[feedId]?.id ?? null) !== entry.cursorId ||
                  baseline?.cursorId !== entry.cursorId ||
                  baseline.requestSignature !== entry.requestSignature ||
                  baseline.quantity !== entry.quantity
                ) {
                  return f;
                }
                const nextUnread = Math.max(f.unreadCount, entry.quantity);
                return nextUnread === f.unreadCount ? f : { ...f, unreadCount: nextUnread };
              }),
            );
          }
          if (entry.quantity <= 0) {
            invalidateTailPreview(feedId);
            setTailAvailability(feedId, currentFeed.items.length > 0 ? 'exhausted' : 'unknown');
            if (loadedTailId != null) {
              newestExhaustedCursorByFeedIdRef.current[feedId] = loadedTailId;
            }
            setMessageFeeds((prev) =>
              prev.map((f) => {
                if (f.id !== feedId) return f;
                let localUnread = 0;
                for (const [id] of f.items) {
                  if (!f.readIds.has(id)) localUnread += 1;
                }
                localUnread += f.windowedUnreadItems?.size ?? 0;
                return localUnread === f.unreadCount ? f : { ...f, unreadCount: localUnread };
              }),
            );
            return;
          }
          let confirmedTailAvailable = tailAvailabilityByFeedIdRef.current[feedId] === 'available';
          if (!nearBottom) {
            let preview: ConfirmedTailPreview | null;
            try {
              preview = await tailPolling.requestValidatedTailPreview(feedId);
            } catch (error) {
              reportPollingFailure(`${feedId}:preview`, error);
              return;
            }
            if (
              !preview ||
              tailPolling.tailPreviewGenerationByFeedIdRef.current[feedId] !== preview.generation
            )
              return;
            clearPollingFailure(`${feedId}:preview`);
            setConfirmedTailPreview(feedId, preview);
            setTailAvailability(feedId, preview.count > 0 ? 'available' : 'exhausted');
            return;
          }
          // Near bottom: keep beyond-tail preview fresh for the badge (cursor-aligned
          // inbox quantity matches tailCount when last-seen == loadedTail).
          if (loadedTailId != null && entry.cursorId === loadedTailId) {
            const generation = tailPolling.tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
            setConfirmedTailPreview(feedId, {
              tailId: loadedTailId,
              count: quantity,
              generation,
            });
            setTailAvailability(feedId, quantity > 0 ? 'available' : 'exhausted');
            confirmedTailAvailable = quantity > 0;
          }
          if (nearBottom) {
            const exhaustedTail =
              loadedTailId != null &&
              newestExhaustedCursorByFeedIdRef.current[feedId] === loadedTailId;
            if (exhaustedTail) {
              const previousAvailability =
                tailAvailabilityByFeedIdRef.current[feedId] ?? 'exhausted';
              setTailAvailability(feedId, 'checking');
              let tailQuantity: number | null;
              try {
                tailQuantity = await tailPolling.requestValidatedTailCount(feedId, loadedTailId!);
              } catch (error) {
                reportPollingFailure(`${feedId}:tail-count`, error);
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
              clearPollingFailure(`${feedId}:tail-count`);
              if (tailQuantity <= 0) {
                setTailAvailability(feedId, 'exhausted');
                invalidateTailPreview(feedId);
                return;
              }
              confirmedTailAvailable = true;
              const generation = tailPolling.tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
              setConfirmedTailPreview(feedId, {
                tailId: loadedTailId!,
                count: tailQuantity,
                generation,
              });
              if (nearBottomByFeedIdRef.current[feedId] !== true) {
                delete newestExhaustedCursorByFeedIdRef.current[feedId];
                setTailAvailability(feedId, 'available');
                return;
              }
              delete newestExhaustedCursorByFeedIdRef.current[feedId];
            }
            if (nearBottomByFeedIdRef.current[feedId] !== true) return;
            const maxCatchUpPages = 20;
            let unreadRunway =
              feedLoadedUnreadCount(currentFeed) + feedPendingNewerUnreadCount(currentFeed);
            for (let page = 0; page < maxCatchUpPages; page++) {
              if (nearBottomByFeedIdRef.current[feedId] !== true) break;
              if (tailAvailabilityByFeedIdRef.current[feedId] === 'exhausted') break;
              const pageFeed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
              if (pageFeed) {
                // Prefer committed state when present; never let a stale ref shrink the runway.
                unreadRunway = Math.max(
                  unreadRunway,
                  feedLoadedUnreadCount(pageFeed) + feedPendingNewerUnreadCount(pageFeed),
                );
              }
              // Prefer a loaded unread runway after last-seen over draining the whole backlog.
              if (unreadRunway >= DUTY_FEED_UNREAD_PREFETCH_MIN) break;
              const preview = confirmedTailPreviewByFeedIdRef.current[feedId];
              if (preview != null && preview.count <= 0) break;
              const pageSinceId = pageFeed != null ? feedNewerSinceId(pageFeed) : null;
              if (pageSinceId == null) break;
              if (newestExhaustedCursorByFeedIdRef.current[feedId] === pageSinceId) break;
              const capturedFollowGeneration = followGenerationByFeedIdRef.current[feedId] ?? -1;
              const shouldFollow =
                !deps.disableAutoScroll &&
                physicallyAtBottomByFeedIdRef.current[feedId] === true &&
                isFollowTailValid(feedId, capturedFollowGeneration);
              const newerResult = await loadFeedNewerMessages(feedId, {
                scrollToEndAfterLoad: shouldFollow,
                skipIfNewestExhausted: true,
                showLoading: false,
                followGeneration: capturedFollowGeneration,
                confirmedTailAvailable: page === 0 ? confirmedTailAvailable : true,
              });
              if (!newerResult.ok || newerResult.addedCount === 0) break;
              // Ref may still be awaiting React commit; approximate runway for this poll tick.
              unreadRunway = shouldFollow ? 0 : unreadRunway + newerResult.addedCount;
            }
          }
        };
        if (!isLifecycleCurrent()) return;
        const tailWork = startFeedWork(feedId, runTailWork);
        if (!tailWork) return;
        void tailWork
          .then(() => {
            if (isLifecycleCurrent()) clearPollingFailure(`${feedId}:tail-work`);
          })
          .catch((error) => {
            if (isLifecycleCurrent()) reportPollingFailure(`${feedId}:tail-work`, error);
          });
      });
      let softDeadlineTimeout: ReturnType<typeof setTimeout> | null = null;
      const allCountTasksSettled = Promise.allSettled(countTasks);
      const softDeadline = new Promise<void>((resolve) => {
        softDeadlineTimeout = setTimeout(resolve, pollIntervalMs);
      });
      try {
        await Promise.race([allCountTasksSettled, softDeadline]);
      } finally {
        if (softDeadlineTimeout) clearTimeout(softDeadlineTimeout);
        if (isLifecycleCurrent()) endDutyNotificationPollCycle(cycle);
        else cancelDutyNotificationPollCycle(cycle);
      }
      void allCountTasksSettled.finally(() => {
        pollNotificationCyclesRef.current.delete(cycle);
      });
    };
    await run();
  }, [
    loadFeedNewerMessages,
    deps.disableAutoScroll,
    requestValidatedInboxCount,
    tailPolling,
    isFollowTailValid,
    setConfirmedTailPreview,
    invalidateTailPreview,
    markFeedReloadRequested,
    pollIntervalMs,
    reportPollingFailure,
    clearPollingFailure,
    buildReqForFeed,
    startFeedWork,
  ]);
  const pollCountThenLoadNewerIfNeeded = useRerDutyPollingCoordinator({
    runCycle: runPollCycle,
    rerunRequestedRef: countPollRerunRequestedRef,
    canRerun: () => !authenticationFailedRef.current && messageFeedsRef.current.length > 0,
  });

  useRerDutyInitialLoadTrigger({
    messageFeeds,
    shortStateReady,
    hasShortState: Boolean(shortStateIdRef.current),
    pendingReloadFeedIdsRef,
    editReloadFeedIdsRef,
    loadGenerationByFeedIdRef,
    loadFeedInitialMessages,
  });

  useRerDutyPollingLifecycle({
    ready: shortStateReady,
    hasShortState: Boolean(shortStateIdRef.current),
    pollIntervalMs,
    poll: pollCountThenLoadNewerIfNeeded,
    intervalRef: loadNewerRef,
    authenticationFailedRef,
    mountedRef: pollLifecycleMountedRef,
    lifecycleGenerationRef: pollLifecycleGenerationRef,
    notificationCyclesRef: pollNotificationCyclesRef,
    rerunRequestedRef: countPollRerunRequestedRef,
  });

  useRerDutyDeferredLanding({
    changeKey: messageFeeds,
    disableAutoScroll: deps.disableAutoScroll,
    columnRefsRef,
    pendingScrollToEndRef,
    scheduledScrollToEndRef,
    isFollowTailValid,
  });

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
      forgetFeedWork(feedId);
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
      removeLastSuccessfulDutyCountCheck(feedId);
    },
  );

  return {
    messageFeedsRef,
    messageFeeds,
    setMessageFeeds,
    error,
    errorNotificationVersion,
    setError,
    shortStateReady,
    columnRefsRef,
    nearBottomByFeedIdRef,
    atBottomByFeedIdRef,
    physicallyAtBottomByFeedIdRef,
    tailAvailabilityByFeedId,
    confirmedTailPreviewByFeedId,
    beginFollowTail,
    beginExplicitNavigation,
    ensureFollowTail,
    cancelFollowTail,
    isExplicitNavigationCurrent,
    registerExplicitLanding,
    registerExplicitLoading,
    cancelExplicitNavigation,
    registerExplicitScheduledWork,
    clearExplicitScheduledWork,
    getExplicitScrollNavigation,
    loadFeedInitialMessages,
    reloadEmptyFeeds,
    reloadFeeds,
    reloadEditedFeeds,
    reloadFeedsPreservingUnread,
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    requestValidatedInboxCount,
    catchUpFeedUnreadToTail,
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
    setFeedInitialTarget,
  };
}
