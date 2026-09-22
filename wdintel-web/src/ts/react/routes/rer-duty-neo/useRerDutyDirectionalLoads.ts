import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  CallsignInfoRes,
  InboxMessagesReq,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/inbox';
import {
  appendNewerItemsToFeed,
  appendWindowedMessageItems,
  feedNewerSinceId,
  feedPendingNewerItems,
  mergePendingNewerItems,
  messageOrderCursor,
  messageOrderTimestamp,
  prependWindowedMessageItems,
  safePendingNewerPrefix,
  shouldBufferNewerMessages,
} from './utils';
import type { MessageCursor, MessageFeedState, MessageItem } from './utils';
import type { TailAvailability } from './types';
import type { ExplicitFeedNavigation } from './useRerDutyNavigation';
import { beginDutyScrollDebugActivity, recordDutyScrollDebugEvent } from './duty-scroll-debug';
import { commitFeedWindowUpdate, commitFeedWindowUpdateUrgent } from './feedWindowCommit';
import {
  DUTY_FEED_PAGINATION_REQUEST_DEADLINE_MS,
  withDutyFeedRequestDeadline,
} from './dutyFeedRequestDeadline';

type NewerLoadOptions = {
  nolimit?: boolean;
  scrollToEndAfterLoad?: boolean;
  markAllReadAfterAppend?: boolean;
  skipIfNewestExhausted?: boolean;
  showLoading?: boolean;
  followGeneration?: number;
  explicitNavigation?: boolean;
  explicitOperation?: ExplicitFeedNavigation | null;
  confirmedTailAvailable?: boolean;
};

export type NewerLoadResult = {
  ok: boolean;
  addedCount: number;
  target?: MessageCursor | null;
};

type DirectionalOperation = {
  direction: 'older' | 'newer';
  promise: Promise<void>;
  resolve: () => void;
  newerOptions: Required<NewerLoadOptions>;
  dispatchedNewerNolimit: boolean | null;
  committedNewerTailId: number | null;
  newerResult: NewerLoadResult;
  newerResultPromise?: Promise<NewerLoadResult>;
  commitExpected: boolean;
  phase: 'running' | 'awaitingCommit';
  run: () => Promise<void>;
  tailAvailabilityBefore: TailAvailability;
};

function reconcileWindowedUnreadIds(
  feed: MessageFeedState,
  windowed: { items: MessageItem[]; addedItems: MessageItem[]; removedItems: MessageItem[] },
  addedItemsAreRead: boolean,
): Map<number, number> {
  const windowedUnreadItems = new Map(feed.windowedUnreadItems);
  windowed.removedItems.forEach(([id, message]) => {
    if (!feed.readIds.has(id)) {
      windowedUnreadItems.set(id, messageOrderTimestamp(message) ?? 0);
    }
  });
  windowed.items.forEach(([id]) => windowedUnreadItems.delete(id));
  if (addedItemsAreRead) {
    windowed.addedItems.forEach(([id]) => windowedUnreadItems.delete(id));
  }
  return windowedUnreadItems;
}

type DirectionalLane = {
  active: DirectionalOperation | null;
  queued: DirectionalOperation[];
};

