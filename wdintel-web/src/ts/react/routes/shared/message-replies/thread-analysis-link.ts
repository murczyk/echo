import dayjs from 'dayjs';
import type { CitedMessage } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';

export const THREAD_MESSAGE_PARAM = 'threadMessageId';

export function readThreadMessageId() {
  if (typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(THREAD_MESSAGE_PARAM);
  if (value == null) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

export function threadAnalysisHref(id: number, messages: ReadonlyMap<number, CitedMessage>) {
  const times = Array.from(messages.values()).flatMap((message) =>
    [message.createdAt, message.timestamp].filter((time): time is number => time != null),
  );
  const earliest = times.reduce(
    (earliest, time) => Math.min(earliest, time),
    times[0] ?? Date.now(),
  );
  const latest = times.reduce((latest, time) => Math.max(latest, time), earliest);
  const start = dayjs(earliest).tz(APP_TIME_ZONE).startOf('day');
  const end = dayjs(latest).tz(APP_TIME_ZONE).add(1, 'day').startOf('day');
  const params = new URLSearchParams({
    [THREAD_MESSAGE_PARAM]: String(id),
    fromDateTime: start.format('YYYY-MM-DDTHH:mm'),
    toDateTime: end.format('YYYY-MM-DDTHH:mm'),
    leftPanelOpen: 'false',
    rightPanelOpen: 'false',
    filterPanelOpen: 'false',
  });
  return `/rer-analysis-neo?${params}`;
}
