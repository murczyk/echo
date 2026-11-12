import { startTransition, useCallback, useEffect, useRef, useState } from 'react';
import dayjs from 'dayjs';
import type { AnalysisSearchMode, InboxMessagesReq } from '../../../../Bindings';
import type { DateTimeRangeValue } from '../../components/DateTimeRangeControl';
import { APP_TIME_ZONE } from '../../utils/misc';
import { fetchInboxCount, fetchInboxMessages } from '../../services/api/inbox-messages';
import { fetchMessagesByIdsMatchingFilters } from '../../services/api/analysis';
import { isUnauthorizedError } from '../../services/api/client';
import { AUTH_UNAUTHORIZED_EVENT } from '../../auth-redirect';
import { useInboxChangedMessageIds } from '../shared/useInboxChangedMessageIds';
import {
  compareMessageTuple,
  messageOrderCursor,
  sortMessageItemsByTime,
  stableStringify,
} from './utils';
import type { MessageFeedState, MessageItem } from './utils';

export const DUTY_SEARCH_BLOCKED_TEXT =
  'Щоб скористатися пошуком, очистіть фільтр по ключовому слову';
const EMPTY_PERIOD: DateTimeRangeValue = { fromDateTimeStr: '', toDateTimeStr: '' };
const SEARCH_DEBOUNCE_MS = 300;

type SearchState = {
  search: string;
  searchMode: AnalysisSearchMode | null;
  period: DateTimeRangeValue;
  signature: string;
  items: MessageItem[];
  pendingItems: MessageItem[];
  total: number | null;
  selectedId: number | null;
  scrollTop: number;
  anchors: { id: number; offset: number }[];
  loading: boolean;
  loadingOlder: boolean;
  hasMore: boolean;
  error: string | null;
  failedOlder: boolean;
  tillMs: number | null;
};

export type DutySearchColumn = {
  open: boolean;
  blocked: boolean;
  navigating: boolean;
  state: SearchState;
  onOpen: () => void;
  onClose: (options?: { restoreFocus?: boolean }) => void;
  onChange: (updates: Partial<Pick<SearchState, 'search' | 'searchMode' | 'period'>>) => void;
  onRetry: () => void;
  onLoadOlder: () => void;
  onSelect: (item: MessageItem) => void;
  onScroll: (top: number, anchors: SearchState['anchors']) => void;
  onShowNew: () => void;
};

type Dependencies = {
  messageFeeds: MessageFeedState[];
  enabled: boolean;
  buildReqForFeed: (feed: MessageFeedState, opts: { loadLatest?: boolean }) => InboxMessagesReq;
  pollIntervalMs: number;
  activateFeed?: (feedId: string) => void;
  navigate: (feedId: string, reference: string, item: MessageItem) => void;
  navigatingFeedId?: string | null;
  cancelNavigation: () => void;
  onError: (message: string, retry: () => void) => void;
};

function emptySearch(signature: string): SearchState {
  return {
    search: '',
    searchMode: 'Fuzzy',
    period: EMPTY_PERIOD,
    signature,
    items: [],
    pendingItems: [],
    total: null,
    selectedId: null,
    scrollTop: 0,
    anchors: [],
    loading: false,
    loadingOlder: false,
    hasMore: false,
    error: null,
    failedOlder: false,
    tillMs: null,
  };
}

function descending(items: MessageItem[]): MessageItem[] {
  return sortMessageItemsByTime([
    ...new Map(items.map((item) => [item[0], item])).values(),
  ]).reverse();
}

