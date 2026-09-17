import * as z from 'zod';
import { parseCoordinateBlock } from '../../../../maps/coordinate-parser';

export {
  attachmentIcon,
  fileExtension,
  formatFileSize,
  mediaKind,
  type MediaKind,
} from '../../../components/attachment-files';

export const FREQ_FORMAT_REGEX = /^\d+([.,]\d+)?$/;
export const DO_NOT_SEND_GROUP_VALUE = '__do_not_send__';

export function parseCoordLine(line: string): { lat: number; lon: number } | null {
  const parsed = parseCoordinateBlock(line)[0];
  if (!parsed) return null;
  return { lat: parsed.lat, lon: parsed.lng };
}

export function parseCoords(value: string): { lat: number; lon: number }[] {
  return parseCoordinateBlock(value).map(({ lat, lng }) => ({ lat, lon: lng }));
}

export function normalizeMultiValue(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    // Split comma-separated free-text so "дождь, синий" becomes two chips.
    for (const part of raw.split(',')) {
      const trimmed = part.trim();
      if (!trimmed || seen.has(trimmed)) continue;
      seen.add(trimmed);
      result.push(trimmed);
    }
  }
  return result;
}

export function normalizeCallsign(value: string): string {
  return value.trim().toUpperCase();
}

const optionalDmrText = z.string().optional();
const dmrMetadataSchema = z.object({
  cc: optionalDmrText.refine(
    (value) => {
      if (!value?.trim()) return true;
      const parsed = Number(value.trim());
      return Number.isInteger(parsed) && parsed >= 0 && parsed <= 15;
    },
    { message: 'Color Code має бути цілим числом від 0 до 15' },
  ),
  sender_id: optionalDmrText,
  sender_name: optionalDmrText,
  call_group_id: optionalDmrText,
  call_group_name: optionalDmrText,
  hash_id: optionalDmrText,
});

export function makeMessageSchema(
  isEditMode: boolean,
  groupOptional = false,
  reportTextRequired = false,
) {
  return z
    .object({
      text: z.string().optional(),
      signalGroupMasterKey: groupOptional
        ? z.string().optional().default('')
        : z.string().trim().min(1, 'Оберіть групу'),
      deviceName: z.string().optional(),
      freq: z
        .string()
        .optional()
        .refine((value) => isEditMode || !value?.trim() || FREQ_FORMAT_REGEX.test(value.trim()), {
          message: 'Невірний формат частоти (напр. 149.5000)',
        }),
      coords: z.string().optional(),
      callsigns: z.array(z.string()).optional(),
      tags: z.array(z.string()).optional(),
      date: z.any().optional(),
      time: z.any().optional(),
      full_body: reportTextRequired
        ? z.string().trim().min(1, 'Введіть текст розвіддонесення')
        : z.string().optional(),
      comment: z.string().optional(),
      post: z.string().optional(),
      unit: z.string().optional(),
      locations: z.array(z.string()).optional(),
      network_signal_name: z.string().optional(),
      network_name: z.string().optional(),
      dmr: z.array(dmrMetadataSchema),
      deleted_media_ids: z.array(z.string()).optional(),
    })
    .superRefine((data, ctx) => {
      if (data.coords?.trim() && !parseCoordLine(data.coords)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['coords'],
          message: 'Невірний формат координат (WGS-84, MGRS, UTM, СК-42 або УСК-2000)',
        });
      }
    });
}

export type MessageFormData = z.infer<ReturnType<typeof makeMessageSchema>>;

export const EMPTY_FORM_VALUES: MessageFormData = {
  text: '',
  signalGroupMasterKey: '',
  deviceName: '',
  freq: '',
  coords: '',
  callsigns: [],
  tags: [],
  date: null,
  time: null,
  full_body: '',
  comment: '',
  post: '',
  unit: '',
  locations: [],
  network_signal_name: '',
  network_name: '',
  dmr: [],
  deleted_media_ids: [],
};
