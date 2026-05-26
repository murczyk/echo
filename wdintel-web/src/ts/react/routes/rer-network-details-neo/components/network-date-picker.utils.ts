import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';

export const NETWORK_DATE_INPUT_FORMAT = 'YYYY-MM-DD';

export function parseNetworkDateValue(value: string): Dayjs | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;

  const parsed = dayjs(trimmed);
  return parsed.isValid() ? parsed : null;
}

export function formatNetworkDateValue(value: Dayjs): string {
  return value.format(NETWORK_DATE_INPUT_FORMAT);
}
