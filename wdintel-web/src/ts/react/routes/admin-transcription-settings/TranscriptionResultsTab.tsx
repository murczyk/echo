import { Box, Chip, Stack } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtCustomCell,
  mrtTextCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../components/mui-customized/table/mrt-overflow';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listTranscriptionResults, type TranscriptionResult } from '../../services/api/transcriber';
import { AnalysisPaginationControl } from '../rer-analysis-neo/components/AnalysisPaginationControl';

const PAGE_SIZE = 100;

const DEFAULT_COLUMNS_VISIBILITY = {
  attachment: true,
  created_at: true,
  started_transcription_at: true,
  completion_time_seconds: true,
  status: true,
  instance: true,
  transcribed_value: true,
  error: true,
};

const DEFAULT_COLUMN_ORDER = [
  'mrt-row-numbers',
  'attachment',
  'created_at',
  'started_transcription_at',
  'completion_time_seconds',
  'status',
  'instance',
  'transcribed_value',
  'error',
];

const STATUS_LABELS: Record<string, string> = {
  queued: 'У черзі',
  processing: 'Транскрибується',
  retrying: 'Повторна спроба',
  completed: 'Завершено',
  terminal: 'Помилка',
};

function formatTimestamp(value: number | null): string {
  if (value === null) return '—';
  return new Date(value).toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCompletionTime(value: number | null): string {
  if (value === null) return '—';
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const seconds = value % 60;
  return [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(':');
}

function statusColor(status: string): 'default' | 'primary' | 'success' | 'error' | 'warning' {
  if (status === 'processing') return 'primary';
  if (status === 'completed') return 'success';
  if (status === 'terminal') return 'error';
  if (status === 'retrying') return 'warning';
  return 'default';
}

function buildColumns(): AppMrtColumnDef<TranscriptionResult>[] {
  return [
    {
      id: 'attachment',
      accessorFn: (row) => row.file_name ?? row.source_id,
      header: 'Вкладення',
      meta: { overflowMode: 'custom', overflowOwner: 'shared-text', interactive: true },
      Cell: mrtCustomCell(({ row }) => {
        const value = row.original.file_name ?? row.original.source_id;
        return (
          <MrtOverflowText
            displayValue={value}
            fullValue={value}
            interactive
            component="a"
            componentProps={{
              href: `/api/admin/transcriber/results/${encodeURIComponent(row.original.source_id)}/media`,
            }}
            sx={{ color: 'primary.main', fontWeight: 600, textDecoration: 'none' }}
          />
        );
      }),
    },
    {
      accessorKey: 'created_at',
      header: 'Створено',
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => formatTimestamp(row.original.created_at),
        fullValue: ({ row }) => formatTimestamp(row.original.created_at),
      }),
    },
    {
      accessorKey: 'started_transcription_at',
      header: 'Почато транскрибування',
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => formatTimestamp(row.original.started_transcription_at),
        fullValue: ({ row }) => formatTimestamp(row.original.started_transcription_at),
      }),
    },
    {
      accessorKey: 'completion_time_seconds',
      header: 'Час виконання',
      size: 140,
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => formatCompletionTime(row.original.completion_time_seconds),
        fullValue: ({ row }) => formatCompletionTime(row.original.completion_time_seconds),
      }),
    },
    {
      accessorKey: 'status',
      header: 'Статус',
      size: 160,
      meta: { overflowMode: 'none' },
      Cell: ({ row }) => (
        <Chip
          size="small"
          color={statusColor(row.original.status)}
          label={STATUS_LABELS[row.original.status] ?? row.original.status}
        />
      ),
    },
    {
      id: 'instance',
      accessorFn: (row) => row.instance_name ?? row.instance_id ?? '',
      header: 'Echo GPU інстанс',
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => row.original.instance_name ?? row.original.instance_id ?? '—',
        fullValue: ({ row }) => row.original.instance_name ?? row.original.instance_id ?? '—',
      }),
    },
    {
      accessorKey: 'transcribed_value',
      header: 'Транскрибоване значення',
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => row.original.transcribed_value ?? '—',
        fullValue: ({ row }) => row.original.transcribed_value ?? '—',
      }),
    },
    {
      accessorKey: 'error',
      header: 'Помилка',
      meta: { overflowMode: 'text' },
      Cell: mrtTextCell({
        displayValue: ({ row }) => row.original.error ?? '—',
        fullValue: ({ row }) => row.original.error ?? '—',
      }),
    },
  ];
}

function ResultsTable({ rows, loading }: { rows: TranscriptionResult[]; loading: boolean }) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo(buildColumns, []);
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<TranscriptionResult>(),
    columns,
    data: rows,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    globalFilterFn: 'contains',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    getColumnCanGlobalFilter: (column) => column.getIsVisible(),
    defaultColumn: { size: 200, renderColumnActionsMenuItems },
    displayColumnDefOptions: CUSTOM_STYLES.displayColumnDefOptions,
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading,
        layout: 'workspace',
        fullScreen: table.getState().isFullScreen,
        hasRows: rows.length > 0,
      }),
    state: {
      showAlertBanner: false,
      isLoading: loading && rows.length === 0,
      showProgressBars: loading,
      globalFilter: tableStateContext.globalFilter,
      columnVisibility: tableStateContext.columnVisibility,
      columnFilters: tableStateContext.columnFilters,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function ResultsPageBody() {
  const [rows, setRows] = useState<TranscriptionResult[]>([]);
  const [total, setTotal] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [pageIndex, setPageIndex] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPage = useCallback(async (nextPageIndex: number, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const result = await listTranscriptionResults(
        nextPageIndex * PAGE_SIZE,
        signal ? { signal } : undefined,
      );
      setRows(result.rows);
      setTotal(result.total);
      setHasMore(result.has_more);
      setPageIndex(nextPageIndex);
    } catch (nextError) {
      if (!signal?.aborted) {
        setError(`Помилка завантаження результатів транскрибації: ${errorMessage(nextError)}`);
      }
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const abortController = new AbortController();
    void loadPage(0, abortController.signal);
    return () => abortController.abort();
  }, [loadPage]);

  const lastPageIndex = Math.max(0, Math.ceil((total ?? 0) / PAGE_SIZE) - 1);
  return (
    <Stack spacing={3} useFlexGap sx={{ height: '100%', minHeight: 0, overflow: 'hidden' }}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <TablePageToolbar
        title="Результати транскрибації"
        withGlobalTextFilter
        hideGlobalTextFilter={loading && rows.length === 0}
        internalActionsDisabled={loading && rows.length === 0}
        actions={
          <>
            <AnalysisPaginationControl
              centerTab="messages"
              pageIndex={pageIndex}
              pageSize={PAGE_SIZE}
              messagesCount={rows.length}
              totalCount={total}
              totalLoading={loading && total === null}
              loading={loading}
              noMoreToLoad={!hasMore}
              busy={loading}
              onFirstPage={() => void loadPage(0)}
              onLastPage={() => void loadPage(lastPageIndex)}
              onPrevPage={() => void loadPage(pageIndex - 1)}
              onNextPage={() => void loadPage(pageIndex + 1)}
            />
            <PowerButton
              type="button"
              variant="outlined"
              disabled={loading}
              onClick={() => void loadPage(pageIndex)}
            >
              Оновити
            </PowerButton>
          </>
        }
      />
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <ResultsTable rows={rows} loading={loading} />
      </Box>
    </Stack>
  );
}

export function TranscriptionResultsTab() {
  return (
    <TableStateProvider
      tableId="admin-transcription-results"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMNS_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <ResultsPageBody />
    </TableStateProvider>
  );
}
