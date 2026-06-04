import { Box } from '@mui/material';
import type { MRT_VisibilityState } from 'material-react-table';
import { MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { Palitra } from '../../../../../Bindings';
import { mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
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

  const rowSelection = useMemo(
    () =>
      rows.reduce<Record<string, boolean>>((acc, row) => {
        if (row.kind === 'palitra' && selectedPalitraIds.includes(row.id)) acc[String(row.id)] = true;
        return acc;
      }, {}),
    [rows, selectedPalitraIds],
  );
  const hasActiveFilters = tableStateContext.globalFilter.trim() !== '' || tableStateContext.columnFilters.length > 0;
  const visibleRows = useMemo(
    () => (hasActiveFilters ? rows : rows.filter((row) => !row.hiddenByCollapsedFolder)),
    [hasActiveFilters, rows],
  );
  const visibleSelectablePalitraIdSet = useMemo(
    () =>
      new Set(
        visibleRows
          .filter((row): row is PalitraRowView => row.kind === 'palitra' && row.canSelect)
          .map((row) => row.id),
      ),
    [visibleRows],
  );
  const isInitialLoading = loading && visibleRows.length === 0;
  const showTableOverlay = loading;
  const tableRows = isInitialLoading ? buildLoadingRows() : visibleRows;

  useEffect(() => {
    if (selectedPalitraIds.length === 0) return;
    const nextIds = selectedPalitraIds.filter((id) => visibleSelectablePalitraIdSet.has(id));
    if (nextIds.length !== selectedPalitraIds.length) {
      onSetSelectedPalitraIds(nextIds);
    }
  }, [visibleSelectablePalitraIdSet, selectedPalitraIds, onSetSelectedPalitraIds]);

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
      const nextIds = visibleRows
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
    renderEmptyRowsFallback: ({ table }) => renderDefaultMrtEmptyRowsFallback({
      table,
    }),
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
      const paperProps = getDefaultMrtPaperProps({ table, loading, layout: 'list' });
      return {
        ...paperProps,
        sx: {
          ...((paperProps as { sx?: object }).sx ?? {}),
          ...(isInitialLoading
            ? {
                backgroundImage: 'none',
                backgroundSize: 'auto',
                backgroundPosition: 'initial',
              }
            : {}),
        },
        style: {
          ...((paperProps as { style?: object }).style ?? {}),
          padding: 0,
        },
      };
    },
    muiTableContainerProps: ({ table }) =>
      getDefaultMrtContainerProps({
        loading: showTableOverlay,
        layout: 'list',
        fullScreen: table.getState().isFullScreen,
        hasRows: rows.length > 0,
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
      <MaterialReactTable table={table} />
    </Box>
  );
}
