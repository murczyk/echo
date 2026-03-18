import React from 'react';

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
  INBOX_COUNT_POLL_INTERVAL_MS,
  parseStateFromUrl,
  sortMessageItemsByTime,
  VIRTUOSO_FIRST_ITEM_INDEX_INITIAL,
} from './utils';
import type { MessageFeedState } from './utils';
import { useRerDutyFeedCrud } from './useRerDutyFeedCrud';

export type FeedStateDeps = {
  freqs: string[];
  setProfiles: React.Dispatch<React.SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: React.Dispatch<React.SetStateAction<Record<string, SignalGroupEntry>>>;
};

export function useRerDutyFeedState(deps: FeedStateDeps) {
  const { freqs, setProfiles, setGroupInfos } = deps;
  const [messageFeeds, setMessageFeeds] = React.useState<MessageFeedState[]>(() => {
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
  const [error, setError] = React.useState<string | null>(null);
  const [networkMap, setNetworkMap] = React.useState<Record<number, Network>>({});
  const [unitsMap, setUnitsMap] = React.useState<Record<number, Unit>>({});
  const loadNewerRef = React.useRef<ReturnType<typeof setInterval> | null>(null);
  const loadNewerInFlightRef = React.useRef<Set<string>>(new Set());
  const countInFlightByFeedIdRef = React.useRef<Set<string>>(new Set());
  const [watchModeByFeedId, setWatchModeByFeedId] = React.useState<Record<string, boolean>>({});
  const [loadingNewerFeedId, setLoadingNewerFeedId] = React.useState<string | null>(null);
  const [arrowResultByFeedId, setArrowResultByFeedId] = React.useState<Record<string, string | null>>({});
  const columnRefsRef = React.useRef<Record<string, FeedColumnHandle | null>>({});
  const arrowResultTimeoutsRef = React.useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const scrollToEndAfterNewerRef = React.useRef<string | null>(null);
  const nearBottomByFeedIdRef = React.useRef<Record<string, boolean>>({});

  const showArrowResult = React.useCallback((feedId: string, message: string) => {
    const key = feedId;
    if (arrowResultTimeoutsRef.current[key]) clearTimeout(arrowResultTimeoutsRef.current[key]);
    setArrowResultByFeedId((prev) => ({ ...prev, [feedId]: message }));
    arrowResultTimeoutsRef.current[key] = setTimeout(() => {
      delete arrowResultTimeoutsRef.current[key];
      setArrowResultByFeedId((prev) => (prev[feedId] === message ? { ...prev, [feedId]: null } : prev));
    }, 3000);
  }, []);

  React.useEffect(() => {
    return () => {
      Object.values(arrowResultTimeoutsRef.current).forEach(clearTimeout);
    };
  }, []);

  const buildReqForFeed = React.useCallback(
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

  const loadFeedInitialMessages = React.useCallback(
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

  const loadFeedOlderMessages = React.useCallback(
    async (feedId: string) => {
      const w = messageFeeds.find((x) => x.id === feedId);
      if (!w || w.items.length === 0 || w.hasReachedStart) return;
      const firstId = w.items[0][0];
      setMessageFeeds((prev) => prev.map((x) => (x.id === feedId ? { ...x, loadingOlder: true } : x)));
      setError(null);
      try {
        const req = buildReqForFeed(w, { beforeIdNoninclusive: firstId });
        const rsp = await fetchInboxMessages(req);
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

  const loadFeedNewerMessages = React.useCallback(
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
              }
              nearBottomByFeedIdRef.current = {
                ...nearBottomByFeedIdRef.current,
                [feedId]: true,
              };
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

  const pollCountThenLoadNewerIfNeeded = React.useCallback(async () => {
    if (!messageFeeds.length) return;
    const nearBottom = nearBottomByFeedIdRef.current;
    const counts = await Promise.all(
      messageFeeds.map(async (w) => {
        if (loadNewerInFlightRef.current.has(w.id) || countInFlightByFeedIdRef.current.has(w.id)) {
          return { feedId: w.id, quantity: null as number | null, hasItems: w.items.length > 0, skipped: true };
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
          return { feedId: w.id, quantity, hasItems, skipped: false };
        } catch {
          return { feedId: w.id, quantity: 0, hasItems: w.items.length > 0, skipped: false };
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
    for (const entry of counts) {
      if (entry.skipped || entry.quantity == null || entry.quantity <= 0) continue;
      const { feedId } = entry;
      if (watchModeByFeedId[feedId] || nearBottom[feedId]) {
        await loadFeedNewerMessages(feedId, {
          scrollToEndAfterLoad: watchModeByFeedId[feedId],
        });
      }
    }
  }, [messageFeeds, watchModeByFeedId, loadFeedNewerMessages, buildReqForFeed]);

  const feedIds = React.useMemo(() => messageFeeds.map((w) => w.id).join(','), [messageFeeds]);
  const feedsNeedingLoadKey = React.useMemo(
    () =>
      messageFeeds
        .filter((w) => w.loading && w.items.length === 0)
        .map((w) => `${w.id}:${JSON.stringify(w.filter)}`)
        .join(';'),
    [messageFeeds],
  );
  const loadFeedInitialMessagesRef = React.useRef(loadFeedInitialMessages);
  loadFeedInitialMessagesRef.current = loadFeedInitialMessages;
  /** Keys are `${feedId}:${JSON.stringify(filter)}` so a filter change on the same feed triggers a new load. */
  const initialLoadStartedRef = React.useRef<Set<string>>(new Set());
  React.useEffect(() => {
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

  React.useEffect(() => {
    loadNewerRef.current = setInterval(() => {
      pollCountThenLoadNewerIfNeeded();
    }, INBOX_COUNT_POLL_INTERVAL_MS);
    return () => {
      if (loadNewerRef.current) clearInterval(loadNewerRef.current);
    };
  }, [pollCountThenLoadNewerIfNeeded]);

  React.useEffect(() => {
    const feedId = scrollToEndAfterNewerRef.current;
    if (feedId == null) return;
    scrollToEndAfterNewerRef.current = null;
    const refs = columnRefsRef.current;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => refs[feedId]?.scrollToEnd());
    });
  }, [messageFeeds]);

  const allNetworkIds = React.useMemo(() => {
    const ids = new Set<number>();
    messageFeeds.forEach((w) => {
      w.items.forEach(([, msg]) => {
        (msg.networkIds ?? []).forEach((id) => ids.add(id));
      });
    });
    return Array.from(ids);
  }, [messageFeeds]);

  const networkMapRef = React.useRef(networkMap);
  networkMapRef.current = networkMap;
  React.useEffect(() => {
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

  React.useEffect(() => {
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

  const networkDisplayMap = React.useMemo(() => {
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
    watchModeByFeedId,
    setWatchModeByFeedId,
    loadingNewerFeedId,
    setLoadingNewerFeedId,
    arrowResultByFeedId,
    showArrowResult,
  };
}
