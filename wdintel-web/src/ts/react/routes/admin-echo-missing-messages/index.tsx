import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { ChipProps } from '@mui/material';
import type { MRT_ColumnDef } from 'material-react-table';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { EchoMissingMessageRow } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  listEchoMissingMessages,
  resolveEchoMissingMessage,
} from '../../services/api/echo-missing-message';
import { parseUtcDateTime } from '../../services/api/report-history';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';

const TRANSLATIONS = {
  pageTitle: 'Загублені повідомлення',
  resolveManually: 'Відновити вручну',
  messageId: 'ID повідомлення',
  groups: 'Групи',
  body: 'Текст повідомлення',
  status: 'Статус',
  createdAt: 'Створено',
  isResolved: 'Відновлено',
  resolvedAt: 'Час відновлення',
  scheduledBy: 'Запланував',
  error: 'Помилка',
  schedule: 'Запланувати',
  scheduled: 'Заплановано',
  yes: 'так',
  no: 'ні',
  refresh: 'Оновити',
  statusPending: 'очікує',
  statusScheduled: 'заплановано',
  statusError: 'помилка',
  statusResolved: 'відновлено',
  statusDeleted: 'видалено',
} as const;

const STATUS_LABELS: Record<string, string> = {
  pending: TRANSLATIONS.statusPending,
  scheduled: TRANSLATIONS.statusScheduled,
  error: TRANSLATIONS.statusError,
  resolved: TRANSLATIONS.statusResolved,
  deleted: TRANSLATIONS.statusDeleted,
};

const STATUS_FILTER_OPTIONS = Object.values(STATUS_LABELS).map((label) => ({
  text: label,
  value: label,
}));

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }
  return 'Невідома помилка. Спробуйте ще раз.';
}

function formatDateTime(value: string | null | undefined): string {
  const date = parseUtcDateTime(value);
  return date ? date.toLocaleString('uk-UA') : '';
}

function statusChipColor(status: string): ChipProps['color'] {
  if (status === 'resolved') return 'success';
  if (status === 'error') return 'error';
  if (status === 'scheduled') return 'warning';
  return 'default';
}

function formatStatus(status: string): string {
  return STATUS_LABELS[status] ?? status;
}

type MissingMessageTableProps = {
  rows: EchoMissingMessageRow[];
  loading: boolean;
  resolvingIds: Set<number>;
  onResolve: (id: number) => void;
  onRefresh: () => void;
};

