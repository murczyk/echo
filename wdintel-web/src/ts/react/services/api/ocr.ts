import type {
  OcrPageReq,
  OcrPageRsp,
  OcrMediaSummary,
  OcrSettingsItem,
  SaveOcrSettingsReq,
} from '../../../../Bindings';
import { getJson, postJson } from './client';

export function getOcrPage(limit = 200): Promise<OcrPageRsp> {
  const req: OcrPageReq = { limit };
  return postJson<OcrPageRsp>('/api/admin/ocr/page', req);
}

export function saveOcrSettings(req: SaveOcrSettingsReq): Promise<OcrSettingsItem> {
  return postJson<OcrSettingsItem>('/api/admin/ocr/settings', req);
}

export function getMediaOcrStatus(mediaId: string): Promise<OcrMediaSummary> {
  return getJson<OcrMediaSummary>(`/api/messenger/media/${encodeURIComponent(mediaId)}/ocr/status`);
}

export function reprocessMediaOcr(mediaId: string): Promise<OcrMediaSummary> {
  return postJson<OcrMediaSummary>(`/api/admin/ocr/${encodeURIComponent(mediaId)}/reprocess`);
}
