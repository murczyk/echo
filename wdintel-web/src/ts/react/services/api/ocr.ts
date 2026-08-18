import type {
  OcrPageReq,
  OcrPageRsp,
  OcrMediaSummary,
  OcrSettingsItem,
  ReprocessMediaOcrReq,
  SaveOcrSettingsReq,
} from '../../../../Bindings';
import { getJson, postJson, type RequestOptions } from './client';

export function getOcrPage(limit = 200): Promise<OcrPageRsp> {
  const req: OcrPageReq = { limit };
  return postJson<OcrPageRsp>('/api/admin/ocr/page', req);
}

export function saveOcrSettings(req: SaveOcrSettingsReq): Promise<OcrSettingsItem> {
  return postJson<OcrSettingsItem>('/api/admin/ocr/settings', req);
}

export function getMediaOcrStatus(
  mediaId: string,
  options?: RequestOptions,
): Promise<OcrMediaSummary> {
  return getJson<OcrMediaSummary>(
    `/api/messenger/media/${encodeURIComponent(mediaId)}/ocr/status`,
    options,
  );
}

export function reprocessMediaOcr(mediaId: string, aiEngineId?: string): Promise<OcrMediaSummary> {
  const req: ReprocessMediaOcrReq = { aiEngineId: aiEngineId ?? null };
  return postJson<OcrMediaSummary>(`/api/admin/ocr/${encodeURIComponent(mediaId)}/reprocess`, req);
}
