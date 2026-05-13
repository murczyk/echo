import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Typography } from '@mui/material';
import { useMemo } from 'react';
import { MaterialReactTable, type MRT_ColumnDef, useMaterialReactTable } from 'material-react-table';

import type { NetworkCallsignCatalogRowView } from '../network-callsigns';
import { MrtRowActionButton, mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerAlert } from '../../../components/PowerAlert';
import { formatDateTime24 } from '../../../utils/misc';
import {
  buildCatalogLoadingRows,
  CATALOG_COLUMNS_VISIBILITY,
  NETWORK_CALLSIGN_COLUMN_SIZES,
} from './NetworkCallsignsTableShared';
import { NetworkCallsignSourceIcon } from './NetworkCallsignSourceUi';

const catalogMRTOptions = getDefaultMRTOptions<NetworkCallsignCatalogRowView>();
const CATALOG_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['callsign', 'position', 'unitName', 'lastDatetime', 'messageCount', 'comment', 'dateBoundAt', 'sourceName'],
  withRowNumbers: true,
  withRowActions: true,
});
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

type Props = {
  rows: NetworkCallsignCatalogRowView[];
  loading: boolean;
  loadingError: string | null;
  canManage: boolean;
  onAddKnownCallsign: (knownCallsignId: number) => void;
  onReload: () => void;
  inFlightAddIds: number[];
};

export function NetworkCallsignsCatalogTable({
  rows,
  loading,
  loadingError,
  canManage,
  onAddKnownCallsign,
  onReload,
  inFlightAddIds,
}: Props) {
  const isInitialLoading = loading && rows.length === 0;
  const isBusy = loading || inFlightAddIds.length > 0;
  const loadingRows = useMemo(() => buildCatalogLoadingRows(), []);
  const columns = useMemo<MRT_ColumnDef<NetworkCallsignCatalogRowView>[]>(() => [
    {
      header: 'Позивний',
      accessorKey: 'callsign',
      id: 'callsign',
      size: NETWORK_CALLSIGN_COLUMN_SIZES.callsign,
      Cell: ({ row }) => <Typography variant="body2" fontWeight={700}>{formatMrtCellTextValue(row.original.callsign)}</Typography>,
    },
    {
      header: 'Посада',
      accessorKey: 'position',
      id: 'position',
      size: NETWORK_CALLSIGN_COLUMN_SIZES.position,
      Cell: ({ row }) => formatMrtCellTextValue(row.original.position),
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
      header: 'Останній раз',
      accessorFn: (row) => row.lastDatetime,
      id: 'lastDatetime',
      size: NETWORK_CALLSIGN_COLUMN_SIZES.lastDatetime,
      Cell: ({ row }) => formatDateTime24(row.original.lastDatetime),
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
      header: "Дата прив'язки",
      accessorFn: (row) => row.dateBoundAt,
      id: 'dateBoundAt',
      size: 150,
      Cell: ({ row }) => formatDateTime24(row.original.dateBoundAt),
      enableSorting: false,
    },
    {
      header: 'Джерело',
      accessorKey: 'sourceName',
      id: 'sourceName',
      size: NETWORK_CALLSIGN_COLUMN_SIZES.sourceName,
      grow: false,
      enableResizing: false,
      Cell: ({ row }) => (row.original.sourceName === '—' ? <Typography variant="body2">—</Typography> : <NetworkCallsignSourceIcon sourceName={row.original.sourceName} />),
    },
  ], []);

  const table = useMaterialReactTable({
    columns,
    data: isInitialLoading ? loadingRows : rows,
    ...catalogMRTOptions,
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
    renderEmptyRowsFallback: ({ table }) => renderDefaultMrtEmptyRowsFallback({
      table,
      noDataMessage: loadingError ? 'Не вдалося завантажити каталог' : 'Співпадіння з каталогом відсутні',
      noDataActionLabel: loadingError ? 'Спробувати ще раз' : undefined,
      onNoDataAction: loadingError ? onReload : undefined,
      filteredMessage: 'Немає співпадінь з каталогом за обраними фільтрами',
      onClearFilters: undefined,
    }),
    state: {
      density: 'comfortable',
      isLoading: isBusy && !isInitialLoading,
      showLoadingOverlay: isBusy && !isInitialLoading,
      showSkeletons: isInitialLoading,
      columnOrder: CATALOG_COLUMN_ORDER,
      columnVisibility: CATALOG_COLUMNS_VISIBILITY,
    },
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': { ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'], size: mrtRowActionsColumnSize(1) },
    },
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
    initialState: { density: 'comfortable', columnOrder: CATALOG_COLUMN_ORDER, columnVisibility: CATALOG_COLUMNS_VISIBILITY },
    getRowId: (row) => String(row.id),
    renderRowActions: ({ row }) => {
      if (isInitialLoading) return <Box sx={{ minHeight: 28 }} />;
      const isInFlight = inFlightAddIds.includes(row.original.knownCallsignId);
      if (!canManage) return <Box sx={{ minHeight: 28 }} />;
      return (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <MrtRowActionButton
            onClick={() => onAddKnownCallsign(row.original.knownCallsignId)}
            disabled={!canManage || isInFlight}
            icon={<AddIcon fontSize="small" />}
            label="Додати в мережу"
          />
        </Box>
      );
    },
  });

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', width: '100%' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 2, mt: 0, mb: 1.25, width: '100%' }}>
        <InternalTableActions table={table} />
      </Box>

      {loadingError && rows.length > 0 ? <PowerAlert severity="error">{loadingError}</PowerAlert> : null}

        <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%', overflowX: 'hidden' }}>
          <Box sx={{ flex: 1, minHeight: 0, minWidth: 0, display: 'flex', width: '100%' }}>
            <MaterialReactTable table={table} />
          </Box>
        </Box>
    </Box>
  );
}
