import ChecklistIcon from '@mui/icons-material/Checklist';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined';
import StarIcon from '@mui/icons-material/Star';
import { Box, Button, Skeleton, Stack, Tooltip, Typography } from '@mui/material';
import { useCallback, useEffect, useMemo } from 'react';
import {
  MaterialReactTable,
  type MRT_ColumnOrderState,
  type MRT_RowSelectionState,
  type MRT_Updater,
} from 'material-react-table';

import type { NetworkFreqCallsignsPeriod } from '../../../../../Bindings';
import type {
  NetworkCallsignMarkerMode,
  NetworkCallsignRowView,
  NetworkCallsignStatusFilter,
} from '../network-callsigns.types';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtCustomCell,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { MrtOverflowText } from '../../../components/mui-customized/table/mrt-overflow';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import { renderMrtCellTextValue } from '../../../components/mui-customized/table/mrt-cell-text';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../../components/mui-customized/table/table-state-provider';
import { NO_DATA_LABEL } from '../../../utils/misc';
import {
  buildNetworkColumnOrder,
  buildNetworkLoadingRows,
  compareCallsignRowsBySorting,
  CountChipLabel,
  getPrimaryCallsignSortingItem,
  NETWORK_STATUS_FILTER_LABELS,
  NETWORK_STATUS_FILTER_ORDER,
  NETWORK_CALLSIGN_COLUMN_SIZES,
  NETWORK_COLUMNS_VISIBILITY,
} from './NetworkCallsignsTableShared';
import { NetworkCallsignSourceCell } from './NetworkCallsignSourceUi';
import { NetworkCallsignStatusDot } from './NetworkCallsignStatusUi';
import { countNetworkCallsignStatusRows } from '../network-callsigns.rows';
import { formatNetworkCallsignDatetime } from '../network-callsigns.search';
import { formatNetworkCallsignStatsPeriodSuffix } from '../network-callsigns.stats';
import { ROW_REMOVAL_ANIMATION_MS } from '../use-animated-row-removal';
import { NetworkFreqCallsignPeriodSettings } from './NetworkFreqCallsignPeriodSettings';

const defaultMRTOptions = getDefaultMRTOptions<NetworkCallsignRowView>();
const NETWORK_MRT_LOCALIZATION = {
  ...defaultMRTOptions.localization,
  rowNumbers: 'Номер рядка',
};
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps =
  typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
const ROW_SELECT_COLUMN_ID = 'mrt-row-select';
const NETWORK_DATA_COLUMN_IDS = [
  'callsign',
  'position',
  'fullName',
  'unitName',
  'lastDatetime',
  'messageCount',
  'comment',
  'sourceName',
];
const EXITING_ROW_SX = {
  opacity: 0,
  transition: `opacity ${ROW_REMOVAL_ANIMATION_MS}ms ease-out`,
  '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
};

export type NetworkCallsignSelection = {
  active: boolean;
  selectedIds: number[];
  onSelectedIdsChange: (ids: number[]) => void;
  onEnter: () => void;
  onExit: () => void;
  onRequestDelete: () => void;
  deleteInFlight: boolean;
};

function resolveUpdater<T>(updater: MRT_Updater<T>, current: T): T {
  return typeof updater === 'function' ? (updater as (value: T) => T)(current) : updater;
}

function withoutRowSelectColumn(columnOrder: MRT_ColumnOrderState): MRT_ColumnOrderState {
  return columnOrder.filter((columnId) => columnId !== ROW_SELECT_COLUMN_ID);
}

export type NetworkCallsignsTableStats = {
  loading: boolean;
  /** False while loading or after a failure, when a zero would be misleading. */
  available: boolean;
  period: NetworkFreqCallsignsPeriod | null;
  error: string | null;
  exitingRowIds: ReadonlySet<number>;
  /** Rows the loaded stats cannot describe yet. */
  unknownRowIds: ReadonlySet<number>;
  onRetry: () => void;
  onLoadAllTime: () => void;
};

