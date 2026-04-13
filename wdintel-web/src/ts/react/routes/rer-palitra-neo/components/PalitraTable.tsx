import { Box, Stack } from '@mui/material';
import type { MRT_VisibilityState } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { Palitra } from '../../../../../Bindings';
import { mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
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
import { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import type { PalitraRowView, TableRowView } from '../types';
import { buildPalitraTableColumns, buildLoadingRows } from './PalitraTable.cells';
import { renderPalitraTableRowActions } from './PalitraTable.row-actions';

const defaultMRTOptions = getDefaultMRTOptions<TableRowView>();

export const DEFAULT_PALITRA_COLUMN_VISIBILITY: MRT_VisibilityState = {
  name: true,
  colorHex: true,
  sourceFileName: true,
  lastUploadedAtTs: true,
  author: true,
  accessSummary: true,
};

export const DEFAULT_PALITRA_COLUMN_ORDER = buildDefaultColumnOrder({
  dataColumnIds: ['name', 'colorHex', 'sourceFileName', 'lastUploadedAtTs', 'author', 'accessSummary'],
  withRowSelection: true,
  withRowNumbers: true,
  withRowActions: true,
});

type Props = {
  loading: boolean;
  rows: TableRowView[];
  bulkDeleteInFlight: boolean;
  externalBusy: boolean;
  selectedPalitraIds: number[];
  onOpenEdit: (palitra: Palitra) => void;
  onRequestArchive: (palitra: Palitra) => void;
  onRequestAssignFolder: (palitra: Palitra) => void;
  onRequestUnarchive: (palitra: Palitra) => void;
  onDownload: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onDelete: (palitra: Palitra) => void;
  onSetSelectedPalitraIds: (palitraIds: number[]) => void;
  onToggleFolderExpanded: (path: string) => void;
  onRequestRenameFolder: (path: string) => void;
  onRequestArchiveFolder: (path: string) => void;
  onRequestDeleteFolder: (path: string) => void;
};

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

export function PalitraTable({
  loading,
  rows,
  bulkDeleteInFlight,
  externalBusy,
  selectedPalitraIds,
  onOpenEdit,
  onRequestArchive,
  onRequestAssignFolder,
  onRequestUnarchive,
  onDownload,
  onRequestUploadPoints,
  onDelete,
  onSetSelectedPalitraIds,
  onToggleFolderExpanded,
  onRequestRenameFolder,
  onRequestArchiveFolder,
  onRequestDeleteFolder,
}: Props) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo(() => buildPalitraTableColumns(onToggleFolderExpanded), [onToggleFolderExpanded]);

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
  const rowSelection = useMemo(
    () =>
      rows.reduce<Record<string, boolean>>((acc, row) => {
        if (row.kind === 'palitra' && selectedPalitraIds.includes(row.id)) acc[String(row.id)] = true;
        return acc;
      }, {}),
    [rows, selectedPalitraIds],
  );
  const hasActiveFilters = tableStateContext.globalFilter.trim() !== '' || tableStateContext.columnFilters.length > 0;
  const isInitialLoading = loading && rows.length === 0;
  const showTableOverlay = loading;
  const tableRows = isInitialLoading ? buildLoadingRows() : rows;

  useEffect(() => {
    if (selectedPalitraIds.length === 0) return;
    onSetSelectedPalitraIds([]);
  }, [tableStateContext.globalFilter, tableStateContext.columnFilters, tableStateContext.sorting]);

  const table = useMaterialReactTable({
    columns,
    data: tableRows,
    ...defaultMRTOptions,
    enablePagination: false,
    enableBottomToolbar: false,
    enableTopToolbar: false,
    enableDensityToggle: false,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: false,
    enableFacetedValues: false,
    enableHiding: true,
    enableSorting: false,
    enableRowNumbers: true,
    enableRowActions: true,
    enableRowSelection: (row) => row.original.kind === 'palitra' && row.original.canSelect && !bulkDeleteInFlight && !externalBusy,
    enableMultiRowSelection: true,
    enableSelectAll: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    positionActionsColumn: 'first',
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onSortingChange: tableStateContext.onSortingChange,
    onRowSelectionChange: (updater) => {
      const nextSelection = resolveUpdater(updater, rowSelection);
      const nextIds = rows
        .filter((row): row is PalitraRowView => row.kind === 'palitra' && Boolean(nextSelection[String(row.id)]))
        .map((row) => row.id);
      onSetSelectedPalitraIds(nextIds);
    },
    renderRowActions: ({ row }) =>
      renderPalitraTableRowActions({
        row: row.original,
        bulkDeleteInFlight,
        externalBusy,
        onOpenEdit,
        onRequestArchive,
        onRequestAssignFolder,
        onRequestUnarchive,
        onDownload,
        onRequestUploadPoints,
        onDelete,
        onToggleFolderExpanded,
        onRequestRenameFolder,
        onRequestArchiveFolder,
        onRequestDeleteFolder,
      }),
    renderEmptyRowsFallback: () => (
      <Box sx={{ py: 6 }}>
        <TableEmptyState message={hasActiveFilters ? 'Немає палітр за обраними фільтрами' : 'Палітри відсутні'} />
      </Box>
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    localization: {
      ...defaultMRTOptions.localization,
      select: '',
      toggleSelectAll: 'Вибрати всі рядки',
      toggleSelectRow: 'Вибрати рядок',
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: mrtRowActionsColumnSize(6),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...((baseProps as { sx?: object }).sx ?? {}),
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isInitialLoading ? '100%' : 'auto',
          minHeight: isInitialLoading ? '100%' : 0,
          overflow: table.getState().isFullScreen ? 'auto' : 'hidden',
          ...(isInitialLoading
            ? {
                backgroundImage: 'none',
                backgroundSize: 'auto',
                backgroundPosition: 'initial',
              }
            : {}),
        },
        style: {
          ...((baseProps as { style?: object }).style ?? {}),
          padding: 0,
        },
      };
    },
    muiTableContainerProps: ({ table }) => ({
      sx: {
        ...((CUSTOM_STYLES.muiTableContainerProps as { sx?: object }).sx ?? {}),
        ...getPageScrollTableContainerSx({
          loading: showTableOverlay,
          height: isInitialLoading ? '100%' : 'auto',
          minHeight: isInitialLoading ? '100%' : 0,
          maxHeight: table.getState().isFullScreen ? '100%' : 'none',
          idleOverflow: 'auto',
        }),
      },
    }),
    muiTableBodyRowProps: ({ row }) => ({
      hover: true,
      sx: {
        backgroundColor: row.original.kind === 'folder' ? 'action.hover' : undefined,
        ...(row.original.kind === 'folder'
          ? {
              '& > .MuiTableCell-root:nth-of-type(n + 4)': {
                borderRight: 0,
              },
            }
          : {}),
        opacity:
          row.original.kind === 'palitra' &&
          (row.original.archiveInFlight || row.original.deleteInFlight || row.original.downloadInFlight || row.original.uploadInFlight)
            ? 0.6
            : 1,
      },
    }),
    state: {
      showAlertBanner: false,
      showLoadingOverlay: false,
      density: tableStateContext.density,
      columnVisibility: tableStateContext.columnVisibility,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
      rowSelection,
      isLoading: loading,
      showSkeletons: loading,
      showProgressBars: false,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table, tableStateContext]);

  return (
    <Box
      sx={{
        height: '100%',
        minHeight: 0,
        overflowY: showTableOverlay ? 'hidden' : 'auto',
        overflowX: showTableOverlay ? 'hidden' : 'auto',
      }}
    >
      <Stack sx={{ height: '100%', minHeight: 0 }}>
        <MaterialReactTable table={table} />
      </Stack>
    </Box>
  );
}
