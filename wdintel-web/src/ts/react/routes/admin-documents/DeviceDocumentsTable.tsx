import ReplayIcon from '@mui/icons-material/Replay';
import { Link, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useMemo } from 'react';

import type { DeviceDocumentItem } from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import { DocumentStateChip } from './DocumentStateChip';

export function DeviceDocumentsTable({
  documents,
  busy,
  onRetry,
}: {
  documents: DeviceDocumentItem[];
  busy: boolean;
  onRetry: (document: DeviceDocumentItem) => void;
}) {
  const columns = useMemo<AppMrtColumnDef<DeviceDocumentItem>[]>(
    () => [
      {
        header: 'Файл',
        accessorKey: 'fileName',
        size: 260,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => <Link href={row.original.citation}>{row.original.fileName}</Link>,
      },
      { header: 'Шлях', accessorKey: 'path', size: 260 },
      { header: 'Формат', accessorKey: 'format', size: 100 },
      {
        header: 'Змінено',
        id: 'modifiedAt',
        accessorFn: (document) => document.modifiedAt,
        size: 160,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) =>
          row.original.modifiedAt == null
            ? null
            : new Date(row.original.modifiedAt * 1000).toLocaleString('uk-UA'),
      },
      {
        header: 'Стан',
        accessorKey: 'state',
        size: 120,
        meta: { overflowMode: 'none' },
        Cell: ({ cell }) => <DocumentStateChip state={cell.getValue<string>()} />,
      },
      {
        header: 'Підсумок',
        accessorKey: 'summaryState',
        size: 120,
        meta: { overflowMode: 'none' },
        Cell: ({ cell }) => <DocumentStateChip state={cell.getValue<string>()} />,
      },
      {
        header: 'Позиції',
        accessorKey: 'positionState',
        size: 120,
        meta: { overflowMode: 'none' },
        Cell: ({ cell }) => <DocumentStateChip state={cell.getValue<string>()} />,
      },
      {
        header: 'Текст підсумку',
        id: 'summary',
        accessorFn: (document) => document.summary ?? '',
        size: 360,
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => (
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {row.original.summary}
          </Typography>
        ),
      },
    ],
    [],
  );
  const table = useAppMaterialReactTable({
    columns,
    data: documents,
    enableSorting: true,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: true,
    positionActionsColumn: 'first',
    getRowId: (document) => `${document.fileId}:${document.revision}`,
    renderRowActions: ({ row }) => (
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Повторити обробку"
          disabled={busy || !row.original.hasContent}
          onClick={() => onRetry(row.original)}
          icon={<ReplayIcon fontSize="small" />}
        />
      </MrtRowActions>
    ),
    defaultColumn: { size: 160, renderColumnActionsMenuItems },
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table }),
    muiTableContainerProps: getDefaultMrtContainerProps({ hasRows: documents.length > 0 }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({ table, noDataMessage: 'Файлів ще немає.' }),
  });
  return <MaterialReactTable table={table} />;
}