async function fetchSearchResults(
  req: InboxMessagesReq,
  state: SearchState,
  older: boolean,
  changedIds: number[],
  signal: AbortSignal,
  currentRequest: () => boolean,
) {
  const options = { signal };
  const cachedIds = [...state.items, ...state.pendingItems].map(([id]) => id);
  const oldestCached = state.items.at(-1);
  const validationIds = [...new Set([...(oldestCached ? [oldestCached[0]] : []), ...changedIds])];
  const [response, count, matching] = await Promise.all([
    fetchInboxMessages(req, options),
    fetchInboxCount({ ...req, beforeIdNoninclusive: null }, options),
    !older && validationIds.length > 0
      ? fetchMessagesByIdsMatchingFilters(validationIds, req, options)
      : Promise.resolve([]),
  ]);
  if (!currentRequest()) throw new DOMException('Aborted', 'AbortError');
  let page = descending(response.inboxItems);
  // Reconcile the loaded range, including historical edits with no local change event.
  const pageLimit = response.pageLimit ?? 20;
  if (
    !older &&
    oldestCached &&
    page.length >= pageLimit &&
    compareMessageTuple(messageOrderCursor(...page.at(-1)!), messageOrderCursor(...oldestCached)) >
      0
  ) {
    let beforeId = page.at(-1)![0];
    while (currentRequest()) {
      const bridge = await fetchInboxMessages(
        { ...req, beforeIdNoninclusive: beforeId, sinceIdNoninclusive: oldestCached[0] },
        options,
      );
      if (!currentRequest()) throw new DOMException('Aborted', 'AbortError');
      const next = descending(bridge.inboxItems);
      const unseen = next.filter(([id]) => !page.some(([known]) => known === id));
      page = descending([...page, ...unseen]);
      if (next.length < (bridge.pageLimit ?? pageLimit)) break;
      if (unseen.length === 0) throw new Error('Search cursor did not advance');
      beforeId = next.at(-1)![0];
    }
  }
  const loadedBoundary = oldestCached ?? page.at(-1);
  const inLoadedRange = matching.filter(
    ([id, message]) =>
      !loadedBoundary ||
      compareMessageTuple(messageOrderCursor(id, message), messageOrderCursor(...loadedBoundary)) >=
        0,
  );
  return { page, count, matching: inLoadedRange, cachedIds };
}

function reconcileSearchResults(
  current: SearchState,
  { page, count, matching, cachedIds }: Awaited<ReturnType<typeof fetchSearchResults>>,
  older: boolean,
  tillMs: number,
): SearchState {
  if (older) {
    return {
      ...current,
      items: descending([...current.items, ...page]),
      total: count.quantity,
      loadingOlder: false,
      hasMore:
        page.length > 0 &&
        descending([...current.items, ...current.pendingItems, ...page]).length < count.quantity,
    };
  }
  const retained = descending([...matching, ...page.filter(([id]) => cachedIds.includes(id))]);
  const known = new Set([...current.items, ...current.pendingItems].map(([id]) => id));
  const newItems = descending([...page, ...matching]).filter(([id]) => !known.has(id));
  const preserve =
    retained.some(([id]) => current.items.some(([cachedId]) => cachedId === id)) &&
    (current.scrollTop > 0 || current.selectedId !== null);
  const pendingIds = new Set(current.pendingItems.map(([id]) => id));
  const items = preserve
    ? descending(retained.filter(([id]) => known.has(id) && !pendingIds.has(id)))
    : descending([...retained, ...page]);
  const pendingItems = preserve
    ? descending([...retained.filter(([id]) => pendingIds.has(id)), ...newItems])
    : [];
  const selectedId =
    current.selectedId !== null && items.some(([id]) => id === current.selectedId)
      ? current.selectedId
      : null;
  return {
    ...current,
    items,
    pendingItems,
    total: count.quantity,
    selectedId,
    loading: false,
    error: null,
    tillMs,
    hasMore: items.length + pendingItems.length < count.quantity,
  };
}