type Params = {
  disableAutoScroll: boolean;
  messageFeeds: MessageFeedState[];
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  reportPollingFailure: (scope: string, error: unknown) => void;
  clearPollingFailure: (scope: string) => void;
  loadingNewerFeedIds: Set<string>;
  setLoadingNewerFeedIds: Dispatch<SetStateAction<Set<string>>>;
  buildReqForFeed: (
    feed: MessageFeedState,
    options: {
      beforeIdNoninclusive?: number;
      sinceIdNoninclusive?: number;
      nolimit?: boolean;
    },
  ) => InboxMessagesReq;
  getFeedLoadGeneration: (feedId: string) => number;
  mergeInboxCallsigns: (feedId: string, callsigns: CallsignInfoRes[] | null | undefined) => void;
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  getFeedCountSignature: (feed: MessageFeedState) => string;
  advanceFeedReadCursor: (
    feedId: string,
    cursor: MessageCursor,
    remainingUnreadCount: number,
    requestSignature: string,
  ) => void;
  newestExhaustedCursorByFeedIdRef: MutableRefObject<Record<string, number>>;
  pendingScrollToEndRef: MutableRefObject<Record<string, { generation: number }>>;
  nearBottomByFeedIdRef: MutableRefObject<Record<string, boolean>>;
  physicallyAtBottomByFeedIdRef: MutableRefObject<Record<string, boolean>>;
  followTailByFeedIdRef: MutableRefObject<Record<string, boolean>>;
  followGenerationByFeedIdRef: MutableRefObject<Record<string, number>>;
  isFollowTailValid: (feedId: string, generation: number) => boolean;
  isExplicitNavigationLoading: (feedId: string) => boolean;
  setTailAvailability: (feedId: string, availability: TailAvailability) => void;
  getTailAvailability: (feedId: string) => TailAvailability;
  invalidateTailPreview: (feedId: string) => void;
  noteNewerAppendForTailPreview: (
    feedId: string,
    previousTailId: number,
    newTailId: number | null,
    addedCount: number,
    options?: { keepLoadedTail?: boolean },
  ) => void;
};

function createOperation(
  direction: 'older' | 'newer',
  options?: NewerLoadOptions,
): DirectionalOperation {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      settle();
    };
  });
  return {
    direction,
    promise,
    resolve,
    newerOptions: {
      nolimit: options?.nolimit ?? false,
      scrollToEndAfterLoad: options?.scrollToEndAfterLoad ?? false,
      markAllReadAfterAppend: options?.markAllReadAfterAppend ?? false,
      skipIfNewestExhausted: options?.skipIfNewestExhausted ?? false,
      showLoading: options?.showLoading ?? true,
      followGeneration: options?.followGeneration ?? -1,
      explicitNavigation: options?.explicitNavigation ?? false,
      explicitOperation: options?.explicitOperation ?? null,
      confirmedTailAvailable: options?.confirmedTailAvailable ?? false,
    },
    dispatchedNewerNolimit: null,
    committedNewerTailId: null,
    commitExpected: false,
    // Default false until a successful run path sets otherwise (invalidate must not look like success).
    newerResult: { ok: false, addedCount: 0 },
    phase: 'running',
    run: async () => {},
    tailAvailabilityBefore: 'unknown',
  };
}

