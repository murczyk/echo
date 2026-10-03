import { Box, Chip, Link, Stack, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AiPositionColumnFilter,
  AiPositionKnowledgeItem,
  AiPositionListCursor,
} from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { usePowerSnackbar } from '../../components/PowerSnackbar';
import { TablePageToolbar } from '../../components/TablePageToolbar';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  buildExplicitSingleSelectColumnFilter,
  getDefaultMRTOptions,
  mrtCustomCell,
  renderColumnActionsMenuItems,
  useAppMaterialReactTable,
  withExplicitSelectAllOption,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../components/mui-customized/table/table-state-provider';
import { listAiPositionKnowledge } from '../../services/api/ai-positions';
import { KIND_LABELS, VERDICT_LABELS } from './feedback';

const PAGE_SIZE = 50;
const FILTER_COLUMNS = new Set(['name', 'kind', 'scope', 'conflicting', 'certainty', 'feedback']);
const SCOPE_OPTIONS = withExplicitSelectAllOption([
  { text: 'район відповідальності', value: 'aor' },
  { text: 'група', value: 'group' },
]);
const YES_NO_OPTIONS = withExplicitSelectAllOption([
  { text: 'так', value: 'так' },
  { text: 'ні', value: 'ні' },
]);
const CERTAINTY_OPTIONS = withExplicitSelectAllOption([
  { text: 'висока', value: 'high' },
  { text: 'середня', value: 'medium' },
  { text: 'низька', value: 'low' },
]);
const FEEDBACK_OPTIONS = withExplicitSelectAllOption([
  { text: 'є', value: 'є' },
  { text: 'немає', value: 'немає' },
]);
const KIND_OPTIONS = withExplicitSelectAllOption(
  Object.entries(KIND_LABELS).map(([value, text]) => ({ text, value })),
);
const CERTAINTY_LABELS: Record<string, string> = {
  high: 'висока',
  medium: 'середня',
  low: 'низька',
};
const DEFAULT_COLUMN_ORDER = [
  'name',
  'kind',
  'scope',
  'location',
  'certainty',
  'conflicting',
  'factCount',
  'lastFactAt',
  'feedback',
];

type QueryState = { globalFilter: string; columnFilters: AiPositionColumnFilter[] };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function selectFilter(options: typeof SCOPE_OPTIONS) {
  return {
    filterVariant: 'select' as const,
    filterSelectOptions: options,
    Filter: buildExplicitSingleSelectColumnFilter<AiPositionKnowledgeItem>({
      options,
      fallbackValue: 'Усі',
      onChange: (column, nextValue) =>
        column.setFilterValue(nextValue === 'Усі' ? undefined : nextValue),
    }),
  };
}

function buildColumns(): AppMrtColumnDef<AiPositionKnowledgeItem>[] {
  return [
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Позиція',
      size: 180,
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => (
        <Link href={`/admin/ai/positions/${row.original.id}`}>{row.original.name}</Link>
      )),
    },
    {
      id: 'kind',
      accessorKey: 'kind',
      header: 'Тип',
      size: 130,
      ...selectFilter(KIND_OPTIONS),
      meta: { overflowMode: 'none' },
      Cell: ({ row }) => (
        <Chip size="small" label={KIND_LABELS[row.original.kind] ?? row.original.kind} />
      ),
    },
    {
      id: 'scope',
      accessorFn: (row) => row.scopeKind,
      header: 'Де відомо',
      size: 220,
      ...selectFilter(SCOPE_OPTIONS),
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => (
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="body2">
            {row.original.scopeKind === 'aor' ? 'РВ' : 'Група'}: {row.original.scopeName || '—'}
          </Typography>
          {row.original.scopeIsSecret ? <Chip size="small" label="приватна" /> : null}
        </Stack>
      )),
    },
    {
      id: 'location',
      accessorKey: 'mgrs',
      header: 'Координати',
      size: 240,
      enableColumnFilter: false,
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => (
        <Box>
          <Typography variant="body2">{row.original.mgrs}</Typography>
          <Typography variant="caption" color="text.secondary">
            {row.original.lat.toFixed(5)}, {row.original.lng.toFixed(5)}
          </Typography>
        </Box>
      )),
    },
    {
      id: 'certainty',
      accessorKey: 'certainty',
      header: 'Впевненість',
      size: 130,
      ...selectFilter(CERTAINTY_OPTIONS),
      meta: { overflowMode: 'none' },
      Cell: ({ row }) => <Chip size="small" label={CERTAINTY_LABELS[row.original.certainty]} />,
    },
    {
      id: 'conflicting',
      accessorFn: (row) => (row.conflicting ? 'так' : 'ні'),
      header: 'Розбіжності',
      size: 130,
      ...selectFilter(YES_NO_OPTIONS),
    },
    {
      id: 'factCount',
      accessorKey: 'factCount',
      header: 'Підтверджень',
      size: 120,
      enableColumnFilter: false,
    },
    {
      id: 'feedback',
      accessorFn: (row) => (row.feedback.length > 0 ? 'є' : 'немає'),
      header: 'Відгук',
      size: 180,
      ...selectFilter(FEEDBACK_OPTIONS),
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => (
        <Stack direction="row" spacing={0.5} flexWrap="wrap" useFlexGap>
          {row.original.feedback.length === 0 ? (
            <Typography color="text.secondary">—</Typography>
          ) : (
            row.original.feedback.map((item) => (
              <Chip
                key={item.id}
                size="small"
                color={item.verdict === 'correct' ? 'success' : 'warning'}
                label={VERDICT_LABELS[item.verdict] ?? item.verdict}
              />
            ))
          )}
        </Stack>
      )),
    },
    {
      id: 'lastFactAt',
      accessorFn: (row) => new Date(row.lastFactAt).toLocaleString('uk-UA'),
      header: 'Останнє',
      size: 170,
      enableColumnFilter: false,
    },
  ];
}

