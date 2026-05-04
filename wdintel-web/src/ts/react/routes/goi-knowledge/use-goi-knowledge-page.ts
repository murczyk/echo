import { useEffect, useMemo, useRef, useState } from 'react';
import {
  GoiKnowledge,
  ListGoiKnowledgeReq,
  ListGoiKnowledgeSortBy,
} from '../../../../Bindings';

import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import { HttpRequestError } from '../../services/api/client';
import { listCurrentUserGoiKnowledge } from '../../services/api/goi-knowledge';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type UiStatus =
  | {
      kind: 'success' | 'error' | 'info' | 'warning';
      text: string;
    }
  | null;

const GOI_KNOWLEDGE_PAGE_SIZE = 50;

export type GoiKnowledgeRowView = GoiKnowledge & {
  sourceCreatedAtLabel: string;
  createdAtLabel: string;
  sourceDateLabel: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof HttpRequestError) return error.message;
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

function formatDateTime(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
}

function getStringColumnFilterValue(
  filters: Array<{ id: string; value: unknown }>,
  id: string,
): string {
  const value = filters.find((item) => item.id === id)?.value;
  return typeof value === 'string' ? value : '';
}

function goiKnowledgeSortBy(
  sorting: Array<{ id: string; desc: boolean }>,
): ListGoiKnowledgeSortBy | null {
  const current = sorting[0];
  if (!current) return 'GoiKnowledgeSourceKnowledgeIdDesc';

  switch (current.id) {
    case 'sourceKnowledgeId':
      return current.desc
        ? 'GoiKnowledgeSourceKnowledgeIdDesc'
        : 'GoiKnowledgeSourceKnowledgeIdAsc';
    case 'sourceCreatedAt':
      return current.desc
        ? 'GoiKnowledgeSourceCreatedAtDesc'
        : 'GoiKnowledgeSourceCreatedAtAsc';
    case 'name':
      return current.desc ? 'GoiKnowledgeNameDesc' : 'GoiKnowledgeNameAsc';
    case 'key':
      return current.desc ? 'GoiKnowledgeKeyDesc' : 'GoiKnowledgeKeyAsc';
    case 'knowledgeType':
      return current.desc
        ? 'GoiKnowledgeTypeDesc'
        : 'GoiKnowledgeTypeAsc';
    case 'author':
      return current.desc
        ? 'GoiKnowledgeAuthorDesc'
        : 'GoiKnowledgeAuthorAsc';
    case 'formation':
      return current.desc
        ? 'GoiKnowledgeFormationDesc'
        : 'GoiKnowledgeFormationAsc';
    case 'note':
      return current.desc ? 'GoiKnowledgeNoteDesc' : 'GoiKnowledgeNoteAsc';
    case 'sourceDate':
      return current.desc
        ? 'GoiKnowledgeSourceDateDesc'
        : 'GoiKnowledgeSourceDateAsc';
    case 'createdAt':
      return current.desc
        ? 'GoiKnowledgeCreatedAtDesc'
        : 'GoiKnowledgeCreatedAtAsc';
    default:
      return 'GoiKnowledgeSourceKnowledgeIdDesc';
  }
}

function toRowView(knowledge: GoiKnowledge): GoiKnowledgeRowView {
  return {
    ...knowledge,
    sourceCreatedAtLabel: formatDateTime(knowledge.sourceCreatedAtMs),
    createdAtLabel: formatDateTime(knowledge.createdAtMs),
    sourceDateLabel:
      formatDateTime(knowledge.sourceDateMs) !== '—'
        ? formatDateTime(knowledge.sourceDateMs)
        : knowledge.sourceDateRaw || '—',
  };
}

