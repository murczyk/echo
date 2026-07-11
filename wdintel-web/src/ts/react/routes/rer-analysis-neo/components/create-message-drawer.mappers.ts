import dayjs from 'dayjs';
import type { Dayjs } from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import type { InboxMessage, Tag } from '../../../../../Bindings';

dayjs.extend(customParseFormat);

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

export function mapInboxMessageToForm(
  message: InboxMessage,
  tagsMap: Record<number, Tag>,
): MessageFormValues {
  return {
    full_body: message.text ?? '',
    comment: message.extendedForm ?? '',
    date: parseDay(message.date, 'YYYY-MM-DD'),
    time: parseDay(message.time, 'HH:mm'),
    freq: message.freq ?? '',
    coords: message.coords ?? '',
    callsigns: message.callsigns ?? [],
    post: message.post ?? '',
    unit: message.unit ?? '',
    locations: message.location ? [message.location] : [],
    tags: (message.tags ?? [])
      .map((id) => tagsMap[id]?.label)
      .filter((label): label is string => Boolean(label)),
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
    freq: nullableTrim(values.freq),
    coords: nullableTrim(values.coords),
    callsigns: values.callsigns,
    post: nullableTrim(values.post),
    unit: nullableTrim(values.unit),
    location: nullableTrim(values.locations.join(', ')),
    tags: tagIds.length > 0 ? tagIds : null,
  };
}