function getMainMarkerActionLabel(networkCallsign: NetworkCallsignRowView): string {
  return networkCallsign.mainRadioStation ? 'Зняти головну' : 'Зробити головною';
}

function getCommandMarkerActionLabel(networkCallsign: NetworkCallsignRowView): string {
  return networkCallsign.commandControl ? 'Зняти ланку управління' : 'Зробити ланкою управління';
}

function buildStatsColumnCell(
  loading: boolean,
  textCell: ReturnType<typeof mrtTextCell<NetworkCallsignRowView>>,
) {
  if (!loading) return { meta: { overflowMode: 'text' as const }, Cell: textCell };
  return {
    meta: { overflowMode: 'custom' as const, overflowOwner: 'structured-layout' as const },
    Cell: mrtCustomCell<NetworkCallsignRowView>(() => <Skeleton variant="text" width="70%" />),
  };
}

function getNetworkStatusFilterCount(
  filter: NetworkCallsignStatusFilter,
  statusCounts: ReturnType<typeof countNetworkCallsignStatusRows>,
) {
  if (filter === 'All') return statusCounts.all;
  if (filter === 'Developing') return statusCounts.developing;
  if (filter === 'Catalog') return statusCounts.catalog;
  return statusCounts.unknown;
}

type Props = {
  title: string;
  countLabel?: string;
  rows: NetworkCallsignRowView[];
  loading: boolean;
  loadingError: string | null;
  canManage: boolean;
  statusFilter: NetworkCallsignStatusFilter;
  onStatusFilterChange: (next: NetworkCallsignStatusFilter) => void;
  period: NetworkFreqCallsignsPeriod;
  periodSettingsDisabled: boolean;
  onPeriodChange: (period: NetworkFreqCallsignsPeriod) => void;
  stats: NetworkCallsignsTableStats;
  onOpenEditDrawer: (row: NetworkCallsignRowView) => void;
  onOpenDeleteDialog: (row: NetworkCallsignRowView) => void;
  onSetMarkerMode: (row: NetworkCallsignRowView, markerMode: NetworkCallsignMarkerMode) => void;
  onReload: () => void;
  inFlightUpdateIds: number[];
  inFlightDeleteIds: number[];
  selection: NetworkCallsignSelection;
};

export function NetworkCallsignDecoratedCell({ row }: { row: NetworkCallsignRowView }) {
  const callsign = formatMrtCellTextValue(row.callsign);

  return (
    <Stack
      direction="row"
      spacing={1.25}
      alignItems="center"
      sx={{ width: '100%', minWidth: 0, maxWidth: '100%', overflow: 'hidden' }}
    >
      <NetworkCallsignStatusDot statusLabel={row.statusLabel} status={row.status} />
      <MrtOverflowText
        displayValue={callsign}
        fullValue={callsign}
        sx={{ minWidth: 0, flex: '1 1 auto', typography: 'body2', fontWeight: 700 }}
      />
      {row.mainRadioStation ? (
        <Tooltip title="Головна радіостанція" arrow>
          <StarIcon fontSize="small" sx={{ color: 'warning.main', flexShrink: 0 }} />
        </Tooltip>
      ) : null}
      {row.commandControl ? (
        <Tooltip title="Ланка управління" arrow>
          <MilitaryTechOutlinedIcon fontSize="small" sx={{ color: 'info.main', flexShrink: 0 }} />
        </Tooltip>
      ) : null}
    </Stack>
  );
}

export function createNetworkCallsignColumn(): AppMrtColumnDef<NetworkCallsignRowView> {
  return {
    header: 'Позивний',
    accessorKey: 'callsign',
    id: 'callsign',
    size: NETWORK_CALLSIGN_COLUMN_SIZES.callsign,
    enableSorting: true,
    meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
    Cell: mrtCustomCell(({ row }) => <NetworkCallsignDecoratedCell row={row.original} />),
  };
}