export function useGoiKnowledgePage() {
  const tableStateContext = useTableStateContext();
  const [rows, setRows] = useState<GoiKnowledgeRowView[]>([]);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiStatus>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        globalFilter: tableStateContext.globalFilter,
        columnFilters: tableStateContext.columnFilters,
        sorting: tableStateContext.sorting,
      }),
    [
      tableStateContext.globalFilter,
      tableStateContext.columnFilters,
      tableStateContext.sorting,
    ],
  );
  const latestQueryKeyRef = useRef(queryKey);
  const loadMoreAbortControllerRef =
    useRef<AbortController | null>(null);

  latestQueryKeyRef.current = queryKey;

  const buildReq = (limit: number, offset: number): ListGoiKnowledgeReq => ({
    limit,
    offset,
    sortBy: goiKnowledgeSortBy(tableStateContext.sorting),
    filterText: tableStateContext.globalFilter.trim() || null,
    filterServer:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'server') ||
      null,
    filterName:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'name') ||
      null,
    filterKey:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'key') ||
      null,
    filterKnowledgeType:
      getStringColumnFilterValue(
        tableStateContext.columnFilters,
        'knowledgeType',
      ) || null,
    filterNote:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'note') ||
      null,
    filterAuthor:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'author') ||
      null,
    filterFormation:
      getStringColumnFilterValue(
        tableStateContext.columnFilters,
        'formation',
      ) || null,
    filterDeleted: false,
  });

  useEffect(() => {
    loadMoreAbortControllerRef.current?.abort();
    loadMoreAbortControllerRef.current = null;
    setLoadingMore(false);
  }, [queryKey]);

  useEffect(() => {
    const abortController = new AbortController();
    const hasExistingRows = rows.length > 0;
    const timeout = window.setTimeout(async () => {
      if (!hasExistingRows) {
        setStatus('loading');
        setErrorMessage(null);
      } else {
        setRefreshing(true);
      }

      try {
        const rsp = await listCurrentUserGoiKnowledge(
          buildReq(GOI_KNOWLEDGE_PAGE_SIZE, 0),
          abortController.signal,
        );
        if (abortController.signal.aborted) return;
        setRows(rsp.items.map(toRowView));
        setHasMore(rsp.hasMore);
        setStatus('success');
        setErrorMessage(null);
        setNotice(null);
      } catch (error) {
        if (abortController.signal.aborted || isAbortError(error)) return;
        const message = formatErrorMessage(error);
        if (hasExistingRows) {
          setNotice({ kind: 'error', text: message });
        } else {
          setStatus('error');
          setErrorMessage(message);
        }
      } finally {
        if (!abortController.signal.aborted) {
          setRefreshing(false);
        }
      }
    }, hasExistingRows ? 250 : 0);

    return () => {
      window.clearTimeout(timeout);
      abortController.abort();
    };
  }, [queryKey]);

  async function onLoadMore() {
    if (loadMoreAbortControllerRef.current) return;

    const abortController = new AbortController();
    const requestQueryKey = latestQueryKeyRef.current;

    loadMoreAbortControllerRef.current = abortController;
    setLoadingMore(true);

    try {
      const nextLimit = rows.length + GOI_KNOWLEDGE_PAGE_SIZE;
      const rsp = await listCurrentUserGoiKnowledge(
        buildReq(nextLimit, 0),
        abortController.signal,
      );
      if (
        abortController.signal.aborted ||
        latestQueryKeyRef.current !== requestQueryKey
      ) {
        return;
      }
      setRows(rsp.items.map(toRowView));
      setHasMore(rsp.hasMore);
      setNotice(null);
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) return;
      setNotice({ kind: 'error', text: formatErrorMessage(error) });
    } finally {
      if (loadMoreAbortControllerRef.current === abortController) {
        loadMoreAbortControllerRef.current = null;
      }
      if (
        !abortController.signal.aborted &&
        latestQueryKeyRef.current === requestQueryKey
      ) {
        setLoadingMore(false);
      }
    }
  }

  function onClearFilters() {
    tableStateContext.onChangeGlobalFilter('');
    tableStateContext.onColumnFiltersChange([]);
  }

  const hasActiveFilters =
    tableStateContext.globalFilter.trim() !== '' ||
    tableStateContext.columnFilters.length > 0;

  return {
    rows,
    status,
    errorMessage,
    notice,
    refreshing,
    loadingMore,
    hasMore,
    hasActiveFilters,
    onLoadMore,
    onClearFilters,
  };
}
