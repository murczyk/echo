import type {
  MediaSummaryCoordinatesResult,
  MediaSummaryResult,
  MediaSummarySettingsItem,
  SaveMediaSummarySettingsReq,
} from '../../../../Bindings';
import { getJson, postJson, type RequestOptions } from './client';

export type MediaSummaryAccess = 'messenger' | 'admin-ocr';

export function saveMediaSummarySettings(
  req: SaveMediaSummarySettingsReq,
): Promise<MediaSummarySettingsItem> {
  return postJson<MediaSummarySettingsItem>('/api/admin/media-summary/settings', req);
}

export function getMediaSummary(
  mediaId: string,
  options?: RequestOptions,
  access: MediaSummaryAccess = 'messenger',
): Promise<MediaSummaryResult> {
  const prefix = access === 'admin-ocr' ? '/api/admin/ocr' : '/api/messenger/media';
  return getJson<MediaSummaryResult>(`${prefix}/${encodeURIComponent(mediaId)}/summary`, options);
}

export function retryMediaSummary(
  mediaId: string,
  options?: RequestOptions,
  access: MediaSummaryAccess = 'messenger',
): Promise<MediaSummaryResult> {
  const prefix = access === 'admin-ocr' ? '/api/admin/ocr' : '/api/messenger/media';
  return postJson<MediaSummaryResult>(
    `${prefix}/${encodeURIComponent(mediaId)}/summary/retry`,
    undefined,
    options,
  );
}

export function getMediaSummaryCoordinates(
  mediaId: string,
): Promise<MediaSummaryCoordinatesResult> {
  return getJson<MediaSummaryCoordinatesResult>(
    `/api/messenger/media/${encodeURIComponent(mediaId)}/summary/coordinates`,
  );
}
