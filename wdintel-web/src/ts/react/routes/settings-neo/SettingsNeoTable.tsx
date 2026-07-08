import { useEffect } from 'react';
import { Box } from '@mui/material';
import type { SxProps, Theme } from '@mui/material/styles';
import {
  MaterialReactTable,
  type MRT_ColumnDef,
  type MRT_RowData,
  type MRT_TableOptions,
  useMaterialReactTable,
} from 'material-react-table';
import type { ReactNode } from 'react';

import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { InternalTableActions } from '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions';
import { mrtRowActionsColumnSize } from '../../components/MrtRowActionButton';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

type SettingsNeoTableProps<TData extends MRT_RowData> = {
  columns: MRT_ColumnDef<TData>[];
  data: TData[];
  loading?: boolean;
  loadingRows?: TData[];
  layoutMode?: MRT_TableOptions<TData>['layoutMode'];
  manualFiltering?: boolean;
  manualSorting?: boolean;
  enableRowActions?: boolean;
  renderRowActions?: MRT_TableOptions<TData>['renderRowActions'];
  rowActionsColumnSize?: number;
  showToolbarInternalActions?: boolean;
  enableTopToolbar?: boolean;
  enableBottomToolbar?: boolean;
  toolbarFiltersHidden?: boolean;
  toolbarColumnsVisibilityDisabled?: boolean;
  toolbarFullScreenEnabled?: boolean;
  toolbarRowNumberAppearanceControl?: boolean;
  toolbarAdditionalActions?: ReactNode;
  renderBottomToolbar?: MRT_TableOptions<TData>['renderBottomToolbar'];
  muiBottomToolbarProps?: MRT_TableOptions<TData>['muiBottomToolbarProps'];
  tableContainerBorderless?: boolean;
  tablePaperSx?: SxProps<Theme>;
  tableContainerSx?: SxProps<Theme>;
  tableHeadCellSx?: Record<string, unknown>;
  onQueryStateChange?: (state: {
    globalFilter: string;
    columnFilters: Array<{ id: string; value: unknown }>;
    sorting: Array<{ id: string; desc: boolean }>;
  }) => void;
};

export function SettingsNeoTable<TData extends MRT_RowData>({
  columns,
  data,
  loading = false,
  loadingRows,
  layoutMode = 'grid-no-grow',
  manualFiltering = false,
  manualSorting = false,
  enableRowActions = false,
  renderRowActions,
  rowActionsColumnSize = mrtRowActionsColumnSize(1),
  showToolbarInternalActions = false,
  enableTopToolbar = false,
  enableBottomToolbar = false,
  toolbarFiltersHidden = false,
  toolbarColumnsVisibilityDisabled = false,
  toolbarFullScreenEnabled = false,
  toolbarRowNumberAppearanceControl = false,
  toolbarAdditionalActions,
  renderBottomToolbar,
  muiBottomToolbarProps,
  tableContainerBorderless = false,
  tablePaperSx,
  tableContainerSx,
  tableHeadCellSx,
  onQueryStateChange,
}: SettingsNeoTableProps<TData>) {
  const tableStateContext = useTableStateContext();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps =
    typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
  const baseHeadCellProps = (CUSTOM_STYLES.muiTableHeadCellProps ?? {}) as { sx?: object };

  const table = useMaterialReactTable({
    columns,
    data: loading && loadingRows ? loadingRows : data,
    ...getDefaultMRTOptions<TData>(),
    layoutMode,
    enableSorting: true,
    enableColumnActions: true,
    enableRowNumbers: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableTopToolbar,
    enableBottomToolbar: enableBottomToolbar || Boolean(renderBottomToolbar),
    enableRowActions,
    manualFiltering,
    manualSorting,
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
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    renderTopToolbar: showToolbarInternalActions
      ? ({ table }) =>
          table.getState().isFullScreen ? (
            <Box sx={{ display: 'flex', justifyContent: 'flex-end', p: 1 }}>
              <InternalTableActions
                table={table}
                filtersHidden={toolbarFiltersHidden}
                columnsVisibilityDisabled={toolbarColumnsVisibilityDisabled}
                fullScreenEnabled={toolbarFullScreenEnabled}
                rowNumberAppearanceControl={toolbarRowNumberAppearanceControl}
              >
                {toolbarAdditionalActions}
              </InternalTableActions>
            </Box>
          ) : (
            <></>
          )
      : undefined,
    renderBottomToolbar,
    renderRowActions,
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: rowActionsColumnSize,
        minSize: rowActionsColumnSize,
        maxSize: rowActionsColumnSize,
        enableResizing: false,
      },
      'mrt-row-numbers': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-numbers'],
        muiTableBodyCellProps: () => ({
          sx: {
            justifyContent: 'center',
            ...CUSTOM_CELL_STYLES,
          },
        }),
      },
    },
    muiTableHeadCellProps: {
      ...baseHeadCellProps,
      sx: {
        ...baseHeadCellProps.sx,
        ...(tableHeadCellSx ?? {}),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          ...tablePaperSx,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({ loading, idleOverflow: 'auto' }),
        ...(tableContainerBorderless ? { border: 0 } : {}),
        ...tableContainerSx,
      },
    },
    muiBottomToolbarProps,
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      showSkeletons: loading,
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

  useEffect(() => {
    onQueryStateChange?.({
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters as Array<{ id: string; value: unknown }>,
      sorting: tableStateContext.sorting as Array<{ id: string; desc: boolean }>,
    });
  }, [
    onQueryStateChange,
    tableStateContext.columnFilters,
    tableStateContext.globalFilter,
    tableStateContext.sorting,
  ]);

  return <MaterialReactTable table={table} />;
}
