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
  const newestExhaustedCursorByFeedIdRef = useRef<Record<string, number>>({});
  const lastServerCountByFeedIdRef = useRef<Record<string, ServerCountBaseline>>({});
  const lastFilterSignatureByFeedIdRef = useRef<Record<string, string>>({});
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
    delete newestExhaustedCursorByFeedIdRef.current[feedId];
    pendingReloadFeedIdsRef.current = new Set([...pendingReloadFeedIdsRef.current, feedId]);
  }, []);

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
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) =>
          prev.map((x) => (x.id === feedId ? { ...x, loading: false } : x)),
        );
      }
    },
    [messageFeeds, buildReqForFeed, mergeInboxCallsigns, setProfiles, setGroupInfos],
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
              messageFeedsRef,
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
        let addedCount = 0;
        if (rsp.inboxItems.length > 0) {
          setMessageFeeds((prev) =>
            prev.map((x) => {
              if (x.id !== feedId) return x;
              const windowed = appendWindowedMessageItems(x.items, rsp.inboxItems);
              if (windowed.addedItems.length === 0) return x;
              addedCount = windowed.addedItems.length;
              const markAllRead =
                opts?.scrollToEndAfterLoad === true || opts?.markAllReadAfterAppend === true;
              const unreadAddedCount = windowed.addedItems.filter(
                ([id]) => !x.readIds.has(id),
              ).length;
              const readIds = markAllRead
                ? new Set<number>([...x.readIds, ...windowed.items.map(([id]) => id)])
                : x.readIds;
              const unreadCount = markAllRead ? 0 : Math.max(x.unreadCount, unreadAddedCount);
              delete newestExhaustedCursorByFeedIdRef.current[feedId];
              delete lastServerCountByFeedIdRef.current[feedId];
              return {
                messageFeedsRef,
                ...x,
                items: windowed.items,
                readIds,
                unreadCount,
                hasReachedStart: windowed.removedItems.length > 0 ? false : x.hasReachedStart,
              };
            }),
          );
        }
        if (addedCount === 0) {
          newestExhaustedCursorByFeedIdRef.current[feedId] = lastId;
        }
        if (addedCount > 0 && opts?.scrollToEndAfterLoad === true) {
          scrollToEndAfterNewerRef.current.add(feedId);
          nearBottomByFeedIdRef.current = {
            ...nearBottomByFeedIdRef.current,
            [feedId]: true,
          };
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
    [buildReqForFeed, setLoadingNewerFeedIds, setProfiles, setGroupInfos, mergeInboxCallsigns],
  );

  useEffect(() => {
    retainFeedIds(messageFeeds.map((feed) => feed.id));
  }, [messageFeeds, retainFeedIds]);

  const pollCountThenLoadNewerIfNeeded = useCallback(async () => {
    if (!messageFeedsRef.current.length) return;
    const nearBottom = nearBottomByFeedIdRef.current;
    messageFeedsRef.current.forEach((feed) => {
      if (feed.loading) return;
      const signature = JSON.stringify({
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
      if (lastFilterSignatureByFeedIdRef.current[feed.id] !== signature) {
        lastFilterSignatureByFeedIdRef.current[feed.id] = signature;
        delete lastServerCountByFeedIdRef.current[feed.id];
      }
    });
    const counts = await Promise.all(
      messageFeedsRef.current.map(async (w) => {
        if (loadNewerInFlightRef.current.has(w.id) || countInFlightByFeedIdRef.current.has(w.id)) {
          return {
            messageFeedsRef,
            feedId: w.id,
            quantity: null as number | null,
            hasItems: w.items.length > 0,
            cursorId: null as number | null,
            skipped: true,
            failed: false,
          };
        }
        countInFlightByFeedIdRef.current.add(w.id);
        try {
          const lastItem = w.items[w.items.length - 1];
          const cursorId = lastItem?.[0] ?? null;
          const hasItems = w.items.length > 0;
          const { quantity } = await fetchInboxCount(
            buildReqForFeed(w, { sinceIdNoninclusive: cursorId, nolimit: true }),
          );
          return {
            messageFeedsRef,
            feedId: w.id,
            quantity,
            hasItems,
            cursorId,
            skipped: false,
            failed: false,
          };
        } catch {
          return {
            messageFeedsRef,
            feedId: w.id,
            quantity: 0,
            hasItems: w.items.length > 0,
            cursorId: null as number | null,
            skipped: false,
            failed: true,
          };
        } finally {
          countInFlightByFeedIdRef.current.delete(w.id);
        }
      }),
    );
    setMessageFeeds((prev) => {
      let changed = false;
      const next = prev.map((f) => {
        const entry = counts.find((c) => c.feedId === f.id);
        if (entry?.skipped) return f;
        if (f.items.length === 0) return f;
        const quantity = entry?.quantity ?? 0;
        const nextUnread = Math.max(f.unreadCount, quantity);
        if (nextUnread === f.unreadCount) return f;
        changed = true;
        return {
          messageFeedsRef,
          ...f,
          unreadCount: nextUnread,
        };
      });
      return changed ? next : prev;
    });
    await Promise.all(
      counts.map(async (entry) => {
        if (entry.skipped || isNullOrUndefined(entry.quantity)) return;
        const { feedId } = entry;
        if (entry.failed) return;
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
  }, [watchModeByFeedId, loadFeedNewerMessages, buildReqForFeed, freqs, deps.disableAutoScroll]);

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
        pendingReloadFeedIdsRef.current = new Set(
          [...pendingReloadFeedIdsRef.current].filter((feedId) => feedId !== w.id),
        );
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
    deps.onFeedRemoved,
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
    applyFilter: crud.applyFilter,
    toggleGroup: crud.toggleGroup,
    selectAllGroups: crud.selectAllGroups,
    createMessageFeed: crud.createMessageFeed,
    removeMessageFeed: crud.removeMessageFeed,
    buildReqForFeed,
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