function MissingMessageTable({
  rows,
  loading,
  resolvingIds,
  onResolve,
  onRefresh,
}: MissingMessageTableProps) {
  const columns = useMemo<MRT_ColumnDef<EchoMissingMessageRow>[]>(
    () => [
      {
        id: 'resolveManually',
        header: TRANSLATIONS.resolveManually,
        size: 180,
        enableSorting: false,
        enableColumnFilter: false,
        Cell: ({ row }) => {
          const item = row.original;
          const disabled =
            item.isResolved ||
            item.status === 'scheduled' ||
            item.status === 'deleted' ||
            resolvingIds.has(item.id);
          return (
            <Button
              size="small"
              variant="outlined"
              startIcon={<PlayArrowIcon fontSize="small" />}
              disabled={disabled}
              onClick={() => onResolve(item.id)}
            >
              {item.status === 'scheduled'
                ? TRANSLATIONS.scheduled
                : item.status === 'deleted'
                  ? TRANSLATIONS.statusDeleted
                  : TRANSLATIONS.schedule}
            </Button>
          );
        },
      },
      {
        accessorKey: 'messageId',
        header: TRANSLATIONS.messageId,
        size: 120,
      },
      {
        accessorKey: 'groupNames',
        header: TRANSLATIONS.groups,
        size: 220,
        Cell: ({ cell }) => (
          <Typography
            component="span"
            variant="body2"
            sx={{
              display: 'block',
              maxWidth: 300,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={cell.getValue<string>()}
          >
            {cell.getValue<string>()}
          </Typography>
        ),
      },
      {
        accessorKey: 'body',
        header: TRANSLATIONS.body,
        size: 420,
        Cell: ({ cell }) => (
          <Typography
            component="span"
            variant="body2"
            sx={{
              display: 'block',
              maxWidth: 520,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={cell.getValue<string>()}
          >
            {cell.getValue<string>()}
          </Typography>
        ),
      },
      {
        id: 'status',
        header: TRANSLATIONS.status,
        accessorFn: (row) => formatStatus(row.status),
        filterVariant: 'select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        size: 130,
        Cell: ({ row }) => {
          const status = row.original.status;
          return (
            <Chip
              size="small"
              label={formatStatus(status)}
              color={statusChipColor(status)}
              variant={status === 'pending' ? 'outlined' : 'filled'}
            />
          );
        },
      },
      {
        accessorKey: 'createdAt',
        header: TRANSLATIONS.createdAt,
        size: 180,
        Cell: ({ cell }) => formatDateTime(cell.getValue<string>()),
      },
      {
        accessorKey: 'isResolved',
        header: TRANSLATIONS.isResolved,
        size: 120,
        Cell: ({ cell }) => (cell.getValue<boolean>() ? TRANSLATIONS.yes : TRANSLATIONS.no),
      },
      {
        accessorKey: 'resolvedAt',
        header: TRANSLATIONS.resolvedAt,
        size: 180,
        Cell: ({ cell }) => formatDateTime(cell.getValue<string | null>()),
      },
      {
        accessorKey: 'scheduledBy',
        header: TRANSLATIONS.scheduledBy,
        size: 160,
        Cell: ({ cell }) => cell.getValue<string | null>() ?? '',
      },
      {
        accessorKey: 'error',
        header: TRANSLATIONS.error,
        size: 360,
        Cell: ({ cell }) => (
          <Typography
            component="span"
            variant="body2"
            color="error"
            sx={{
              display: 'block',
              maxWidth: 460,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={cell.getValue<string | null>() ?? ''}
          >
            {cell.getValue<string | null>() ?? ''}
          </Typography>
        ),
      },
    ],
    [onResolve, resolvingIds],
  );

  return (
    <TableStateProvider
      tableId="admin-echo-missing-messages-v1"
      defaultColumnOrder={[
        'mrt-row-numbers',
        'resolveManually',
        'messageId',
        'groupNames',
        'body',
        'status',
        'createdAt',
        'isResolved',
        'resolvedAt',
        'scheduledBy',
        'error',
      ]}
      defaultSorting={[{ id: 'createdAt', desc: true }]}
      defaultColumnVisibility={{}}
    >
      <SettingsNeoTable
        columns={columns}
        data={rows}
        loading={loading}
        enableTopToolbar
        enableBottomToolbar
        showToolbarInternalActions
        toolbarFiltersHidden
        toolbarFullScreenEnabled
        toolbarAdditionalActions={
          <Tooltip title={TRANSLATIONS.refresh}>
            <span>
              <IconButton
                size="small"
                onClick={onRefresh}
                disabled={loading}
                aria-label={TRANSLATIONS.refresh}
              >
                <RefreshIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        }
        tableContainerSx={{ maxHeight: 'calc(100vh - 240px)' }}
      />
    </TableStateProvider>
  );
}

export function AdminEchoMissingMessagesPage() {
  const [rows, setRows] = useState<EchoMissingMessageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<number>>(() => new Set());

  const loadRows = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      setRows(await listEchoMissingMessages());
    } catch (error) {
      setLoadError(`Помилка завантаження відсутніх повідомлень: ${formatErrorMessage(error)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows();
  }, [loadRows]);

  const handleResolve = useCallback(async (id: number) => {
    setActionError(null);
    setResolvingIds((prev) => new Set(prev).add(id));
    try {
      const row = await resolveEchoMissingMessage(id);
      setRows((prev) => prev.map((item) => (item.id === row.id ? row : item)));
    } catch (error) {
      setActionError(`Помилка планування відновлення: ${formatErrorMessage(error)}`);
    } finally {
      setResolvingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, []);

  return (
    <Box className="w-full h-full min-h-0">
      <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
        <PageHeader title={TRANSLATIONS.pageTitle} />
        {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
        {actionError ? <PowerAlert severity="error">{actionError}</PowerAlert> : null}
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <MissingMessageTable
            rows={rows}
            loading={loading}
            resolvingIds={resolvingIds}
            onResolve={handleResolve}
            onRefresh={loadRows}
          />
        </Box>
      </Stack>
    </Box>
  );
}
