import type { SvgIconComponent } from '@mui/icons-material';
import AudiotrackOutlinedIcon from '@mui/icons-material/AudiotrackOutlined';
import CodeOutlinedIcon from '@mui/icons-material/CodeOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import FolderZipOutlinedIcon from '@mui/icons-material/FolderZipOutlined';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import InsertDriveFileOutlinedIcon from '@mui/icons-material/InsertDriveFileOutlined';
import MapOutlinedIcon from '@mui/icons-material/MapOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import PictureAsPdfOutlinedIcon from '@mui/icons-material/PictureAsPdfOutlined';
import SlideshowOutlinedIcon from '@mui/icons-material/SlideshowOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';

const MEDIA_TYPES = {
  image: { icon: ImageOutlinedIcon, label: 'Зображення' },
  video: { icon: MovieOutlinedIcon, label: 'Відео' },
  audio: { icon: AudiotrackOutlinedIcon, label: 'Аудіо' },
};
const FILE_TYPES = [
  {
    icon: PictureAsPdfOutlinedIcon,
    label: 'Документи',
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
  },
  {
    icon: TableChartOutlinedIcon,
    label: 'Таблиці',
    extensions: ['xls', 'xlsx', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'],
    mimeTypes: [
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'application/vnd.ms-excel.sheet.binary.macroenabled.12',
      'application/vnd.oasis.opendocument.spreadsheet',
      'text/csv',
      'text/tab-separated-values',
    ],
  },
  {
    icon: SlideshowOutlinedIcon,
    label: 'Презентації',
    extensions: ['ppt', 'pptx', 'pptm', 'odp'],
    mimeTypes: [
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.ms-powerpoint.presentation.macroenabled.12',
      'application/vnd.oasis.opendocument.presentation',
    ],
  },
  {
    icon: DescriptionOutlinedIcon,
    label: 'Документи',
    extensions: ['doc', 'docx', 'docm', 'odt', 'rtf', 'txt', 'md', 'markdown', 'log'],
    mimeTypes: [
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-word.document.macroenabled.12',
      'application/vnd.oasis.opendocument.text',
      'application/rtf',
      'text/rtf',
      'text/markdown',
    ],
  },
  {
    icon: MapOutlinedIcon,
    label: 'Карти',
    extensions: ['kml', 'kmz', 'gpx', 'geojson', 'ldk', 'trk', 'are', 'rte', 'wpt', 'set', 'fit'],
    mimeTypes: [
      'application/vnd.google-earth.kml+xml',
      'application/vnd.google-earth.kmz',
      'application/gpx+xml',
      'application/geo+json',
      'application/vnd.geo+json',
    ],
  },
  {
    icon: FolderZipOutlinedIcon,
    label: 'Архіви',
    extensions: ['zip', 'rar', '7z', 'tar', 'gz', 'gzip', 'tgz', 'bz2', 'tbz2', 'xz', 'txz', 'zst'],
    mimeTypes: [
      'application/zip',
      'application/x-zip',
      'application/x-zip-compressed',
      'application/vnd.rar',
      'application/x-rar-compressed',
      'application/x-7z-compressed',
      'application/x-tar',
      'application/gzip',
      'application/x-gzip',
      'application/x-bzip2',
      'application/x-xz',
      'application/zstd',
    ],
  },
  {
    icon: CodeOutlinedIcon,
    label: 'Код і дані',
    extensions: [
      'json',
      'xml',
      'html',
      'htm',
      'css',
      'scss',
      'less',
      'js',
      'ts',
      'jsx',
      'tsx',
      'py',
      'rb',
      'go',
      'rs',
      'c',
      'cpp',
      'h',
      'hpp',
      'cs',
      'java',
      'sh',
      'bash',
      'zsh',
      'ps1',
      'sql',
      'ini',
      'conf',
      'cfg',
      'toml',
      'yaml',
      'yml',
      'env',
    ],
    mimeTypes: [
      'application/json',
      'application/xml',
      'text/xml',
      'text/html',
      'text/css',
      'text/javascript',
      'application/javascript',
      'application/yaml',
      'text/yaml',
      'application/toml',
    ],
  },
];
const ZIP_MIME_TYPES = new Set([
  'application/zip',
  'application/x-zip',
  'application/x-zip-compressed',
]);
const ZIP_DOCUMENT_EXTENSIONS = new Set([
  'docx',
  'docm',
  'xlsx',
  'xlsm',
  'xlsb',
  'pptx',
  'pptm',
  'odt',
  'ods',
  'odp',
  'kmz',
]);

export function fileExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot < name.length - 1 ? name.slice(dot + 1).toUpperCase() : '';
}

export function attachmentIcon(name: string, mimeType: string | undefined): SvgIconComponent {
  return attachmentType(name, mimeType).icon;
}

export function attachmentTypeLabel(name: string, mimeType: string | undefined): string {
  return attachmentType(name, mimeType).label;
}

function attachmentType(
  name: string,
  mimeType: string | undefined,
): { icon: SvgIconComponent; label: string } {
  const type = (mimeType ?? '').split(';', 1)[0].trim().toLowerCase();
  const declaredMedia = mediaKind(type);
  if (declaredMedia) return MEDIA_TYPES[declaredMedia];
  if (type === 'application/mp4' || type === 'application/x-matroska') return MEDIA_TYPES.video;
  const ext = fileExtension(name).toLowerCase();
  const namedType = FILE_TYPES.find((category) => category.extensions.includes(ext));
  const declaredType = FILE_TYPES.find((category) => category.mimeTypes.includes(type));
  if (namedType && ZIP_MIME_TYPES.has(type) && ZIP_DOCUMENT_EXTENSIONS.has(ext)) return namedType;
  if (
    namedType?.icon === MapOutlinedIcon &&
    ['application/json', 'application/xml', 'text/xml'].includes(type)
  )
    return namedType;
  if (declaredType) return declaredType;
  if (namedType) return namedType;
  const namedMedia = mediaKind(undefined, name);
  if (namedMedia) return MEDIA_TYPES[namedMedia];
  if (['tif', 'heic', 'heif', 'jfif'].includes(ext)) return MEDIA_TYPES.image;
  if (['aif', 'aiff', 'alac', 'amr', 'wma'].includes(ext)) return MEDIA_TYPES.audio;
  if (ext === 'f4v') return MEDIA_TYPES.video;
  if (type.startsWith('text/')) return { icon: DescriptionOutlinedIcon, label: 'Документи' };
  return { icon: InsertDriveFileOutlinedIcon, label: 'Інше' };
}

export type MediaKind = 'image' | 'video' | 'audio';

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
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'mpeg',
  'mpga',
  'wav',
  'ogg',
  'oga',
  'opus',
  'm4a',
  'aac',
  'flac',
]);

export function mediaKind(mimeType: string | undefined, fileName?: string): MediaKind | null {
  const type = (mimeType ?? '').toLowerCase();
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (fileName) {
    const ext = fileExtension(fileName).toLowerCase();
    if (IMAGE_EXTENSIONS.has(ext)) return 'image';
    if (VIDEO_EXTENSIONS.has(ext)) return 'video';
    if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
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
