import type {
  MessageReplayActivityBucket,
  MessageReplayActivityPoint,
  MessageReplaySpeed,
} from '../../../../Bindings';
import { APP_TIME_ZONE } from '../../utils/misc';

export const MINUTE_MS = 60_000;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;
/** Server cap on the replay window. */
export const MAX_WINDOW_DAYS = 31;
/** Days shown in the year overview (the server caps day histograms at 366). */
export const OVERVIEW_DAYS = 365;

export type MsRange = [number, number];
export type Bar = { startMs: number; count: number };

export const SPEED_OPTIONS: Array<{ value: MessageReplaySpeed; label: string }> = [
  { value: 'Speed100', label: '1×' },
  { value: 'Speed200', label: '2×' },
  { value: 'Speed300', label: '3×' },
  { value: 'Speed500', label: '5×' },
  { value: 'Speed1000', label: '10×' },
];

/** How many days the bar strip shows, starting at the selected day. */
export const SPAN_DAY_OPTIONS = [1, 3, 7];

export const DURATION_OPTIONS: Array<{ ms: number; label: string }> = [
  { ms: 30 * MINUTE_MS, label: '30 хв' },
  { ms: HOUR_MS, label: '1 год' },
  { ms: 2 * HOUR_MS, label: '2 год' },
  { ms: 4 * HOUR_MS, label: '4 год' },
  { ms: 8 * HOUR_MS, label: '8 год' },
  { ms: DAY_MS, label: 'доба' },
  { ms: 3 * DAY_MS, label: '3 доби' },
  { ms: 7 * DAY_MS, label: 'тиждень' },
];

export function speedLabel(speed: MessageReplaySpeed): string {
  return SPEED_OPTIONS.find((option) => option.value === speed)?.label ?? speed;
}

export function bucketMs(bucket: MessageReplayActivityBucket): number {
  switch (bucket) {
    case 'Minutes15':
      return 15 * MINUTE_MS;
    case 'Hour1':
      return HOUR_MS;
    case 'Day1':
      return DAY_MS;
  }
}

/** Up to 3 days: 15-minute bars; longer: hourly (at most 744 bars for 31 days). */
export function autoBucket(range: MsRange): MessageReplayActivityBucket {
  return range[1] - range[0] <= 3 * DAY_MS ? 'Minutes15' : 'Hour1';
}

// Kyiv calendar math through Intl: no dependence on the browser time zone,
// and every step is guaranteed to move forward across DST changes.

const KYIV_PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: APP_TIME_ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function kyivParts(ms: number) {
  const parts: Record<string, number> = {};
  for (const part of KYIV_PARTS.formatToParts(ms)) {
    if (part.type !== 'literal') parts[part.type] = Number(part.value);
  }
  return parts as {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
  };
}

/** Kyiv UTC offset at instant `ms`. */
function kyivOffsetMs(ms: number): number {
  const p = kyivParts(ms);
  const wallClockAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wallClockAsUtc - Math.floor(ms / 1000) * 1000;
}

/** Instant of Kyiv midnight of the date `YYYY-MM-DD` (midnight is never in a DST gap). */
export function kyivMidnight(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  const midnightAsUtc = Date.UTC(year, month - 1, day);
  const guess = midnightAsUtc - kyivOffsetMs(midnightAsUtc);
  return midnightAsUtc - kyivOffsetMs(guess);
}

/** Kyiv calendar date `YYYY-MM-DD` of instant `ms`. */
export function kyivDate(ms: number): string {
  const p = kyivParts(ms);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** Calendar date arithmetic on `YYYY-MM-DD` strings. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day) + days * DAY_MS).toISOString().slice(0, 10);
}

const UK_LOCALE = 'uk-UA';
const COUNT_FORMAT = new Intl.NumberFormat(UK_LOCALE);
/** Calendar dates are formatted as UTC midnights, so no time zone shifts them. */
const DATE_FORMAT = new Intl.DateTimeFormat(UK_LOCALE, {
  timeZone: 'UTC',
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const SHORT_MONTH_FORMAT = new Intl.DateTimeFormat(UK_LOCALE, { timeZone: 'UTC', month: 'short' });
const SHORT_WEEKDAY_FORMAT = new Intl.DateTimeFormat(UK_LOCALE, {
  timeZone: 'UTC',
  weekday: 'short',
});

/** Short month names, January first. */
export const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
  SHORT_MONTH_FORMAT.format(Date.UTC(2026, month, 15)),
);
/** Short weekday names, Sunday first (2023-01-01 was a Sunday). */
export const WEEKDAY_NAMES = Array.from({ length: 7 }, (_, day) =>
  SHORT_WEEKDAY_FORMAT.format(Date.UTC(2023, 0, 1 + day)),
);

export function formatCount(count: number): string {
  return COUNT_FORMAT.format(count);
}

/** `DD.MM.YYYY HH:mm[:ss]` in Kyiv time. */
export function formatKyiv(ms: number, withSeconds = false): string {
  const p = kyivParts(ms);
  const pad = (value: number) => String(value).padStart(2, '0');
  const time = `${pad(p.hour)}:${pad(p.minute)}${withSeconds ? `:${pad(p.second)}` : ''}`;
  return `${formatDate(kyivDate(ms))} ${time}`;
}

/** `HH:mm` in Kyiv time. */
export function formatKyivTime(ms: number): string {
  const p = kyivParts(ms);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

/** `DD.MM.YYYY` for a `YYYY-MM-DD` date. */
export function formatDate(date: string): string {
  const [year, month, day] = date.split('-').map(Number);
  return DATE_FORMAT.format(Date.UTC(year, month - 1, day));
}

/** `DD.MM` for a `YYYY-MM-DD` date. */
export function formatDayMonth(date: string): string {
  return formatDate(date).slice(0, 5);
}

/** Day counts keyed by Kyiv date, from `Day1` activity points. */
export function dayCounts(points: MessageReplayActivityPoint[]): Map<string, number> {
  return new Map(points.map((point) => [kyivDate(point.tsMs), point.count]));
}

/** Every 15-minute / hourly bucket in `range`, empty ones included. */
export function fillBars(
  points: MessageReplayActivityPoint[],
  range: MsRange,
  bucket: MessageReplayActivityBucket,
): Bar[] {
  const counts = new Map(points.map((point) => [point.tsMs, point.count]));
  const step = bucketMs(bucket);
  const bars: Bar[] = [];
  for (let ts = Math.floor(range[0] / step) * step; ts < range[1]; ts += step) {
    bars.push({ startMs: ts, count: counts.get(ts) ?? 0 });
  }
  return bars;
}

/** A window of `durationMs` from `startMs`, kept in the past and under the cap. */
export function windowFrom(startMs: number, durationMs: number, nowMs: number): MsRange | null {
  const to = Math.min(startMs + Math.min(durationMs, MAX_WINDOW_DAYS * DAY_MS), nowMs);
  return to > startMs ? [startMs, to] : null;
}

export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days} д ${hours} год`;
  if (hours > 0) return `${hours} год ${minutes} хв`;
  if (minutes > 0) return `${minutes} хв ${seconds} с`;
  return `${seconds} с`;
}