export function useRerDutyDirectionalLoads(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const lanesRef = useRef<Record<string, DirectionalLane>>({});
  const invalidatedLoadingFeedIdsRef = useRef<Set<string>>(new Set());
  const startOperationRef = useRef<(feedId: string) => void>(() => {});

  const getLane = useCallback((feedId: string): DirectionalLane => {
    return (lanesRef.current[feedId] ??= { active: null, queued: [] });
  }, []);

  useLayoutEffect(() => {
    params.messageFeedsRef.current = params.messageFeeds;
    Object.entries(lanesRef.current).forEach(([feedId, lane]) => {
      const active = lane.active;
      const committedNewerTailId = active?.committedNewerTailId ?? null;
      const newerCommitVisible =
        committedNewerTailId === null ||
        params.messageFeeds.some(
          (feed) => feed.id === feedId && feedNewerSinceId(feed) === committedNewerTailId,
        );
      if (active?.phase === 'awaitingCommit' && newerCommitVisible) {
        active.resolve();
        lane.active = null;
      }
      startOperationRef.current(feedId);
    });
    if (invalidatedLoadingFeedIdsRef.current.size > 0) {
      const invalidatedFeedIds = invalidatedLoadingFeedIdsRef.current;
      invalidatedLoadingFeedIdsRef.current = new Set();
      params.setLoadingNewerFeedIds((previous) => {
        const next = new Set(previous);
        invalidatedFeedIds.forEach((feedId) => {
          if (lanesRef.current[feedId]?.active?.direction !== 'newer') next.delete(feedId);
        });
        return next.size === previous.size ? previous : next;
      });
    }
  }, [params.loadingNewerFeedIds, params.messageFeeds, params.messageFeedsRef]);

  const loadFeedOlderMessages = useCallback(
    (feedId: string) => {
      const currentParams = paramsRef.current;
      const feed = currentParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (!feed || feed.items.length === 0 || feed.hasReachedStart) return Promise.resolve();
      const lane = getLane(feedId);
      if (lane.active?.direction === 'older') return lane.active.promise;
      const queuedOlder = lane.queued.find((operation) => operation.direction === 'older');
      if (queuedOlder) return queuedOlder.promise;
      const operation = createOperation('older');
      operation.run = async () => {
        const runParams = paramsRef.current;
        const currentFeed = runParams.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        if (!currentFeed || currentFeed.items.length === 0 || currentFeed.hasReachedStart) {
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        const requestGeneration = runParams.getFeedLoadGeneration(feedId);
        const beforeIdNoninclusive = currentFeed.items[0][0];
        runParams.setMessageFeeds((previous) =>
          previous.map((feed) => (feed.id === feedId ? { ...feed, loadingOlder: true } : feed)),
        );
        runParams.setError(null);
        const finishDebugActivity = beginDutyScrollDebugActivity(
          feedId,
          'olderMessages',
          `before=${beforeIdNoninclusive}; generation=${requestGeneration}`,
        );
        try {
          const response = await withDutyFeedRequestDeadline(
            DUTY_FEED_PAGINATION_REQUEST_DEADLINE_MS,
            (signal) =>
              fetchInboxMessages(runParams.buildReqForFeed(currentFeed, { beforeIdNoninclusive }), {
                signal,
              }),
          );
          finishDebugActivity(`ok; received=${response.inboxItems.length}`);
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const accepted = Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items[0]?.[0] === beforeIdNoninclusive,
          );
          if (accepted && latestFeed) {
            runParams.mergeInboxCallsigns(feedId, response.callsigns);
            if (response.signalProfiles) {
              runParams.setProfiles((previous) => ({ ...previous, ...response.signalProfiles }));
            }
            if (response.signalGroups?.length) {
              const groups: Record<string, SignalGroupEntry> = {};
              response.signalGroups.forEach((group) => {
                groups[group.masterKey] = group;
              });
              runParams.setGroupInfos((previous) => ({ ...previous, ...groups }));
            }
          }
          if (accepted && latestFeed) {
            const acceptedWindow = prependWindowedMessageItems(
              latestFeed.items,
              response.inboxItems,
            );
            // The operation was accepted against `latestFeed`; decide follow-up
            // invalidation from that same snapshot rather than mutating outer state
            // from React's deferred updater.
            const droppedNewerEnd = acceptedWindow.removedItems.some(([id]) =>
              latestFeed.items.some(([existingId]) => existingId === id),
            );
            commitFeedWindowUpdate(runParams.setMessageFeeds, (previous) =>
              previous.map((feed) => {
                if (feed.id !== feedId) return feed;
                const windowed = prependWindowedMessageItems(feed.items, response.inboxItems);
                // Prepending can evict the newer end of the bounded window. A pending
                // tail then no longer connects to that window; discard it so the next
                // newer request starts at the retained tail and refills sequentially.
                const droppedNewerEnd = windowed.removedItems.some(([id]) =>
                  feed.items.some(([existingId]) => existingId === id),
                );
                const evictedNewerTailId = droppedNewerEnd
                  ? (feed.evictedNewerTailId ?? feedNewerSinceId(feed))
                  : feed.evictedNewerTailId;
                return {
                  ...feed,
                  items: windowed.items,
                  evictedNewerTailId,
                  readIds: new Set<number>([
                    ...feed.readIds,
                    ...windowed.addedItems.map(([id]) => id),
                  ]),
                  windowedUnreadItems: reconcileWindowedUnreadIds(feed, windowed, true),
                  loadingOlder: false,
                  hasReachedStart: windowed.addedItems.length === 0,
                  pendingNewerItems: droppedNewerEnd ? [] : feed.pendingNewerItems,
                };
              }),
            );
            if (droppedNewerEnd) {
              delete runParams.newestExhaustedCursorByFeedIdRef.current[feedId];
              runParams.invalidateTailPreview(feedId);
              runParams.setTailAvailability(feedId, 'unknown');
            }
          }
        } catch (error) {
          finishDebugActivity(`error; ${error instanceof Error ? error.message : String(error)}`);
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const stillCurrent = Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items[0]?.[0] === beforeIdNoninclusive,
          );
          if (stillCurrent) {
            runParams.setError(error instanceof Error ? error.message : String(error));
            runParams.setMessageFeeds((previous) =>
              previous.map((feed) =>
                feed.id === feedId ? { ...feed, loadingOlder: false } : feed,
              ),
            );
          }
        }
        operation.phase = 'awaitingCommit';
        operation.resolve();
      };
      if (lane.active) lane.queued.push(operation);
      else {
        lane.active = operation;
        void operation.run();
      }
      return operation.promise;
    },
    [getLane],
  );

  const loadFeedNewerMessages = useCallback(
    (feedId: string, options?: NewerLoadOptions) => {
      const currentParams = paramsRef.current;
      const lane = getLane(feedId);
      const activeNewer = lane.active?.direction === 'newer' ? lane.active : null;
      const queuedNewer = lane.queued.find((operation) => operation.direction === 'newer');
      const requiresDedicatedNolimit =
        options?.nolimit === true && activeNewer?.dispatchedNewerNolimit === false;
      const existing =
        activeNewer?.phase === 'running' && !requiresDedicatedNolimit ? activeNewer : queuedNewer;
      if (existing) {
        existing.newerOptions.nolimit ||= options?.nolimit === true;
        existing.newerOptions.scrollToEndAfterLoad ||= options?.scrollToEndAfterLoad === true;
        existing.newerOptions.explicitNavigation ||= options?.explicitNavigation === true;
        if (options?.followGeneration != null) {
          existing.newerOptions.followGeneration = options.followGeneration;
        }
        const gainedConfirmedTail =
          options?.confirmedTailAvailable === true && !existing.newerOptions.confirmedTailAvailable;
        existing.newerOptions.confirmedTailAvailable ||= options?.confirmedTailAvailable === true;
        if (gainedConfirmedTail && !existing.newerOptions.showLoading) {
          currentParams.setTailAvailability(feedId, 'loading');
        }
        existing.newerOptions.markAllReadAfterAppend ||= options?.markAllReadAfterAppend === true;
        if (options?.skipIfNewestExhausted !== true) {
          existing.newerOptions.skipIfNewestExhausted = false;
        }
        if (options?.showLoading === true && !existing.newerOptions.showLoading) {
          existing.newerOptions.showLoading = true;
        }
        // Always surface in-flight newer get-inbox on the FAB (badge may already show pending).
        currentParams.setLoadingNewerFeedIds((previous) => new Set(previous).add(feedId));
        return (
          existing.newerResultPromise ??
          (existing.newerResultPromise = existing.promise.then(() => existing.newerResult))
        );
      }
      const feed = currentParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (!feed || feed.items.length === 0) return Promise.resolve({ ok: true, addedCount: 0 });
      const operation = createOperation('newer', options);
      operation.newerResultPromise = operation.promise.then(() => operation.newerResult);
      operation.run = async () => {
        const runParams = paramsRef.current;
        const currentFeed = runParams.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        if (!currentFeed || currentFeed.items.length === 0) {
          operation.newerResult = { ok: true, addedCount: 0 };
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        const requestGeneration = runParams.getFeedLoadGeneration(feedId);
        const loadedTailId = currentFeed.items.at(-1)![0];
        const requestedSinceId = feedNewerSinceId(currentFeed) ?? loadedTailId;
        const requestSignature = runParams.getFeedCountSignature(currentFeed);
        const isStillCurrent = () => {
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          return Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items.at(-1)?.[0] === loadedTailId &&
            runParams.getFeedCountSignature(latestFeed) === requestSignature,
          );
        };
        if (
          operation.newerOptions.skipIfNewestExhausted &&
          runParams.newestExhaustedCursorByFeedIdRef.current[feedId] === requestedSinceId
        ) {
          operation.newerResult = { ok: true, addedCount: 0 };
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        runParams.setLoadingNewerFeedIds((previous) => new Set(previous).add(feedId));
        operation.tailAvailabilityBefore = runParams.getTailAvailability(feedId);
        if (operation.newerOptions.confirmedTailAvailable) {
          runParams.setTailAvailability(feedId, 'loading');
        }
        const requestNolimit = operation.newerOptions.nolimit;
        operation.dispatchedNewerNolimit = requestNolimit;
        const finishDebugActivity = beginDutyScrollDebugActivity(
          feedId,
          'newerMessages',
          `since=${requestedSinceId}; loadedTail=${loadedTailId}; generation=${requestGeneration}; followRequested=${operation.newerOptions.scrollToEndAfterLoad}; followGeneration=${operation.newerOptions.followGeneration}; confirmed=${operation.newerOptions.confirmedTailAvailable}`,
        );
        try {
          const response = await withDutyFeedRequestDeadline(
            DUTY_FEED_PAGINATION_REQUEST_DEADLINE_MS,
            (signal) =>
              fetchInboxMessages(
                runParams.buildReqForFeed(currentFeed, {
                  sinceIdNoninclusive: requestedSinceId,
                  nolimit: requestNolimit || undefined,
                }),
                { signal },
              ),
          );
          finishDebugActivity(`ok; received=${response.inboxItems.length}`);
          const capturedFollowGeneration = operation.newerOptions.followGeneration;
          const followStillValid = runParams.isFollowTailValid(feedId, capturedFollowGeneration);
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const accepted = isStillCurrent();
          if (accepted) {
            runParams.mergeInboxCallsigns(feedId, response.callsigns);
            if (response.signalProfiles) {
              runParams.setProfiles((previous) => ({ ...previous, ...response.signalProfiles }));
            }
            if (response.signalGroups?.length) {
              const groups: Record<string, SignalGroupEntry> = {};
              response.signalGroups.forEach((group) => {
                groups[group.masterKey] = group;
              });
              runParams.setGroupInfos((previous) => ({ ...previous, ...groups }));
            }
          }
          if (!accepted || !latestFeed) {
            operation.newerResult = { ok: false, addedCount: 0 };
            return;
          }
          runParams.clearPollingFailure(`${feedId}:newer`);
          const previousTailId = loadedTailId;
          const pendingBefore = feedPendingNewerItems(latestFeed);
          const navigationStillValid = runParams.isFollowTailValid(
            feedId,
            capturedFollowGeneration,
          );
          const followTail =
            operation.newerOptions.scrollToEndAfterLoad &&
            navigationStillValid &&
            (operation.newerOptions.explicitNavigation || !paramsRef.current.disableAutoScroll);
          const landingGeneration = capturedFollowGeneration;
          const markAllRead =
            (followTail && navigationStillValid && !operation.newerOptions.explicitNavigation) ||
            operation.newerOptions.markAllReadAfterAppend;
          // With automatic scrolling disabled, never accept a background page straight
          // into a bounded window: a response can arrive after the reader moved and trim
          // their anchor. ON keeps the established physical-edge fast path.
          const backgroundWindow = appendWindowedMessageItems(latestFeed.items, [
            ...pendingBefore,
            ...response.inboxItems,
          ]);
          const wouldTrimLoadedItems = backgroundWindow.removedItems.some(([id]) =>
            latestFeed.items.some(([loadedId]) => loadedId === id),
          );
          const bufferNewer =
            shouldBufferNewerMessages({
              nearBottom: runParams.nearBottomByFeedIdRef.current[feedId] === true,
              physicallyAtBottom: runParams.physicallyAtBottomByFeedIdRef.current[feedId] === true,
              followTail,
              markAllRead,
            }) ||
            (!followTail &&
              !markAllRead &&
              (paramsRef.current.disableAutoScroll || wouldTrimLoadedItems));
          const nextPending = bufferNewer
            ? mergePendingNewerItems(latestFeed, response.inboxItems)
            : pendingBefore;
          const liveAppendPreview = bufferNewer ? null : backgroundWindow;
          const addedCount = bufferNewer
            ? Math.max(0, nextPending.length - pendingBefore.length)
            : (liveAppendPreview?.addedItems.length ?? 0);
          const newestItem = bufferNewer
            ? (nextPending.at(-1) ?? null)
            : (liveAppendPreview?.items.at(-1) ?? null);
          const responseIncludesEvictedNewerTail =
            latestFeed.evictedNewerTailId != null &&
            response.inboxItems.some(([id]) => id === latestFeed.evictedNewerTailId);
          const resolvesEvictedNewerTail =
            latestFeed.evictedNewerTailId != null &&
            (response.inboxItems.length === 0 ||
              (requestNolimit && !responseIncludesEvictedNewerTail));
          operation.newerResult = {
            ok: true,
            addedCount,
            ...(operation.newerOptions.explicitNavigation && response.inboxItems.at(-1)
              ? {
                  target: messageOrderCursor(
                    response.inboxItems.at(-1)![0],
                    response.inboxItems.at(-1)![1],
                  ),
                }
              : {}),
          };
          recordDutyScrollDebugEvent(
            feedId,
            'newer:decision',
            `accepted=${accepted}; added=${addedCount}; buffer=${bufferNewer}; followValid=${followStillValid}; follow=${followTail}; markRead=${markAllRead}; near=${runParams.nearBottomByFeedIdRef.current[feedId] === true}; physical=${runParams.physicallyAtBottomByFeedIdRef.current[feedId] === true}`,
          );
          if (markAllRead && newestItem != null) {
            runParams.advanceFeedReadCursor(
              feedId,
              messageOrderCursor(newestItem[0], newestItem[1]),
              0,
              runParams.getFeedCountSignature(latestFeed!),
            );
          }
          if (addedCount > 0) {
            delete runParams.newestExhaustedCursorByFeedIdRef.current[feedId];
            runParams.setTailAvailability(feedId, 'unknown');
            if (bufferNewer) {
              runParams.noteNewerAppendForTailPreview(
                feedId,
                previousTailId,
                newestItem?.[0] ?? null,
                addedCount,
                { keepLoadedTail: true },
              );
            } else {
              runParams.noteNewerAppendForTailPreview(
                feedId,
                previousTailId,
                newestItem?.[0] ?? null,
                addedCount,
              );
            }
          } else {
            runParams.newestExhaustedCursorByFeedIdRef.current[feedId] = requestedSinceId;
            runParams.setTailAvailability(feedId, 'exhausted');
            runParams.invalidateTailPreview(feedId);
            // Messages API is authoritative: nothing newer than the loaded/pending tail.
            // Recompute local unread from the latest committed feed state so a concurrent
            // at-bottom mark-read cannot be overwritten with a stale residual stock.
            operation.commitExpected = true;
            let localUnread = 0;
            runParams.setMessageFeeds((previous) =>
              previous.map((feed) => {
                if (feed.id !== feedId) return feed;
                const localUnreadIds = new Set([
                  ...feed.items.map(([id]) => id),
                  ...(feed.windowedUnreadItems?.keys() ?? []),
                  ...feedPendingNewerItems(feed).map(([id]) => id),
                  ...(feed.unresolvedUnreadIds ?? []),
                ]);
                feed.readIds.forEach((id) => localUnreadIds.delete(id));
                const nextLocal = localUnreadIds.size + (feed.unresolvedUnreadCount ?? 0);
                localUnread = nextLocal;
                const evictedNewerTailId =
                  resolvesEvictedNewerTail &&
                  feed.evictedNewerTailId === latestFeed.evictedNewerTailId
                    ? null
                    : feed.evictedNewerTailId;
                return nextLocal === feed.unreadCount &&
                  evictedNewerTailId === feed.evictedNewerTailId
                  ? feed
                  : { ...feed, unreadCount: nextLocal, evictedNewerTailId };
              }),
            );
            const tailItem = latestFeed.items.at(-1);
            if (tailItem != null) {
              runParams.advanceFeedReadCursor(
                feedId,
                messageOrderCursor(tailItem[0], tailItem[1]),
                localUnread,
                runParams.getFeedCountSignature(latestFeed),
              );
            }
            recordDutyScrollDebugEvent(
              feedId,
              'newer:exhausted',
              `localUnread=${localUnread}; since=${requestedSinceId}`,
            );
          }
          if (
            followTail &&
            !operation.newerOptions.explicitNavigation &&
            runParams.isFollowTailValid(feedId, landingGeneration)
          ) {
            runParams.pendingScrollToEndRef.current[feedId] = {
              generation: landingGeneration,
            };
            runParams.nearBottomByFeedIdRef.current = {
              ...runParams.nearBottomByFeedIdRef.current,
              [feedId]: true,
            };
          }
          if (addedCount > 0 || markAllRead || followTail) {
            operation.commitExpected = true;
            if (addedCount > 0) operation.committedNewerTailId = newestItem?.[0] ?? null;
            if (bufferNewer) {
              // Off-DOM buffer: keep `items` identity stable (no MessageCard remount).
              runParams.setMessageFeeds((previous) => {
                const next = previous.map((feed) => {
                  if (feed.id !== feedId) return feed;
                  const pendingNewerItems = mergePendingNewerItems(feed, response.inboxItems);
                  const evictedNewerTailId =
                    resolvesEvictedNewerTail &&
                    feed.evictedNewerTailId === latestFeed.evictedNewerTailId
                      ? null
                      : feed.evictedNewerTailId;
                  if (
                    pendingNewerItems.length === (feed.pendingNewerItems?.length ?? 0) &&
                    evictedNewerTailId === feed.evictedNewerTailId
                  ) {
                    return feed;
                  }
                  const pendingUnreadCount = pendingNewerItems.filter(
                    ([id]) => !feed.readIds.has(id),
                  ).length;
                  const loadedUnreadCount = feed.items.filter(
                    ([id]) => !feed.readIds.has(id),
                  ).length;
                  const localUnreadCount =
                    loadedUnreadCount + (feed.windowedUnreadItems?.size ?? 0) + pendingUnreadCount;
                  return {
                    ...feed,
                    evictedNewerTailId,
                    pendingNewerItems,
                    unreadCount: Math.max(feed.unreadCount, localUnreadCount),
                  };
                });
                // Poll catch-up awaits this promise before React paint; publish pending
                // immediately so the next sinceId / runway sees the buffer.
                runParams.messageFeedsRef.current = next;
                return next;
              });
            } else {
              // Live window commit: publish urgently + sync the ref so the next sinceId
              // is not stuck on the pre-append tail while startTransition is deferred.
              const physicallyAtBottom =
                runParams.physicallyAtBottomByFeedIdRef.current[feedId] === true;
              const commit =
                physicallyAtBottom || followTail || markAllRead
                  ? commitFeedWindowUpdateUrgent
                  : commitFeedWindowUpdate;
              commit(runParams.setMessageFeeds, (previous) => {
                const next = previous.map((feed) => {
                  if (feed.id !== feedId) return feed;
                  const appendFeed =
                    resolvesEvictedNewerTail &&
                    feed.evictedNewerTailId === latestFeed.evictedNewerTailId
                      ? { ...feed, evictedNewerTailId: null }
                      : feed;
                  return appendNewerItemsToFeed(
                    appendFeed,
                    [...feedPendingNewerItems(appendFeed), ...response.inboxItems],
                    { markAllRead },
                  );
                });
                runParams.messageFeedsRef.current = next;
                return next;
              });
            }
          }
        } catch (error) {
          finishDebugActivity(`error; ${error instanceof Error ? error.message : String(error)}`);
          operation.newerResult = { ok: false, addedCount: 0 };
          // Keep polling and the previously loaded messages after a transient failure.
          if (!isStillCurrent()) return;
          runParams.reportPollingFailure(`${feedId}:newer`, error);
          if (operation.newerOptions.confirmedTailAvailable) {
            runParams.setTailAvailability(feedId, 'available');
          }
        } finally {
          if (lanesRef.current[feedId]?.active === operation) {
            runParams.setLoadingNewerFeedIds((previous) => {
              if (!previous.has(feedId) || runParams.isExplicitNavigationLoading(feedId))
                return previous;
              const next = new Set(previous);
              next.delete(feedId);
              return next;
            });
          }
          if (!operation.commitExpected && lanesRef.current[feedId]?.active === operation) {
            lanesRef.current[feedId].active = null;
            startOperationRef.current(feedId);
          } else {
            operation.phase = 'awaitingCommit';
          }
          operation.resolve();
        }
      };
      if (lane.active) lane.queued.push(operation);
      else {
        lane.active = operation;
        void operation.run();
      }
      return operation.newerResultPromise!;
    },
    [getLane],
  );

  startOperationRef.current = (feedId: string) => {
    const lane = lanesRef.current[feedId];
    if (!lane || lane.active) return;
    const operation = lane.queued.shift();
    if (!operation) return;
    lane.active = operation;
    operation.phase = 'running';
    void operation.run();
  };

  const invalidateFeedLoads = useCallback((feedId: string) => {
    const lane = lanesRef.current[feedId];
    lane?.queued.forEach((operation) => operation.resolve());
    lane?.active?.resolve();
    delete lanesRef.current[feedId];
    invalidatedLoadingFeedIdsRef.current.add(feedId);
  }, []);

  const removeFeedLoads = useCallback(
    (feedId: string) => {
      invalidateFeedLoads(feedId);
    },
    [invalidateFeedLoads],
  );

  const flushPendingNewerMessages = useCallback(
    (
      feedId: string,
      options?: {
        markAllRead?: boolean;
        urgent?: boolean;
        allowWindowTrim?: boolean;
        protectedItemIds?: readonly number[];
      },
    ) => {
      const feed = paramsRef.current.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (!feed) return;
      const pending = feedPendingNewerItems(feed);
      if (pending.length === 0 && options?.markAllRead !== true) return;
      const protectedItemIds = options?.protectedItemIds ?? [];
      const incoming =
        options?.allowWindowTrim === true && protectedItemIds.length === 0
          ? pending
          : safePendingNewerPrefix(feed.items, pending, protectedItemIds);
      if (incoming.length === 0 && options?.markAllRead !== true) return;
      const previousTailId = feed.items.at(-1)?.[0] ?? null;
      const newTailId = incoming.at(-1)?.[0] ?? null;
      const pendingCount = incoming.length;
      const commit =
        options?.urgent === true ? commitFeedWindowUpdateUrgent : commitFeedWindowUpdate;
      commit(paramsRef.current.setMessageFeeds, (previous) => {
        const next = previous.map((candidate) => {
          if (candidate.id !== feedId) return candidate;
          const flushed = appendNewerItemsToFeed(candidate, incoming, {
            markAllRead: options?.markAllRead,
          });
          const remainingPending = feedPendingNewerItems(candidate).slice(incoming.length);
          return { ...flushed, pendingNewerItems: remainingPending };
        });
        // Keep sinceId / poll catch-up in sync when flushing urgently at the live edge.
        paramsRef.current.messageFeedsRef.current = next;
        return next;
      });
      if (previousTailId != null && pendingCount > 0) {
        paramsRef.current.noteNewerAppendForTailPreview(
          feedId,
          previousTailId,
          newTailId,
          pendingCount,
        );
      }
      recordDutyScrollDebugEvent(
        feedId,
        'newer:flushPending',
        `pending=${pendingCount}; markRead=${options?.markAllRead === true}; urgent=${options?.urgent === true}`,
      );
    },
    [],
  );

  return {
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    invalidateFeedLoads,
    removeFeedLoads,
  };
}
