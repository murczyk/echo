import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import DeleteIcon from '@mui/icons-material/Delete';
import EditIcon from '@mui/icons-material/Edit';
import { Box, Stack, Typography } from '@mui/material';
import { MaterialReactTable } from 'material-react-table';
import { useMemo } from 'react';

import type {
  AiCallsignEngineItem,
  AiCallsignParseResultItem,
  AiCallsignTestMessageItem,
} from '../../../../Bindings';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerButton } from '../../components/PowerButton';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import {
  type AppMrtColumnDef,
  getDefaultMRTOptions,
  useAppMaterialReactTable,
  renderColumnActionsMenuItems,
  renderDefaultMrtEmptyRowsFallback,
} from '../../components/mui-customized/table/get-default-table-options';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { AiCallsignResultCell } from './AiCallsignResultCell';

function resultKey(testMessageId: string, aiEngineId: string): string {
  return `${testMessageId}:${aiEngineId}`;
}

function resultMap(results: AiCallsignParseResultItem[]) {
  return new Map(
    results.map((result) => [resultKey(result.testMessageId, result.aiEngineId), result]),
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
  const { notify } = useOptionalPowerSnackbar();
  const savedResults = useMemo(
    () => resultMap(messages.flatMap((message) => message.results)),
    [messages],
  );
  const currentTestResults = useMemo(() => resultMap(testResults), [testResults]);
  const columns = useMemo<AppMrtColumnDef<AiCallsignTestMessageItem>[]>(
    () => [
      {
        header: 'Тестове повідомлення',
        accessorKey: 'message',
        size: 360,
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => (
          <Box component="span" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
            {cell.getValue<string>()}
          </Box>
        ),
      },
      ...engines.map((engine): AppMrtColumnDef<AiCallsignTestMessageItem> => ({
        id: `engine-${engine.id}`,
        header: `${engine.modelName}: Позивні`,
        size: 220,
        enableColumnFilter: false,
        enableGlobalFilter: false,
        enableSorting: false,
        meta: { overflowMode: 'wrap' },
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
  const table = useAppMaterialReactTable({
    columns,
    data: messages,
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
          label="Копіювати UUID"
          onClick={() =>
            void copyTextToClipboard(row.original.id)
              .then(() => notify({ severity: 'success', message: 'UUID скопійовано.' }))
              .catch(() => notify({ severity: 'error', message: 'Не вдалося скопіювати UUID.' }))
          }
          icon={<ContentCopyIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Редагувати"
          onClick={() => onEdit(row.original)}
          icon={<EditIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Видалити"
          onClick={() => onDelete(row.original)}
          icon={<DeleteIcon fontSize="small" />}
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
        size: 76,
        minSize: 76,
        maxSize: 76,
        enableResizing: false,
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