export function useDutySearch(dependencies: Dependencies) {
  const [activeFeedId, setActiveFeedId] = useState<string | null>(null);
  const [states, setStates] = useState<Record<string, SearchState>>({});
  const statesRef = useRef(states);
  const dependenciesRef = useRef(dependencies);
  dependenciesRef.current = dependencies;
  const activeRef = useRef(activeFeedId);
  activeRef.current = activeFeedId;
  const requestRef = useRef<AbortController | null>(null);
  const generationRef = useRef(0);
  const refreshPendingRef = useRef(false);
  const changedIdsRef = useRef(new Set<number>());
  const authenticationFailedRef = useRef(false);

  const update = useCallback((id: string, change: (state: SearchState) => SearchState) => {
    const state = statesRef.current[id];
    if (!state) return;
    const next = { ...statesRef.current, [id]: change(state) };
    statesRef.current = next;
    setStates(next);
  }, []);
  const cancel = useCallback(() => {
    generationRef.current += 1;
    requestRef.current?.abort();
    requestRef.current = null;
    refreshPendingRef.current = false;
    changedIdsRef.current.clear();
  }, []);
  const signatureFor = useCallback((feed: MessageFeedState) => {
    const request = dependenciesRef.current.buildReqForFeed(feed, {});
    return stableStringify({ ...request, sinceDateInclusiveMs: null, tillDateInclusiveMs: null });
  }, []);
  const runRef = useRef<(older?: boolean) => Promise<void>>(async () => {});
  const run = useCallback(
    async (older = false) => {
      const deps = dependenciesRef.current;
      const id = activeRef.current;
      const feed = deps.messageFeeds.find((entry) => entry.id === id);
      const state = id ? statesRef.current[id] : null;
      if (
        !id ||
        !feed ||
        !state ||
        !deps.enabled ||
        feed.filter.search?.trim() ||
        !state.search.trim() ||
        authenticationFailedRef.current
      )
        return;
      if (requestRef.current) {
        if (!older) refreshPendingRef.current = true;
        return;
      }
      const signature = signatureFor(feed);
      if (signature !== state.signature) return;
      const controller = new AbortController();
      requestRef.current = controller;
      const generation = ++generationRef.current;
      const tillMs = older ? state.tillMs! : Date.now();
      const from = state.period.fromDateTimeStr
        ? dayjs.tz(state.period.fromDateTimeStr, APP_TIME_ZONE).valueOf()
        : null;
      const till = state.period.toDateTimeStr
        ? dayjs.tz(state.period.toDateTimeStr, APP_TIME_ZONE).valueOf()
        : tillMs;
      const req: InboxMessagesReq = {
        ...deps.buildReqForFeed(feed, { loadLatest: true }),
        search: state.search.trim(),
        searchMode: state.searchMode ?? 'Fuzzy',
        sinceDateInclusiveMs: from,
        tillDateInclusiveMs: till,
        sinceIdNoninclusive: null,
        beforeIdNoninclusive: null,
        sortBy: 'IMSCreatedAt',
        nolimit: false,
        aroundMessageRef: null,
      };
      if (older) req.beforeIdNoninclusive = state.items.at(-1)?.[0] ?? null;
      update(id, (current) => ({ ...current, loading: !older, loadingOlder: older, error: null }));
      const currentRequest = () =>
        !controller.signal.aborted &&
        generationRef.current === generation &&
        activeRef.current === id &&
        signatureFor(
          dependenciesRef.current.messageFeeds.find((entry) => entry.id === id) ?? feed,
        ) === signature;
      const changedIds = older ? [] : [...changedIdsRef.current];
      changedIds.forEach((id) => changedIdsRef.current.delete(id));
      try {
        const result = await fetchSearchResults(
          req,
          state,
          older,
          changedIds,
          controller.signal,
          currentRequest,
        );
        if (!currentRequest()) return;
        startTransition(() =>
          update(id, (current) => reconcileSearchResults(current, result, older, tillMs)),
        );
      } catch (error) {
        if (!currentRequest()) return;
        changedIds.forEach((id) => changedIdsRef.current.add(id));
        if (isUnauthorizedError(error)) authenticationFailedRef.current = true;
        update(id, (current) => ({
          ...current,
          loading: false,
          loadingOlder: false,
          error: 'Не вдалося оновити результати пошуку. Спробуйте ще раз.',
          failedOlder: older,
        }));
        dependenciesRef.current.onError(
          `Не вдалося оновити результати пошуку. Спробуйте ще раз.${state.items.length > 0 ? ' Показано попередні результати.' : ''}`,
          () => {
            const current = statesRef.current[id];
            if (
              activeRef.current === id &&
              current?.error &&
              current.search === state.search &&
              current.searchMode === state.searchMode &&
              current.period === state.period &&
              current.signature === signature
            )
              void runRef.current(current.failedOlder);
          },
        );
      } finally {
        if (requestRef.current === controller) requestRef.current = null;
        if (currentRequest() && refreshPendingRef.current) {
          refreshPendingRef.current = false;
          void runRef.current();
        }
      }
    },
    [signatureFor, update],
  );
  runRef.current = run;

  const activeFeed = dependencies.messageFeeds.find((feed) => feed.id === activeFeedId);
  const activeSignature = activeFeed ? signatureFor(activeFeed) : null;
  const activeState = activeFeedId ? states[activeFeedId] : null;
  const blocked = !dependencies.enabled || Boolean(activeFeed?.filter.search?.trim());
  useEffect(() => {
    if (!activeFeedId) return;
    if (!activeFeed || blocked) {
      cancel();
      dependenciesRef.current.cancelNavigation();
      setActiveFeedId(null);
      return;
    }
    if (activeState?.signature !== activeSignature) {
      cancel();
      dependenciesRef.current.cancelNavigation();
      update(activeFeedId, (state) => ({
        ...emptySearch(activeSignature!),
        search: state.search,
        searchMode: state.searchMode,
        period: state.period,
      }));
      return;
    }
    const timer = setTimeout(() => {
      void run();
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      cancel();
    };
  }, [
    activeFeedId,
    activeSignature,
    blocked,
    activeState?.search,
    activeState?.searchMode,
    activeState?.period,
    activeState?.signature,
    cancel,
    run,
    update,
  ]);

  useInboxChangedMessageIds({
    enabled: Boolean(activeFeedId) && !blocked,
    scopeKey: activeFeedId,
    minIntervalMs: dependencies.pollIntervalMs,
    onMessageIds: (ids) => {
      ids.forEach((id) => changedIdsRef.current.add(id));
      return run();
    },
  });
  useEffect(() => {
    const stop = () => {
      authenticationFailedRef.current = true;
      cancel();
    };
    window.addEventListener(AUTH_UNAUTHORIZED_EVENT, stop);
    return () => {
      window.removeEventListener(AUTH_UNAUTHORIZED_EVENT, stop);
      cancel();
    };
  }, [cancel]);
  useEffect(() => {
    const ids = new Set(dependencies.messageFeeds.map((feed) => feed.id));
    const retained = Object.fromEntries(
      Object.entries(statesRef.current).filter(([id]) => ids.has(id)),
    );
    if (Object.keys(retained).length !== Object.keys(statesRef.current).length) {
      statesRef.current = retained;
      setStates(retained);
    }
  }, [dependencies.messageFeeds]);

  const columnFor = (feed: MessageFeedState): DutySearchColumn | undefined => {
    if (!dependencies.enabled) return undefined;
    const signature = signatureFor(feed);
    const cached = states[feed.id];
    const state =
      cached?.signature === signature
        ? cached
        : {
            ...emptySearch(signature),
            search: cached?.search ?? '',
            searchMode: cached?.searchMode ?? 'Fuzzy',
            period: cached?.period ?? EMPTY_PERIOD,
          };
    return {
      open: activeFeedId === feed.id && !feed.filter.search?.trim(),
      blocked: Boolean(feed.filter.search?.trim()),
      navigating: dependencies.navigatingFeedId === feed.id,
      state,
      onOpen: () => {
        if (feed.filter.search?.trim()) return;
        cancel();
        dependenciesRef.current.cancelNavigation();
        const next = {
          ...statesRef.current,
          [feed.id]: { ...state, loading: false, loadingOlder: false },
        };
        statesRef.current = next;
        setStates(next);
        dependenciesRef.current.activateFeed?.(feed.id);
        setActiveFeedId(feed.id);
      },
      onClose: ({ restoreFocus = true } = {}) => {
        cancel();
        dependenciesRef.current.cancelNavigation();
        setActiveFeedId(null);
        if (restoreFocus) {
          requestAnimationFrame(() =>
            document.getElementById(`duty-search-trigger-${feed.id}`)?.focus(),
          );
        }
      },
      onChange: (changes) => {
        cancel();
        dependenciesRef.current.cancelNavigation();
        update(feed.id, (current) => ({
          ...emptySearch(signature),
          search: current.search,
          searchMode: current.searchMode,
          period: current.period,
          ...changes,
        }));
      },
      onRetry: () => {
        void run(state.failedOlder);
      },
      onLoadOlder: () => {
        if (!requestRef.current) void run(true);
      },
      onSelect: (item) => {
        update(feed.id, (current) => ({ ...current, selectedId: item[0] }));
        dependenciesRef.current.navigate(
          feed.id,
          item[1].messageUid ?? item[1].messageUuid ?? String(item[0]),
          item,
        );
      },
      onScroll: (scrollTop, anchors) => {
        const current = statesRef.current[feed.id];
        if (current) {
          current.scrollTop = scrollTop;
          current.anchors = anchors;
        }
      },
      onShowNew: () =>
        update(feed.id, (current) => ({
          ...current,
          items: descending([...current.items, ...current.pendingItems]),
          pendingItems: [],
          scrollTop: 0,
          anchors: [],
        })),
    };
  };
  const close = useCallback(() => {
    cancel();
    dependenciesRef.current.cancelNavigation();
    setActiveFeedId(null);
  }, [cancel]);
  const clearSelection = useCallback(
    (feedId: string) => {
      if (dependenciesRef.current.navigatingFeedId === feedId)
        dependenciesRef.current.cancelNavigation();
      update(feedId, (state) => ({ ...state, selectedId: null }));
    },
    [update],
  );
  return { activeFeedId, columnFor, close, clearSelection };
}