export function NetworkCallsignsNetworkTable({
  title,
  countLabel,
  rows,
  loading,
  loadingError,
  canManage,
  statusFilter,
  onStatusFilterChange,
  period,
  periodSettingsDisabled,
  onPeriodChange,
  stats,
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onSetMarkerMode,
  onReload,
  inFlightUpdateIds,
  inFlightDeleteIds,
  selection,
}: Props) {
  return (
    <TableStateProvider
      tableId="network-details-callsigns"
      defaultColumnVisibility={{ ...NETWORK_COLUMNS_VISIBILITY, 'mrt-row-numbers': true }}
      defaultColumnOrder={buildNetworkColumnOrder({ dataColumnIds: NETWORK_DATA_COLUMN_IDS })}
    >
      <NetworkCallsignsNetworkTableContent
        title={title}
        countLabel={countLabel}
        rows={rows}
        loading={loading}
        loadingError={loadingError}
        canManage={canManage}
        statusFilter={statusFilter}
        onStatusFilterChange={onStatusFilterChange}
        period={period}
        periodSettingsDisabled={periodSettingsDisabled}
        onPeriodChange={onPeriodChange}
        stats={stats}
        onOpenEditDrawer={onOpenEditDrawer}
        onOpenDeleteDialog={onOpenDeleteDialog}
        onSetMarkerMode={onSetMarkerMode}
        onReload={onReload}
        inFlightUpdateIds={inFlightUpdateIds}
        inFlightDeleteIds={inFlightDeleteIds}
        selection={selection}
      />
    </TableStateProvider>
  );
}

