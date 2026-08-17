import type {
  MediaSummaryCoordinatesResult,
  MediaSummaryResult,
  MediaSummarySettingsItem,
  SaveMediaSummarySettingsReq,
} from '../../../../Bindings';
import { getJson, postJson } from './client';

export function saveMediaSummarySettings(
  req: SaveMediaSummarySettingsReq,
): Promise<MediaSummarySettingsItem> {
  return postJson<MediaSummarySettingsItem>('/api/admin/media-summary/settings', req);
}

export function getMediaSummary(mediaId: string): Promise<MediaSummaryResult> {
  return getJson<MediaSummaryResult>(`/api/messenger/media/${encodeURIComponent(mediaId)}/summary`);
}

export function getMediaSummaryCoordinates(
  mediaId: string,
): Promise<MediaSummaryCoordinatesResult> {
  return getJson<MediaSummaryCoordinatesResult>(
    `/api/messenger/media/${encodeURIComponent(mediaId)}/summary/coordinates`,
  );
}
