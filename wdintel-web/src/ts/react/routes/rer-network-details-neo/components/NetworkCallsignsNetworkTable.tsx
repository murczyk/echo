import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import MoreVertOutlinedIcon from '@mui/icons-material/MoreVertOutlined';
import { Box, IconButton, ListItemIcon, Menu, MenuItem, Stack, Typography } from '@mui/material';
import { useMemo, useState } from 'react';
import { MaterialReactTable, type MRT_ColumnDef, useMaterialReactTable } from 'material-react-table';

import type { NetworkCallsignRowView, NetworkCallsignStatusFilter } from '../network-callsigns';
import { TableEmptyState } from '../../../components/TableEmptyState';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerAlert } from '../../../components/PowerAlert';
import { PowerChip } from '../../../components/PowerChip';
import { PowerMenu } from '../../../components/PowerMenu';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import {
  buildNetworkLoadingRows,
  CountChipLabel,
  NETWORK_COLUMNS_VISIBILITY,
  NETWORK_STATUS_FILTER_LABELS,
  NETWORK_STATUS_FILTER_ORDER,
  renderStatusChip,
} from './NetworkCallsignsTableShared';
import { countNetworkCallsignStatusRows, formatNetworkCallsignDatetime } from '../network-callsigns';

const defaultMRTOptions = getDefaultMRTOptions<NetworkCallsignRowView>();
const NETWORK_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['callsign', 'status', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'sourceName'],
  withRowNumbers: true,
  withRowActions: true,
});
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
const COMPACT_LOADED_ROW_LIMIT = 8;

type Props = {
  rows: NetworkCallsignRowView[];
  loading: boolean;
  loadingError: string | null;
  canManage: boolean;
  statusFilter: NetworkCallsignStatusFilter;
  onStatusFilterChange: (next: NetworkCallsignStatusFilter) => void;
  onOpenEditDrawer: (row: NetworkCallsignRowView) => void;
  onOpenDeleteDialog: (row: NetworkCallsignRowView) => void;
  onReload: () => void;
  inFlightUpdateIds: number[];
  inFlightDeleteIds: number[];
};