function NetworkCallsignsNetworkTableContent({
  title,
  countLabel,
  rows,
  loading,
  loadingError,
  canManage,
  statusFilter,
  onStatusFilterChange,
  period,
  periodSettingsDisabled,
  onPeriodChange,
  stats,
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onSetMarkerMode,
  onReload,
  inFlightUpdateIds,
  inFlightDeleteIds,
  selection,
}: Props) {
  const tableStateContext = useTableStateContext();

  const visibleRows = useMemo(() => rows, [rows]);
  const normalizedStatusFilter = NETWORK_STATUS_FILTER_ORDER.includes(statusFilter)
    ? statusFilter
    : 'All';
  const tableStateRows = useMemo(() => {
    const filtered =
      normalizedStatusFilter === 'All'
        ? visibleRows
        : visibleRows.filter((row) =>
            normalizedStatusFilter === 'Developing'
              ? row.status === 'developing'
              : normalizedStatusFilter === 'Catalog'
                ? row.status === 'catalog'
                : row.status === 'unknown',
          );

    const primarySorting = getPrimaryCallsignSortingItem(tableStateContext.sorting);
    const intraGroupCmp = (a: NetworkCallsignRowView, b: NetworkCallsignRowView) => {
      if (primarySorting) return compareCallsignRowsBySorting(a, b, primarySorting);
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      if ((b.lastDatetime ?? 0) !== (a.lastDatetime ?? 0))
        return (b.lastDatetime ?? 0) - (a.lastDatetime ?? 0);
      return a.callsign.localeCompare(b.callsign, 'uk');
    };

    const copy = filtered.slice();
    const mainGroup = copy
      .filter((r) => r.mainRadioStation)
      .slice()
      .sort(intraGroupCmp);
    const rest = copy.filter((r) => !r.mainRadioStation);
    const commandGroup = rest
      .filter((r) => r.commandControl)
      .slice()
      .sort(intraGroupCmp);
    const otherGroup = rest
      .filter((r) => !r.commandControl)
      .slice()
      .sort(intraGroupCmp);

    return [...mainGroup, ...commandGroup, ...otherGroup];
  }, [normalizedStatusFilter, tableStateContext.sorting, visibleRows]);

  const statusCounts = useMemo(() => countNetworkCallsignStatusRows(visibleRows), [visibleRows]);
  const isInitialLoading = loading && rows.length === 0;
  const isBusy = loading || inFlightUpdateIds.length > 0 || inFlightDeleteIds.length > 0;
  const loadingRows = useMemo(() => buildNetworkLoadingRows(), []);
  const titleCountLabel = countLabel ?? (isInitialLoading ? NO_DATA_LABEL : null);
  const statsHeaderSuffix = formatNetworkCallsignStatsPeriodSuffix(stats.period);
  const formatStatsCount = useCallback(
    (row: NetworkCallsignRowView) =>
      stats.available && !stats.unknownRowIds.has(row.id)
        ? String(row.messageCount)
        : NO_DATA_LABEL,
    [stats.available, stats.unknownRowIds],
  );
  const selectionActive = selection.active && canManage && !isInitialLoading;
  const { rowSelection, columnOrder, onColumnOrderChange, onRowSelectionChange } =
    useNetworkCallsignRowSelection({
      selection,
      selectionActive,
      rows: tableStateRows,
      columnOrder: tableStateContext.columnOrder,
      onColumnOrderChange: tableStateContext.onColumnOrderChange,
    });
  const columns = useMemo<AppMrtColumnDef<NetworkCallsignRowView>[]>(
    () => [
      createNetworkCallsignColumn(),
      {
        header: 'ПІП',
        accessorKey: 'fullName',
        id: 'fullName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.fullName,
        enableSorting: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.fullName),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.fullName),
        }),
      },
      {
        header: 'Посада',
        accessorKey: 'position',
        id: 'position',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.position,
        enableSorting: true,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.position),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.position),
        }),
      },
      {
        header: 'Підрозділ',
        accessorKey: 'unitName',
        id: 'unitName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.unitName,
        enableSorting: true,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.unitName),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.unitName),
        }),
      },
      {
        header: `Остання акт.${statsHeaderSuffix}`,
        accessorFn: (row) => row.lastDatetime,
        id: 'lastDatetime',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.lastDatetime,
        enableSorting: true,
        ...buildStatsColumnCell(
          stats.loading,
          mrtTextCell({
            displayValue: ({ row }) => formatNetworkCallsignDatetime(row.original.lastDatetime),
            fullValue: ({ row }) => formatNetworkCallsignDatetime(row.original.lastDatetime),
          }),
        ),
      },
      {
        header: `К-сть${statsHeaderSuffix}`,
        accessorKey: 'messageCount',
        id: 'messageCount',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.messageCount,
        enableSorting: true,
        ...buildStatsColumnCell(
          stats.loading,
          mrtTextCell({
            displayValue: ({ row }) => formatStatsCount(row.original),
            fullValue: ({ row }) => formatStatsCount(row.original),
          }),
        ),
      },
      {
        header: 'Коментар',
        accessorKey: 'comment',
        id: 'comment',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.comment,
        enableSorting: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.comment),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.comment),
        }),
      },
      {
        header: 'Джерело',
        accessorKey: 'sourceName',
        id: 'sourceName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.sourceName,
        grow: false,
        enableResizing: false,
        enableSorting: true,
        meta: { overflowMode: 'custom', overflowOwner: 'structured-layout' },
        Cell: mrtCustomCell(({ row }) => (
          <NetworkCallsignSourceCell sourceName={row.original.sourceName} />
        )),
      },
    ],
    [formatStatsCount, statsHeaderSuffix, stats.loading],
  );

  const table = useAppMaterialReactTable({
    columns,
    data: isInitialLoading ? loadingRows : tableStateRows,
    localization: NETWORK_MRT_LOCALIZATION,
    enableColumnActions: true,
    enableRowSelection: selectionActive ? () => !selection.deleteInFlight : false,
    enableMultiRowSelection: true,
    enableSelectAll: true,
    onRowSelectionChange,
    enableRowNumbers: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    enableColumnFilters: true,
    columnFilterDisplayMode: 'popover',
    enableGlobalFilter: false,
    enableSorting: true,
    manualSorting: true,
    enableMultiSort: false,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableHiding: true,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    renderRowActions: ({ row }) => {
      if (isInitialLoading) return <Box sx={{ minHeight: 28 }} />;
      const networkCallsign = row.original;
      if (!canManage) return <Box sx={{ minHeight: 28 }} />;
      const editDisabled = inFlightUpdateIds.includes(networkCallsign.id);
      const markerDisabled = editDisabled;
      return (
        <MrtRowActions>
          <MrtRowActionButton
            onClick={() => onOpenEditDrawer(networkCallsign)}
            disabled={editDisabled}
            icon={<EditIcon fontSize="small" />}
            label="Редагувати позивний"
            opensModal
          />
          <MrtRowActionButton
            label={getMainMarkerActionLabel(networkCallsign)}
            onClick={() =>
              onSetMarkerMode(
                networkCallsign,
                networkCallsign.mainRadioStation ? 'none' : 'mainRadioStation',
              )
            }
            disabled={markerDisabled}
            icon={<StarIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label={getCommandMarkerActionLabel(networkCallsign)}
            onClick={() =>
              onSetMarkerMode(
                networkCallsign,
                networkCallsign.commandControl ? 'none' : 'commandControl',
              )
            }
            disabled={markerDisabled}
            icon={<MilitaryTechOutlinedIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="Видалити"
            onClick={() => onOpenDeleteDialog(networkCallsign)}
            disabled={inFlightDeleteIds.includes(networkCallsign.id)}
            icon={<DeleteIcon fontSize="small" />}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
      );
    },
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        externalHasFilters: normalizedStatusFilter !== 'All',
        noDataMessage: loadingError
          ? 'Не вдалося завантажити позивні мережі'
          : 'Позивні мережі відсутні',
        noDataActionLabel: loadingError ? 'Спробувати ще раз' : undefined,
        onNoDataAction: loadingError ? onReload : undefined,
        filteredMessage: 'Немає позивних за обраним статусом',
        onClearFilters:
          normalizedStatusFilter !== 'All'
            ? () => {
                table.setColumnFilters([]);
                table.setGlobalFilter('');
                onStatusFilterChange('All');
              }
            : undefined,
      }),
    state: {
      isLoading: isBusy && !isInitialLoading,
      showLoadingOverlay: isBusy && !isInitialLoading,
      showSkeletons: isInitialLoading,
      columnOrder,
      rowSelection,
      columnVisibility: tableStateContext.columnVisibility,
      columnSizing: tableStateContext.columnSizing,
      density: tableStateContext.density,
      sorting: tableStateContext.sorting,
    },
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
    muiTablePaperProps: ({ table }) => ({
      ...((resolvedPaperProps({ table }) as object) ?? {}),
      sx: {
        ...((resolvedPaperProps({ table }) as { sx?: object }).sx ?? {}),
        ...FULL_WIDTH_TABLE_PAPER_SX,
        width: '100%',
        maxWidth: '100%',
        height: '100%',
        minHeight: 0,
        minWidth: 0,
        overflow: table.getState().isFullScreen ? 'auto' : 'hidden',
        border: '1px solid',
        borderColor: 'divider',
        borderRadius: 0,
        boxShadow: 'none',
      },
      style: {
        ...((resolvedPaperProps({ table }) as { style?: object }).style ?? {}),
        padding: 0,
      },
    }),
    muiTableContainerProps: {
      sx: getPageScrollTableContainerSx({
        loading: isBusy,
        height: '100%',
        minHeight: 0,
        idleOverflowX: 'auto',
        idleOverflowY: 'auto',
      }),
    },
    initialState: {
      density: 'comfortable',
      columnOrder: buildNetworkColumnOrder({ dataColumnIds: NETWORK_DATA_COLUMN_IDS }),
      columnVisibility: NETWORK_COLUMNS_VISIBILITY,
    },
    muiTableBodyRowProps: ({ row }) => ({
      sx: stats.exitingRowIds.has(row.original.id) ? EXITING_ROW_SX : undefined,
    }),
    getRowId: (row) => String(row.id),
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  const visibleSelectedIds = selectionActive
    ? table
        .getFilteredRowModel()
        .rows.map((row) => row.original.id)
        .filter((id) => rowSelection[String(id)])
    : [];
  usePruneHiddenSelection(selection, selectionActive, visibleSelectedIds);

  return (
    <Box
      sx={{
        minHeight: 0,
        minWidth: 0,
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        width: '100%',
      }}
    >
      <Stack spacing={2} sx={{ minHeight: 0, flex: 1 }}>
        <Stack spacing={1.25} sx={{ mt: 0 }}>
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 2,
              flexWrap: 'wrap',
              minWidth: 0,
            }}
          >
            <Stack
              direction="row"
              spacing={1}
              alignItems="center"
              useFlexGap
              sx={{ flexWrap: 'wrap', minWidth: 0 }}
            >
              <Stack
                direction="row"
                spacing={1.25}
                alignItems="baseline"
                sx={{ flexWrap: 'wrap', minWidth: 0 }}
              >
                <Typography variant="h6">{title}</Typography>
                {titleCountLabel !== null ? (
                  <Typography variant="body2" color="text.secondary">
                    {titleCountLabel}
                  </Typography>
                ) : null}
              </Stack>
              {NETWORK_STATUS_FILTER_ORDER.map((filter) => (
                <PowerChip
                  key={filter}
                  label={
                    <CountChipLabel
                      label={NETWORK_STATUS_FILTER_LABELS[filter]}
                      count={
                        isInitialLoading ? null : getNetworkStatusFilterCount(filter, statusCounts)
                      }
                    />
                  }
                  selected={normalizedStatusFilter === filter}
                  onClick={() => onStatusFilterChange(filter)}
                  interactive
                  fontWeight={600}
                  labelPaddingX={0.85}
                  labelPaddingY={0.1}
                  sx={{ height: 30, lineHeight: 1 }}
                />
              ))}
            </Stack>
            <div className="flex min-w-0 flex-wrap items-center gap-echo-sm">
              {canManage ? (
                <NetworkCallsignSelectionControls
                  selection={selection}
                  selectionActive={selectionActive}
                  selectedCount={visibleSelectedIds.length}
                  enterDisabled={isBusy || tableStateRows.length === 0}
                />
              ) : null}
              <InternalTableActions
                table={table}
                rowNumberAppearanceControl
                leadingInternalActions={
                  <NetworkFreqCallsignPeriodSettings
                    period={period}
                    disabled={periodSettingsDisabled}
                    onChange={onPeriodChange}
                    onLoadAllTimeStats={
                      period === 'Unlimited' && stats.period !== 'Unlimited'
                        ? stats.onLoadAllTime
                        : undefined
                    }
                  />
                }
              />
            </div>
          </Box>
        </Stack>

        {loadingError && rows.length > 0 ? (
          <PowerAlert severity="error">{loadingError}</PowerAlert>
        ) : null}

        {stats.error ? (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ flexWrap: 'wrap' }}>
            <PowerAlert severity="warning">
              {`Не вдалося завантажити статистику позивних: ${stats.error}`}
            </PowerAlert>
            <Button size="small" onClick={stats.onRetry}>
              Спробувати ще раз
            </Button>
          </Stack>
        ) : null}

        <Box
          sx={{
            flex: 1,
            minHeight: 0,
            minWidth: 0,
            display: 'flex',
            width: '100%',
            overflowX: 'hidden',
          }}
        >
          <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
      </Stack>
    </Box>
  );
}

