import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { Badge, Box, IconButton, Stack, Tooltip, Typography } from '@mui/material';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import { DateCalendar } from '@mui/x-date-pickers/DateCalendar';
import { LocalizationProvider } from '@mui/x-date-pickers/LocalizationProvider';
import { PickersDay, type PickersDayProps } from '@mui/x-date-pickers/PickersDay';
import dayjs from 'dayjs';
import 'dayjs/locale/uk';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { Dayjs } from 'dayjs';

import { APP_TIME_ZONE } from '../../utils/misc';
import { parseUtcDateTime } from '../../services/api/report-history';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('uk');

export type DayCountMap = Record<string, number>;

type CountedPickersDayProps = PickersDayProps<Dayjs> & {
  countsByDay?: DayCountMap;
};

type DayCounterCalendarProps = {
  countsByDay: DayCountMap;
  disabled?: boolean;
  selectedDate: Dayjs;
  selectedLabel: string;
  onSelectedDateChange: (date: Dayjs) => void;
  onVisibleMonthChange?: (date: Dayjs) => void;
};

export function appDayKey(date: Dayjs): string {
  return date.tz(APP_TIME_ZONE).format('YYYY-MM-DD');
}

export function utcDateTimeToAppDayKey(value: string | null | undefined): string | null {
  const date = utcDateTimeToAppDay(value);
  return date ? appDayKey(date) : null;
}

export function utcDateTimeToAppDay(value: string | null | undefined): Dayjs | null {
  const date = parseUtcDateTime(value);
  return date ? dayjs(date).tz(APP_TIME_ZONE).startOf('day') : null;
}

export function countRowsByAppDay<T>(rows: T[], getDateTime: (row: T) => string): DayCountMap {
  return rows.reduce<DayCountMap>((acc, row) => {
    const key = utcDateTimeToAppDayKey(getDateTime(row));
    if (!key) return acc;
    acc[key] = (acc[key] ?? 0) + 1;
    return acc;
  }, {});
}

export function isRowOnAppDay<T>(
  row: T,
  selectedDate: Dayjs,
  getDateTime: (row: T) => string,
): boolean {
  return utcDateTimeToAppDayKey(getDateTime(row)) === appDayKey(selectedDate);
}

export function todayInAppTimeZone(): Dayjs {
  return dayjs().tz(APP_TIME_ZONE).startOf('day');
}

function appLocalDateToUtcIso(dateKey: string): string {
  return dayjs.tz(`${dateKey}T00:00:00`, APP_TIME_ZONE).utc().toISOString();
}

function addUtcCalendarDate(dateKey: string, amount: number, unit: 'day' | 'month'): string {
  return dayjs.utc(`${dateKey}T00:00:00Z`).add(amount, unit).format('YYYY-MM-DD');
}

export function appDayUtcRange(date: Dayjs): { since: string; till: string } {
  const sinceDay = appDayKey(date);
  const tillDay = addUtcCalendarDate(sinceDay, 1, 'day');
  return {
    since: appLocalDateToUtcIso(sinceDay),
    till: appLocalDateToUtcIso(tillDay),
  };
}

export function appMonthUtcRange(date: Dayjs): { since: string; till: string } {
  const sinceMonth = date.tz(APP_TIME_ZONE).format('YYYY-MM-01');
  const tillMonth = addUtcCalendarDate(sinceMonth, 1, 'month');
  return {
    since: appLocalDateToUtcIso(sinceMonth),
    till: appLocalDateToUtcIso(tillMonth),
  };
}

function CountedPickersDay({
  countsByDay = {},
  day,
  outsideCurrentMonth,
  ...props
}: CountedPickersDayProps) {
  const count = outsideCurrentMonth ? 0 : (countsByDay[appDayKey(day)] ?? 0);

  return (
    <Badge
      overlap="circular"
      color="primary"
      badgeContent={count}
      invisible={count === 0}
      sx={{
        '& .MuiBadge-badge': {
          minWidth: 16,
          height: 16,
          px: 0.5,
          fontSize: '0.625rem',
          lineHeight: 1,
        },
      }}
    >
      <PickersDay day={day} outsideCurrentMonth={outsideCurrentMonth} {...props} />
    </Badge>
  );
}

export function DayCounterCalendar({
  countsByDay,
  disabled = false,
  selectedDate,
  selectedLabel,
  onSelectedDateChange,
  onVisibleMonthChange,
}: DayCounterCalendarProps) {
  const normalizedSelectedDate = selectedDate.tz(APP_TIME_ZONE).startOf('day');
  const selectedDayCount = countsByDay[appDayKey(normalizedSelectedDate)] ?? 0;

  function moveSelectedDate(days: number) {
    onSelectedDateChange(normalizedSelectedDate.add(days, 'day'));
  }

  return (
    <Box
      sx={{
        border: 1,
        borderColor: 'divider',
        p: 1.5,
        minWidth: 0,
        width: { xs: '100%', lg: 336 },
      }}
    >
      <Stack spacing={1.5}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={1}>
          <Tooltip title="Попередній день">
            <span>
              <IconButton
                size="small"
                disabled={disabled}
                onClick={() => moveSelectedDate(-1)}
                aria-label="Попередній день"
              >
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>

          <Box sx={{ minWidth: 0, textAlign: 'center' }}>
            <Typography variant="subtitle2" sx={{ fontWeight: 700 }}>
              {normalizedSelectedDate.format('DD MMMM YYYY')}
            </Typography>
            <Typography variant="caption" color="text.secondary">
              {selectedLabel}: {selectedDayCount}
            </Typography>
          </Box>

          <Tooltip title="Наступний день">
            <span>
              <IconButton
                size="small"
                disabled={disabled}
                onClick={() => moveSelectedDate(1)}
                aria-label="Наступний день"
              >
                <ChevronRightIcon fontSize="small" />
              </IconButton>
            </span>
          </Tooltip>
        </Stack>

        <LocalizationProvider dateAdapter={AdapterDayjs} adapterLocale="uk">
          <DateCalendar
            disabled={disabled}
            value={normalizedSelectedDate}
            onChange={(nextDate) => {
              if (!nextDate) return;
              onSelectedDateChange(nextDate.tz(APP_TIME_ZONE).startOf('day'));
            }}
            onMonthChange={(nextMonth) => {
              onVisibleMonthChange?.(nextMonth.tz(APP_TIME_ZONE).startOf('month'));
            }}
            slots={{ day: CountedPickersDay }}
            slotProps={{
              day: {
                countsByDay,
              } as never,
            }}
            sx={{
              width: '100%',
              maxHeight: 336,
              '& .MuiDayCalendar-weekContainer': {
                justifyContent: 'space-between',
              },
              '& .MuiDayCalendar-header': {
                justifyContent: 'space-between',
              },
            }}
          />
        </LocalizationProvider>
      </Stack>
    </Box>
  );
}
