import type {
  AiAgentFileCitation,
  DeviceDocumentAdminRsp,
  DeviceDocumentReadReq,
  DeviceDocumentReadRsp,
  DeviceDocumentSettings,
} from '../../../../Bindings';
import { postJson } from './client';

export const deviceDocumentRequest = (source: AiAgentFileCitation): DeviceDocumentReadReq => ({
  deviceId: source.deviceId,
  fileId: source.fileId,
  revision: source.revision,
  extractionRevision: source.extractionRevision ?? null,
  member: null,
  query: null,
  after: source.section == null ? null : source.section - 1,
  limit: 4,
});
export const readDeviceDocument = (req: DeviceDocumentReadReq, signal?: AbortSignal) =>
  postJson<DeviceDocumentReadRsp>('/api/device/files/ai/read', req, { signal });
export const getDeviceDocumentsPage = (query: string, signal?: AbortSignal) =>
  postJson<DeviceDocumentAdminRsp>(
    '/api/admin/device-documents/page',
    { query, limit: 20 },
    { signal },
  );
export const saveDeviceDocumentSettings = (settings: DeviceDocumentSettings) =>
  postJson<DeviceDocumentSettings>('/api/admin/device-documents/settings', settings);
export const retryDeviceDocument = (source: AiAgentFileCitation) =>
  postJson<DeviceDocumentReadRsp>(
    '/api/admin/device-documents/retry',
    deviceDocumentRequest(source),
  );
export function fileCitationHref(source: AiAgentFileCitation): string {
  const query = new URLSearchParams({ file: source.fileId, revision: String(source.revision) });
  if (source.extractionRevision) query.set('extraction', source.extractionRevision);
  if (source.section != null) query.set('section', String(source.section));
  return `/devices/${source.deviceId}/files?${query}`;
}
