import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { isNullOrUndefined, isPresent } from '../../utils/misc';

import type { SignalGroupEntry, SignalProfileEntry } from '../../../../Bindings';
import {
  fetchInboxCount,
  fetchInboxMessages,
  rerDutyShortStateCreate,
  rerDutyShortStateGet,
} from '../../services/api/inbox';
import type { FeedColumnHandle } from './FeedColumn';
import {
  appendWindowedMessageItems,
  buildInboxReq,
  emptyFilter,
  findAllAdjacentFreqs,
  getShortStateIdFromUrl,
  parseStateFromUrl,
  prependWindowedMessageItems,
  pushShortStateToUrl,
  pushStateToUrl,
  stableStringify,
  toRerDutyStateFromShort,
  toShortQueryState,
  windowInitialMessageItems,
} from './utils';
import type { MessageFeedState } from './utils';
import { useRerDutyFeedCrud } from './useRerDutyFeedCrud';
import { notifyDutyNewMessages } from './notifications';
import { useRerDutyCallsignInfo } from './useRerDutyCallsignInfo';
import { useRerDutyReferenceData } from './useRerDutyReferenceData';
import { currentSystemSettings } from '../../services/api/system-settings';

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
};

function buildFeedCountSignature(feed: MessageFeedState, freqs: string[]): string {
  return JSON.stringify({
    filter: {
      groupsSelected: feed.filter.groupsSelected ?? null,
      deniedGroups: feed.filter.groupsDenied ?? null,
      sendersSelected: feed.filter.sendersSelected ?? null,
      deniedSenders: feed.filter.deniedSenders ?? null,
      freqsSelected: feed.filter.freqsSelected ?? null,
      freqsDenied: feed.filter.freqsDenied ?? null,
      postsSelected: feed.filter.postsSelected ?? null,
      postsDenied: feed.filter.postsDenied ?? null,
      unitsSelected: feed.filter.unitsSelected ?? null,
      unitsDenied: feed.filter.unitsDenied ?? null,
      unitsExactMatchOnly: feed.filter.unitsExactMatchOnly ?? null,
    },
    freqUniverse: feed.adjacentFreqsRange > 0 ? freqs : null,
    adjacentFreqsRange: feed.adjacentFreqsRange ?? 0,
    highlightSignalsEnabled: feed.highlightSignalsEnabled ?? false,
    onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled ?? false,
  });
}

