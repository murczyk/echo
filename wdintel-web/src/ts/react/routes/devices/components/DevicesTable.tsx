import { Box, CircularProgress, Link, Typography } from '@mui/material';
import type { MRT_ColumnDef, MRT_ColumnOrderState, MRT_TableInstance } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo, useRef } from 'react';

import { mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { PowerChip } from '../../../components/PowerChip';
import { PowerButton } from '../../../components/PowerButton';
import { SectionLoadingOverlay } from '../../../components/SectionLoadingOverlay';
import { TableEmptyState } from '../../../components/TableEmptyState';
import { handleNavigateWithinSpaClick } from '../../../utils/browser';
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
import type { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { DeviceRowActions } from './DeviceRowActions';
import type { DeviceRowView } from '../helpers';

const defaultMrtOptions = getDefaultMRTOptions<DeviceRowView>();
const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
const resolvedPaperProps =
  typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

type Props = {
  rows: DeviceRowView[];
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number;
  canEdit: boolean;
  mutatingDeviceId: string | null;
  showLifecycle: boolean;
  hasFilters: boolean;
  tableStateContext: ReturnType<typeof useTableStateContext>;
  onEdit: (deviceId: string) => void;
  onLoadMore: () => Promise<void>;
  onClearFilters: () => void;
  onTableInitialized: (table: MRT_TableInstance<DeviceRowView>) => void;
  columnOrder: MRT_ColumnOrderState;
};

function useDevicesTableColumns(showLifecycle: boolean): MRT_ColumnDef<DeviceRowView>[] {
  return useMemo(
    () => [
      {
        id: 'name',
        accessorFn: (row) => row.name || row.sourceLabel,
        header: 'Назва',
        size: 260,
        Cell: ({ row }) => {
          const href = `/devices/${row.original.id}`;
          return (
            <Link
              href={href}
              underline="hover"
              fontWeight={600}
              onClick={(event) => handleNavigateWithinSpaClick(event, href)}
            >
              {row.original.name || row.original.sourceLabel}
            </Link>
          );
        },
      },
      {
        id: 'createdBy',
        accessorKey: 'createdBy',
        header: 'Створив',
        size: 160,
        enableSorting: false,
      },
      {
        id: 'aors',
        accessorKey: 'aorLabel',
        header: 'Смуги',
        size: 240,
        enableSorting: false,
        Cell: ({ cell }) => (
          <Typography
            variant="body2"
            color={cell.getValue<string>() === '—' ? 'text.secondary' : undefined}
          >
            {cell.getValue<string>()}
          </Typography>
        ),
      },
      {
        id: 'unit',
        accessorKey: 'unitLabel',
        header: 'Підрозділ',
        size: 220,
        enableSorting: false,
        Cell: ({ cell }) => (
          <Typography
            variant="body2"
            color={cell.getValue<string>() === '—' ? 'text.secondary' : undefined}
          >
            {cell.getValue<string>()}
          </Typography>
        ),
      },
      {
        id: 'updatedAt',
        accessorKey: 'updatedAt',
        header: 'Оновлено',
        size: 170,
        Cell: ({ row }) => row.original.updatedAtLabel,
      },
      {
        id: 'lifecycle',
        accessorKey: 'archived',
        header: 'Стан',
        size: 120,
        enableSorting: false,
        Cell: ({ row }) =>
          showLifecycle ? (
            row.original.archived ? (
              <PowerChip label="Архівний" color="warning" selected />
            ) : (
              <PowerChip label="Активний" color="success" selected />
            )
          ) : null,
      },
    ],
    [showLifecycle],
  );
}

export function DevicesTable({
  rows,
  loading,
  refreshing,
  loadingMore,
  hasMore,
  total,
  canEdit,
  mutatingDeviceId,
  showLifecycle,
  hasFilters,
  tableStateContext,
  onEdit,
  onLoadMore,
  onClearFilters,
  onTableInitialized,
  columnOrder,
}: Props) {
  const columns = useDevicesTableColumns(showLifecycle);
  const isInitialLoading = loading && rows.length === 0;
  const isEmptyResult = !isInitialLoading && rows.length === 0;
  const showLoadMore = !isInitialLoading && hasMore;
  const showTableOverlay =
    !isInitialLoading && (loadingMore || refreshing || mutatingDeviceId !== null);

  const table = useMaterialReactTable({
    ...defaultMrtOptions,
    data: rows,
    columns,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: false,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableSorting: true,
    manualFiltering: true,
    manualSorting: true,
    enableHiding: true,
    enableRowActions: canEdit,
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
    onSortingChange: tableStateContext.onSortingChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    renderRowActions: ({ row }) => (
      <DeviceRowActions
        row={row.original}
        canEdit={canEdit}
        disabled={mutatingDeviceId !== null}
        onEdit={onEdit}
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
        size: mrtRowActionsColumnSize(1),
        enableResizing: false,
      },
    },
    renderEmptyRowsFallback: () => (
      <TableEmptyState
        message={hasFilters ? 'Пристрої не знайдено' : 'Пристрої ще не створені'}
        actionLabel={hasFilters ? 'Очистити фільтри' : undefined}
        onAction={hasFilters ? onClearFilters : undefined}
      />
    ),
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
          overflow: table.getState().isFullScreen
            ? 'auto'
            : showTableOverlay || isEmptyResult
              ? 'hidden'
              : 'auto',
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
      'aria-label': 'Пристрої',
    },
    state: {
      isLoading: loading,
      showLoadingOverlay: false,
      showSkeletons: isInitialLoading,
      showProgressBars: false,
      globalFilter: tableStateContext.globalFilter,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder ?? columnOrder,
      columnSizing: tableStateContext.columnSizing ?? {},
      columnVisibility: {
        ...(tableStateContext.columnVisibility ?? {}),
        lifecycle: showLifecycle,
      },
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
      }}
    >
      <SectionLoadingOverlay
        open={showTableOverlay}
        ariaLabel={isInitialLoading ? 'Завантаження пристроїв' : 'Оновлення пристроїв'}
        showSpinner={!isInitialLoading}
      />
      <Box
        sx={{
          position: 'relative',
          minHeight: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
        }}
      >
        <MaterialReactTable table={table} />
        {showLoadMore ? (
          <Box
            sx={{
              borderTop: '1px solid',
              borderColor: 'var(--bs-border-color)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 2,
              p: '10px',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Показано {rows.length} з {total}
            </Typography>
            <PowerButton
              variant="outlined"
              onClick={() => void onLoadMore()}
              disabled={loadingMore || loading || refreshing}
              startIcon={loadingMore ? <CircularProgress size={16} color="inherit" /> : null}
            >
              {loadingMore ? 'Завантаження…' : 'Завантажити ще'}
            </PowerButton>
          </Box>
        ) : rows.length > 0 ? (
          <Box
            sx={{
              borderTop: '1px solid',
              borderColor: 'var(--bs-border-color)',
              display: 'flex',
              justifyContent: 'center',
              p: '10px',
            }}
          >
            <Typography variant="body2" color="text.secondary">
              Показано {rows.length} з {total}
            </Typography>
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}
