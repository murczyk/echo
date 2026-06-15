import { Box, Button, CircularProgress } from '@mui/material';
import type { MRT_ColumnOrderState, MRT_TableInstance } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useRef } from 'react';
import type { PointerEvent } from 'react';

import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../../components/mui-customized/table/get-default-table-options';
import { mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import type { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import type { NetworkRowView } from '../helpers';
import { sanitizeNetworkColumnFilters } from '../helpers';
import { NetworkRowActions } from './NetworkRowActions';
import { useNetworksTableColumns } from './NetworksTableColumns';

const defaultMrtOptions = getDefaultMRTOptions<NetworkRowView>();
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

type Props = {
  rows: NetworkRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  noMoreToLoad: boolean;
  permissions: { canEdit: boolean; canExport: boolean; canDelete: boolean };
  tableStateContext: ReturnType<typeof useTableStateContext>;
  aorFilterOptions: Array<{ label: string; value: string }>;
  aorOptions: Array<{ id: number; name: string }>;
  onFrequencyHoverEnter: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onFrequencyHoverLeave: () => void;
  onLocationHoverEnter: (anchorEl: HTMLElement, row: NetworkRowView) => void;
  onLocationHoverLeave: () => void;
  onOpenReportDialog: (network: NetworkRowView['network']) => void;
  onOpenEditDialog: (network: NetworkRowView['network']) => void;
  onOpenDeleteDialog: (network: NetworkRowView['network']) => void;
  onLoadMoreNetworks: () => Promise<void>;
  onPointerMoveCapture: (event: PointerEvent<HTMLDivElement>) => void;
  onTableInitialized: (table: MRT_TableInstance<NetworkRowView>) => void;
  columnOrder: MRT_ColumnOrderState;
};

export function NetworksTable({
  rows,
  loading,
  refreshing,
  loadingMore,
  noMoreToLoad,
  permissions,
  tableStateContext,
  aorFilterOptions,
  aorOptions,
  onFrequencyHoverEnter,
  onFrequencyHoverLeave,
  onLocationHoverEnter,
  onLocationHoverLeave,
  onOpenReportDialog,
  onOpenEditDialog,
  onOpenDeleteDialog,
  onLoadMoreNetworks,
  onPointerMoveCapture,
  onTableInitialized,
  columnOrder,
}: Props) {
  const columns = useNetworksTableColumns({
    aorFilterOptions,
    aorOptions,
    onFrequencyHoverEnter,
    onFrequencyHoverLeave,
    onLocationHoverEnter,
    onLocationHoverLeave,
  });
  const safeColumnFilters = useMemo(() => sanitizeNetworkColumnFilters(tableStateContext.columnFilters), [tableStateContext.columnFilters]);
  const isInitialLoading = loading && rows.length === 0;
  const isEmptyResult = !isInitialLoading && rows.length === 0;
  const showLoadMore = !isInitialLoading && !noMoreToLoad;
  const showTableOverlay = !isInitialLoading && (loadingMore || refreshing);

  const table = useMaterialReactTable({
    ...defaultMrtOptions,
    data: rows,
    columns,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    columnFilterDisplayMode: 'popover',
    enableFacetedValues: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableSorting: true,
    manualFiltering: true,
    manualSorting: true,
    enableHiding: true,
    enableRowActions: true,
    positionActionsColumn: 'first',
    enableRowNumbers: true,
    initialState: {
      columnOrder,
      pagination: {
        pageIndex: 0,
        pageSize: FULL_HEIGHT_LOADING_ROW_COUNT,
      },
    },
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onSortingChange: tableStateContext.onSortingChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    renderRowActions: ({ row }) => (
      <NetworkRowActions
        network={row.original}
        canEdit={permissions.canEdit}
        canExport={permissions.canExport}
        canDelete={permissions.canDelete}
        onOpenReportDialog={onOpenReportDialog}
        onOpenEditDialog={onOpenEditDialog}
        onOpenDeleteDialog={onOpenDeleteDialog}
      />
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        enableResizing: false,
      },
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(4),
        enableResizing: false,
      },
    },
    muiTablePaperProps: ({ table }) => {
      const paperProps = resolvedPaperProps({ table });
      return {
        ...paperProps,
        sx: {
          ...(paperProps as { sx?: object }).sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          width: '100%',
          maxWidth: '100%',
          height: isInitialLoading || isEmptyResult ? '100%' : 'auto',
          minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
          minWidth: 0,
          overflow: table.getState().isFullScreen ? 'auto' : showTableOverlay || isEmptyResult ? 'hidden' : 'auto',
          border: 0,
          borderRadius: 0,
          boxShadow: 'none',
        },
        style: {
          ...((paperProps as { style?: object }).style ?? {}),
          padding: 0,
        },
      };
    },
    muiTableContainerProps: {
      sx: getPageScrollTableContainerSx({
        loading: showTableOverlay,
        height: '100%',
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
        maxHeight: 'none',
        idleOverflowX: 'auto',
        idleOverflowY: isEmptyResult ? 'hidden' : 'auto',
        idleOverflow: isEmptyResult ? 'hidden' : 'auto',
      }),
    },
    muiTableHeadCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableHeadCellProps.sx,
        '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
          mr: '-8px',
        },
      },
    },
    muiTableBodyCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
        verticalAlign: 'top',
      },
    },
    muiTableBodyProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyProps.sx,
        minHeight: isInitialLoading || isEmptyResult ? '100%' : 0,
      },
    },
    muiTableProps: {
      'aria-label': 'Мережі',
    },
    state: {
      isLoading: loading,
      showLoadingOverlay: false,
      showSkeletons: isInitialLoading,
      showProgressBars: false,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: safeColumnFilters,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder ?? columnOrder,
      columnSizing: tableStateContext.columnSizing ?? {},
      columnVisibility: tableStateContext.columnVisibility ?? {},
    },
  });

  const onTableInitializedRef = useRef(onTableInitialized);

  useEffect(() => {
    onTableInitializedRef.current = onTableInitialized;
  }, [onTableInitialized]);

  useEffect(() => {
    onTableInitializedRef.current(table);
  }, [table]);

  return (
    <Box
      sx={{
        position: 'relative',
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid',
        borderColor: 'var(--bs-border-color)',
        backgroundColor: 'var(--bs-body-bg)',
        overflow: 'hidden',
        '& .Mui-TableHeadCell-ResizeHandle-Wrapper': {
          mr: '-8px',
        },
      }}
      onPointerMoveCapture={onPointerMoveCapture}
    >
      <SectionLoadingOverlay open={showTableOverlay} ariaLabel={isInitialLoading ? 'Завантаження мереж' : 'Оновлення мереж'} showSpinner={!isInitialLoading} />
      <Box sx={{ position: 'relative', minHeight: '100%', height: '100%', display: 'flex', flexDirection: 'column' }}>
        <MaterialReactTable table={table} />
        {showLoadMore ? (
          <Box sx={{ borderTop: '1px solid', borderColor: 'var(--bs-border-color)', display: 'flex', justifyContent: 'center', p: '10px' }}>
            <Button
              variant="outlined"
              onClick={() => void onLoadMoreNetworks()}
              disabled={loadingMore || loading || refreshing}
              startIcon={loadingMore ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {loadingMore ? 'Завантаження...' : 'Завантажити ще'}
            </Button>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
