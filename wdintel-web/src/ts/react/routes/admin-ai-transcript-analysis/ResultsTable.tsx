import { useMemo } from 'react';
import { MaterialReactTable } from 'material-react-table';
import { Tooltip, Typography } from '@mui/material';
import type {
  AiTranscriptPage,
  AiTranscriptResult,
  AiTranscriptTestMessage,
} from '../../../../Bindings';
import { MrtRowActionButton, MrtRowActions } from '../../components/MrtRowActionButton';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
import { useOptionalPowerSnackbar } from '../../components/PowerSnackbar';
import { copyTextToClipboard } from '../../../copy-to-clipboard';
import AddIcon from '@mui/icons-material/Add';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import EditIcon from '@mui/icons-material/Edit';
import DeleteIcon from '@mui/icons-material/Delete';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
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

function Result({ result }: { result?: AiTranscriptResult }) {
  if (!result)
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  if (result.error) {
    return (
      <Tooltip
        arrow
        title={
          <div className="max-w-[600px]">
            <Typography variant="subtitle2">{result.error}</Typography>
            {result.responseText && (
              <pre className="mb-0 mt-echo-sm whitespace-pre-wrap break-words">
                {result.responseText}
              </pre>
            )}
          </div>
        }
      >
        <span className="inline-flex items-center text-echo-error" aria-label={result.error}>
          <ErrorOutlineIcon />
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip title={result.responseText} arrow>
      <span className="inline-flex">
        <PowerChip
          color="default"
          selected
          size="small"
          label={result.important ? 'Важливе' : 'Неважливе'}
        />
      </span>
    </Tooltip>
  );
}

export function ResultsTable({
  page,
  results,
  disabled,
  onCreate,
  onEdit,
  onDelete,
}: {
  page: AiTranscriptPage;
  results: AiTranscriptResult[];
  disabled: boolean;
  onCreate: () => void;
  onEdit: (message: AiTranscriptTestMessage) => void;
  onDelete: (message: AiTranscriptTestMessage) => void;
}) {
  const { notify } = useOptionalPowerSnackbar();
  const columns = useMemo<AppMrtColumnDef<AiTranscriptTestMessage>[]>(
    () => [
      {
        accessorKey: 'message',
        header: 'Тестове повідомлення',
        size: 360,
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => (
          <span className="whitespace-pre-wrap break-words">{cell.getValue<string>()}</span>
        ),
      },
      ...page.engines.map((engine): AppMrtColumnDef<AiTranscriptTestMessage> => ({
        id: `engine-${engine.id}`,
        header: `${engine.modelName}: Важливість`,
        size: 220,
        enableColumnFilter: false,
        enableGlobalFilter: false,
        enableSorting: false,
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => (
          <div className="flex flex-col gap-[6px]">
            <Result
              result={row.original.results.find((result) => result.aiEngineId === engine.id)}
            />
            {results.some(
              (result) =>
                result.testMessageId === row.original.id && result.aiEngineId === engine.id,
            ) && (
              <div className="flex flex-wrap items-center gap-echo-xs">
                <Typography variant="caption" color="text.secondary">
                  ТЕСТ:
                </Typography>
                <Result
                  result={results.find(
                    (result) =>
                      result.testMessageId === row.original.id && result.aiEngineId === engine.id,
                  )}
                />
              </div>
            )}
          </div>
        ),
      })),
    ],
    [page.engines, results],
  );
  const defaultMrtOptions = getDefaultMRTOptions<AiTranscriptTestMessage>();
  const table = useAppMaterialReactTable({
    columns,
    data: page.messages,
    enableSorting: true,
    enableColumnActions: true,
    enableColumnFilters: true,
    enableColumnFilterModes: true,
    enableFacetedValues: true,
    enableRowActions: true,
    enableRowVirtualization: false,
    positionActionsColumn: 'first',
    defaultColumn: { size: 180, renderColumnActionsMenuItems },
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
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table }),
    muiTableContainerProps: getDefaultMrtContainerProps({ hasRows: page.messages.length > 0 }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        noDataMessage: 'Тестових повідомлень ще немає.',
        noDataActionLabel: 'Додати',
        onNoDataAction: onCreate,
      }),
    renderRowActions: ({ row }) => (
      <MrtRowActions forceMenu>
        <MrtRowActionButton
          label="Копіювати UUID"
          disabled={disabled}
          onClick={() =>
            void copyTextToClipboard(row.original.id)
              .then(() => notify({ severity: 'success', message: 'UUID скопійовано.' }))
              .catch(() => notify({ severity: 'error', message: 'Не вдалося скопіювати UUID.' }))
          }
          icon={<ContentCopyIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Редагувати"
          disabled={disabled}
          onClick={() => onEdit(row.original)}
          icon={<EditIcon fontSize="small" />}
        />
        <MrtRowActionButton
          label="Видалити"
          disabled={disabled}
          opensModal
          tone="danger"
          onClick={() => onDelete(row.original)}
          icon={<DeleteIcon fontSize="small" />}
        />
      </MrtRowActions>
    ),
  });
  return (
    <section className="flex flex-col gap-echo-lg">
      <div className="flex items-center justify-between gap-echo-lg">
        <Typography component="h2" variant="h6">
          Тестові повідомлення
        </Typography>
        <PowerButton
          type="button"
          variant="contained"
          disabled={disabled}
          onClick={onCreate}
          startIcon={<AddIcon />}
        >
          Додати
        </PowerButton>
      </div>
      <MaterialReactTable table={table} />
    </section>
  );
}
