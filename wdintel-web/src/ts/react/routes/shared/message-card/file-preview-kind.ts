import type { FilePreviewSource } from './attachment-preview/file-preview-source';
import { getDocumentFileKind } from './document-file-kind';

export type FilePreviewKind =
  'image' | 'audio' | 'video' | 'map' | 'converted-map' | 'document' | 'zip' | 'unsupported';
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg']);
const AUDIO_EXTENSIONS = new Set([
  'mp3',
  'wav',
  'ogg',
  'oga',
  'm4a',
  'aac',
  'flac',
  'opus',
  'mpga',
]);
const VIDEO_EXTENSIONS = new Set([
  'mp4',
  'mov',
  'webm',
  'mkv',
  'avi',
  'm4v',
  'mpg',
  'mpeg',
  'wmv',
  '3gp',
  '3g2',
  'flv',
  'f4v',
  'ogv',
  'm2ts',
  'vob',
  'asf',
]);
const CONVERTED_MAP_EXTENSIONS = new Set([
  'gpx',
  'geojson',
  'ldk',
  'trk',
  'are',
  'rte',
  'wpt',
  'set',
  'fit',
]);
export function getFilePreviewKind(source: FilePreviewSource): FilePreviewKind {
  const { extension, contentType } = source;
  if (
    extension === 'kml' ||
    extension === 'kmz' ||
    contentType.includes('kml') ||
    contentType.includes('google-earth')
  )
    return 'map';
  if (CONVERTED_MAP_EXTENSIONS.has(extension)) return 'converted-map';
  if (contentType.startsWith('audio/')) return 'audio';
  if (
    contentType.startsWith('video/') ||
    contentType === 'application/mp4' ||
    contentType === 'application/x-matroska'
  )
    return 'video';
  if (contentType.startsWith('image/')) return 'image';
  if (VIDEO_EXTENSIONS.has(extension)) return 'video';
  if (AUDIO_EXTENSIONS.has(extension)) return 'audio';
  if (
    (!contentType || contentType === 'application/octet-stream') &&
    IMAGE_EXTENSIONS.has(extension)
  )
    return 'image';
  const documentKind = getDocumentFileKind(source);
  return documentKind === 'zip'
    ? 'zip'
    : documentKind === 'unsupported'
      ? 'unsupported'
      : 'document';
}
