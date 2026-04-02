import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

dayjs.extend(utc);
dayjs.extend(timezone);

export function emptyArrToNull<T>(arr: T[] | null | undefined): T[] | null {
  if (arr == null) return null;
  if (Array.isArray(arr) && arr.length === 0) return null;
  return arr;
}

export function strArraysEqual(arr1: string[], arr2: string[]) {
  if (arr1.length !== arr2.length) {
    return false;
  }

  return arr1.every((value, index) => value === arr2[index]);
}

export function objectsEqual(obj1: { [key: string]: any }, obj2: { [key: string]: any }) {
  const keys1 = Object.keys(obj1);
  const keys2 = Object.keys(obj2);

  if (keys1.length !== keys2.length) {
    return false;
  }

  return keys1.every((key) => obj1[key] === obj2[key]);
}

export function formatDate(value: number | null | undefined, timeFormat?: Intl.DateTimeFormatOptions): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('uk-UA', timeFormat);
}

export function formatDateTime24(value: number | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export const APP_DATE_INPUT_MIN = '2022-01-01';
export const APP_DATE_INPUT_MIN_YEAR = 2022;
export const APP_TIME_ZONE = 'Europe/Kiev';

export function formatLocalDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatLocalTimeInputValue(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}

export function formatDateInputValueInTimeZone(date: Date, timeZone: string = APP_TIME_ZONE): string {
  return dayjs(date).tz(timeZone).format('YYYY-MM-DD');
}

export function formatTimeInputValueInTimeZone(date: Date, timeZone: string = APP_TIME_ZONE): string {
  return dayjs(date).tz(timeZone).format('HH:mm');
}

export function isValidDateInput(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;
  const [yearRaw, monthRaw, dayRaw] = dateStr.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  if (!Number.isInteger(year) || year < APP_DATE_INPUT_MIN_YEAR) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function isValidTimeInput(timeStr: string): boolean {
  if (!/^\d{2}:\d{2}$/.test(timeStr)) return false;
  const [hoursRaw, minutesRaw] = timeStr.split(':');
  const hours = Number(hoursRaw);
  const minutes = Number(minutesRaw);
  if (!Number.isInteger(hours) || hours < 0 || hours > 23) return false;
  if (!Number.isInteger(minutes) || minutes < 0 || minutes > 59) return false;
  return true;
}

export function combineDateTimeToMs(dateStr: string, timeStr: string, timeZone: string = APP_TIME_ZONE): number | null {
  if (!isValidDateInput(dateStr) || !isValidTimeInput(timeStr)) return null;
  const parsed = dayjs.tz(`${dateStr}T${timeStr}:00`, timeZone);
  const millis = parsed.valueOf();
  return Number.isFinite(millis) ? millis : null;
}