function NetworkCallsignSelectionControls({
  selection,
  selectionActive,
  selectedCount,
  enterDisabled,
}: {
  selection: NetworkCallsignSelection;
  selectionActive: boolean;
  selectedCount: number;
  enterDisabled: boolean;
}) {
  if (!selectionActive) {
    return (
      <Button
        variant="outlined"
        size="small"
        startIcon={<ChecklistIcon fontSize="small" />}
        onClick={selection.onEnter}
        disabled={enterDisabled}
      >
        Вибрати
      </Button>
    );
  }

  return (
    <>
      <Typography variant="body2" color="text.secondary" role="status">
        {`Обрано: ${selectedCount}`}
      </Typography>
      <Button
        variant="outlined"
        color="error"
        size="small"
        startIcon={<DeleteIcon fontSize="small" />}
        onClick={selection.onRequestDelete}
        disabled={selectedCount === 0 || selection.deleteInFlight}
      >
        Видалити обрані
      </Button>
      <Button size="small" onClick={selection.onExit} disabled={selection.deleteInFlight}>
        Скасувати
      </Button>
    </>
  );
}

/**
 * Keeps only selected rows that are still visible, so search, status or column filters
 * and reloads never leave hidden rows queued for deletion.
 */
function usePruneHiddenSelection(
  selection: NetworkCallsignSelection,
  selectionActive: boolean,
  visibleSelectedIds: number[],
) {
  const { selectedIds, onSelectedIdsChange } = selection;
  const visibleSelectedKey = visibleSelectedIds.join(',');
  useEffect(() => {
    if (!selectionActive) return;
    const visibleSelectedIdSet = new Set(
      visibleSelectedKey === '' ? [] : visibleSelectedKey.split(',').map(Number),
    );
    if (selectedIds.some((id) => !visibleSelectedIdSet.has(id))) {
      onSelectedIdsChange(selectedIds.filter((id) => visibleSelectedIdSet.has(id)));
    }
  }, [onSelectedIdsChange, selectedIds, selectionActive, visibleSelectedKey]);
}

