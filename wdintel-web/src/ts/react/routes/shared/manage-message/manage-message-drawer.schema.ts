import * as z from 'zod';
import type { SvgIconComponent } from '@mui/icons-material';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import AudiotrackOutlinedIcon from '@mui/icons-material/AudiotrackOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import { parseCoordinateInput } from '../../../../maps/coordinate-search';

export const FREQ_FORMAT_REGEX = /^\d+([.,]\d+)?$/;

// Accepts either WGS84 decimal degrees ("lat, lon") or an MGRS grid reference
// ("37U DR 05997 22279") on a single line, returning backend {lat, lon}.
export function parseCoordLine(line: string): { lat: number; lon: number } | null {
  const parsed = parseCoordinateInput(line);
  if (!parsed) return null;
  return { lat: parsed.lat, lon: parsed.lng };
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

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '';
}

export function attachmentIcon(name: string, mimeType: string | undefined): SvgIconComponent {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('image/')) return ImageOutlinedIcon;
  if (type.startsWith('video/')) return MovieOutlinedIcon;
  if (type.startsWith('audio/')) return AudiotrackOutlinedIcon;
  const ext = fileExtension(name).toLowerCase();
  if (type === 'application/pdf' || ext === 'pdf') return PictureAsPdfOutlinedIcon;
  if (['xlsx', 'xls', 'csv', 'ods'].includes(ext)) return TableChartOutlinedIcon;
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(ext)) return DescriptionOutlinedIcon;
  return InsertDriveFileOutlinedIcon;
}

export type MediaKind = 'image' | 'video';

export function mediaKind(mimeType: string | undefined): MediaKind | null {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  return null;
}

export function formatFileSize(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return '';
  const units = ['Б', 'КБ', 'МБ', 'ГБ'];
  let size = bytes;
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }
  const rounded = size >= 10 || unitIndex === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
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

export function makeMessageSchema(isEditMode: boolean) {
  return z
    .object({
      text: z.string().optional(),
      signalGroupMasterKey: z.string().trim().min(1, 'Оберіть групу'),
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
      full_body: z.string().optional(),
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
          message: 'Невірний формат координат (очікується "lat, lon" або MGRS)',
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
