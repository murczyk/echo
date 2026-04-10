import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloudUploadIcon from '@mui/icons-material/CloudUpload';
import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DriveFileMoveOutlinedIcon from '@mui/icons-material/DriveFileMoveOutlined';
import EditIcon from '@mui/icons-material/Edit';
import FolderOutlinedIcon from '@mui/icons-material/FolderOutlined';
import UnarchiveOutlinedIcon from '@mui/icons-material/UnarchiveOutlined';
import { Box, CircularProgress, Stack, Typography } from '@mui/material';
import type { MRT_VisibilityState } from 'material-react-table';
import { MRT_ColumnDef, MaterialReactTable, useMaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';

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
import type { FolderTableRowView, PalitraRowView, TableRowView } from '../types';

const defaultMRTOptions = getDefaultMRTOptions<TableRowView>();

function buildLoadingRows(): TableRowView[] {
  return Array.from({ length: FULL_HEIGHT_LOADING_ROW_COUNT }, (_, index) => ({
    id: -(index + 1),
    kind: 'palitra',
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
      folder: null,
    } as unknown as Palitra,
    name: '',
    depth: 0,
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

function formatText(value: string | null | undefined): string {
  if (!value || value.trim() === '') return '—';
  return value;
}

function renderEmptyFolderCell() {
  return <Box component='span' sx={{ display: 'block', minHeight: 20 }} />;
}

function renderFolderNameCell(row: FolderTableRowView, onToggleFolderExpanded: (path: string) => void) {
  const leftPadding = row.depth * 3 + 1;

  return (
    <Box
      component='button'
      type='button'
      onClick={() => onToggleFolderExpanded(row.folderPath)}
      sx={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        gap: 1.25,
        pl: leftPadding,
        pr: 0,
        py: 0.25,
        border: 0,
        background: 'transparent',
        textAlign: 'left',
        cursor: 'pointer',
        color: 'inherit',
        font: 'inherit',
      }}
    >
      <FolderOutlinedIcon fontSize='small' color='action' />
      <Typography variant='body2' fontWeight={700} noWrap>
        {formatText(row.name)}
      </Typography>
      <PowerChip
        label={'Палітр: ' + String(row.totalCount)}
        size='small'
        interactive={false}
        unselectedOpacity={1}
        unselectedBackgroundColor='action.selected'
        unselectedTextColor='text.primary'
        unselectedBorderColor='transparent'
      />
    </Box>
  );
}

function renderNameCell(row: TableRowView, onToggleFolderExpanded: (path: string) => void) {
  const leftPadding = row.depth * 3;

  if (row.kind === 'folder') {
    return renderFolderNameCell(row, onToggleFolderExpanded);
  }

  return (
    <Stack direction='row' spacing={1} alignItems='center' flexWrap='wrap' useFlexGap sx={{ pl: leftPadding }}>
      <Typography variant='body2' fontWeight={600}>
        {formatText(row.name)}
      </Typography>
      {row.palitra.isArchived ? (
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
  );
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
  const columns = useMemo<MRT_ColumnDef<TableRowView>[]>(
    () => [
      {
        header: 'Назва',
        accessorKey: 'name',
        id: 'name',
        size: 360,
        Cell: ({ row }) => renderNameCell(row.original, onToggleFolderExpanded),
      },
      {
        header: 'Колір',
        accessorKey: 'colorHex',
        id: 'colorHex',
        size: 140,
        enableSorting: false,
        Cell: ({ row }) =>
          row.original.kind === 'folder' ? (
            renderEmptyFolderCell()
          ) : (
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
        enableSorting: false,
        Cell: ({ row }) =>
          row.original.kind === 'folder' ? (
            renderEmptyFolderCell()
          ) : (
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
        enableSorting: false,
        Cell: ({ row }) => (row.original.kind === 'folder' ? renderEmptyFolderCell() : formatDateTime24(row.original.lastUploadedAtTs)),
      },
      {
        header: 'Автор',
        accessorKey: 'author',
        id: 'author',
        size: 180,
        enableSorting: false,
        Cell: ({ row }) => (row.original.kind === 'folder' ? renderEmptyFolderCell() : formatText(row.original.author)),
      },
      {
        header: 'Доступ',
        accessorKey: 'accessSummary',
        id: 'accessSummary',
        enableSorting: false,
        size: 320,
        Cell: ({ row }) =>
          row.original.kind === 'folder' ? (
            renderEmptyFolderCell()
          ) : (
            <Typography variant='body2' sx={{ maxWidth: 360 }} title={row.original.accessSummary}>
              {row.original.accessSummary}
            </Typography>
          ),
      },
    ],
    [onToggleFolderExpanded],
  );

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
    renderRowActions: ({ row }) => {
      const original = row.original;

      if (original.kind === 'folder') {
        return (
          <Box sx={{ display: 'flex', justifyContent: 'center' }}>
            <MrtRowActions>
              <MrtRowActionButton
                label={original.isExpanded ? 'Згорнути папку' : 'Розгорнути папку'}
                onClick={() => onToggleFolderExpanded(original.folderPath)}
                disabled={externalBusy}
                icon={original.isExpanded ? <ExpandMoreIcon fontSize='small' /> : <ChevronRightIcon fontSize='small' />}
              />
              <MrtRowActionButton
                label='Перейменувати папку'
                onClick={() => onRequestRenameFolder(original.folderPath)}
                disabled={!original.canModify || externalBusy}
                icon={<EditIcon fontSize='small' />}
              />
              <MrtRowActionButton
                label='Архівувати всі палітри в папці'
                onClick={() => onRequestArchiveFolder(original.folderPath)}
                disabled={!original.canModify || externalBusy}
                icon={<ArchiveOutlinedIcon fontSize='small' />}
              />
              <MrtRowActionButton
                label='Видалити всі палітри в папці'
                onClick={() => onRequestDeleteFolder(original.folderPath)}
                disabled={!original.canModify || externalBusy}
                icon={<DeleteIcon fontSize='small' />}
                tone='danger'
              />
            </MrtRowActions>
          </Box>
        );
      }

      const palitraRow = original as PalitraRowView;

      return (
        <Box sx={{ display: 'flex', justifyContent: 'center' }}>
          <MrtRowActions>
            <MrtRowActionButton
              label='Редагувати'
              onClick={() => onOpenEdit(palitraRow.palitra)}
              disabled={
                !palitraRow.canModify ||
                palitraRow.archiveInFlight ||
                palitraRow.deleteInFlight ||
                palitraRow.downloadInFlight ||
                palitraRow.uploadInFlight ||
                bulkDeleteInFlight ||
                externalBusy
              }
              icon={<EditIcon fontSize='small' />}
            />
            <MrtRowActionButton
              label='Перемістити в папку'
              onClick={() => onRequestAssignFolder(palitraRow.palitra)}
              disabled={
                !palitraRow.canModify ||
                palitraRow.archiveInFlight ||
                palitraRow.deleteInFlight ||
                palitraRow.downloadInFlight ||
                palitraRow.uploadInFlight ||
                bulkDeleteInFlight ||
                externalBusy
              }
              icon={<DriveFileMoveOutlinedIcon fontSize='small' />}
            />
            {palitraRow.palitra.isArchived ? (
              <MrtRowActionButton
                label='Повернути з архіву'
                onClick={() => onRequestUnarchive(palitraRow.palitra)}
                disabled={
                  !palitraRow.canModify ||
                  palitraRow.archiveInFlight ||
                  palitraRow.deleteInFlight ||
                  palitraRow.downloadInFlight ||
                  palitraRow.uploadInFlight ||
                  bulkDeleteInFlight ||
                  externalBusy
                }
                icon={
                  palitraRow.archiveInFlight ? (
                    <CircularProgress size={16} color='inherit' />
                  ) : (
                    <UnarchiveOutlinedIcon fontSize='small' />
                  )
                }
              />
            ) : (
              <MrtRowActionButton
                label='Перенести в архів'
                onClick={() => onRequestArchive(palitraRow.palitra)}
                disabled={
                  !palitraRow.canModify ||
                  palitraRow.archiveInFlight ||
                  palitraRow.deleteInFlight ||
                  palitraRow.downloadInFlight ||
                  palitraRow.uploadInFlight ||
                  bulkDeleteInFlight ||
                  externalBusy
                }
                icon={
                  palitraRow.archiveInFlight ? (
                    <CircularProgress size={16} color='inherit' />
                  ) : (
                    <ArchiveOutlinedIcon fontSize='small' />
                  )
                }
              />
            )}
            <MrtRowActionButton
              label='Завантажити'
              onClick={() => onDownload(palitraRow.palitra)}
              disabled={
                palitraRow.id < 0 ||
                palitraRow.archiveInFlight ||
                palitraRow.deleteInFlight ||
                palitraRow.downloadInFlight ||
                palitraRow.uploadInFlight ||
                bulkDeleteInFlight ||
                externalBusy
              }
              icon={palitraRow.downloadInFlight ? <CircularProgress size={16} color='inherit' /> : <DownloadIcon fontSize='small' />}
            />
            <MrtRowActionButton
              label='Додати точки'
              onClick={() => onRequestUploadPoints(palitraRow.id)}
              disabled={
                !palitraRow.canModify ||
                palitraRow.archiveInFlight ||
                palitraRow.deleteInFlight ||
                palitraRow.downloadInFlight ||
                palitraRow.uploadInFlight ||
                bulkDeleteInFlight ||
                externalBusy
              }
              icon={palitraRow.uploadInFlight ? <CircularProgress size={16} color='inherit' /> : <CloudUploadIcon fontSize='small' />}
            />
            <MrtRowActionButton
              label='Видалити'
              onClick={() => onDelete(palitraRow.palitra)}
              disabled={
                !palitraRow.canModify ||
                palitraRow.archiveInFlight ||
                palitraRow.deleteInFlight ||
                palitraRow.downloadInFlight ||
                palitraRow.uploadInFlight ||
                bulkDeleteInFlight ||
                externalBusy
              }
              icon={palitraRow.deleteInFlight ? <CircularProgress size={16} color='inherit' /> : <DeleteIcon fontSize='small' />}
              tone='danger'
            />
          </MrtRowActions>
        </Box>
      );
    },
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
              '& > .MuiTableCell-root': {
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