export function useRerDutyFeedState(deps: FeedStateDeps) {
  const { freqs, setProfiles, setGroupInfos } = deps;
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(() => {
    const state = parseStateFromUrl();
    return (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) => ({
      id,
      filter,
      items: [],
      loading: true,
      loadingOlder: false,
      hasReachedStart: false,
      referenceTimeMs: null,
      readIds: new Set<number>(),
      unreadCount: 0,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    }));
  });
  const [error, setError] = useState<string | null>(null);
  const [featureShortStateEnabled, setFeatureShortStateEnabled] = useState(false);
  const [shortStateReady, setShortStateReady] = useState(false);
  const messageFeedsRef = useRef(messageFeeds);
  const loadNewerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadNewerInFlightRef = useRef<Set<string>>(new Set());
  const countInFlightByFeedIdRef = useRef<Set<string>>(new Set());
  const [watchModeByFeedId, setWatchModeByFeedId] = useState<Record<string, boolean>>({});
  const [loadingNewerFeedIds, setLoadingNewerFeedIds] = useState<Set<string>>(new Set());
  const [arrowResultByFeedId, setArrowResultByFeedId] = useState<Record<string, string | null>>({});
  const columnRefsRef = useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const loadGenerationByFeedIdRef = useRef<Record<string, number>>({});
  const pendingReloadFeedIdsRef = useRef<Set<string>>(new Set());
  const scrollToEndAfterNewerRef = useRef<Set<string>>(new Set());
  const nearBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const unreadCursorByFeedIdRef = useRef<Record<string, number | null>>({});
  const newestExhaustedCursorByFeedIdRef = useRef<Record<string, number>>({});
  const lastServerCountByFeedIdRef = useRef<Record<string, ServerCountBaseline>>({});
  /** Pixel-level at-bottom state; used so poll only auto-scrolls when the scroller is actually at the bottom. */
  const atBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const shortStateRef = useRef<{ id: string | null; hash: string | null }>({
    id: null,
    hash: null,
  });
  const shortStateRequestRef = useRef<{ requestId: number; hash: string | null }>({
    requestId: 0,
    hash: null,
  });
  const shortStateMountedRef = useRef(true);
  const shortStateIdRef = useRef(getShortStateIdFromUrl());
  const initialMessageFeedsHashRef = useRef<string>(
    stableStringify(toShortQueryState(messageFeeds)),
  );
  const blockShortStateHydrationRef = useRef(false);

  useEffect(() => {
    messageFeedsRef.current = messageFeeds;
  }, [messageFeeds]);

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

  const markFeedReloadRequested = useCallback((feedId: string) => {
    loadGenerationByFeedIdRef.current = {
      ...loadGenerationByFeedIdRef.current,
      [feedId]: (loadGenerationByFeedIdRef.current[feedId] ?? 0) + 1,
    };
    delete unreadCursorByFeedIdRef.current[feedId];
    delete lastServerCountByFeedIdRef.current[feedId];
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
    pendingReloadFeedIdsRef.current = new Set([...pendingReloadFeedIdsRef.current, feedId]);
  }, []);
  const clearFeedUnreadBaselines = useCallback((feedId: string) => {
    delete unreadCursorByFeedIdRef.current[feedId];
    delete lastServerCountByFeedIdRef.current[feedId];
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
    pendingReloadFeedIdsRef.current = new Set(
      [...pendingReloadFeedIdsRef.current].filter((id) => id !== feedId),
    );
  }, []);
  const setFeedUnreadCursor = useCallback((feedId: string, cursorId: number | null) => {
    unreadCursorByFeedIdRef.current[feedId] = cursorId;
  }, []);
  const advanceFeedReadCursor = useCallback(
    (feedId: string, cursorId: number, remainingUnreadCount: number) => {
      unreadCursorByFeedIdRef.current[feedId] = cursorId;
      lastServerCountByFeedIdRef.current[feedId] = {
        cursorId,
        quantity: remainingUnreadCount,
      };
      delete newestExhaustedCursorByFeedIdRef.current[feedId];
    },
    [],
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
        reportTagsOnlyThisUnit: feed.onlyMyUnitTagsEnabled ? true : null,
      });
    },
    [freqs],
  );
  const requestValidatedInboxCount = useCallback(
    async (feedId: string) => {
      const feed = messageFeedsRef.current.find((x) => x.id === feedId);
      if (
        !feed ||
        feed.loading ||
        pendingReloadFeedIdsRef.current.has(feedId) ||
        loadNewerInFlightRef.current.has(feedId) ||
        countInFlightByFeedIdRef.current.has(feedId)
      ) {
        return null;
      }
      countInFlightByFeedIdRef.current.add(feedId);
      const requestGeneration = getFeedLoadGeneration(feedId);
      const cursorId = unreadCursorByFeedIdRef.current[feedId] ?? null;
      const requestSignature = buildFeedCountSignature(feed, freqs);
      try {
        const { quantity } = await fetchInboxCount(
          buildReqForFeed(feed, { sinceIdNoninclusive: cursorId, nolimit: true }),
        );
        const currentFeed = messageFeedsRef.current.find((x) => x.id === feedId);
        if (
          !currentFeed ||
          currentFeed.loading ||
          pendingReloadFeedIdsRef.current.has(feedId) ||
          getFeedLoadGeneration(feedId) !== requestGeneration ||
          (unreadCursorByFeedIdRef.current[feedId] ?? null) !== cursorId ||
          buildFeedCountSignature(currentFeed, freqs) !== requestSignature
        ) {
          return null;
        }
        return {
          feedId,
          quantity,
          cursorId,
          hasItems: feed.items.length > 0,
        };
      } finally {
        countInFlightByFeedIdRef.current.delete(feedId);
      }
    },
    [buildReqForFeed, freqs, getFeedLoadGeneration],
  );

  useEffect(() => {
    if (shortStateReady) return;
    const currentHash = stableStringify(toShortQueryState(messageFeeds));
    if (currentHash !== initialMessageFeedsHashRef.current) {
      blockShortStateHydrationRef.current = true;
    }
  }, [messageFeeds, shortStateReady]);

  useEffect(() => {
    let cancelled = false;
    const loadShortState = async () => {
      try {
        const systemSettings = await currentSystemSettings();
        if (cancelled) return;
        const enabled = systemSettings.rerShortUrlEnabled ?? false;
        setFeatureShortStateEnabled(enabled);
        const shortId = shortStateIdRef.current;
        if (enabled && shortId) {
          try {
            const rsp = await rerDutyShortStateGet(shortId);
            if (cancelled) return;
            if (blockShortStateHydrationRef.current) return;
            const currentHash = stableStringify(toShortQueryState(messageFeedsRef.current));
            if (currentHash !== initialMessageFeedsHashRef.current) return;
            const state = toRerDutyStateFromShort(rsp.state);
            shortStateRef.current = { id: shortId, hash: stableStringify(rsp.state) };
            setMessageFeeds(
              (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) => ({
                id,
                filter,
                items: [],
                loading: true,
                loadingOlder: false,
                hasReachedStart: false,
                referenceTimeMs: null,
                readIds: new Set<number>(),
                unreadCount: 0,
                adjacentFreqsRange: 0,
                highlightSignalsEnabled: false,
                onlyMyUnitTagsEnabled: false,
              })),
            );
          } catch (e) {
            if (!cancelled) {
              setError(e instanceof Error ? e.message : String(e));
            }
          }
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
        }
      } finally {
        if (!cancelled) setShortStateReady(true);
      }
    };
    loadShortState();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    shortStateMountedRef.current = true;
    return () => {
      shortStateMountedRef.current = false;
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  const loadFeedInitialMessages = useCallback(
    async (
      feedId: string,
      overrides?: { highlightSignalsEnabled?: boolean; onlyMyUnitTagsEnabled?: boolean },
    ) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      const requestLoadVersion = loadGenerationByFeedIdRef.current[feedId] ?? 0;
      const effectiveFeed = overrides ? { ...feed, ...overrides } : feed;
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loading: true } : x)));
      setError(null);
      try {
        const req = buildReqForFeed(effectiveFeed, { loadLatest: true });
        const rsp = await fetchInboxMessages(req);
        if ((loadGenerationByFeedIdRef.current[feedId] ?? 0) !== requestLoadVersion) return;
        mergeInboxCallsigns(feedId, rsp.callsigns, { replace: true });
        const items = windowInitialMessageItems(rsp.inboxItems);
        const initialReadIds = new Set<number>(items.map(([id]) => id));
        clearFeedUnreadBaselines(feedId);
        setFeedUnreadCursor(feedId, items.at(-1)?.[0] ?? null);
        setMessageFeeds((prev) =>
          prev.map((x) =>
            x.id === feedId
              ? {
                  ...x,
                  items,
                  loading: false,
                  referenceTimeMs: Date.now(),
                  readIds: initialReadIds,
                  unreadCount: 0,
                }
              : x,
          ),
        );
        if (rsp.signalProfiles) setProfiles((p) => ({ ...p, ...rsp.signalProfiles }));
        if (rsp.signalGroups?.length) {
          const map: Record<string, SignalGroupEntry> = {};
          rsp.signalGroups.forEach((g) => {
            map[g.masterKey] = g;
          });
          setGroupInfos((prev) => ({ ...prev, ...map }));
        }
      } catch (e) {
        if ((loadGenerationByFeedIdRef.current[feedId] ?? 0) !== requestLoadVersion) return;
        const currentFeed = messageFeedsRef.current.find((x) => x.id === feedId);
        const retainedCursorId = currentFeed?.items.at(-1)?.[0] ?? null;
        clearFeedUnreadBaselines(feedId);
        setFeedUnreadCursor(feedId, retainedCursorId);
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) => (x.id === feedId ? { ...x, loading: false } : x)),
        );
      }
    },
    [
      messageFeeds,
      buildReqForFeed,
      mergeInboxCallsigns,
      setProfiles,
      setGroupInfos,
      clearFeedUnreadBaselines,
      setFeedUnreadCursor,
    ],
  );

  const loadFeedOlderMessages = useCallback(
    async (feedId: string) => {
      const w = messageFeedsRef.current.find((x) => x.id === feedId);
      if (!w || w.items.length === 0 || w.hasReachedStart) return;
      const firstId = w.items[0][0];
      setMessageFeeds((prev) =>
        prev.map((x) => (x.id === feedId ? { ...x, loadingOlder: true } : x)),
      );
      setError(null);
      try {
        const req = buildReqForFeed(w, { beforeIdNoninclusive: firstId });
        const rsp = await fetchInboxMessages(req);
        mergeInboxCallsigns(feedId, rsp.callsigns);
        if (rsp.signalProfiles) setProfiles((p) => ({ ...p, ...rsp.signalProfiles }));
        if (rsp.signalGroups?.length) {
          const map: Record<string, SignalGroupEntry> = {};
          rsp.signalGroups.forEach((g) => {
            map[g.masterKey] = g;
          });
          setGroupInfos((prev) => ({ ...prev, ...map }));
        }
        setMessageFeeds((prev) =>
          prev.map((x) => {
            if (x.id !== feedId) return x;
            const windowed = prependWindowedMessageItems(x.items, rsp.inboxItems);
            const hasReachedStart = windowed.addedItems.length === 0;
            const readIdsWithOlder = new Set<number>([
              ...x.readIds,
              ...windowed.addedItems.map(([id]) => id),
            ]);
            return {
              ...x,
              items: windowed.items,
              readIds: readIdsWithOlder,
              loadingOlder: false,
              hasReachedStart,
            };
          }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) => (x.id === feedId ? { ...x, loadingOlder: false } : x)),
        );
      }
    },
    [buildReqForFeed, mergeInboxCallsigns],
  );

  const loadFeedNewerMessages = useCallback(
    async (
      feedId: string,
      opts?: {
        nolimit?: boolean;
        scrollToEndAfterLoad?: boolean;
        markAllReadAfterAppend?: boolean;
        skipIfNewestExhausted?: boolean;
      },
    ) => {
      if (loadNewerInFlightRef.current.has(feedId)) return;
      const feed = messageFeedsRef.current.find((x) => x.id === feedId);
      if (!feed || feed.items.length === 0) return;
      const requestLoadVersion = loadGenerationByFeedIdRef.current[feedId] ?? 0;
      const lastId = feed.items[feed.items.length - 1][0];
      if (
        opts?.skipIfNewestExhausted &&
        newestExhaustedCursorByFeedIdRef.current[feedId] === lastId
      ) {
        return;
      }
      loadNewerInFlightRef.current.add(feedId);
      setLoadingNewerFeedIds((prev) => {
        const next = new Set(prev);
        next.add(feedId);
        return next;
      });
      try {
        const req = buildReqForFeed(feed, {
          sinceIdNoninclusive: lastId,
          nolimit: opts?.nolimit ?? undefined,
        });
        const rsp = await fetchInboxMessages(req);
        if ((loadGenerationByFeedIdRef.current[feedId] ?? 0) !== requestLoadVersion) return;
        mergeInboxCallsigns(feedId, rsp.callsigns);
        if (rsp.signalProfiles) setProfiles((p) => ({ ...p, ...rsp.signalProfiles }));
        if (rsp.signalGroups?.length) {
          const map: Record<string, SignalGroupEntry> = {};
          rsp.signalGroups.forEach((g) => {
            map[g.masterKey] = g;
          });
          setGroupInfos((prev) => ({ ...prev, ...map }));
        }
        const latestFeed = messageFeedsRef.current.find((x) => x.id === feedId);
        if (!latestFeed) return;
        const latestWindowed = appendWindowedMessageItems(latestFeed.items, rsp.inboxItems);
        const addedCount = latestWindowed.addedItems.length;
        const newestCursor = latestWindowed.items.at(-1)?.[0] ?? null;
        const markAllRead =
          opts?.scrollToEndAfterLoad === true || opts?.markAllReadAfterAppend === true;
        if (markAllRead && newestCursor != null) {
          advanceFeedReadCursor(feedId, newestCursor, 0);
        }
        if (addedCount > 0) {
          delete newestExhaustedCursorByFeedIdRef.current[feedId];
        } else {
          newestExhaustedCursorByFeedIdRef.current[feedId] = lastId;
        }
        if (opts?.scrollToEndAfterLoad === true) {
          scrollToEndAfterNewerRef.current.add(feedId);
          nearBottomByFeedIdRef.current = {
            ...nearBottomByFeedIdRef.current,
            [feedId]: true,
          };
        }
        if (addedCount > 0 || markAllRead || opts?.scrollToEndAfterLoad === true) {
          setMessageFeeds((prev) =>
            prev.map((x) => {
              if (x.id !== feedId) return x;
              const windowed = appendWindowedMessageItems(x.items, rsp.inboxItems);
              if (windowed.addedItems.length === 0) {
                if (markAllRead) {
                  const readIds = new Set<number>([...x.readIds, ...x.items.map(([id]) => id)]);
                  return {
                    ...x,
                    readIds,
                    unreadCount: 0,
                  };
                }
                if (opts?.scrollToEndAfterLoad === true) return { ...x };
                return x;
              }
              const unreadAddedCount = windowed.addedItems.filter(
                ([id]) => !x.readIds.has(id),
              ).length;
              const readIds = markAllRead
                ? new Set<number>([...x.readIds, ...windowed.items.map(([id]) => id)])
                : x.readIds;
              const unreadCount = markAllRead ? 0 : Math.max(x.unreadCount, unreadAddedCount);
              return {
                ...x,
                items: windowed.items,
                readIds,
                unreadCount,
                hasReachedStart: windowed.removedItems.length > 0 ? false : x.hasReachedStart,
              };
            }),
          );
        }
      } catch {
        // ignore single failure to keep polling and prev messages
      } finally {
        loadNewerInFlightRef.current.delete(feedId);
        setLoadingNewerFeedIds((prev) => {
          if (!prev.has(feedId)) return prev;
          const next = new Set(prev);
          next.delete(feedId);
          return next;
        });
      }
    },
    [
      buildReqForFeed,
      setLoadingNewerFeedIds,
      setProfiles,
      setGroupInfos,
      mergeInboxCallsigns,
      advanceFeedReadCursor,
    ],
  );

  useEffect(() => {
    messageFeeds.forEach((feed) => {
      if (feed.loading || pendingReloadFeedIdsRef.current.has(feed.id)) return;
      const currentCursor = unreadCursorByFeedIdRef.current[feed.id] ?? null;
      let nextCursor = currentCursor;
      for (const [id] of feed.items) {
        if (currentCursor != null && id <= currentCursor) continue;
        if (!feed.readIds.has(id)) break;
        nextCursor = id;
      }
      if (nextCursor != null && nextCursor !== currentCursor) {
        advanceFeedReadCursor(feed.id, nextCursor, feed.unreadCount);
      }
    });
  }, [advanceFeedReadCursor, messageFeeds]);

  useEffect(() => {
    retainFeedIds(messageFeeds.map((feed) => feed.id));
  }, [messageFeeds, retainFeedIds]);

  const pollCountThenLoadNewerIfNeeded = useCallback(async () => {
    if (!messageFeedsRef.current.length) return;
    const nearBottom = nearBottomByFeedIdRef.current;
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
          if (isPresent(entry.cursorId))
            newestExhaustedCursorByFeedIdRef.current[feedId] = entry.cursorId;
          lastServerCountByFeedIdRef.current[feedId] = {
            cursorId: entry.cursorId,
            quantity: 0,
          };
          return;
        }
        delete newestExhaustedCursorByFeedIdRef.current[feedId];
        const prevServerCount = lastServerCountByFeedIdRef.current[feedId];
        const nextCount = entry.quantity;
        if (prevServerCount?.cursorId === entry.cursorId || (!prevServerCount && entry.hasItems)) {
          const prevQuantity = prevServerCount?.quantity ?? 0;
          const newCount = Math.max(0, nextCount - prevQuantity);
          if (newCount > 0) {
            notifyDutyNewMessages(feedId, newCount);
          }
        }
        lastServerCountByFeedIdRef.current[feedId] = {
          cursorId: entry.cursorId,
          quantity: nextCount,
        };
        const watchMode = watchModeByFeedId[feedId] ?? false;
        if (watchMode || nearBottom[feedId]) {
          const shouldFollowScroll =
            !deps.disableAutoScroll && watchMode && (atBottomByFeedIdRef.current[feedId] ?? false);
          await loadFeedNewerMessages(feedId, {
            scrollToEndAfterLoad: shouldFollowScroll,
            skipIfNewestExhausted: true,
          });
        }
      }),
    );
  }, [
    watchModeByFeedId,
    loadFeedNewerMessages,
    deps.disableAutoScroll,
    requestValidatedInboxCount,
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
    const feedIds = Array.from(scrollToEndAfterNewerRef.current);
    if (feedIds.length === 0) return;
    scrollToEndAfterNewerRef.current.clear();
    const refs = columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        feedIds.forEach((feedId) => {
          refs[feedId]?.scrollToEnd('auto');
        });
      });
    });
  }, [messageFeeds]);

  const persistStateToUrl = useCallback(
    (next: MessageFeedState[]) => {
      if (shortStateIdRef.current && !shortStateReady) {
        blockShortStateHydrationRef.current = true;
      }
      if (!featureShortStateEnabled) {
        pushStateToUrl({ messageFeeds: next.map((f) => [f.id, f.filter]) });
        return;
      }
      const queryState = toShortQueryState(next);
      const stateHash = stableStringify(queryState);
      const cached = shortStateRef.current;
      if (cached.id && cached.hash === stateHash) {
        const requestId = shortStateRequestRef.current.requestId + 1;
        shortStateRequestRef.current = { requestId, hash: stateHash };
        pushShortStateToUrl(cached.id);
        return;
      }
      pushStateToUrl({ messageFeeds: next.map((f) => [f.id, f.filter]) });
      const requestId = shortStateRequestRef.current.requestId + 1;
      shortStateRequestRef.current = { requestId, hash: stateHash };
      rerDutyShortStateCreate(queryState)
        .then((rsp) => {
          if (!shortStateMountedRef.current) return;
          if (shortStateRequestRef.current.requestId !== requestId) return;
          if (shortStateRequestRef.current.hash !== stateHash) return;
          shortStateRef.current = { id: rsp.id, hash: stateHash };
          pushShortStateToUrl(rsp.id);
        })
        .catch((e) => {
          if (!shortStateMountedRef.current) return;
          if (shortStateRequestRef.current.requestId !== requestId) return;
          if (shortStateRequestRef.current.hash !== stateHash) return;
          setError(e instanceof Error ? e.message : String(e));
          pushStateToUrl({ messageFeeds: next.map((f) => [f.id, f.filter]) });
        });
    },
    [featureShortStateEnabled, shortStateReady],
  );

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
      clearFeedUnreadBaselines(feedId);
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
    loadFeedInitialMessages,
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
