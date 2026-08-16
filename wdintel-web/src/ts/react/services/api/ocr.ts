import type {
  OcrPageReq,
  OcrPageRsp,
  OcrSettingsItem,
  SaveOcrSettingsReq,
} from '../../../../Bindings';
import { postJson } from './client';

export function getOcrPage(limit = 200): Promise<OcrPageRsp> {
  const req: OcrPageReq = { limit };
  return postJson<OcrPageRsp>('/api/admin/ocr/page', req);
}

export function saveOcrSettings(req: SaveOcrSettingsReq): Promise<OcrSettingsItem> {
  return postJson<OcrSettingsItem>('/api/admin/ocr/settings', req);
}