function KnowledgeTable({
  rows,
  loading,
  onQueryStateChange,
}: {
  rows: AiPositionKnowledgeItem[];
  loading: boolean;
  onQueryStateChange: (queryState: QueryState) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo(buildColumns, []);
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<AiPositionKnowledgeItem>(),
    columns,
    data: rows,
    getRowId: (row) => String(row.id),
    enableSorting: false,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableRowVirtualization: false,
    manualFiltering: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
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
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  useEffect(() => {
    onQueryStateChange({
      globalFilter: tableStateContext.globalFilter ?? '',
      columnFilters: (tableStateContext.columnFilters as Array<{ id: string; value: unknown }>)
        .filter((filter) => FILTER_COLUMNS.has(filter.id) && filter.value != null)
        .map((filter) => ({ id: filter.id, value: String(filter.value) })),
    });
  }, [onQueryStateChange, tableStateContext.columnFilters, tableStateContext.globalFilter]);

  return <MaterialReactTable table={table} />;
}

function KnowledgeBody() {
  const { notify } = usePowerSnackbar();
  const [rows, setRows] = useState<AiPositionKnowledgeItem[]>([]);
  const [nextCursor, setNextCursor] = useState<AiPositionListCursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [queryState, setQueryState] = useState<QueryState>({ globalFilter: '', columnFilters: [] });
  const activeRequestRef = useRef<AbortController | null>(null);

  const load = useCallback(
    async (after: AiPositionListCursor | null) => {
      activeRequestRef.current?.abort();
      const abortController = new AbortController();
      activeRequestRef.current = abortController;
      setLoading(true);
      setError(null);
      try {
        const response = await listAiPositionKnowledge(
          {
            limit: PAGE_SIZE,
            after,
            globalFilter: queryState.globalFilter || null,
            columnFilters: queryState.columnFilters,
          },
          abortController.signal,
        );
        if (abortController.signal.aborted) return;
        setRows((current) => (after ? [...current, ...response.items] : response.items));
        setNextCursor(response.nextCursor);
      } catch (nextError) {
        if (abortController.signal.aborted) return;
        const message = `Не вдалося завантажити відомі позиції: ${errorMessage(nextError)}`;
        setError(message);
        notify({ severity: 'error', message });
      } finally {
        if (activeRequestRef.current === abortController) {
          activeRequestRef.current = null;
          setLoading(false);
        }
      }
    },
    [notify, queryState],
  );

  useEffect(() => {
    void load(null);
    return () => {
      activeRequestRef.current?.abort();
      activeRequestRef.current = null;
    };
  }, [load]);

  const handleQueryStateChange = useCallback((next: QueryState) => {
    setQueryState((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
  }, []);

  return (
    <Stack spacing={2} useFlexGap sx={{ height: '100%', minHeight: 0 }}>
      {error ? <PowerAlert severity="error">{error}</PowerAlert> : null}
      <TablePageToolbar
        title="Відомі позиції"
        withGlobalTextFilter
        actions={
          <PowerButton variant="outlined" disabled={loading} onClick={() => void load(null)}>
            Оновити
          </PowerButton>
        }
      />
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <KnowledgeTable rows={rows} loading={loading} onQueryStateChange={handleQueryStateChange} />
      </Box>
      {nextCursor ? (
        <Box>
          <PowerButton variant="outlined" disabled={loading} onClick={() => void load(nextCursor)}>
            Завантажити ще
          </PowerButton>
        </Box>
      ) : null}
    </Stack>
  );
}

export function KnowledgeTab() {
  return (
    <TableStateProvider
      tableId="admin-ai-position-knowledge"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={{}}
      defaultEnableColumnOrdering={false}
    >
      <KnowledgeBody />
    </TableStateProvider>
  );
}
