import RefreshIcon from '@mui/icons-material/Refresh';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { Box, Button, Chip, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { Dayjs } from 'dayjs';
import type { ChipProps } from '@mui/material';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { EchoMissingMessageRow } from '../../../../Bindings';
import { PageHeader } from '../../components/PageHeader';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  mrtTextCell,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  listEchoMissingMessageCounts,
  listEchoMissingMessages,
  resolveEchoMissingMessage,
} from '../../services/api/echo-missing-message';
import { parseUtcDateTime } from '../../services/api/report-history';
import {
  appDayKey,
  appDayUtcRange,
  appMonthUtcRange,
  type DayCountMap,
  DayCounterCalendar,
  todayInAppTimeZone,
} from '../admin-messenger-neo/DayCounterCalendar';
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
  statusDuplicate: 'дублікат',
} as const;

const STATUS_LABELS: Record<string, string> = {
  pending: TRANSLATIONS.statusPending,
  scheduled: TRANSLATIONS.statusScheduled,
  error: TRANSLATIONS.statusError,
  resolved: TRANSLATIONS.statusResolved,
  deleted: TRANSLATIONS.statusDeleted,
  duplicate: TRANSLATIONS.statusDuplicate,
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
  if (status === 'duplicate') return 'info';
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
  const columns = useMemo<AppMrtColumnDef<EchoMissingMessageRow>[]>(
    () => [
      {
        id: 'resolveManually',
        header: TRANSLATIONS.resolveManually,
        size: 180,
        enableSorting: false,
        enableColumnFilter: false,
        meta: { overflowMode: 'none' },
        Cell: ({ row }) => {
          const item = row.original;
          const disabled =
            item.isResolved ||
            item.status === 'scheduled' ||
            item.status === 'deleted' ||
            item.status === 'duplicate' ||
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
                  : item.status === 'duplicate'
                    ? TRANSLATIONS.statusDuplicate
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => cell.getValue() as string,
          fullValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        accessorKey: 'body',
        header: TRANSLATIONS.body,
        size: 420,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => cell.getValue() as string,
          fullValue: ({ cell }) => cell.getValue() as string,
        }),
      },
      {
        id: 'status',
        header: TRANSLATIONS.status,
        accessorFn: (row) => formatStatus(row.status),
        filterVariant: 'select',
        filterSelectOptions: STATUS_FILTER_OPTIONS,
        size: 130,
        meta: { overflowMode: 'none' },
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
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => formatDateTime(cell.getValue() as string),
          fullValue: ({ cell }) => formatDateTime(cell.getValue() as string),
        }),
      },
      {
        accessorKey: 'isResolved',
        header: TRANSLATIONS.isResolved,
        size: 120,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => (cell.getValue() ? TRANSLATIONS.yes : TRANSLATIONS.no),
          fullValue: ({ cell }) => (cell.getValue() ? TRANSLATIONS.yes : TRANSLATIONS.no),
        }),
      },
      {
        accessorKey: 'resolvedAt',
        header: TRANSLATIONS.resolvedAt,
        size: 180,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => formatDateTime(cell.getValue() as string | null),
          fullValue: ({ cell }) => formatDateTime(cell.getValue() as string | null),
        }),
      },
      {
        accessorKey: 'scheduledBy',
        header: TRANSLATIONS.scheduledBy,
        size: 160,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => (cell.getValue() as string | null) ?? '',
          fullValue: ({ cell }) => (cell.getValue() as string | null) ?? '',
        }),
      },
      {
        accessorKey: 'error',
        header: TRANSLATIONS.error,
        size: 360,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell, row }) => {
            const value =
              row.original.status === 'deleted' || row.original.status === 'duplicate'
                ? ''
                : ((cell.getValue() as string | null) ?? '');
            return value;
          },
          fullValue: ({ cell, row }) =>
            row.original.status === 'deleted' || row.original.status === 'duplicate'
              ? ''
              : ((cell.getValue() as string | null) ?? ''),
        }),
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

export function AdminEchoMissingMessagesSection() {
  const [rows, setRows] = useState<EchoMissingMessageRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [countsLoading, setCountsLoading] = useState(true);
  const [countsByDay, setCountsByDay] = useState<DayCountMap>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [resolvingIds, setResolvingIds] = useState<Set<number>>(() => new Set());
  const [selectedDate, setSelectedDate] = useState(todayInAppTimeZone);
  const selectedMonthKey = appDayKey(selectedDate).slice(0, 7);

  const loadRows = useCallback(async (date: Dayjs) => {
    setRowsLoading(true);
    setLoadError(null);
    try {
      setRows(await listEchoMissingMessages({ ...appDayUtcRange(date), limit: 1000 }));
    } catch (error) {
      setLoadError(`Помилка завантаження відсутніх повідомлень: ${formatErrorMessage(error)}`);
    } finally {
      setRowsLoading(false);
    }
  }, []);

  const loadCounts = useCallback(async (date: Dayjs) => {
    setCountsLoading(true);
    setLoadError(null);
    try {
      const counts = await listEchoMissingMessageCounts(appMonthUtcRange(date));
      setCountsByDay(
        counts.reduce<DayCountMap>((acc, item) => {
          acc[item.day] = item.count;
          return acc;
        }, {}),
      );
    } catch (error) {
      setLoadError(
        `Помилка завантаження лічильників відсутніх повідомлень: ${formatErrorMessage(error)}`,
      );
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRows(selectedDate);
  }, [loadRows, selectedDate]);

  useEffect(() => {
    loadCounts(selectedDate);
  }, [loadCounts, selectedMonthKey]);

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

  const loading = rowsLoading || countsLoading;

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
      {actionError ? <PowerAlert severity="error">{actionError}</PowerAlert> : null}
      <Box
        sx={{
          display: { xs: 'flex', lg: 'grid' },
          flexDirection: { xs: 'column', lg: 'row' },
          gridTemplateColumns: { lg: '336px minmax(0, 1fr)' },
          gap: 2,
          flex: 1,
          minHeight: 0,
          minWidth: 0,
        }}
      >
        <DayCounterCalendar
          countsByDay={countsByDay}
          disabled={loading}
          selectedDate={selectedDate}
          selectedLabel="Повідомлень"
          onSelectedDateChange={setSelectedDate}
          onVisibleMonthChange={loadCounts}
        />
        <Box sx={{ minHeight: 0, minWidth: 0 }}>
          <MissingMessageTable
            rows={rows}
            loading={rowsLoading}
            resolvingIds={resolvingIds}
            onResolve={handleResolve}
            onRefresh={() => {
              loadRows(selectedDate);
              loadCounts(selectedDate);
            }}
          />
        </Box>
      </Box>
    </Stack>
  );
}

export function AdminEchoMissingMessagesPage() {
  return (
    <Box className="w-full h-full min-h-0">
      <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
        <PageHeader title={TRANSLATIONS.pageTitle} />
        <Box sx={{ flex: 1, minHeight: 0 }}>
          <AdminEchoMissingMessagesSection />
        </Box>
      </Stack>
    </Box>
  );
}
