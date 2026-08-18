import { useEffect, useMemo, useRef, useState } from 'react';
import dayjs from 'dayjs';
import {
  GoiAssociation,
  ListGoiAssociationsReq,
  ListGoiAssociationsSortBy,
} from '../../../../Bindings';

import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';
import type { DateTimeRangeValue } from '../../components/DateTimeRangeControl';
import { HttpRequestError } from '../../services/api/client';
import {
  launchGoiAssociationsReport,
  listCurrentUserGoiAssociations,
} from '../../services/api/goi-associations';
import { APP_TIME_ZONE, combineDateTimeInputToMs } from '../../utils/misc';

type LoadingStatus = 'idle' | 'loading' | 'success' | 'error';

type UiStatus = {
  kind: 'success' | 'error' | 'info' | 'warning';
  text: string;
} | null;

export type GoiAssociationRowView = GoiAssociation & {
  sourceCreatedAtLabel: string;
  createdAtLabel: string;
  sourceDateLabel: string;
  callSignsLabel: string;
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
      return current.desc ? 'GoiAssociationFrequencyDesc' : 'GoiAssociationFrequencyAsc';
    case 'coordinates':
      return current.desc ? 'GoiAssociationCoordinatesDesc' : 'GoiAssociationCoordinatesAsc';
    case 'category':
      return current.desc ? 'GoiAssociationCategoryDesc' : 'GoiAssociationCategoryAsc';
    case 'author':
      return current.desc ? 'GoiAssociationAuthorDesc' : 'GoiAssociationAuthorAsc';
    case 'createdAt':
      return current.desc ? 'GoiAssociationCreatedAtDesc' : 'GoiAssociationCreatedAtAsc';
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
    callSignsLabel: association.callSigns.length > 0 ? association.callSigns.join(', ') : '—',
  };
}

function defaultDateRange(): DateTimeRangeValue {
  const to = dayjs().tz(APP_TIME_ZONE);
  return {
    fromDateTimeStr: to.subtract(7, 'day').format('YYYY-MM-DDTHH:mm'),
    toDateTimeStr: to.format('YYYY-MM-DDTHH:mm'),
  };
}

export function useGoiAssociationsPage() {
  const tableStateContext = useTableStateContext();
  const [rows, setRows] = useState<GoiAssociationRowView[]>([]);
  const [status, setStatus] = useState<LoadingStatus>('idle');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<UiStatus>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [hasMore, setHasMore] = useState(false);
  const [dateRange, setDateRange] = useState<DateTimeRangeValue>(defaultDateRange);
  const [reporting, setReporting] = useState(false);
  const queryKey = useMemo(
    () =>
      JSON.stringify({
        globalFilter: tableStateContext.globalFilter,
        columnFilters: tableStateContext.columnFilters,
        sorting: tableStateContext.sorting,
        dateRange,
      }),
    [
      tableStateContext.globalFilter,
      tableStateContext.columnFilters,
      tableStateContext.sorting,
      dateRange,
    ],
  );
  const latestQueryKeyRef = useRef(queryKey);
  const loadMoreAbortControllerRef = useRef<AbortController | null>(null);

  latestQueryKeyRef.current = queryKey;

  const buildReq = (offset: number): ListGoiAssociationsReq => ({
    limit: 50,
    offset,
    sinceDateInclusiveMs: combineDateTimeInputToMs(dateRange.fromDateTimeStr, APP_TIME_ZONE),
    tillDateInclusiveMs: combineDateTimeInputToMs(dateRange.toDateTimeStr, APP_TIME_ZONE),
    sortBy: goiAssociationsSortBy(tableStateContext.sorting),
    filterText: tableStateContext.globalFilter.trim() || null,
    filterServer: getStringColumnFilterValue(tableStateContext.columnFilters, 'server') || null,
    filterFrequency:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'frequency') || null,
    filterCoordinates:
      getStringColumnFilterValue(tableStateContext.columnFilters, 'coordinates') || null,
    filterNote: getStringColumnFilterValue(tableStateContext.columnFilters, 'note') || null,
    filterCategory: getStringColumnFilterValue(tableStateContext.columnFilters, 'category') || null,
    filterAuthor: getStringColumnFilterValue(tableStateContext.columnFilters, 'author') || null,
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
    const timeout = window.setTimeout(
      async () => {
        if (!hasExistingRows) {
          setStatus('loading');
          setErrorMessage(null);
        } else {
          setRefreshing(true);
        }

        try {
          const rsp = await listCurrentUserGoiAssociations(buildReq(0), abortController.signal);
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
      },
      hasExistingRows ? 250 : 0,
    );

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
      const rsp = await listCurrentUserGoiAssociations(
        buildReq(rows.length),
        abortController.signal,
      );
      if (abortController.signal.aborted || latestQueryKeyRef.current !== requestQueryKey) {
        return;
      }
      setRows((prev) => [...prev, ...rsp.items.map(toRowView)]);
      setHasMore(rsp.hasMore);
      setNotice(null);
    } catch (error) {
      if (abortController.signal.aborted || isAbortError(error)) return;
      setNotice({ kind: 'error', text: formatErrorMessage(error) });
    } finally {
      if (loadMoreAbortControllerRef.current === abortController) {
        loadMoreAbortControllerRef.current = null;
      }
      if (!abortController.signal.aborted && latestQueryKeyRef.current === requestQueryKey) {
        setLoadingMore(false);
      }
    }
  }

  function onClearFilters() {
    tableStateContext.onChangeGlobalFilter('');
    tableStateContext.onColumnFiltersChange([]);
  }

  async function onLaunchReport() {
    if (reporting) return;
    setReporting(true);
    try {
      await launchGoiAssociationsReport(buildReq(0));
      setNotice({
        kind: 'success',
        text: 'Звіт поставлено в чергу. Стежити за прогресом і завантажити файл можна в «Мої звіти».',
      });
    } catch (error) {
      setNotice({ kind: 'error', text: formatErrorMessage(error) });
    } finally {
      setReporting(false);
    }
  }

  const hasActiveFilters =
    tableStateContext.globalFilter.trim() !== '' || tableStateContext.columnFilters.length > 0;

  return {
    rows,
    status,
    errorMessage,
    notice,
    refreshing,
    loadingMore,
    hasMore,
    dateRange,
    reporting,
    hasActiveFilters,
    onDateRangeChange: setDateRange,
    onLaunchReport,
    onLoadMore,
    onClearFilters,
  };
}
