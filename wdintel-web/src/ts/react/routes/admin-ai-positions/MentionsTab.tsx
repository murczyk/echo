import { Box, Chip, Link, Stack, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type {
  AiPositionColumnFilter,
  AiPositionCoordinateItem,
  AiPositionListCursor,
  AiPositionMentionItem,
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
import { listAiPositionMentions } from '../../services/api/ai-positions';

const PAGE_SIZE = 50;
const FILTER_COLUMNS = new Set(['name', 'source', 'hasCoordinates', 'certainty']);

const HAS_COORDINATES_OPTIONS = withExplicitSelectAllOption([
  { text: 'так', value: 'так' },
  { text: 'ні', value: 'ні' },
]);
const SOURCE_OPTIONS = withExplicitSelectAllOption([
  { text: 'повідомлення', value: 'message' },
  { text: 'документ', value: 'document' },
]);
const CERTAINTY_OPTIONS = withExplicitSelectAllOption([
  { text: 'висока', value: 'high' },
  { text: 'середня', value: 'medium' },
  { text: 'низька', value: 'low' },
]);
const CERTAINTY_LABELS: Record<string, string> = {
  high: 'висока',
  medium: 'середня',
  low: 'низька',
};

const DEFAULT_COLUMN_ORDER = [
  'messageAt',
  'name',
  'source',
  'context',
  'hasCoordinates',
  'certainty',
  'modelName',
];
const DEFAULT_COLUMN_VISIBILITY = { modelName: false };

type QueryState = { globalFilter: string; columnFilters: AiPositionColumnFilter[] };

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message ? error.message : String(error);
}

function formatDateTime(millis: number): string {
  return new Date(millis).toLocaleString('uk-UA');
}

function selectFilter(options: typeof SOURCE_OPTIONS) {
  return {
    filterVariant: 'select' as const,
    filterSelectOptions: options,
    Filter: buildExplicitSingleSelectColumnFilter<AiPositionMentionItem>({
      options,
      fallbackValue: 'Усі',
      onChange: (column, nextValue) =>
        column.setFilterValue(nextValue === 'Усі' ? undefined : nextValue),
    }),
  };
}

function CoordinateList({ coordinates }: { coordinates: AiPositionCoordinateItem[] }) {
  if (coordinates.length === 0) return <Typography color="text.secondary">—</Typography>;
  return (
    <Stack spacing={0.5}>
      {coordinates.map((coordinate) => (
        <Box key={coordinate.mgrs} title={coordinate.evidence}>
          <Typography variant="body2">{coordinate.text}</Typography>
          <Typography variant="caption" color="text.secondary">
            {coordinate.lat.toFixed(5)}, {coordinate.lng.toFixed(5)} · {coordinate.mgrs}
          </Typography>
        </Box>
      ))}
    </Stack>
  );
}

function bestCertainty(coordinates: AiPositionCoordinateItem[]): string | null {
  return (
    ['high', 'medium', 'low'].find((level) =>
      coordinates.some((coordinate) => coordinate.certainty === level),
    ) ?? null
  );
}

function buildColumns(): AppMrtColumnDef<AiPositionMentionItem>[] {
  return [
    {
      id: 'messageAt',
      accessorFn: (row) => formatDateTime(row.messageAt),
      header: 'Час',
      size: 170,
      enableColumnFilter: false,
    },
    {
      id: 'name',
      accessorKey: 'name',
      header: 'Позиція',
      size: 180,
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => (
        <Stack>
          <Typography variant="body2" fontWeight={600}>
            {row.original.name}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            {row.original.nameKey}
          </Typography>
        </Stack>
      )),
    },
    {
      id: 'source',
      accessorFn: (row) => (row.sourceKind === 'message' ? 'message' : 'document'),
      header: 'Джерело',
      size: 160,
      ...selectFilter(SOURCE_OPTIONS),
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => {
        const label =
          row.original.sourceKind === 'message'
            ? 'Повідомлення'
            : `Документ${row.original.mediaName ? `: ${row.original.mediaName}` : ''}`;
        const secret = row.original.groupIsSecret ? (
          <Chip size="small" label="приватна група" sx={{ ml: 1 }} />
        ) : null;
        return row.original.messageUuid ? (
          <Link
            href={`/rer-analysis-neo?m=${encodeURIComponent(row.original.messageUuid)}`}
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
            {secret}
          </Link>
        ) : (
          <span>
            {label}
            {secret}
          </span>
        );
      }),
    },
    {
      id: 'context',
      accessorFn: (row) => `${row.contextBefore}${row.contextMatch}${row.contextAfter}`,
      header: 'Контекст',
      size: 420,
      enableColumnFilter: false,
      meta: { overflowMode: 'wrap' },
      Cell: ({ row }) => (
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {row.original.contextBefore}
          <mark>{row.original.contextMatch}</mark>
          {row.original.contextAfter}
        </Typography>
      ),
    },
    {
      id: 'hasCoordinates',
      accessorFn: (row) => (row.coordinates.length > 0 ? 'так' : 'ні'),
      header: 'Координати',
      size: 260,
      ...selectFilter(HAS_COORDINATES_OPTIONS),
      meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
      Cell: mrtCustomCell(({ row }) => <CoordinateList coordinates={row.original.coordinates} />),
    },
    {
      id: 'certainty',
      accessorFn: (row) => bestCertainty(row.coordinates) ?? '',
      header: 'Впевненість',
      size: 130,
      ...selectFilter(CERTAINTY_OPTIONS),
      meta: { overflowMode: 'none' },
      Cell: ({ row }) => {
        const certainty = bestCertainty(row.original.coordinates);
        return certainty ? (
          <Chip
            size="small"
            label={CERTAINTY_LABELS[certainty]}
            color={
              certainty === 'high' ? 'success' : certainty === 'medium' ? 'warning' : 'default'
            }
          />
        ) : null;
      },
    },
    {
      id: 'modelName',
      accessorKey: 'modelName',
      header: 'Модель',
      size: 160,
      enableColumnFilter: false,
    },
  ];
}

function MentionsTable({
  rows,
  loading,
  onQueryStateChange,
}: {
  rows: AiPositionMentionItem[];
  loading: boolean;
  onQueryStateChange: (queryState: QueryState) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo(buildColumns, []);
  const table = useAppMaterialReactTable({
    ...getDefaultMRTOptions<AiPositionMentionItem>(),
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

function MentionsBody() {
  const { notify } = usePowerSnackbar();
  const [rows, setRows] = useState<AiPositionMentionItem[]>([]);
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
        const response = await listAiPositionMentions(
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
        const message = `Не вдалося завантажити позиції: ${errorMessage(nextError)}`;
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
        title="Позиції у повідомленнях"
        withGlobalTextFilter
        actions={
          <PowerButton variant="outlined" disabled={loading} onClick={() => void load(null)}>
            Оновити
          </PowerButton>
        }
      />
      <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex' }}>
        <MentionsTable rows={rows} loading={loading} onQueryStateChange={handleQueryStateChange} />
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

export function MentionsTab() {
  return (
    <TableStateProvider
      tableId="admin-ai-positions"
      defaultColumnOrder={DEFAULT_COLUMN_ORDER}
      defaultColumnVisibility={DEFAULT_COLUMN_VISIBILITY}
      defaultEnableColumnOrdering={false}
    >
      <MentionsBody />
    </TableStateProvider>
  );
}
