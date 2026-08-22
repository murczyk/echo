import DeleteIcon from '@mui/icons-material/Delete';
import DownloadIcon from '@mui/icons-material/Download';
import EditIcon from '@mui/icons-material/Edit';
import { Box, Button } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useEffect, useMemo } from 'react';

import type { UnitAttachment } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import {
  CUSTOM_STYLES,
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  mrtItemsCell,
  mrtTextCell,
  useAppMaterialReactTable,
  getFilterModeHelperText,
  getSharedFilterTextFieldProps,
  renderColumnActionsMenuItems,
} from '../../components/mui-customized/table/get-default-table-options';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

const defaultMrtOptions = getDefaultMRTOptions<UnitAttachment>();
const ROW_ACTIONS_COLUMN_SIZE = 76;

function formatDateTime(value: number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('uk-UA', {
    dateStyle: 'short',
    timeStyle: 'short',
  }).format(date);
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) return `${Math.floor(sizeBytes / (1024 * 1024))} МБ`;
  if (sizeBytes >= 1024) return `${Math.floor(sizeBytes / 1024)} КБ`;
  return `${sizeBytes} Б`;
}

function useAttachmentColumns(
  downloadingId: number | null,
  onDownload: (attachment: UnitAttachment) => void,
): AppMrtColumnDef<UnitAttachment>[] {
  return useMemo(
    () => [
      {
        header: 'Файл',
        accessorKey: 'fileName',
        size: 240,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => (
          <Box>
            <Button
              variant="text"
              size="small"
              startIcon={<DownloadIcon fontSize="small" />}
              disabled={downloadingId !== null}
              onClick={() => onDownload(row.original)}
              sx={{ p: 0, minWidth: 0, textTransform: 'none', textAlign: 'left' }}
            >
              {row.original.fileName || `attachment-${row.original.id}`}
            </Button>
            <Box sx={{ color: 'text.secondary', fontSize: '0.75rem', mt: 0.5 }}>
              {formatFileSize(row.original.sizeBytes)}
            </Box>
          </Box>
        ),
      },
      {
        header: 'Короткий опис',
        accessorKey: 'shortDescription',
        size: 260,
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '') || '—'}
          </Box>
        ),
      },
      {
        header: 'Повний опис',
        accessorKey: 'fullDescription',
        size: 360,
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => (
          <Box sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {String(cell.getValue() ?? '') || '—'}
          </Box>
        ),
      },
      {
        header: 'Смуги',
        id: 'aors',
        accessorFn: (attachment) => (attachment.aors ?? []).map(({ name }) => name).join(', '),
        size: 220,
        meta: { overflowMode: 'items' },
        Cell: mrtItemsCell<UnitAttachment, string>({
          items: ({ row }) => (row.original.aors ?? []).map(({ name }) => name),
          renderItem: (name) => <Box component="span">{name}</Box>,
          measurementScope: 'unit-attachments:aors',
          disclosureLayout: 'list',
          getItemText: (name) => name,
        }),
      },
      {
        header: 'Дата внесення',
        id: 'createdAt',
        accessorFn: (attachment) => formatDateTime(attachment.createdAt),
        sortingFn: (left, right) => left.original.createdAt - right.original.createdAt,
        sortDescFirst: true,
        size: 170,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ row }) => formatDateTime(row.original.createdAt),
          fullValue: ({ row }) => formatDateTime(row.original.createdAt),
        }),
      },
    ],
    [downloadingId, onDownload],
  );
}

export function UnitAttachmentsTable({
  attachments,
  loading,
  actionInFlight,
  downloadingId,
  onDownload,
  onEdit,
  onDelete,
}: {
  attachments: UnitAttachment[];
  loading: boolean;
  actionInFlight: boolean;
  downloadingId: number | null;
  onDownload: (attachment: UnitAttachment) => void;
  onEdit: (attachment: UnitAttachment) => void;
  onDelete: (attachment: UnitAttachment) => void;
}) {
  const tableStateContext = useTableStateContext();
  const columns = useAttachmentColumns(downloadingId, onDownload);
  const table = useAppMaterialReactTable({
    columns,
    data: attachments,
    enableSorting: true,
    enableColumnActions: true,
    enableGlobalFilter: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableColumnOrdering: tableStateContext.enableColumnOrdering,
    enableColumnResizing: tableStateContext.enableColumnResizing,
    enableRowActions: true,
    positionActionsColumn: 'first',
    columnFilterDisplayMode: 'popover',
    onColumnVisibilityChange: tableStateContext.onColumnVisibilityChange,
    onColumnFiltersChange: tableStateContext.onColumnFiltersChange,
    onColumnOrderChange: tableStateContext.onColumnOrderChange,
    onColumnSizingChange: tableStateContext.onColumnSizingChange,
    onSortingChange: tableStateContext.onSortingChange,
    onGlobalFilterChange: tableStateContext.onChangeGlobalFilter,
    muiFilterTextFieldProps: ({ column }) => ({
      ...getSharedFilterTextFieldProps(column.columnDef.filterVariant),
      helperText: getFilterModeHelperText(column.columnDef.filterVariant),
    }),
    defaultColumn: {
      size: 200,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...CUSTOM_STYLES.displayColumnDefOptions,
      'mrt-row-actions': {
        ...CUSTOM_STYLES.displayColumnDefOptions['mrt-row-actions'],
        size: ROW_ACTIONS_COLUMN_SIZE,
        minSize: ROW_ACTIONS_COLUMN_SIZE,
        maxSize: ROW_ACTIONS_COLUMN_SIZE,
      },
    },
    renderRowActions: ({ row }) => (
      <Box sx={{ display: 'flex', justifyContent: 'center', gap: 0.5 }}>
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onEdit(row.original)}
          disabled={actionInFlight}
          icon={<EditIcon fontSize="small" />}
        />
        <MrtRowActions forceMenu>
          <MrtRowActionButton
            label="Видалити"
            onClick={() => onDelete(row.original)}
            disabled={actionInFlight}
            icon={<DeleteIcon fontSize="small" />}
            tone="danger"
            opensModal
          />
        </MrtRowActions>
      </Box>
    ),
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({ table, loading, layout: 'workspace' }),
    muiTableContainerProps: getDefaultMrtContainerProps({
      loading,
      layout: 'workspace',
      hasRows: attachments.length > 0,
    }),
    muiTableBodyCellProps: {
      sx: {
        ...CUSTOM_STYLES.muiTableBodyCellProps.sx,
        verticalAlign: 'top',
      },
    },
    state: {
      isLoading: loading,
      showLoadingOverlay: false,
      showSkeletons: loading,
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
      columnOrder: tableStateContext.columnOrder,
      columnSizing: tableStateContext.columnSizing,
      columnVisibility: tableStateContext.columnVisibility,
    },
  });

  useEffect(() => {
    tableStateContext.onTableInitialized(table);
  }, [table]);

  return <MaterialReactTable table={table} />;
}
