import RefreshIcon from '@mui/icons-material/Refresh';
import { Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import type { Dayjs } from 'dayjs';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { SignalRestapiErrorRow } from '../../../../Bindings';
import { PowerAlert } from '../../components/PowerAlert';
import { TableStateProvider } from '../../components/mui-customized/table/table-state-provider';
import {
  mrtTextCell,
  type AppMrtColumnDef,
} from '../../components/mui-customized/table/get-default-table-options';
import {
  loadLatestSignalRestapiErrorCreatedAt,
  listSignalRestapiErrorCounts,
  listSignalRestapiErrors,
} from '../../services/api/signal-restapi-error';
import { parseUtcDateTime } from '../../services/api/report-history';
import { SettingsNeoTable } from '../settings-neo/SettingsNeoTable';
import {
  appDayKey,
  appDayUtcRange,
  appMonthUtcRange,
  type DayCountMap,
  DayCounterCalendar,
  todayInAppTimeZone,
  utcDateTimeToAppDay,
} from './DayCounterCalendar';

const TRANSLATIONS = {
  refresh: 'Оновити',
  id: 'ID',
  createdAt: 'Створено',
  source: 'Джерело',
  clientName: 'Клієнт',
  responseText: 'Текст відповіді',
  responseJson: 'JSON відповіді',
  discordSentAt: 'Discord',
} as const;

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

function clippedText(value: string | null | undefined, color?: 'error') {
  const text = value ?? '';
  return (
    <Typography
      component="span"
      variant="body2"
      color={color}
      sx={{
        display: 'block',
        maxWidth: 620,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={text}
    >
      {text}
    </Typography>
  );
}

function RestApiErrorsTable({
  loading,
  rows,
  onRefresh,
}: {
  loading: boolean;
  rows: SignalRestapiErrorRow[];
  onRefresh: () => void;
}) {
  const columns = useMemo<AppMrtColumnDef<SignalRestapiErrorRow>[]>(
    () => [
      {
        accessorKey: 'id',
        header: TRANSLATIONS.id,
        size: 100,
      },
      {
        accessorKey: 'createdAt',
        header: TRANSLATIONS.createdAt,
        size: 180,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => formatDateTime(cell.getValue()),
          fullValue: ({ cell }) => formatDateTime(cell.getValue()),
        }),
      },
      {
        accessorKey: 'source',
        header: TRANSLATIONS.source,
        size: 120,
      },
      {
        accessorKey: 'clientName',
        header: TRANSLATIONS.clientName,
        size: 180,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => cell.getValue() ?? '',
          fullValue: ({ cell }) => cell.getValue() ?? '',
        }),
      },
      {
        accessorKey: 'responseText',
        header: TRANSLATIONS.responseText,
        size: 520,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => clippedText(cell.getValue(), 'error'),
          fullValue: ({ cell }) => cell.getValue() ?? '',
        }),
      },
      {
        accessorKey: 'responseJson',
        header: TRANSLATIONS.responseJson,
        size: 520,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => clippedText(cell.getValue()),
          fullValue: ({ cell }) => cell.getValue() ?? '',
        }),
      },
      {
        accessorKey: 'discordSentAt',
        header: TRANSLATIONS.discordSentAt,
        size: 180,
        meta: { overflowMode: 'text' },
        Cell: mrtTextCell({
          displayValue: ({ cell }) => formatDateTime(cell.getValue()),
          fullValue: ({ cell }) => formatDateTime(cell.getValue()),
        }),
      },
    ],
    [],
  );

  return (
    <TableStateProvider
      tableId="admin-echo-restapi-errors-v1"
      defaultColumnOrder={[
        'mrt-row-numbers',
        'id',
        'createdAt',
        'source',
        'clientName',
        'responseText',
        'responseJson',
        'discordSentAt',
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

export function RestApiErrorsSection() {
  const [rows, setRows] = useState<SignalRestapiErrorRow[]>([]);
  const [rowsLoading, setRowsLoading] = useState(true);
  const [countsLoading, setCountsLoading] = useState(true);
  const [countsByDay, setCountsByDay] = useState<DayCountMap>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(todayInAppTimeZone);
  const [latestDateLoaded, setLatestDateLoaded] = useState(false);
  const selectedMonthKey = appDayKey(selectedDate).slice(0, 7);

  const loadRows = useCallback(async (date: Dayjs) => {
    setRowsLoading(true);
    setLoadError(null);
    try {
      setRows(await listSignalRestapiErrors({ ...appDayUtcRange(date), limit: 1000 }));
    } catch (error) {
      setLoadError(`Помилка завантаження REST API помилок: ${formatErrorMessage(error)}`);
    } finally {
      setRowsLoading(false);
    }
  }, []);

  const loadCounts = useCallback(async (date: Dayjs) => {
    setCountsLoading(true);
    setLoadError(null);
    try {
      const counts = await listSignalRestapiErrorCounts(appMonthUtcRange(date));
      setCountsByDay(
        counts.reduce<DayCountMap>((acc, item) => {
          acc[item.day] = item.count;
          return acc;
        }, {}),
      );
    } catch (error) {
      setLoadError(
        `Помилка завантаження лічильників REST API помилок: ${formatErrorMessage(error)}`,
      );
    } finally {
      setCountsLoading(false);
    }
  }, []);

  useEffect(() => {
    let ignore = false;

    async function loadLatestDate() {
      try {
        const latestCreatedAt = await loadLatestSignalRestapiErrorCreatedAt();
        const latestDate = utcDateTimeToAppDay(latestCreatedAt);
        if (!ignore && latestDate) {
          setSelectedDate(latestDate);
        }
      } catch (error) {
        setLoadError(
          `Помилка завантаження останньої REST API помилки: ${formatErrorMessage(error)}`,
        );
      } finally {
        if (!ignore) {
          setLatestDateLoaded(true);
        }
      }
    }

    loadLatestDate();

    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!latestDateLoaded) return;
    loadRows(selectedDate);
  }, [latestDateLoaded, loadRows, selectedDate]);

  useEffect(() => {
    if (!latestDateLoaded) return;
    loadCounts(selectedDate);
  }, [latestDateLoaded, loadCounts, selectedMonthKey]);

  const loading = !latestDateLoaded || rowsLoading || countsLoading;

  return (
    <Stack spacing={2} sx={{ height: '100%', minHeight: 0 }}>
      {loadError ? <PowerAlert severity="error">{loadError}</PowerAlert> : null}
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
          selectedLabel="Помилок"
          onSelectedDateChange={setSelectedDate}
          onVisibleMonthChange={loadCounts}
        />
        <Box sx={{ minHeight: 0, minWidth: 0 }}>
          <RestApiErrorsTable
            loading={rowsLoading}
            rows={rows}
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
