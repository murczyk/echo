import ReplayIcon from '@mui/icons-material/Replay';
import VisibilityIcon from '@mui/icons-material/Visibility';
import { Box, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useMemo } from 'react';

import type { AttachmentItem } from '../../../../Bindings';
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

export function MessageDocumentsTable({
  documents,
  onPreview,
  onRetry,
}: {
  documents: AttachmentItem[];
  onPreview: (mediaId: string) => void;
  onRetry: (mediaId: string) => void;
}) {
  const columns = useMemo<AppMrtColumnDef<AttachmentItem>[]>(
    () => [
      { header: 'Файл', accessorKey: 'fileName', size: 260 },
      { header: 'Тип', accessorKey: 'contentType', size: 160 },
      {
        header: 'Стан',
        accessorKey: 'state',
        size: 120,
        meta: { overflowMode: 'none' },
        Cell: ({ cell }) => <DocumentStateChip state={cell.getValue<string>()} />,
      },
      { header: 'Якість', accessorKey: 'quality', size: 100 },
      { header: 'Розділи', accessorKey: 'chunkCount', size: 100 },
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
          <Box>
            <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
              {row.original.summary}
            </Typography>
            {row.original.lastError && (
              <Typography variant="caption" color="error" sx={{ overflowWrap: 'anywhere' }}>
                {row.original.lastError}
              </Typography>
            )}
          </Box>
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
    getRowId: (document) => document.mediaId,
    renderRowActions: ({ row }) => (
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Переглянути"
          onClick={() => onPreview(row.original.mediaId)}
          icon={<VisibilityIcon fontSize="small" />}
          opensModal
        />
        <MrtRowActionButton
          label="Повторити обробку"
          onClick={() => onRetry(row.original.mediaId)}
          icon={<ReplayIcon fontSize="small" />}
        />
      </MrtRowActions>
    ),
    defaultColumn: { size: 160, renderColumnActionsMenuItems },
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table }),
    muiTableContainerProps: getDefaultMrtContainerProps({ hasRows: documents.length > 0 }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({ table, noDataMessage: 'Документів ще немає.' }),
  });
  return <MaterialReactTable table={table} />;
}
