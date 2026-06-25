import { useEffect } from 'react';
import {
  MaterialReactTable,
  type MRT_ColumnDef,
  type MRT_RowData,
  type MRT_TableOptions,
  useMaterialReactTable,
} from 'material-react-table';

import {
  CUSTOM_CELL_STYLES,
  CUSTOM_STYLES,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../components/mui-customized/table/custom-styles';
import { getDefaultMRTOptions, renderColumnActionsMenuItems } from '../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

type SettingsNeoTableProps<TData extends MRT_RowData> = {
  columns: MRT_ColumnDef<TData>[];
  data: TData[];
  loading?: boolean;
  loadingRows?: TData[];
  layoutMode?: MRT_TableOptions<TData>['layoutMode'];
  manualFiltering?: boolean;
  manualSorting?: boolean;
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
  onQueryStateChange,
}: SettingsNeoTableProps<TData>) {
  const tableStateContext = useTableStateContext();
  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};

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
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
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
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as any)?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
        },
      };
    },
    muiTableContainerProps: {
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as any)?.sx,
        ...getPageScrollTableContainerSx({ loading, idleOverflow: 'auto' }),
      },
    },
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
  }, [onQueryStateChange, tableStateContext.columnFilters, tableStateContext.globalFilter, tableStateContext.sorting]);

  return <MaterialReactTable table={table} />;
}
