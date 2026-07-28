import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import {
  MaterialReactTable,
  type MRT_ColumnDef,
  useMaterialReactTable,
} from 'material-react-table';
import { useMemo, useState } from 'react';

import type {
  AiCallsignEngineItem,
  AiCallsignParseResultItem,
  AiCallsignTestMessageItem,
} from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import {
  MrtRowActionButton,
  MrtRowActions,
  mrtRowActionsColumnSize,
} from '../../components/MrtRowActionButton';
import { PowerButton } from '../../components/PowerButton';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  getDefaultMRTOptions,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../components/mui-customized/table/get-default-table-options';
import { AiCallsignResultCell } from './AiCallsignResultCell';

function resultKey(testMessageId: string, aiEngineId: string): string {
  return `${testMessageId}:${aiEngineId}`;
}

function resultMap(results: AiCallsignParseResultItem[]) {
  return new Map(
    results.map((result) => [resultKey(result.testMessageId, result.aiEngineId), result]),
  );
}

function CompactUuidCell({ uuid }: { uuid: string }) {
  const [copyStatus, setCopyStatus] = useState<'idle' | 'copied' | 'error'>('idle');
  const copyLabel =
    copyStatus === 'copied'
      ? 'UUID скопійовано'
      : copyStatus === 'error'
        ? 'Не вдалося скопіювати UUID'
        : 'Копіювати UUID';

  return (
    <Tooltip title={copyLabel}>
      <IconButton
        size="small"
        aria-label={copyLabel}
        onClick={(event) => {
          event.stopPropagation();
          event.currentTarget.blur();
          void copyTextToClipboard(uuid)
            .then(() => setCopyStatus('copied'))
            .catch(() => setCopyStatus('error'));
        }}
        onBlur={() => setCopyStatus('idle')}
        onMouseLeave={() => setCopyStatus('idle')}
      >
        <ContentCopyIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

export function AiCallsignsTable({
  engines,
  messages,
  testResults,
  onCreate,
  onDelete,
  onEdit,
}: {
  engines: AiCallsignEngineItem[];
  messages: AiCallsignTestMessageItem[];
  testResults: AiCallsignParseResultItem[];
  onCreate: () => void;
  onDelete: (message: AiCallsignTestMessageItem) => void;
  onEdit: (message: AiCallsignTestMessageItem) => void;
}) {
  const savedResults = useMemo(
    () => resultMap(messages.flatMap((message) => message.results)),
    [messages],
  );
  const currentTestResults = useMemo(() => resultMap(testResults), [testResults]);
  const columns = useMemo<MRT_ColumnDef<AiCallsignTestMessageItem>[]>(
    () => [
      {
        header: 'ID',
        accessorKey: 'id',
        size: 48,
        minSize: 48,
        maxSize: 48,
        grow: false,
        enableColumnActions: false,
        enableColumnFilter: false,
        enableResizing: false,
        muiTableHeadCellProps: {
          sx: {
            padding: '5px!important',
            '& .Mui-TableHeadCell-Content': {
              justifyContent: 'center',
            },
            '& .Mui-TableHeadCell-Content-Labels': {
              justifyContent: 'center',
            },
          },
        },
        muiTableBodyCellProps: {
          sx: {
            padding: '5px!important',
            textAlign: 'center',
          },
        },
        Cell: ({ row }) => <CompactUuidCell uuid={row.original.id} />,
      },
      {
        header: 'Тестове повідомлення',
        accessorKey: 'message',
        size: 360,
        Cell: ({ cell }) => (
          <Box component="span" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {cell.getValue<string>()}
          </Box>
        ),
      },
      ...engines.map((engine): MRT_ColumnDef<AiCallsignTestMessageItem> => ({
        id: `engine-${engine.id}`,
        header: `${engine.modelName}: Позивні`,
        size: 220,
        enableColumnFilter: false,
        enableGlobalFilter: false,
        enableSorting: false,
        Cell: ({ row }) => {
          const key = resultKey(row.original.id, engine.id);
          const testResult = currentTestResults.get(key);
          return (
            <Stack spacing={0.75}>
              <AiCallsignResultCell result={savedResults.get(key)} />
              {testResult ? (
                <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap">
                  <Typography variant="caption" color="text.secondary">
                    ТЕСТ:
                  </Typography>
                  <AiCallsignResultCell result={testResult} />
                </Stack>
              ) : null}
            </Stack>
          );
        },
      })),
    ],
    [currentTestResults, engines, savedResults],
  );
  const defaultMrtOptions = getDefaultMRTOptions<AiCallsignTestMessageItem>();
  const table = useMaterialReactTable({
    columns,
    data: messages,
    ...defaultMrtOptions,
    enableSorting: true,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowVirtualization: false,
    enableRowActions: true,
    positionActionsColumn: 'first',
    renderRowActions: ({ row }) => (
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onEdit(row.original)}
          icon={<EditOutlinedIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Видалити"
          onClick={() => onDelete(row.original)}
          icon={<DeleteOutlineIcon fontSize="small" />}
          tone="danger"
          opensModal
        />
      </MrtRowActions>
    ),
    defaultColumn: {
      size: 180,
      renderColumnActionsMenuItems,
    },
    displayColumnDefOptions: {
      ...defaultMrtOptions.displayColumnDefOptions,
      'mrt-row-actions': {
        ...defaultMrtOptions.displayColumnDefOptions?.['mrt-row-actions'],
        size: mrtRowActionsColumnSize(2),
      },
    },
    muiTablePaperProps: ({ table }) =>
      getDefaultMrtPaperProps({
        table,
      }),
    muiTableContainerProps: getDefaultMrtContainerProps({
      hasRows: messages.length > 0,
    }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        noDataMessage: 'Тестових повідомлень ще немає.',
        noDataActionLabel: 'Додати',
        onNoDataAction: onCreate,
      }),
  });

  return (
    <Stack spacing={2}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2 }}>
        <Typography component="h2" variant="h6">
          Тестові повідомлення
        </Typography>
        <PowerButton type="button" variant="contained" onClick={onCreate} startIcon={<AddIcon />}>
          Додати
        </PowerButton>
      </Box>

      <MaterialReactTable table={table} />
    </Stack>
  );
}
