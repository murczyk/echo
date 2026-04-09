import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import type { MRT_VisibilityState } from 'material-react-table';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';
import type { CSSProperties } from 'react';

import type { Palitra } from '../../../../../Bindings';
import { MrtRowActionButton, MrtRowActions, mrtRowActionsColumnSize } from '../../../components/MrtRowActionButton';
import { PowerChip } from '../../../components/PowerChip';
import { TableEmptyState } from '../../../components/TableEmptyState';
import {
  CUSTOM_STYLES,
  FULL_HEIGHT_LOADING_ROW_COUNT,
  FULL_WIDTH_TABLE_PAPER_SX,
  getPageScrollTableContainerSx,
} from '../../../components/mui-customized/table/custom-styles';
import {
  buildDefaultColumnOrder,
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
} from '../../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../../components/mui-customized/table/table-state-provider';
import { formatDateTime24 } from '../../../utils/misc';
import type { PalitraRowView } from '../types';

const defaultMRTOptions = getDefaultMRTOptions<PalitraRowView>();

function buildLoadingRows(): PalitraRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    palitra: {
      id: -(index + 1),
      name: '',
      colorHex: '',
      sourceFileName: null,
      author: null,
      lastUploadedAtTs: null,
      accessLogins: [],
      accessOrganismIds: [],
      accessAorId: [],
    } as unknown as Palitra,
    name: '',
    colorHex: '',
    sourceFileName: null,
    lastUploadedAtTs: null,
    author: null,
    accessSummary: '',
    canModify: false,
    canSelect: false,
    archiveInFlight: false,
    deleteInFlight: false,
    downloadInFlight: false,
    uploadInFlight: false,
  }));
}

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
  rows: PalitraRowView[];
  bulkDeleteInFlight: boolean;
  selectedPalitraIds: number[];
  onOpenEdit: (palitra: Palitra) => void;
  onRequestArchive: (palitra: Palitra) => void;
  onRequestUnarchive: (palitra: Palitra) => void;
  onDownload: (palitra: Palitra) => void;
  onRequestUploadPoints: (palitraId: number) => void;
  onDelete: (palitra: Palitra) => void;
  onSetSelectedPalitraIds: (palitraIds: number[]) => void;
};

type Updater<T> = T | ((prev: T) => T);

function resolveUpdater<T>(value: Updater<T>, current: T): T {
  return typeof value === 'function' ? (value as (prev: T) => T)(current) : value;
}

function formatText(value: string | null | undefined): string {
  if (!value || value.trim() === '') return '—';
  return value;
}

