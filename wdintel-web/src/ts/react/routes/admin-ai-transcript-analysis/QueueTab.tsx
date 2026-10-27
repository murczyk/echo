import { useMemo } from 'react';
import { Link, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import { MaterialReactTable } from 'material-react-table';
import type { AiTranscriptQueueItem } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { PowerButton } from '../../components/PowerButton';
import { PowerChip } from '../../components/PowerChip';
import {
  type AppMrtColumnDef,
  renderDefaultMrtEmptyRowsFallback,
  useAppMaterialReactTable,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  getDefaultMrtContainerProps,
  getDefaultMrtPaperProps,
} from '../../components/mui-customized/table/custom-styles';
import { buildMessageLinkHref } from '../shared/message-card/message-card.utils';
import { useTranscriptQueue } from './use-transcript-queue';

const statusLabels: Record<string, string> = {
  waiting: 'Очікує',
  running: 'Аналізується',
  retry: 'Повторна спроба',
  completed: 'Завершено',
  skipped: 'Пропущено',
  failed: 'Помилка',
};

function dateTime(value: number | null) {
  return value == null ? '—' : new Date(value).toLocaleString('uk-UA');
}

export function QueueTab() {
  const state = useTranscriptQueue();
  const columns = useMemo<AppMrtColumnDef<AiTranscriptQueueItem>[]>(
    () => [
      {
        accessorKey: 'messageId',
        header: 'Повідомлення',
        size: 150,
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => (
          <Link
            href={buildMessageLinkHref(row.original, 'analysis', row.original.messageId)}
            target="_blank"
            rel="noopener noreferrer"
          >
            {row.original.messageId}
          </Link>
        ),
      },
      { accessorFn: (item) => item.groups.join(', '), header: 'Групи', size: 220 },
      {
        accessorFn: (item) => dateTime(item.createdAt),
        header: 'Надійшло',
        size: 180,
      },
      {
        accessorKey: 'state',
        header: 'Статус',
        size: 180,
        meta: { overflowMode: 'wrap' },
        Cell: ({ row }) => (
          <PowerChip
            label={
              row.original.manualSuppressed
                ? 'Ручне блокування'
                : (statusLabels[row.original.state] ?? row.original.state)
            }
            color={
              row.original.state === 'failed'
                ? 'error'
                : row.original.state === 'retry'
                  ? 'warning'
                  : 'default'
            }
          />
        ),
      },
      { accessorKey: 'attempts', header: 'Спроби', size: 90 },
      {
        accessorFn: (item) =>
          item.important == null ? '—' : item.important ? 'Важливе' : 'Неважливе',
        header: 'Рішення',
        size: 140,
      },
      {
        accessorFn: (item) =>
          ['waiting', 'retry'].includes(item.state) && !item.manualSuppressed
            ? dateTime(item.nextAttemptAt)
            : '—',
        header: 'Наступна спроба',
        size: 180,
      },
      {
        accessorFn: (item) => dateTime(item.completedAt),
        header: 'Завершено',
        size: 180,
      },
      {
        accessorKey: 'lastError',
        header: 'Остання помилка',
        size: 300,
        meta: { overflowMode: 'wrap' },
        Cell: ({ cell }) => cell.getValue<string | null>() ?? '—',
      },
    ],
    [],
  );
  const items = useMemo(() => state.data?.items ?? [], [state.data]);
  const table = useAppMaterialReactTable({
    columns,
    data: items,
    enableSorting: false,
    enableColumnFilters: false,
    enableRowVirtualization: false,
    state: { isLoading: state.loading },
    muiTablePaperProps: ({ table }) => getDefaultMrtPaperProps({ table }),
    muiTableContainerProps: getDefaultMrtContainerProps({ hasRows: items.length > 0 }),
    renderEmptyRowsFallback: ({ table }) =>
      renderDefaultMrtEmptyRowsFallback({
        table,
        noDataMessage: state.error ? 'Не вдалося завантажити чергу.' : 'Черга аналізу порожня.',
      }),
  });

  return (
    <section className="flex flex-col gap-echo-lg" aria-label="Черга аналізу транскрипцій">
      <div className="flex flex-wrap items-center justify-between gap-echo-lg">
        <Typography component="h2" variant="h6">
          Черга аналізу
        </Typography>
        <div className="flex items-center gap-echo-md">
          <Typography variant="body2" color="text.secondary">
            Оновлюється кожні 10 секунд
          </Typography>
          <PowerButton
            variant="outlined"
            startIcon={<RefreshIcon />}
            disabled={state.loading}
            onClick={state.refresh}
          >
            Оновити
          </PowerButton>
        </div>
      </div>
      {state.error && <PowerAlert severity="error">{state.error}</PowerAlert>}
      <MaterialReactTable table={table} />
      <div className="flex items-center justify-end gap-echo-md">
        <PowerButton
          variant="outlined"
          disabled={state.loading || state.page === 1}
          onClick={state.previous}
        >
          Назад
        </PowerButton>
        <Typography variant="body2">Сторінка {state.page}</Typography>
        <PowerButton
          variant="outlined"
          disabled={
            state.loading || state.error !== null || state.data?.nextBeforeMessageId == null
          }
          onClick={state.next}
        >
          Далі
        </PowerButton>
      </div>
    </section>
  );
}
