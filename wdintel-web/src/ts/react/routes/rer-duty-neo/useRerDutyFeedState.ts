import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type {
  Network,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
  SignalGroupEntry,
  SignalProfileEntry,
  Unit,
} from '../../../../Bindings';
import { fetchInboxCount, fetchInboxMessages } from '../../services/api/inbox';
import { getNetworksByIds } from '../../services/api/networks';
import { getUnitsList } from '../../services/api/units';
import type { FeedColumnHandle } from './FeedColumn';
import {
  buildInboxReq,
  createMasterUnitText,
  dedupeMessageItems,
  emptyFilter,
  findAllAdjacentFreqs,
  parseStateFromUrl,
  sortMessageItemsByTime,
  VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
} from './utils';
import type { MessageFeedState } from './utils';
import { useRerDutyFeedCrud } from './useRerDutyFeedCrud';
import { notifyDutyNewMessages } from './notifications';

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
      firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
      referenceTimeMs: null,
      readIds: new Set<number>(),
      unreadCount: 0,
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    }));
  });
  const [error, setError] = useState<string | null>(null);
  const messageFeedsRef = useRef(messageFeeds);
  const [networkMap, setNetworkMap] = useState<Record<number, Network>>({});
  const [unitsMap, setUnitsMap] = useState<Record<number, Unit>>({});
  const loadNewerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const loadNewerInFlightRef = useRef<Set<string>>(new Set());
  const countInFlightByFeedIdRef = useRef<Set<string>>(new Set());
  const [watchModeByFeedId, setWatchModeByFeedId] = useState<Record<string, boolean>>({});
  const [loadingNewerFeedId, setLoadingNewerFeedId] = useState<string | null>(null);
  const [arrowResultByFeedId, setArrowResultByFeedId] = useState<Record<string, string | null>>({});
  const columnRefsRef = useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scrollToEndAfterNewerRef = useRef<string | null>(null);
  const nearBottomByFeedIdRef = useRef<Record<string, boolean>>({});
  const lastServerCountByFeedIdRef = useRef<Record<string, number>>({});
  const lastFilterSignatureByFeedIdRef = useRef<Record<string, string>>({});
  /** Virtuoso "at bottom" (pixel threshold); used so poll only auto-scrolls when the scroller is actually at the bottom. */
  const atBottomByFeedIdRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    messageFeedsRef.current = messageFeeds;
  }, [messageFeeds]);

  const showArrowResult = useCallback((feedId: string, message: string) => {
    const key = feedId;
    if (arrowResultTimeoutsRef.current[key]) clearTimeout(arrowResultTimeoutsRef.current[key]);
    setArrowResultByFeedId((prev) => ({ ...prev, [feedId]: message }));
    arrowResultTimeoutsRef.current[key] = setTimeout(() => {
      delete arrowResultTimeoutsRef.current[key];
      setArrowResultByFeedId((prev) => (prev[feedId] === message ? { ...prev, [feedId]: null } : prev));
    }, 3000);
  }, []);

  useEffect(() => {
    return () => {
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  const buildReqForFeed = useCallback(
    (
      feed: MessageFeedState,
      opts: Omit<
        Parameters<typeof buildInboxReq>[0],
        'filter' | 'expandedFreqsSelected' | 'expandedFreqsDenied' | 'highlightSignals' | 'reportTagsOnlyThisUnit'
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
          ? [...(feed.filter.freqsDenied ?? []), ...findAllAdjacentFreqs(freqs, feed.filter.freqsDenied ?? [], range)]
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
    async (feedId: string, overrides?: { highlightSignalsEnabled?: boolean; onlyMyUnitTagsEnabled?: boolean }) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      const effectiveFeed = overrides ? { ...feed, ...overrides } : feed;
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loading: true } : x)));
      setError(null);
      try {
        const req = buildReqForFeed(effectiveFeed, { loadLatest: true });
        const rsp = await fetchInboxMessages(req);
        const deduped = dedupeMessageItems(rsp.inboxItems);
        const initialReadIds = new Set<number>(deduped.map(([id]) => id));
        setMessageFeeds((prev) =>
          prev.map((x) =>
            x.id === feedId
              ? {
                  ...x,
                  items: sortMessageItemsByTime(deduped),
                  loading: false,
                  firstItemIndex: VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
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
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loading: false } : x)));
      }
    },
    [messageFeeds, buildReqForFeed, setProfiles, setGroupInfos],
  );

  const loadFeedOlderMessages = useCallback(
    async (feedId: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w || w.items.length === 0 || w.hasReachedStart) return;
      const firstId = w.items[0][0];
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingOlder: true } : x)));
      setError(null);
      try {
        const req = buildReqForFeed(w, { beforeIdNoninclusive: firstId });
        const rsp = await fetchInboxMessages(req);
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
            const existingIds = new Set(x.items.map(([id]) => id));
            const newItems = rsp.inboxItems.filter(([id]) => !existingIds.has(id));
            const hasReachedStart = newItems.length === 0;
            const prevFirst = x.firstItemIndex ?? VIRTUOSO_FIRST_ITEM_INDEX_INITIAL;
            const firstItemIndex = Math.max(0, prevFirst - newItems.length);
            const combined = dedupeMessageItems([...newItems, ...x.items]);
            const olderIds = newItems.map(([id]) => id);
            const nextReadIds = new Set([...x.readIds, ...olderIds]);
            return {
              ...x,
              items: sortMessageItemsByTime(combined),
              readIds: nextReadIds,
              loadingOlder: false,
              hasReachedStart,
              firstItemIndex,
            };
          }),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingOlder: false } : x)));
      }
    },
    [messageFeeds, buildReqForFeed],
  );

  const loadFeedNewerMessages = useCallback(
    async (
      feedId: string,
      opts?: { nolimit?: boolean; scrollToEndAfterLoad?: boolean; markAllReadAfterAppend?: boolean },
    ) => {
      if (loadNewerInFlightRef.current.has(feedId)) return;
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed || feed.items.length === 0) return;
      loadNewerInFlightRef.current.add(feedId);
      setLoadingNewerFeedId(feedId);
      const lastId = feed.items[feed.items.length - 1][0];
      try {
        const req = buildReqForFeed(feed, {
          sinceIdNoninclusive: lastId,
          nolimit: opts?.nolimit ?? undefined,
        });
        const rsp = await fetchInboxMessages(req);
        if (rsp.signalProfiles) setProfiles((p) => ({ ...p, ...rsp.signalProfiles }));
        if (rsp.signalGroups?.length) {
          const map: Record<string, SignalGroupEntry> = {};
          rsp.signalGroups.forEach((g) => {
            map[g.masterKey] = g;
          });
          setGroupInfos((prev) => ({ ...prev, ...map }));
        }
        if (rsp.inboxItems.length > 0) {
          const feedNow = messageFeeds.find((x) => x.id === feedId);
          if (feedNow) {
            const newItems = rsp.inboxItems.filter(([id]) => !new Set(feedNow.items.map(([i]) => i)).has(id));
            if (newItems.length > 0) {
              setMessageFeeds((prev) =>
                prev.map((x) => {
                  if (x.id !== feedId) return x;
                  const existingIds = new Set(x.items.map(([id]) => id));
                  const toAdd = newItems.filter(([id]) => !existingIds.has(id));
                  if (toAdd.length === 0) return x;
                  const combined = dedupeMessageItems([...x.items, ...toAdd]);
                  const markAllRead = opts?.scrollToEndAfterLoad === true || opts?.markAllReadAfterAppend === true;
                  const readIds = markAllRead ? new Set(combined.map(([id]) => id)) : x.readIds;
                  const unreadCount = markAllRead ? 0 : combined.length - x.readIds.size;
                  delete lastServerCountByFeedIdRef.current[feedId];
                  return {
                    ...x,
                    items: sortMessageItemsByTime(combined),
                    readIds,
                    unreadCount,
                  };
                }),
              );
              if (opts?.scrollToEndAfterLoad === true) {
                scrollToEndAfterNewerRef.current = feedId;
                nearBottomByFeedIdRef.current = {
                  ...nearBottomByFeedIdRef.current,
                  [feedId]: true,
                };
              }
            }
          }
        }
      } catch {
        // ignore single failure to keep polling and prev messages
      } finally {
        loadNewerInFlightRef.current.delete(feedId);
        setLoadingNewerFeedId((prev) => (prev === feedId ? null : prev));
      }
    },
    [messageFeeds, buildReqForFeed],
  );

  const pollCountThenLoadNewerIfNeeded = useCallback(async () => {
    if (!messageFeeds.length) return;
    const nearBottom = nearBottomByFeedIdRef.current;
    const signatureByFeedId: Record<string, string> = {};
    messageFeeds.forEach((feed) => {
      const signature = JSON.stringify({
        filter: {
          groupsSelected: feed.filter.groupsSelected ?? null,
          sendersSelected: feed.filter.sendersSelected ?? null,
          deniedSenders: feed.filter.deniedSenders ?? null,
          freqsSelected: feed.filter.freqsSelected ?? null,
          freqsDenied: feed.filter.freqsDenied ?? null,
          postsSelected: feed.filter.postsSelected ?? null,
          postsDenied: feed.filter.postsDenied ?? null,
        },
        freqUniverse: feed.adjacentFreqsRange > 0 ? freqs : null,
        adjacentFreqsRange: feed.adjacentFreqsRange ?? 0,
        highlightSignalsEnabled: feed.highlightSignalsEnabled ?? false,
        onlyMyUnitTagsEnabled: feed.onlyMyUnitTagsEnabled ?? false,
      });
      signatureByFeedId[feed.id] = signature;
      if (lastFilterSignatureByFeedIdRef.current[feed.id] !== signature) {
        lastFilterSignatureByFeedIdRef.current[feed.id] = signature;
        delete lastServerCountByFeedIdRef.current[feed.id];
      }
    });
    const counts = await Promise.all(
      messageFeeds.map(async (w) => {
        if (loadNewerInFlightRef.current.has(w.id) || countInFlightByFeedIdRef.current.has(w.id)) {
          return {
            feedId: w.id,
            quantity: null as number | null,
            hasItems: w.items.length > 0,
            skipped: true,
            failed: false,
          };
        }
        countInFlightByFeedIdRef.current.add(w.id);
        try {
          const lastItem = w.items[w.items.length - 1];
          const sinceMs =
            lastItem != null && lastItem[1].timestamp != null && lastItem[1].timestamp > 0
              ? lastItem[1].timestamp + 1
              : 0;
          const hasItems = w.items.length > 0;
          const { quantity } = await fetchInboxCount(
            buildReqForFeed(w, { sinceDateInclusiveMs: sinceMs, nolimit: true }),
          );
          return { feedId: w.id, quantity, hasItems, skipped: false, failed: false };
        } catch {
          return { feedId: w.id, quantity: 0, hasItems: w.items.length > 0, skipped: false, failed: true };
        } finally {
          countInFlightByFeedIdRef.current.delete(w.id);
        }
      }),
    );
    setMessageFeeds((prev) =>
      prev.map((f) => {
        const entry = counts.find((c) => c.feedId === f.id);
        if (entry?.skipped) return f;
        const quantity = entry?.quantity ?? 0;
        const hasItems = entry?.hasItems ?? f.items.length > 0;
        const allItemsRead =
          f.items.length > 0 && f.items.length === f.readIds.size && f.items.every(([id]) => f.readIds.has(id));
        const unreadCount = !hasItems
          ? f.unreadCount
          : quantity === 0 && allItemsRead
            ? 0
            : Math.max(f.unreadCount, quantity);
        return { ...f, unreadCount };
      }),
    );
    const newCountBySignature: Record<string, number> = {};
    for (const entry of counts) {
      if (entry.skipped || entry.quantity == null) continue;
      const { feedId } = entry;
      if (entry.failed) {
        continue;
      }
      if (entry.quantity <= 0) {
        lastServerCountByFeedIdRef.current[feedId] = 0;
        continue;
      }
      const prevServerCount = lastServerCountByFeedIdRef.current[feedId] ?? (entry.hasItems ? 0 : null);
      const nextCount = entry.quantity;
      if (prevServerCount != null) {
        const newCount = Math.max(0, nextCount - prevServerCount);
        const signatureKey = signatureByFeedId[feedId] ?? feedId;
        const prevCount = newCountBySignature[signatureKey] ?? 0;
        newCountBySignature[signatureKey] = Math.max(prevCount, newCount);
      }
      lastServerCountByFeedIdRef.current[feedId] = nextCount;
      if (watchModeByFeedId[feedId] || nearBottom[feedId]) {
        const atBottom = atBottomByFeedIdRef.current[feedId] ?? false;
        const shouldFollowScroll =
          !deps.disableAutoScroll &&
          (watchModeByFeedId[feedId] ?? false) &&
          atBottom;
        await loadFeedNewerMessages(feedId, {
          scrollToEndAfterLoad: shouldFollowScroll,
        });
      }
    }
    const totalNewCount = Object.values(newCountBySignature).reduce((sum, count) => sum + count, 0);
    if (totalNewCount > 0) {
      notifyDutyNewMessages(totalNewCount);
    }
  }, [messageFeeds, watchModeByFeedId, loadFeedNewerMessages, buildReqForFeed, freqs,deps.disableAutoScroll]);

  const feedIds = useMemo(() => messageFeeds.map((w) => w.id).join(','), [messageFeeds]);
  const feedsNeedingLoadKey = useMemo(
    () =>
      messageFeeds
        .filter((w) => w.loading && w.items.length === 0)
        .map((w) => `${w.id}:${JSON.stringify(w.filter)}`)
        .join(';'),
    [messageFeeds],
  );
  const loadFeedInitialMessagesRef = useRef(loadFeedInitialMessages);
  loadFeedInitialMessagesRef.current = loadFeedInitialMessages;
  /** Keys are `${feedId}:${JSON.stringify(filter)}` so a filter change on the same feed triggers a new load. */
  const initialLoadStartedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const needingLoad = messageFeeds.filter((w) => w.loading && w.items.length === 0);
    const needingKeys = new Set(needingLoad.map((w) => `${w.id}:${JSON.stringify(w.filter)}`));
    const started = initialLoadStartedRef.current;
    [...started].forEach((key) => {
      if (!needingKeys.has(key)) started.delete(key);
    });
    needingLoad.forEach((w) => {
      const key = `${w.id}:${JSON.stringify(w.filter)}`;
      if (!started.has(key)) {
        started.add(key);
        loadFeedInitialMessagesRef.current(w.id);
      }
    });
  }, [feedIds, feedsNeedingLoadKey]);

  useEffect(() => {
    const intervalMs = Math.max(1, Math.floor(deps.pollIntervalSec) || 1) * 1000;
    loadNewerRef.current = setInterval(() => {
      pollCountThenLoadNewerIfNeeded();
    }, intervalMs);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [deps.pollIntervalSec, pollCountThenLoadNewerIfNeeded]);

  useEffect(() => {
    const feedId = scrollToEndAfterNewerRef.current;
    if (feedId == null) return;
    scrollToEndAfterNewerRef.current = null;
    const refs = columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => refs[feedId]?.scrollToEnd());
    });
  }, [messageFeeds]);

  const allNetworkIds = useMemo(() => {
    const ids = new Set<number>();
    messageFeeds.forEach((w) => {
      w.items.forEach(([, msg]) => {
        (msg.networkIds ?? []).forEach((id) => ids.add(id));
      });
    });
    return Array.from(ids);
  }, [messageFeeds]);

  const networkMapRef = useRef(networkMap);
  networkMapRef.current = networkMap;
  useEffect(() => {
    const missing = allNetworkIds.filter((id) => !(id in networkMapRef.current));
    if (missing.length === 0) return;
    let cancelled = false;
    getNetworksByIds(missing)
      .then((networks) => {
        if (cancelled) return;
        setNetworkMap((prev) => {
          const next = { ...prev };
          networks.forEach((n) => {
            next[n.id] = n;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load networks', err));
    return () => {
      cancelled = true;
    };
  }, [allNetworkIds.join(',')]);

  useEffect(() => {
    let cancelled = false;
    getUnitsList()
      .then((units) => {
        if (cancelled) return;
        setUnitsMap((prev) => {
          const next = { ...prev };
          units.forEach((u) => {
            next[u.id] = u;
          });
          return next;
        });
      })
      .catch((err) => console.error('Failed to load units', err));
    return () => {
      cancelled = true;
    };
  }, []);

  const networkDisplayMap = useMemo(() => {
    const out: Record<number, string> = {};
    Object.entries(networkMap).forEach(([idStr, n]) => {
      const id = Number(idStr);
      out[id] = createMasterUnitText(n, unitsMap);
    });
    return out;
  }, [networkMap, unitsMap]);

  const crud = useRerDutyFeedCrud(messageFeeds, setMessageFeeds);

  return {
    messageFeeds,
    setMessageFeeds,
    error,
    setError,
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
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedId,
    setLoadingNewerFeedId,
    arrowResultByFeedId,
    showArrowResult,
  };
}