export function PalitraTable({
  loading,
  rows,
  bulkDeleteInFlight,
  selectedPalitraIds,
  onOpenEdit,
  onRequestArchive,
  onRequestUnarchive,
  onDownload,
  onRequestUploadPoints,
  onDelete,
  onSetSelectedPalitraIds,
}: Props) {
  const tableStateContext = useTableStateContext();
  const columns = useMemo<MRT_ColumnDef<PalitraRowView>[]>(
    () => [
      {
        header: 'Назва',
        accessorKey: 'name',
        id: 'name',
        size: 240,
        Cell: ({ row }) => (
          <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap>
            <Typography variant='body2' fontWeight={600}>
              {formatText(row.original.name)}
            </Typography>
            {row.original.palitra.isArchived ? (
              <PowerChip
                label='Архів'
                size='small'
                interactive={false}
                selected
                backgroundColor='warning.light'
                selectedBorderColor='warning.main'
                selectedTextColor='warning.contrastText'
                sx={{ '& .MuiChip-label': { px: 1 } }}
              />
            ) : null}
          </Stack>
        ),
      },
      {
        header: 'Колір',
        accessorKey: 'colorHex',
        id: 'colorHex',
        size: 140,
        Cell: ({ row }) => (
          <PowerChip
            label={formatText(row.original.colorHex)}
            size='small'
            interactive={false}
            selected
            backgroundColor={row.original.colorHex || 'transparent'}
            selectedBorderColor={row.original.colorHex || 'divider'}
            autoTextContrast
          />
        ),
      },
      {
        header: 'Файл',
        accessorKey: 'sourceFileName',
        id: 'sourceFileName',
        size: 240,
        Cell: ({ row }) => (
          <Typography variant='body2' sx={{ maxWidth: 280 }} noWrap title={formatText(row.original.sourceFileName)}>
            {formatText(row.original.sourceFileName)}
          </Typography>
        ),
      },
      {
        header: 'Додано',
        accessorKey: 'lastUploadedAtTs',
        id: 'lastUploadedAtTs',
        size: 170,
        enableColumnFilter: false,
        Cell: ({ row }) => formatDateTime24(row.original.lastUploadedAtTs),
      },
      {
        header: 'Автор',
        accessorKey: 'author',
        id: 'author',
        size: 180,
        Cell: ({ row }) => formatText(row.original.author),
      },
      {
        header: 'Доступ',
        accessorKey: 'accessSummary',
        id: 'accessSummary',
        enableSorting: false,
        size: 320,
        Cell: ({ row }) => (
          <Typography variant='body2' sx={{ maxWidth: 360 }} title={row.original.accessSummary}>
            {row.original.accessSummary}
          </Typography>
        ),
      },
    ],
    [],
  );

  const basePaperProps = CUSTOM_STYLES.muiTablePaperProps;
  const resolvedPaperProps = typeof basePaperProps === 'function' ? basePaperProps : () => basePaperProps || {};
  const rowSelection = useMemo(
    () =>
      rows.reduce<Record<string, boolean>>((acc, row) => {
        if (selectedPalitraIds.includes(row.id)) {
          acc[String(row.id)] = true;
        }
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
    enableSorting: true,
    enableRowNumbers: true,
    enableRowActions: true,
    enableRowSelection: (row) => row.original.canSelect && bulkDeleteInFlight === false,
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
      const nextIds = rows.filter((row) => nextSelection[String(row.id)]).map((row) => row.id);
      onSetSelectedPalitraIds(nextIds);
    },
    renderRowActions: ({ row }) => (
      <Box sx={{ display: 'flex', justifyContent: 'center' }}>
        <MrtRowActions>
          <MrtRowActionButton
            label='Редагувати'
            onClick={() => onOpenEdit(row.original.palitra)}
            disabled={
              row.original.canModify === false ||
              row.original.archiveInFlight ||
              row.original.deleteInFlight ||
              row.original.downloadInFlight ||
              row.original.uploadInFlight ||
              bulkDeleteInFlight
            }
            icon={<EditIcon fontSize='small' />}
          />
          {row.original.palitra.isArchived ? (
            <MrtRowActionButton
              label='Повернути з архіву'
              onClick={() => onRequestUnarchive(row.original.palitra)}
              disabled={
                row.original.canModify === false ||
                row.original.archiveInFlight ||
                row.original.deleteInFlight ||
                row.original.downloadInFlight ||
                row.original.uploadInFlight ||
                bulkDeleteInFlight
              }
              icon={
                row.original.archiveInFlight ? (
                  <CircularProgress size={16} color='inherit' />
                ) : (
                  <UnarchiveOutlinedIcon fontSize='small' />
                )
              }
            />
          ) : (
            <MrtRowActionButton
              label='Перенести в архів'
              onClick={() => onRequestArchive(row.original.palitra)}
              disabled={
                row.original.canModify === false ||
                row.original.archiveInFlight ||
                row.original.deleteInFlight ||
                row.original.downloadInFlight ||
                row.original.uploadInFlight ||
                bulkDeleteInFlight
              }
              icon={
                row.original.archiveInFlight ? (
                  <CircularProgress size={16} color='inherit' />
                ) : (
                  <ArchiveOutlinedIcon fontSize='small' />
                )
              }
            />
          )}
          <MrtRowActionButton
            label='Завантажити'
            onClick={() => onDownload(row.original.palitra)}
            disabled={
              row.original.id < 0 ||
              row.original.archiveInFlight ||
              row.original.deleteInFlight ||
              row.original.downloadInFlight ||
              row.original.uploadInFlight ||
              bulkDeleteInFlight
            }
            icon={row.original.downloadInFlight ? <CircularProgress size={16} color='inherit' /> : <DownloadIcon fontSize='small' />}
          />
          <MrtRowActionButton
            label='Додати точки'
            onClick={() => onRequestUploadPoints(row.original.id)}
            disabled={
              row.original.canModify === false ||
              row.original.archiveInFlight ||
              row.original.deleteInFlight ||
              row.original.downloadInFlight ||
              row.original.uploadInFlight ||
              bulkDeleteInFlight
            }
            icon={row.original.uploadInFlight ? <CircularProgress size={16} color='inherit' /> : <CloudUploadIcon fontSize='small' />}
          />
          <MrtRowActionButton
            label='Видалити'
            onClick={() => onDelete(row.original.palitra)}
            disabled={
              row.original.canModify === false ||
              row.original.archiveInFlight ||
              row.original.deleteInFlight ||
              row.original.downloadInFlight ||
              row.original.uploadInFlight ||
              bulkDeleteInFlight
            }
            icon={row.original.deleteInFlight ? <CircularProgress size={16} color='inherit' /> : <DeleteIcon fontSize='small' />}
            tone='danger'
          />
        </MrtRowActions>
      </Box>
    ),
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
        size: mrtRowActionsColumnSize(5),
      },
    },
    muiTablePaperProps: ({ table }) => {
      const baseProps = resolvedPaperProps({ table });
      return {
        ...baseProps,
        sx: {
          ...(baseProps as { sx?: object })?.sx,
          ...FULL_WIDTH_TABLE_PAPER_SX,
          height: isInitialLoading ? '100%' : 'auto',
          minHeight: isInitialLoading ? '100%' : 0,
          overflow: table.getState().isFullScreen ? 'auto' : 'hidden',
        },
        style: {
          ...(baseProps as { style?: CSSProperties })?.style,
          padding: 0,
        },
      };
    },
    muiTableContainerProps: ({ table }) => ({
      sx: {
        ...(CUSTOM_STYLES.muiTableContainerProps as { sx?: object })?.sx,
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
        opacity:
          row.original.archiveInFlight ||
          row.original.deleteInFlight ||
          row.original.downloadInFlight ||
          row.original.uploadInFlight
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
