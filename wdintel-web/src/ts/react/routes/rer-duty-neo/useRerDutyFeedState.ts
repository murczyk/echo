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
  endDutyNotificationPollCycle,
  notifyDutyNewMessages,
  recordLastSuccessfulDutyCountCheck,
  removeLastSuccessfulDutyCountCheck,
} from './notifications';
import { useRerDutyCallsignInfo } from './useRerDutyCallsignInfo';
import { useRerDutyReferenceData } from './useRerDutyReferenceData';
import { useRerDutyDirectionalLoads } from './useRerDutyDirectionalLoads';
import { useRerDutyShortState } from './useRerDutyShortState';
import { createEmptyFeedState, useRerDutyInitialLoad } from './useRerDutyInitialLoad';
import { buildFeedCountSignature } from './rerDutyFeedCount';
import { compareMessageTuple } from './utils';
import type { TailAvailability } from './types';
import { beginDutyScrollDebugActivity, recordDutyScrollDebugEvent } from './duty-scroll-debug';
import { getDutyFollowScrollBehavior } from './duty-follow-scroll';
import { withDutyFeedRequestDeadline } from './dutyFeedRequestDeadline';

export type FeedStateDeps = {
  freqs: string[];
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
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
  const [error, setError] = useState<string | null>(null);
  const pollingErrorRef = useRef<string | null>(null);
  const reportPollingFailure = useCallback((pollingError: unknown) => {
    if (pollingErrorRef.current !== null) return;
    const message = pollingError instanceof Error ? pollingError.message : String(pollingError);
    pollingErrorRef.current = message;
    setError(message);
  }, []);
  const clearPollingFailure = useCallback(() => {
    const pollingError = pollingErrorRef.current;
    if (pollingError === null) return;
    pollingErrorRef.current = null;
    setError((current) => (current === pollingError ? null : current));
  }, []);
  const messageFeedsRef = useRef(messageFeeds);
  const loadNewerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeCountPollPromiseRef = useRef<Promise<void> | null>(null);
  const countPollRerunRequestedRef = useRef(false);
  const pollCountThenLoadNewerIfNeededRef = useRef<(() => Promise<void>) | null>(null);
  const activePollTailWorkPromiseByFeedIdRef = useRef<Partial<Record<string, Promise<void>>>>({});
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
  const pollIntervalMs = getDutyPollIntervalMs(deps.pollIntervalSec);
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
  const editReloadFeedIdsRef = useRef<Set<string>>(new Set());
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
      tailPreviewGenerationByFeedIdRef.current[feedId] =
        (tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0) + 1;
      delete tailPreviewPromiseByFeedIdRef.current[feedId];
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
      if (!preserveUnread) {
        delete unreadCursorByFeedIdRef.current[feedId];
        delete lastServerCountByFeedIdRef.current[feedId];
      }
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
  /** Arrow / watch catch-up: clear local badge and pin read cursor to loaded tail. */
  const catchUpFeedUnreadToTail = useCallback(
    (feedId: string) => {
      const feed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
      if (!feed) return;
      const tail = feed.items.at(-1);
      if (tail != null) {
        advanceFeedReadCursor(
          feedId,
          { id: tail[0], timestamp: tail[1].timestamp },
          0,
          buildFeedCountSignature(feed, freqs),
        );
        newestExhaustedCursorByFeedIdRef.current[feedId] = tail[0];
      } else {
        resetOrRewindFeedReadCursor(feedId, null);
        delete newestExhaustedCursorByFeedIdRef.current[feedId];
      }
      invalidateTailPreview(feedId);
      setTailAvailability(feedId, feed.items.length > 0 ? 'exhausted' : 'unknown');
      setMessageFeeds((previous) =>
        previous.map((candidate) =>
          candidate.id !== feedId
            ? candidate
            : {
                ...candidate,
                readIds: new Set(candidate.items.map(([id]) => id)),
                windowedUnreadItems: new Map<number, number>(),
                unreadCount: 0,
                pendingNewerItems: [],
              },
        ),
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
        filter: feed.filter,
        expandedFreqsSelected: expandedSelected,
        expandedFreqsDenied: expandedDenied,
        highlightSignals: feed.highlightSignalsEnabled ?? false,
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
        const finishDebugActivity = beginDutyScrollDebugActivity(
          feedId,
          'unreadCount',
          `cursor=${cursorId ?? '—'}; loadedTail=${feed.items.at(-1)?.[0] ?? '—'}`,
        );
        let quantity: number;
        try {
          ({ quantity } = await withDutyFeedRequestDeadline((signal) =>
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
        const finishDebugActivity = beginDutyScrollDebugActivity(
          feedId,
          'tailCount',
          `tail=${tailId}`,
        );
        let quantity: number;
        try {
          ({ quantity } = await withDutyFeedRequestDeadline((signal) =>
            fetchInboxCount(buildReqForFeed(feed, { sinceIdNoninclusive: tailId, nolimit: true }), {
              signal,
            }),
          ));
          finishDebugActivity(`ok; quantity=${quantity}; tail=${tailId}`);
        } catch (error) {
          finishDebugActivity(
            `error; tail=${tailId}; ${error instanceof Error ? error.message : String(error)}`,
          );
          throw error;
        }
        const currentFeed = messageFeedsRef.current.find((candidate) => candidate.id === feedId);
        if (
          !currentFeed ||
          currentFeed.loading ||
          getFeedLoadGeneration(feedId) !== requestGeneration ||
          currentFeed.items.at(-1)?.[0] !== tailId ||
          buildFeedCountSignature(currentFeed, freqs) !== requestSignature
        ) {
          recordDutyScrollDebugEvent(feedId, 'counter:discard', `tail=${tailId} became stale`);
          return null;
        }
        recordDutyScrollDebugEvent(feedId, 'counter:accept', `tail=${tailId}; newer=${quantity}`);
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
    completeFeedReload,
    setFeedUnreadCursor,
    installFeedUnreadCursorAndBaseline,
  });

  const {
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    invalidateFeedLoads,
    removeFeedLoads,
  } = useRerDutyDirectionalLoads({
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
      const loadedTail = feed.items.at(-1);
      const loadedFullyRead =
        loadedTail != null && feed.items.every(([id]) => feed.readIds.has(id));
      const hasBlockingWindowedUnread =
        earliestWindowedUnreadItem !== null &&
        loadedTail != null &&
        compareMessageTuple(earliestWindowedUnreadItem, {
          id: loadedTail[0],
          timestamp: loadedTail[1].timestamp,
        }) <= 0;
      if (loadedFullyRead && !hasBlockingWindowedUnread) {
        nextCursor = {
          id: loadedTail[0],
          timestamp: loadedTail[1].timestamp,
        };
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
    if (activeCountPollPromiseRef.current) {
      countPollRerunRequestedRef.current = true;
      return activeCountPollPromiseRef.current;
    }
    const run = async () => {
      const participatingFeeds = [...messageFeedsRef.current];
      const eligibleFeeds = participatingFeeds.filter(
        (feed) =>
          !feed.loading &&
          !pendingReloadFeedIdsRef.current.has(feed.id) &&
          !countRequestPromiseByFeedIdRef.current[feed.id],
      );
      if (!eligibleFeeds.length) return;
      beginDutyNotificationPollCycle();
      const countTasks = eligibleFeeds.map(async (feed) => {
        let entry: Awaited<ReturnType<typeof requestValidatedInboxCount>>;
        let feedId: string | null = null;
        let currentFeed: (typeof messageFeedsRef.current)[number] | undefined;
        try {
          entry = await requestValidatedInboxCount(feed.id);
          clearPollingFailure();
        } catch (error) {
          reportPollingFailure(error);
          return;
        }
        if (!entry || isNullOrUndefined(entry.quantity)) return;
        feedId = entry.feedId;
        recordLastSuccessfulDutyCountCheck(feedId);
        currentFeed = messageFeedsRef.current.find((feed) => feed.id === feedId);
        if (!currentFeed || currentFeed.loading) return;
        const prevServerCount = lastServerCountByFeedIdRef.current[feedId];
        const canCompareBaseline =
          prevServerCount?.cursorId === entry.cursorId &&
          prevServerCount?.requestSignature === entry.requestSignature;
        if (canCompareBaseline && entry.quantity > prevServerCount.quantity) {
          notifyDutyNewMessages(feedId, entry.quantity - prevServerCount.quantity);
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
              preview = await requestValidatedTailPreview(feedId);
            } catch (error) {
              reportPollingFailure(error);
              return;
            }
            if (!preview || tailPreviewGenerationByFeedIdRef.current[feedId] !== preview.generation)
              return;
            setConfirmedTailPreview(feedId, preview);
            setTailAvailability(feedId, preview.count > 0 ? 'available' : 'exhausted');
            return;
          }
          // Near bottom: keep beyond-tail preview fresh for the badge (cursor-aligned
          // inbox quantity matches tailCount when last-seen == loadedTail).
          if (loadedTailId != null && entry.cursorId === loadedTailId) {
            const generation = tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
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
                tailQuantity = await requestValidatedTailCount(feedId, loadedTailId!);
              } catch (error) {
                reportPollingFailure(error);
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
                invalidateTailPreview(feedId);
                return;
              }
              confirmedTailAvailable = true;
              const generation = tailPreviewGenerationByFeedIdRef.current[feedId] ?? 0;
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
        if (activePollTailWorkPromiseByFeedIdRef.current[feedId]) return;
        const tailWork = runTailWork();
        activePollTailWorkPromiseByFeedIdRef.current[feedId] = tailWork;
        void tailWork.catch(reportPollingFailure).finally(() => {
          if (activePollTailWorkPromiseByFeedIdRef.current[feedId] === tailWork) {
            delete activePollTailWorkPromiseByFeedIdRef.current[feedId];
          }
        });
      });
      let softDeadlineTimeout: ReturnType<typeof setTimeout> | null = null;
      const allCountTasksSettled = Promise.allSettled(countTasks);
      const softDeadline = new Promise<void>((resolve) => {
        softDeadlineTimeout = setTimeout(resolve, pollIntervalMs);
      });
      await Promise.race([allCountTasksSettled, softDeadline]);
      if (softDeadlineTimeout) clearTimeout(softDeadlineTimeout);
      endDutyNotificationPollCycle();
    };
    const promise = run().finally(() => {
      if (activeCountPollPromiseRef.current === promise) activeCountPollPromiseRef.current = null;
      const rerunRequested = countPollRerunRequestedRef.current;
      countPollRerunRequestedRef.current = false;
      if (rerunRequested && messageFeedsRef.current.length > 0) {
        void pollCountThenLoadNewerIfNeededRef.current?.();
      }
    });
    activeCountPollPromiseRef.current = promise;
    return promise;
  }, [
    loadFeedNewerMessages,
    deps.disableAutoScroll,
    requestValidatedInboxCount,
    requestValidatedTailCount,
    requestValidatedTailPreview,
    isFollowTailValid,
    setConfirmedTailPreview,
    invalidateTailPreview,
    markFeedReloadRequested,
    pollIntervalMs,
    reportPollingFailure,
    clearPollingFailure,
  ]);
  pollCountThenLoadNewerIfNeededRef.current = pollCountThenLoadNewerIfNeeded;

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
        const preserveUnread = editReloadFeedIdsRef.current.delete(w.id);
        loadFeedInitialMessagesRef.current(w.id, { preserveUnread });
      }
    });
  }, [feedIds, feedsNeedingLoadKey, shortStateReady]);

  useEffect(() => {
    if (shortStateIdRef.current && !shortStateReady) return;
    loadNewerRef.current = setInterval(() => {
      pollCountThenLoadNewerIfNeeded();
    }, pollIntervalMs);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [pollCountThenLoadNewerIfNeeded, pollIntervalMs, shortStateReady]);

  useEffect(() => {
    const recover = () => {
      if (document.visibilityState !== 'hidden') void pollCountThenLoadNewerIfNeeded();
    };
    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);
    document.addEventListener('visibilitychange', recover);
    return () => {
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
      document.removeEventListener('visibilitychange', recover);
    };
  }, [pollCountThenLoadNewerIfNeeded]);

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
          refs[feedId]?.scrollToEnd(getDutyFollowScrollBehavior());
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
      removeLastSuccessfulDutyCountCheck(feedId);
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
    reloadEditedFeeds,
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
  };
}
