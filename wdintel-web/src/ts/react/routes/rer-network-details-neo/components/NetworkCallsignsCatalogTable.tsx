import AddIcon from '@mui/icons-material/Add';
import { Box, Button, Stack, Typography } from '@mui/material';
import { useEffect, useMemo } from 'react';
import { MaterialReactTable } from 'material-react-table';

import type { NetworkCallsignCatalogRowView } from '../network-callsigns.types';
import {
  MrtRowActionButton,
  mrtRowActionsColumnSize,
} from '../../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtTextCell,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../../components/mui-customized/table/get-default-table-options';
import { renderMrtCellTextValue } from '../../../components/mui-customized/table/mrt-cell-text';
import { InternalTableActions } from '../../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { formatMrtCellTextValue } from '../../../components/formatMrtCellTextValue';
import { PowerAlert } from '../../../components/PowerAlert';
import { formatDateTime24 } from '../../../utils/misc';
import {
  buildCatalogLoadingRows,
  buildNetworkColumnOrder,
  CATALOG_COLUMNS_VISIBILITY,
  NETWORK_CALLSIGN_COLUMN_SIZES,
} from './NetworkCallsignsTableShared';
import { NetworkCallsignSourceCell } from './NetworkCallsignSourceUi';
import {
  TableStateProvider,
  useTableStateContext,
} from '../../../components/mui-customized/table/table-state-provider';

const catalogMRTOptions = getDefaultMRTOptions<NetworkCallsignCatalogRowView>();
const NETWORK_MRT_LOCALIZATION = {
  ...catalogMRTOptions.localization,
  rowNumbers: 'Номер рядка',
};
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps =
  typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

type Props = {
  title: string;
  countLabel: string;
  rows: NetworkCallsignCatalogRowView[];
  loading: boolean;
  loadingError: string | null;
  canManage: boolean;
  onAddKnownCallsign: (knownCallsignId: number) => void;
  onReload: () => void;
  inFlightAddIds: number[];
};

export function NetworkCallsignsCatalogTable({
  title,
  countLabel,
  rows,
  loading,
  loadingError,
  canManage,
  onAddKnownCallsign,
  onReload,
  inFlightAddIds,
}: Props) {
  return (
    <TableStateProvider
      tableId="network-details-callsigns-catalog"
      defaultColumnVisibility={{ ...CATALOG_COLUMNS_VISIBILITY, 'mrt-row-numbers': true }}
      defaultColumnOrder={buildNetworkColumnOrder({
        dataColumnIds: [
          'callsign',
          'position',
          'unitName',
          'lastDatetime',
          'messageCount',
          'comment',
          'dateBoundAt',
          'sourceName',
        ],
      })}
    >
      <NetworkCallsignsCatalogTableContent
        title={title}
        countLabel={countLabel}
        rows={rows}
        loading={loading}
        loadingError={loadingError}
        canManage={canManage}
        onAddKnownCallsign={onAddKnownCallsign}
        onReload={onReload}
        inFlightAddIds={inFlightAddIds}
      />
    </TableStateProvider>
  );
}

function NetworkCallsignsCatalogTableContent({
  title,
  countLabel,
  rows,
  loading,
  loadingError,
  canManage,
  onAddKnownCallsign,
  onReload,
  inFlightAddIds,
}: Props) {
  const tableStateContext = useTableStateContext();
  const isInitialLoading = loading && rows.length === 0;
  const isBusy = loading || inFlightAddIds.length > 0;
  const loadingRows = useMemo(() => buildCatalogLoadingRows(), []);
  const columns = useMemo<AppMrtColumnDef<NetworkCallsignCatalogRowView>[]>(
    () => [
      {
        header: 'Позивний',
        accessorKey: 'callsign',
        id: 'callsign',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.callsign,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => (
            <Typography variant="body2" fontWeight={700}>
              {formatMrtCellTextValue(row.original.callsign)}
            </Typography>
          ),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.callsign),
        }),
      },
      {
        header: 'Посада',
        accessorKey: 'position',
        id: 'position',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.position,
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.unitName),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.unitName),
        }),
      },
      {
        header: 'Останній раз',
        accessorFn: (row) => row.lastDatetime,
        id: 'lastDatetime',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.lastDatetime,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDateTime24(row.original.lastDatetime),
          fullValue: ({ row }) => formatDateTime24(row.original.lastDatetime),
        }),
        enableSorting: false,
      },
      {
        header: 'К-сть',
        accessorKey: 'messageCount',
        id: 'messageCount',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.messageCount,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => String(row.original.messageCount),
          fullValue: ({ row }) => String(row.original.messageCount),
        }),
      },
      {
        header: 'Коментар',
        accessorKey: 'comment',
        id: 'comment',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.comment,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatMrtCellTextValue(row.original.comment),
          fullValue: ({ row }) => formatMrtCellTextValue(row.original.comment),
        }),
      },
      {
        header: "Дата прив'язки",
        accessorFn: (row) => row.dateBoundAt,
        id: 'dateBoundAt',
        size: 150,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDateTime24(row.original.dateBoundAt),
          fullValue: ({ row }) => formatDateTime24(row.original.dateBoundAt),
        }),
        enableSorting: false,
      },
      {
        header: 'Джерело',
        accessorKey: 'sourceName',
        id: 'sourceName',
        size: NETWORK_CALLSIGN_COLUMN_SIZES.sourceName,
        grow: false,
        enableResizing: false,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          interactive: true,
          displayValue: ({ row }) => (
            <NetworkCallsignSourceCell sourceName={row.original.sourceName} />
          ),
          fullValue: ({ row }) => row.original.sourceName,
        }),
      },
    ],
    [canManage, inFlightAddIds, isInitialLoading, onAddKnownCallsign],
  );

  const table = useAppMaterialReactTable({
    columns,
    data: isInitialLoading ? loadingRows : rows,
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
    displayColumnDefOptions: {
      ...catalogMRTOptions.displayColumnDefOptions,
      'mrt-row-actions': {
        ...catalogMRTOptions.displayColumnDefOptions?.['mrt-row-actions'],
        size: mrtRowActionsColumnSize(1),
      },
    },
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
            opensModal
          />
        </Box>
      );
    },
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        noDataMessage: loadingError
          ? 'Не вдалося завантажити каталог'
          : 'Співпадіння з каталогом відсутні',
        noDataActionLabel: loadingError ? 'Спробувати ще раз' : undefined,
        onNoDataAction: loadingError ? onReload : undefined,
        filteredMessage: 'Немає співпадінь з каталогом за обраними фільтрами',
        onClearFilters: undefined,
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
        dataColumnIds: [
          'callsign',
          'position',
          'unitName',
          'lastDatetime',
          'messageCount',
          'comment',
          'dateBoundAt',
          'sourceName',
        ],
      }),
      columnVisibility: CATALOG_COLUMNS_VISIBILITY,
    },
    getRowId: (row) => String(row.id),
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

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
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 2,
          mt: 0,
          mb: 1.25,
          width: '100%',
          flexWrap: 'wrap',
        }}
      >
        <Stack
          direction="row"
          spacing={1.25}
          alignItems="baseline"
          sx={{ flexWrap: 'wrap', minWidth: 0 }}
        >
          <Typography variant="h6">{title}</Typography>
          <Typography variant="body2" color="text.secondary">
            {countLabel}
          </Typography>
        </Stack>
        <InternalTableActions table={table} rowNumberAppearanceControl />
      </Box>

      {loadingError && rows.length > 0 ? (
        <PowerAlert severity="error">{loadingError}</PowerAlert>
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
    </Box>
  );
}