export function NetworkCallsignsNetworkTable({
  rows,
  loading,
  loadingError,
  canManage,
  statusFilter,
  onStatusFilterChange,
  onOpenEditDrawer,
  onOpenDeleteDialog,
  onReload,
  inFlightUpdateIds,
  inFlightDeleteIds,
}: Props) {
  const [rowMenuAnchorEl, setRowMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [rowMenuTarget, setRowMenuTarget] = useState<NetworkCallsignRowView | null>(null);

  const tableStateRows = useMemo(() => {
    const filtered = statusFilter === 'All'
      ? rows
      : rows.filter((row) => {
          if (statusFilter === 'Verified') return row.status === 'verified';
          if (statusFilter === 'Developing') return row.status === 'developing';
          if (statusFilter === 'Catalog') return row.status === 'catalog';
          return row.status === 'unknown';
        });
    return filtered;
  }, [rows, statusFilter]);

  const statusCounts = useMemo(() => countNetworkCallsignStatusRows(rows), [rows]);
  const isInitialLoading = loading && rows.length === 0;
  const isCompactLoadedLayout = !isInitialLoading && tableStateRows.length <= COMPACT_LOADED_ROW_LIMIT;
  const isBusy = loading || inFlightUpdateIds.length > 0 || inFlightDeleteIds.length > 0;
  const loadingRows = useMemo(() => buildNetworkLoadingRows(), []);
  const columns = useMemo<MRT_ColumnDef<NetworkCallsignRowView>[]>(() => [
    {
      header: 'Позивний',
      accessorKey: 'callsign',
      id: 'callsign',
      size: 170,
      Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{formatMrtCellTextValue(row.original.callsign)}</Typography>,
    },
    {
      header: 'Статус',
      accessorKey: 'statusLabel',
      id: 'status',
      size: 150,
      Cell: ({ row }) => renderStatusChip(row.original.statusLabel),
    },
    {
      header: 'Посада',
      accessorKey: 'position',
      id: 'position',
      size: 150,
      Cell: ({ row }) => formatMrtCellTextValue(row.original.position),
    },
    {
      header: 'Підрозділ',
      accessorKey: 'unitName',
      id: 'unitName',
      size: 220,
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
      size: 150,
      Cell: ({ row }) => formatNetworkCallsignDatetime(row.original.lastDatetime),
      enableSorting: false,
    },
    {
      header: 'К-сть',
      accessorKey: 'messageCount',
      id: 'messageCount',
      size: 100,
      Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{row.original.messageCount}</Typography>,
    },
    {
      header: 'Коментар',
      accessorKey: 'comment',
      id: 'comment',
      size: 240,
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
      size: 170,
      Cell: ({ row }) => (
        <Typography variant="body2" noWrap title={row.original.sourceName}>
          {formatMrtCellTextValue(row.original.sourceName)}
        </Typography>
      ),
    },
  ], []);

  const table = useMaterialReactTable({
    columns,
    data: isInitialLoading ? loadingRows : tableStateRows,
    ...defaultMRTOptions,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableRowSelection: false,
    enableColumnFilters: true,
    columnFilterDisplayMode: 'popover',
    enableGlobalFilter: false,
    enableSorting: false,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableColumnOrdering: true,
    enableColumnResizing: true,
    enableHiding: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderEmptyRowsFallback: () => (
        <Box sx={{ py: 6 }}>
          <TableEmptyState
            message={loadingError ? 'Не вдалося завантажити позивні мережі' : 'Позивні мережі відсутні'}
          actionLabel={loadingError ? 'Спробувати ще раз' : undefined}
          onAction={loadingError ? onReload : undefined}
        />
      </Box>
    ),
    state: {
      density: 'comfortable',
      isLoading: isBusy && !isInitialLoading,
      showLoadingOverlay: isBusy && !isInitialLoading,
      showSkeletons: isInitialLoading,
      columnOrder: NETWORK_COLUMN_ORDER,
      columnVisibility: NETWORK_COLUMNS_VISIBILITY,
    },
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': { ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'], size: mrtRowActionsColumnSize(2) + 8 },
    },
    muiTablePaperProps: ({ table }) => ({
      ...((resolvedPaperProps({ table }) as object) ?? {}),
      sx: {
        ...((resolvedPaperProps({ table }) as { sx?: object }).sx ?? {}),
        ...FULL_WIDTH_TABLE_PAPER_SX,
        width: '100%',
        maxWidth: '100%',
        height: isCompactLoadedLayout ? 'auto' : '100%',
        minHeight: isCompactLoadedLayout ? 'auto' : 0,
        minWidth: 0,
        overflow: table.getState().isFullScreen ? 'auto' : isCompactLoadedLayout ? 'visible' : 'hidden',
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
        loading,
        height: isCompactLoadedLayout ? 'auto' : '100%',
        minHeight: 0,
        idleOverflowX: 'auto',
        idleOverflowY: isCompactLoadedLayout ? 'visible' : 'auto',
      }),
    },
    initialState: { density: 'comfortable', columnOrder: NETWORK_COLUMN_ORDER, columnVisibility: NETWORK_COLUMNS_VISIBILITY },
    getRowId: (row) => String(row.id),
    renderRowActions: ({ row }) => {
      if (isInitialLoading) return <Box sx={{ minHeight: 28 }} />;
      const networkCallsign = row.original;
      const editDisabled = !canManage || inFlightUpdateIds.includes(networkCallsign.id);
      if (!canManage) return <Box sx={{ minHeight: 28 }} />;
      return (
        <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center" useFlexGap>
          <MrtRowActionButton
            onClick={() => onOpenEditDrawer(networkCallsign)}
            disabled={editDisabled}
            icon={<EditIcon fontSize="small" />}
            label="Редагувати позивний"
          />
          <IconButton
            size="small"
            aria-label="Дії з позивним"
            onClick={(event) => {
              event.stopPropagation();
              setRowMenuTarget(networkCallsign);
              setRowMenuAnchorEl(event.currentTarget);
            }}
          >
            <MoreVertOutlinedIcon fontSize="small" />
          </IconButton>
        </Stack>
      );
    },
  });

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: isCompactLoadedLayout ? '0 0 auto' : 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Stack spacing={2} sx={{ minHeight: 0, flex: isCompactLoadedLayout ? '0 0 auto' : 1 }}>
        <Stack spacing={1.25} sx={{ mt: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 2, flexWrap: 'wrap', minWidth: 0 }}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ flexWrap: 'wrap' }}>
              {NETWORK_STATUS_FILTER_ORDER.map((filter) => (
                <PowerChip
                  key={filter}
                  label={<CountChipLabel label={NETWORK_STATUS_FILTER_LABELS[filter]} count={filter === 'All' ? statusCounts.all : filter === 'Verified' ? statusCounts.verified : filter === 'Developing' ? statusCounts.developing : filter === 'Catalog' ? statusCounts.catalog : statusCounts.unknown} />}
                  selected={statusFilter === filter}
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
            <InternalTableActions table={table} />
          </Box>
        </Stack>

        {loadingError && rows.length > 0 ? <PowerAlert severity="error">{loadingError}</PowerAlert> : null}

        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%', overflowX: 'auto' }}>
          <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
      </Stack>

      <Menu
        anchorEl={rowMenuAnchorEl}
        open={rowMenuAnchorEl !== null && rowMenuTarget !== null}
        onClose={() => {
          setRowMenuAnchorEl(null);
          setRowMenuTarget(null);
        }}
        slotProps={{ paper: { sx: { minWidth: 160 } } }}
      >
        {rowMenuTarget ? (
          <MenuItem
            onClick={() => {
              onOpenDeleteDialog(rowMenuTarget);
              setRowMenuAnchorEl(null);
              setRowMenuTarget(null);
            }}
            sx={{ color: 'error.main' }}
            disabled={!canManage || inFlightDeleteIds.includes(rowMenuTarget?.id ?? 0)}
          >
            <ListItemIcon sx={{ color: 'error.main' }}>
              <DeleteIcon fontSize="small" />
            </ListItemIcon>
            Видалити
          </MenuItem>
        ) : null}
      </Menu>
    </Box>
  );
}
