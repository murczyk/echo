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

type PageState = {
  entries: AnalysisCallsignPageEntry[];
  hasMore: boolean;
  nextCursor: string | null;
};

const emptyPage: PageState = { entries: [], hasMore: false, nextCursor: null };

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
  const [cursorHistory, setCursorHistory] = useState<Array<string | null>>([null]);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [debouncing, setDebouncing] = useState(false);
  const [error, setError] = useState<unknown>(null);
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
    async (cursor: string | null, index: number, scope: string) => {
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
            cursor,
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
        setPageIndex(index);
        setError(null);
        return true;
      } catch (loadError) {
        if (
          !isAbortError(loadError) &&
          requestId === requestIdRef.current &&
          scope === effectiveScopeRef.current
        ) {
          setError(loadError);
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
    setCursorHistory([null]);
    setPageIndex(0);
    setError(null);
    setDebouncing(true);
    const scope = effectiveScope;
    const timeout = window.setTimeout(() => {
      setDebouncing(false);
      void requestPage(null, 0, scope);
    }, SEARCH_DELAY_MS);
    return () => {
      window.clearTimeout(timeout);
      abortRequest();
    };
  }, [active, abortRequest, effectiveScope, hasRequest, requestPage]);

  const loadNextPage = useCallback(async () => {
    if (loading || debouncing || !page.hasMore || page.nextCursor == null) return;
    const nextIndex = pageIndex + 1;
    const loaded = await requestPage(page.nextCursor, nextIndex, effectiveScope);
    if (loaded) setCursorHistory((history) => [...history.slice(0, nextIndex), page.nextCursor]);
  }, [debouncing, effectiveScope, loading, page.hasMore, page.nextCursor, pageIndex, requestPage]);

  const loadPreviousPage = useCallback(async () => {
    if (loading || debouncing || pageIndex === 0) return;
    const previousIndex = pageIndex - 1;
    await requestPage(cursorHistory[previousIndex] ?? null, previousIndex, effectiveScope);
  }, [cursorHistory, debouncing, effectiveScope, loading, pageIndex, requestPage]);

  const loadFirstPage = useCallback(async () => {
    if (loading || debouncing || pageIndex === 0) return;
    await requestPage(null, 0, effectiveScope);
  }, [debouncing, effectiveScope, loading, pageIndex, requestPage]);

  useEffect(() => () => abortRequest(), [abortRequest]);

  return {
    entries: page.entries,
    error,
    hasMore: page.hasMore,
    hasPrevious: pageIndex > 0,
    loadFirstPage,
    loadNextPage,
    loadPreviousPage,
    loading,
    pageIndex,
    query,
    setQuery,
  };
}
