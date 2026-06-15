import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MilitaryTechOutlinedIcon from '@mui/icons-material/MilitaryTechOutlined';
import StarIcon from '@mui/icons-material/Star';
import { Box, Stack, Tooltip, Typography } from '@mui/material';
import { useEffect, useMemo } from 'react';
import { MaterialReactTable, type MRT_ColumnDef, useMaterialReactTable } from 'material-react-table';

import type { NetworkCallsignMarkerMode, NetworkCallsignRowView, NetworkCallsignStatusFilter } from '../network-callsigns.types';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import { MrtRowActionButton, MrtRowActions } from '../../../components/MrtRowActionButton';
import { renderMrtCellTextValue } from '../../../components/mui-customized/table/mrt-cell-text';
import { TableStateProvider, useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import {
  buildNetworkColumnOrder,
  buildNetworkLoadingRows,
  CountChipLabel,
  NETWORK_STATUS_FILTER_LABELS,
  NETWORK_STATUS_FILTER_ORDER,
  NETWORK_CALLSIGN_COLUMN_SIZES,
  NETWORK_COLUMNS_VISIBILITY,
} from './NetworkCallsignsTableShared';
import { NetworkCallsignSourceCell } from './NetworkCallsignSourceUi';
import { NetworkCallsignStatusDot } from './NetworkCallsignStatusUi';
import { countNetworkCallsignStatusRows } from '../network-callsigns.rows';
import { formatNetworkCallsignDatetime } from '../network-callsigns.search';

const defaultMRTOptions = getDefaultMRTOptions<NetworkCallsignRowView>();
const NETWORK_MRT_LOCALIZATION = {
  ...defaultMRTOptions.localization,
  rowNumbers: 'Номер рядка',
};
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

function getMainMarkerActionLabel(networkCallsign: NetworkCallsignRowView): string {
  return networkCallsign.mainRadioStation ? 'Зняти головну' : 'Зробити головною';
}

function getCommandMarkerActionLabel(networkCallsign: NetworkCallsignRowView): string {
  return networkCallsign.commandControl ? 'Зняти ланку управління' : 'Зробити ланкою управління';
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
  onOpenEditDrawer: (row: NetworkCallsignRowView) => void;
  onOpenDeleteDialog: (row: NetworkCallsignRowView) => void;
  onSetMarkerMode: (row: NetworkCallsignRowView, markerMode: NetworkCallsignMarkerMode) => void;
  onReload: () => void;
  inFlightUpdateIds: number[];
  inFlightDeleteIds: number[];
};

export function NetworkCallsignsNetworkTable({
  title,
  countLabel,
  rows,
  loading,
  loadingError,
  canManage,
  statusFilter,
  onStatusFilterChange,
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onSetMarkerMode,
  onReload,
  inFlightUpdateIds,
  inFlightDeleteIds,
}: Props) {
  return (
    <TableStateProvider
      tableId="network-details-callsigns"
      defaultColumnVisibility={{ ...NETWORK_COLUMNS_VISIBILITY, 'mrt-row-numbers': true }}
      defaultColumnOrder={buildNetworkColumnOrder({
        dataColumnIds: ['callsign', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'sourceName'],
      })}
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
        onOpenEditDrawer={onOpenEditDrawer}
        onOpenDeleteDialog={onOpenDeleteDialog}
        onSetMarkerMode={onSetMarkerMode}
        onReload={onReload}
        inFlightUpdateIds={inFlightUpdateIds}
        inFlightDeleteIds={inFlightDeleteIds}
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
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onSetMarkerMode,
  onReload,
  inFlightUpdateIds,
  inFlightDeleteIds,
}: Props) {
  const tableStateContext = useTableStateContext();

  const visibleRows = useMemo(() => rows, [rows]);
  const normalizedStatusFilter = NETWORK_STATUS_FILTER_ORDER.includes(statusFilter) ? statusFilter : 'All';
  const tableStateRows = useMemo(() => {
    const filtered = normalizedStatusFilter === 'All'
      ? visibleRows
      : visibleRows.filter((row) => (
        normalizedStatusFilter === 'Developing'
          ? row.status === 'developing'
          : normalizedStatusFilter === 'Catalog'
            ? row.status === 'catalog'
            : row.status === 'unknown'
      ));

    // comparator used inside each group: messageCount desc, lastDatetime desc, callsign uk
    const intraGroupCmp = (a: NetworkCallsignRowView, b: NetworkCallsignRowView) => {
      if (b.messageCount !== a.messageCount) return b.messageCount - a.messageCount;
      if ((b.lastDatetime ?? 0) !== (a.lastDatetime ?? 0)) return (b.lastDatetime ?? 0) - (a.lastDatetime ?? 0);
      return a.callsign.localeCompare(b.callsign, 'uk');
    };

    const copy = filtered.slice();
    const mainGroup = copy.filter(r => r.mainRadioStation).slice().sort(intraGroupCmp);
    const rest = copy.filter(r => !r.mainRadioStation);
    const commandGroup = rest.filter(r => r.commandControl).slice().sort(intraGroupCmp);
    const otherGroup = rest.filter(r => !r.commandControl).slice().sort(intraGroupCmp);

    return [...mainGroup, ...commandGroup, ...otherGroup];
  }, [normalizedStatusFilter, visibleRows]);

  const statusCounts = useMemo(() => countNetworkCallsignStatusRows(visibleRows), [visibleRows]);
  const isInitialLoading = loading && rows.length === 0;
  const isBusy = loading || inFlightUpdateIds.length > 0 || inFlightDeleteIds.length > 0;
  const loadingRows = useMemo(() => buildNetworkLoadingRows(), []);
  const columns = useMemo<MRT_ColumnDef<NetworkCallsignRowView>[]>(() => [
      {
        header: 'Позивний',
        accessorKey: 'callsign',
        id: 'callsign',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.callsign,
        Cell: ({ row }) => (
          <Stack direction="row" spacing={1.25} alignItems="center" sx={{ minWidth: 0 }}>
            <NetworkCallsignStatusDot statusLabel={row.original.statusLabel} status={row.original.status} />
            <Typography variant="body2" fontWeight={700} noWrap title={row.original.callsign}>
              {formatMrtCellTextValue(row.original.callsign)}
            </Typography>
            {row.original.mainRadioStation ? (
              <Tooltip title="Головна радіостанція" arrow>
                <StarIcon fontSize="small" sx={{ color: 'warning.main', flexShrink: 0 }} />
              </Tooltip>
            ) : null}
            {row.original.commandControl ? (
              <Tooltip title="Ланка управління" arrow>
                <MilitaryTechOutlinedIcon fontSize="small" sx={{ color: 'info.main', flexShrink: 0 }} />
              </Tooltip>
            ) : null}
          </Stack>
        ),
      },
      {
        header: 'Посада',
        accessorKey: 'position',
        id: 'position',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.position,
        Cell: ({ row }) => renderMrtCellTextValue(row.original.position),
      },
      {
        header: 'Підрозділ',
        accessorKey: 'unitName',
        id: 'unitName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.unitName,
        Cell: ({ row }) => (
          <Typography variant="body2" noWrap title={row.original.unitName}>
            {formatMrtCellTextValue(row.original.unitName)}
          </Typography>
        ),
      },
      {
        header: 'Остання акт.',
        accessorFn: (row) => row.lastDatetime,
        id: 'lastDatetime',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.lastDatetime,
        Cell: ({ row }) => formatNetworkCallsignDatetime(row.original.lastDatetime),
        enableSorting: false,
      },
      {
        header: 'К-сть',
        accessorKey: 'messageCount',
        id: 'messageCount',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.messageCount,
        Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{row.original.messageCount}</Typography>,
      },
      {
        header: 'Коментар',
        accessorKey: 'comment',
        id: 'comment',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.comment,
        Cell: ({ row }) => (
          <Typography variant="body2" noWrap title={row.original.comment}>
            {formatMrtCellTextValue(row.original.comment)}
          </Typography>
        ),
      },
      {
        header: 'Джерело',
        accessorKey: 'sourceName',
        id: 'sourceName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.sourceName,
        grow: false,
        enableResizing: false,
        Cell: ({ row }) => <NetworkCallsignSourceCell sourceName={row.original.sourceName} />,
      },
    ], []);

  const table = useMaterialReactTable({
    columns,
    data: isInitialLoading ? loadingRows : tableStateRows,
    ...defaultMRTOptions,
    localization: NETWORK_MRT_LOCALIZATION,
    enableColumnActions: true,
    enableRowSelection: false,
    enableRowNumbers: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    enableColumnFilters: true,
    columnFilterDisplayMode: 'popover',
    enableGlobalFilter: false,
    enableSorting: false,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableHiding: true,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    renderRowActions: ({ row }) => {
      if (isInitialLoading) return <Box sx={{ minHeight: 28 }} />;
      const networkCallsign = row.original;
      if (!canManage) return <Box sx={{ minHeight: 28 }} />;
      const editDisabled = inFlightUpdateIds.includes(networkCallsign.id);
      const markerDisabled = editDisabled;
      const clearMarkerDisabled = editDisabled || (!networkCallsign.mainRadioStation && !networkCallsign.commandControl);
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
            onClick={() => onSetMarkerMode(networkCallsign, networkCallsign.mainRadioStation ? 'none' : 'mainRadioStation')}
            disabled={markerDisabled}
            icon={<StarIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label={getCommandMarkerActionLabel(networkCallsign)}
            onClick={() => onSetMarkerMode(networkCallsign, networkCallsign.commandControl ? 'none' : 'commandControl')}
            disabled={markerDisabled}
            icon={<MilitaryTechOutlinedIcon fontSize="small" />}
          />
          <MrtRowActionButton
            label="Очистити маркер"
            onClick={() => onSetMarkerMode(networkCallsign, 'none')}
            disabled={clearMarkerDisabled}
            icon={<Box component="span" sx={{ width: 18, display: 'inline-flex', justifyContent: 'center' }}>−</Box>}
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
    renderEmptyRowsFallback: ({ table }) => renderDefaultMrtEmptyRowsFallback({
      table,
      externalHasFilters: normalizedStatusFilter !== 'All',
      noDataMessage: loadingError ? 'Не вдалося завантажити позивні мережі' : 'Позивні мережі відсутні',
      noDataActionLabel: loadingError ? 'Спробувати ще раз' : undefined,
      onNoDataAction: loadingError ? onReload : undefined,
      filteredMessage: 'Немає позивних за обраним статусом',
      onClearFilters: normalizedStatusFilter !== 'All'
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
      columnOrder: tableStateContext.columnOrder,
      columnVisibility: tableStateContext.columnVisibility,
      columnSizing: tableStateContext.columnSizing,
      density: tableStateContext.density,
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
      columnOrder: buildNetworkColumnOrder({
        dataColumnIds: ['callsign', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'sourceName'],
      }),
      columnVisibility: NETWORK_COLUMNS_VISIBILITY,
    },
    getRowId: (row) => String(row.id),
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Stack spacing={2} sx={{ minHeight: 0, flex: 1 }}>
        <Stack spacing={1.25} sx={{ mt: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap sx={{ flexWrap: 'wrap', minWidth: 0 }}>
              <Stack direction="row" spacing={1.25} alignItems="baseline" sx={{ flexWrap: 'wrap', minWidth: 0 }}>
                <Typography variant="h6">{title}</Typography>
                {countLabel ? (
                  <Typography variant="body2" color="text.secondary">
                    {countLabel}
                  </Typography>
                ) : null}
              </Stack>
              {NETWORK_STATUS_FILTER_ORDER.map((filter) => (
                <PowerChip
                  key={filter}
                  label={
                    <CountChipLabel
                      label={NETWORK_STATUS_FILTER_LABELS[filter]}
                      count={getNetworkStatusFilterCount(filter, statusCounts)}
                    />
                  }
                  selected={normalizedStatusFilter === filter}
                  onClick={() => onStatusFilterChange(filter)}
                  interactive
                  fontSize="0.75rem"
                  fontWeight={600}
                  labelPaddingX={0.85}
                  labelPaddingY={0.1}
                  sx={{ height: 30, lineHeight: 1 }}
                />
              ))}
            </Stack>
            <InternalTableActions table={table} rowNumberAppearanceControl />
          </Box>
        </Stack>

        {loadingError && rows.length > 0 ? <PowerAlert severity="error">{loadingError}</PowerAlert> : null}

        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%', overflowX: 'hidden' }}>
          <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
      </Stack>

    </Box>
  );
}
