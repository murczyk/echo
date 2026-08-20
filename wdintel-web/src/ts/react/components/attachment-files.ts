import type { SvgIconComponent } from '@mui/icons-material';
import AudiotrackOutlinedIcon from '@mui/icons-material/AudiotrackOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';

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

const IMAGE_EXTENSIONS = new Set([
  'png',
  'jpg',
  'jpeg',
  'gif',
  'webp',
  'bmp',
  'svg',
  'ico',
  'tiff',
  'avif',
]);

const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'm4v',
  'mov',
  'webm',
  'mkv',
  'avi',
  'mpeg',
  'mpg',
  'wmv',
  'flv',
  '3gp',
  '3g2',
  'm2ts',
  'ogv',
  'vob',
  'asf',
]);

export function mediaKind(mimeType: string | undefined, fileName?: string): MediaKind | null {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (fileName) {
    const ext = fileExtension(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
  }
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