function useNetworkCallsignRowSelection({
  selection,
  selectionActive,
  rows,
  columnOrder,
  onColumnOrderChange,
}: {
  selection: NetworkCallsignSelection;
  selectionActive: boolean;
  rows: NetworkCallsignRowView[];
  columnOrder: MRT_ColumnOrderState;
  onColumnOrderChange: (updater: MRT_Updater<MRT_ColumnOrderState>) => void;
}) {
  const { selectedIds, onSelectedIdsChange } = selection;
  const rowSelection = useMemo(() => {
    const selectedIdSet = new Set(selectedIds);
    return rows.reduce<MRT_RowSelectionState>((acc, row) => {
      if (selectedIdSet.has(row.id)) acc[String(row.id)] = true;
      return acc;
    }, {});
  }, [rows, selectedIds]);

  const displayedColumnOrder = useMemo(() => {
    const dataColumnOrder = withoutRowSelectColumn(columnOrder);
    return selectionActive ? [ROW_SELECT_COLUMN_ID, ...dataColumnOrder] : dataColumnOrder;
  }, [columnOrder, selectionActive]);

  const handleColumnOrderChange = useCallback(
    (updater: MRT_Updater<MRT_ColumnOrderState>) => {
      // The selection column is transient: never persist it into the stored column order.
      onColumnOrderChange(withoutRowSelectColumn(resolveUpdater(updater, displayedColumnOrder)));
    },
    [displayedColumnOrder, onColumnOrderChange],
  );

  const handleRowSelectionChange = useCallback(
    (updater: MRT_Updater<MRT_RowSelectionState>) => {
      const nextSelection = resolveUpdater(updater, rowSelection);
      onSelectedIdsChange(rows.filter((row) => nextSelection[String(row.id)]).map((row) => row.id));
    },
    [onSelectedIdsChange, rowSelection, rows],
  );

  return {
    rowSelection,
    columnOrder: displayedColumnOrder,
    onColumnOrderChange: handleColumnOrderChange,
    onRowSelectionChange: handleRowSelectionChange,
  };
}
