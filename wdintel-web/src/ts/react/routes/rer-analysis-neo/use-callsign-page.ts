import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AnalysisCallsignPageEntry,
  AnalysisCallsignPageOrder,
  AnalysisStatsReq,
} from '../../../../Bindings';
import { fetchAnalysisCallsignPage } from '../../services/api/analysis';
import { isAbortError } from '../../services/api/client';

const PAGE_SIZE = 50;
const SEARCH_DELAY_MS = 250;
const CURSOR_HISTORY_LIMIT = 20;

type PageState = {
  entries: AnalysisCallsignPageEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};

type CursorHistoryEntry = {
  cursor: string | null;
  index: number;
};

type PageRequest = CursorHistoryEntry;

const emptyPage: PageState = { entries: [], hasMore: false, nextCursor: null };

function retainCursorHistory(
  history: CursorHistoryEntry[],
  entry: CursorHistoryEntry,
): CursorHistoryEntry[] {
  const next = [...history.filter((item) => item.index < entry.index), entry];
  if (next.length <= CURSOR_HISTORY_LIMIT) return next;
  return [next[0], ...next.slice(-(CURSOR_HISTORY_LIMIT - 1))];
}

function pageOrder(query: string): AnalysisCallsignPageOrder {
  return query.trim() === '' ? 'count_desc' : 'match_then_name';
}

export function useCallsignPage({
  active,
  analysisReq,
  onError,
}: {
  active: boolean;
  analysisReq: AnalysisStatsReq | null;
  onError: (error: unknown) => void;
}) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState<PageState>(emptyPage);
  const [cursorHistory, setCursorHistory] = useState<CursorHistoryEntry[]>([
    { cursor: null, index: 0 },
  ]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [debouncing, setDebouncing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [failedRequest, setFailedRequest] = useState<PageRequest | null>(null);
  const requestIdRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const scopeKey = useMemo(() => JSON.stringify(analysisReq), [analysisReq]);
  const effectiveScope = `${scopeKey}:${query}:${pageOrder(query)}`;
  const hasRequest = analysisReq != null;
  const analysisReqRef = useRef(analysisReq);
  const queryRef = useRef(query);
  const effectiveScopeRef = useRef(effectiveScope);
  analysisReqRef.current = analysisReq;
  queryRef.current = query;
  effectiveScopeRef.current = effectiveScope;

  const abortRequest = useCallback(() => {
    controllerRef.current?.abort();
    controllerRef.current = null;
  }, []);

  const requestPage = useCallback(
    async (request: PageRequest, scope: string) => {
      const currentReq = analysisReqRef.current;
      if (!active || currentReq == null || scope !== effectiveScopeRef.current) return false;
      abortRequest();
      const controller = new AbortController();
      controllerRef.current = controller;
      const requestId = requestIdRef.current + 1;
      requestIdRef.current = requestId;
      setLoading(true);
      try {
        const response = await fetchAnalysisCallsignPage(
          {
            req: currentReq,
            query: queryRef.current,
            pageSize: PAGE_SIZE,
            cursor: request.cursor,
            order: pageOrder(queryRef.current),
          },
          { signal: controller.signal },
        );
        if (
          requestId !== requestIdRef.current ||
          scope !== effectiveScopeRef.current ||
          controller.signal.aborted
        ) {
          return false;
        }
        setPage({
          entries: response.entries,
          hasMore: response.hasMore,
          nextCursor: response.nextCursor,
        });
        setPageIndex(request.index);
        setError(null);
        setFailedRequest(null);
        return true;
      } catch (loadError) {
        if (
          !isAbortError(loadError) &&
          requestId === requestIdRef.current &&
          scope === effectiveScopeRef.current
        ) {
          setError(loadError);
          setFailedRequest(request);
          onErrorRef.current(loadError);
        }
        return false;
      } finally {
        if (requestId === requestIdRef.current) setLoading(false);
      }
    },
    [abortRequest, active],
  );

  useEffect(() => {
    if (!active || !hasRequest) {
      abortRequest();
      requestIdRef.current += 1;
      setLoading(false);
      setDebouncing(false);
      return;
    }
    requestIdRef.current += 1;
    abortRequest();
    setPage(emptyPage);
    setCursorHistory([{ cursor: null, index: 0 }]);
    setPageIndex(0);
    setError(null);
    setFailedRequest(null);
    setDebouncing(true);
    const scope = effectiveScope;
    const timeout = window.setTimeout(() => {
      setDebouncing(false);
      void requestPage({ cursor: null, index: 0 }, scope);
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      abortRequest();
    };
  }, [active, abortRequest, effectiveScope, hasRequest, requestPage]);

  const loadNextPage = useCallback(async () => {
    if (loading || debouncing || !page.hasMore || page.nextCursor == null) return;
    const request = { cursor: page.nextCursor, index: pageIndex + 1 };
    const loaded = await requestPage(request, effectiveScope);
    if (loaded) setCursorHistory((history) => retainCursorHistory(history, request));
  }, [debouncing, effectiveScope, loading, page.hasMore, page.nextCursor, pageIndex, requestPage]);

  const loadPreviousPage = useCallback(async () => {
    if (loading || debouncing) return;
    const request = cursorHistory.find((item) => item.index === pageIndex - 1);
    if (request == null) return;
    await requestPage(request, effectiveScope);
  }, [cursorHistory, debouncing, effectiveScope, loading, pageIndex, requestPage]);

  const loadFirstPage = useCallback(async () => {
    if (loading || debouncing || pageIndex === 0) return;
    await requestPage({ cursor: null, index: 0 }, effectiveScope);
  }, [debouncing, effectiveScope, loading, pageIndex, requestPage]);

  const retry = useCallback(async () => {
    if (loading || debouncing || failedRequest == null) return;
    const loaded = await requestPage(failedRequest, effectiveScope);
    if (loaded && failedRequest.index > pageIndex) {
      setCursorHistory((history) => retainCursorHistory(history, failedRequest));
    }
  }, [debouncing, effectiveScope, failedRequest, loading, pageIndex, requestPage]);

  useEffect(() => () => abortRequest(), [abortRequest]);

  return {
    entries: page.entries,
    error,
    canRetry: failedRequest != null,
    hasMore: page.hasMore,
    hasPrevious: cursorHistory.some((item) => item.index === pageIndex - 1),
    loadFirstPage,
    loadNextPage,
    loadPreviousPage,
    loading,
    pageIndex,
    query,
    retry,
    setQuery,
  };
}
