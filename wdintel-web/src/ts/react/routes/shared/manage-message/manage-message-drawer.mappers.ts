import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';
import type { InboxMessage, Tag } from '../../../../../Bindings';
import { APP_TIME_ZONE } from '../../../utils/misc';
import type { DirectSubmitRequest } from '../../../services/api/direct-submit';
import {
  normalizeCallsign,
  normalizeMultiValue,
  type MessageFormData,
} from './manage-message-drawer.schema';

dayjs.extend(customParseFormat);
dayjs.extend(utc);
dayjs.extend(timezone);

export type MessageFormValues = {
  full_body: string;
  comment: string;
  date: Dayjs | null;
  time: Dayjs | null;
  freq: string;
  coords: string;
  callsigns: string[];
  post: string;
  unit: string;
  locations: string[];
  tags: string[];
};

function parseDay(value: string | null, format: string): Dayjs | null {
  if (value == null || value.trim() === '') return null;
  const parsed = dayjs(value, format);
  return parsed.isValid() ? parsed : null;
}

function nullableTrim(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function splitLocations(value: string | null): string[] {
  return (value ?? '')
    .split(',')
    .map((location) => location.trim())
    .filter(Boolean);
}

function messageCoordinates(message: InboxMessage): string {
  const coordsWithLocality = message.coordsWithLocality ?? [];
  if (coordsWithLocality.length === 0) return message.coords ?? '';
  return coordsWithLocality
    .map(({ coords }) => `${Number(coords.lat.toFixed(6))}, ${Number(coords.lon.toFixed(6))}`)
    .join('\n');
}

export function mapInboxMessageToForm(
  message: InboxMessage,
  tagsMap: Record<number, Tag>,
): MessageFormValues {
  const timestamp = message.timestamp == null ? null : dayjs(message.timestamp).tz(APP_TIME_ZONE);
  const date = parseDay(message.date, 'YYYY-MM-DD') ?? (timestamp?.isValid() ? timestamp : null);
  const time =
    message.isTimeNull === true
      ? null
      : (parseDay(message.time, 'HH:mm') ?? (timestamp?.isValid() ? timestamp : null));
  return {
    full_body: message.text ?? '',
    comment: message.extendedForm ?? '',
    date,
    time,
    freq: message.freq ?? '',
    coords: messageCoordinates(message),
    callsigns: normalizeMultiValue((message.callsigns ?? []).map(normalizeCallsign)),
    post: message.post ?? '',
    unit: message.unit ?? '',
    locations: splitLocations(message.location),
    tags: Array.from(
      new Set(
        (message.tags ?? [])
          .map((id) => tagsMap[id]?.label)
          .filter((label): label is string => Boolean(label)),
      ),
    ),
  };
}

export function mapDirectSubmitCopyToForm(payload: DirectSubmitRequest): MessageFormData {
  const timestamp = payload.timestamp ? dayjs(payload.timestamp).tz(APP_TIME_ZONE) : null;
  return {
    text: payload.text ?? '',
    signalGroupMasterKey: payload.signal_group_master_key ?? '',
    deviceName: '',
    freq: payload.freq ?? '',
    coords: (payload.coords ?? []).map(({ lat, lon }) => `${lat}, ${lon}`).join('\n'),
    callsigns: normalizeMultiValue((payload.to ?? []).map(normalizeCallsign)),
    tags: payload.tags ?? [],
    date: timestamp?.isValid() ? timestamp : null,
    time: payload.is_time_null === true ? null : timestamp?.isValid() ? timestamp : null,
    full_body: payload.full_body ?? payload.text ?? '',
    comment: payload.comment ?? '',
    post: payload.post ?? '',
    unit: payload.unit ?? '',
    locations: payload.locations ?? [],
    network_signal_name: payload.network?.signal_name ?? '',
    network_name: payload.network?.name ?? '',
    dmr: (payload.dmr ?? []).map((metadata) => ({
      cc: metadata.cc?.toString() ?? '',
      sender_id: metadata.sender_id?.toString() ?? '',
      sender_name: metadata.sender_name ?? '',
      call_group_id: metadata.call_group_id?.toString() ?? '',
      call_group_name: metadata.call_group_name ?? '',
      hash_id: metadata.hash_id ?? '',
    })),
    deleted_media_ids: [],
  };
}

export function mapFormToInboxMessage(
  original: InboxMessage,
  values: MessageFormValues,
  labelToTagId: Map<string, number>,
): InboxMessage {
  const tagIds = values.tags
    .map((label) => labelToTagId.get(label))
    .filter((id): id is number => id != null);

  return {
    ...original,
    text: values.full_body.trim(),
    extendedForm: nullableTrim(values.comment),
    date: values.date?.isValid() ? values.date.format('YYYY-MM-DD') : null,
    time: values.time?.isValid() ? values.time.format('HH:mm') : null,
    isTimeNull: values.time == null,
    freq: nullableTrim(values.freq),
    coords: nullableTrim(values.coords),
    callsigns: values.callsigns,
    post: nullableTrim(values.post),
    unit: nullableTrim(values.unit),
    location: nullableTrim(values.locations.join(', ')),
    tags: tagIds.length > 0 ? tagIds : null,
  };
}
