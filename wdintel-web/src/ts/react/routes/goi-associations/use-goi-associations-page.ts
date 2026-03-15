import React from 'react';
import {
  GoiAssociation,
  ListGoiAssociationsReq,
  ListGoiAssociationsSortBy,
} from '../../../../Bindings';

import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import {
  HttpRequestError,
  isUnauthorizedError,
} from '../../services/api/client';
import { listCurrentUserGoiAssociations } from '../../services/api/goi-associations';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type UiStatus =
  | {
      kind: 'success' | 'error' | 'info' | 'warning';
      text: string;
    }
  | null;

export type GoiAssociationRowView = GoiAssociation & {
  sourceCreatedAtLabel: string;
  createdAtLabel: string;
  sourceDateLabel: string;
  callSignsLabel: string;
};

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function redirectToLogin() {
  window.location.assign('/login');
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

function goiAssociationsSortBy(
  sorting: Array<{ id: string; desc: boolean }>,
): ListGoiAssociationsSortBy | null {
  const current = sorting[0];
  if (!current) return 'GoiAssociationSourceAssociationIdDesc';

  switch (current.id) {
    case 'sourceAssociationId':
      return current.desc
        ? 'GoiAssociationSourceAssociationIdDesc'
        : 'GoiAssociationSourceAssociationIdAsc';
    case 'sourceCreatedAt':
      return current.desc
        ? 'GoiAssociationSourceCreatedAtDesc'
        : 'GoiAssociationSourceCreatedAtAsc';
    case 'frequency':
      return current.desc
        ? 'GoiAssociationFrequencyDesc'
        : 'GoiAssociationFrequencyAsc';
    case 'coordinates':
      return current.desc
        ? 'GoiAssociationCoordinatesDesc'
        : 'GoiAssociationCoordinatesAsc';
    case 'category':
      return current.desc
        ? 'GoiAssociationCategoryDesc'
        : 'GoiAssociationCategoryAsc';
    case 'author':
      return current.desc
        ? 'GoiAssociationAuthorDesc'
        : 'GoiAssociationAuthorAsc';
    case 'createdAt':
      return current.desc
        ? 'GoiAssociationCreatedAtDesc'
        : 'GoiAssociationCreatedAtAsc';
    default:
      return 'GoiAssociationSourceAssociationIdDesc';
  }
}

function toRowView(association: GoiAssociation): GoiAssociationRowView {
  return {
    ...association,
    sourceCreatedAtLabel: formatDateTime(association.sourceCreatedAtMs),
    createdAtLabel: formatDateTime(association.createdAtMs),
    sourceDateLabel: formatDateTime(association.sourceDateMs),
    callSignsLabel:
      association.callSigns.length > 0 ? association.callSigns.join(', ') : '—',
  };
}

export function useGoiAssociationsPage() {
  const tableStateContext = useTableStateContext();
  const [rows, setRows] = React.useState<GoiAssociationRowView[]>([]);
  const [status, setStatus] = React.useState<LoadingStatus>('idle');
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<UiStatus>(null);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [hasMore, setHasMore] = React.useState(false);

  const buildReq = (offset: number): ListGoiAssociationsReq => ({
    limit: 50,
    offset,
    sortBy: goiAssociationsSortBy(tableStateContext.sorting),
    filterText:
      tableStateContext.globalFilter.trim() || null,
    filterFrequency:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'frequency') ||
      null,
    filterCoordinates:
      getStringColumnFilterValue(
        tableStateContext.columnFilters,
        'coordinates',
      ) || null,
    filterNote:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'note') ||
      null,
    filterCategory:
      getStringColumnFilterValue(
        tableStateContext.columnFilters,
        'category',
      ) || null,
    filterAuthor:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'author') ||
      null,
    filterDeleted: null,
  });

  React.useEffect(() => {
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
        const rsp = await listCurrentUserGoiAssociations(
          buildReq(0),
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
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
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
  }, [
    tableStateContext.globalFilter,
    JSON.stringify(tableStateContext.columnFilters),
    JSON.stringify(tableStateContext.sorting),
  ]);

  async function onLoadMore() {
    setLoadingMore(true);
    try {
      const rsp = await listCurrentUserGoiAssociations(buildReq(rows.length));
      setRows((prev) => [...prev, ...rsp.items.map(toRowView)]);
      setHasMore(rsp.hasMore);
      setNotice(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setNotice({ kind: 'error', text: formatErrorMessage(error) });
    } finally {
      setLoadingMore(false);
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
