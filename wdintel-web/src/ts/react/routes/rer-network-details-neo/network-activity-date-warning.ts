import dayjs from 'dayjs';

import { APP_TIME_ZONE, isValidDateInput } from '../../utils/misc';

export const NETWORK_ACTIVITY_FUTURE_DATE_WARNING =
  'Перевірте дату: вона більш ніж на місяць у майбутньому.';

export function isNetworkActivityDateMoreThanOneMonthAhead(
  value: string,
  now: Date = new Date(),
): boolean {
  if (!isValidDateInput(value)) return false;

  const warningThreshold = dayjs(now)
    .tz(APP_TIME_ZONE)
    .startOf('day')
    .add(1, 'month')
    .format('YYYY-MM-DD');

  return value > warningThreshold;
}
