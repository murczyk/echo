import type {
  AttachmentAdminRsp,
  AttachmentReadReq,
  AttachmentReadRsp,
  AttachmentSettings,
} from '../../../../Bindings';
import { postJson } from './client';

export const attachmentReadRequest = (mediaId: string): AttachmentReadReq => ({
  mediaId,
  revision: null,
  member: null,
  after: null,
  limit: 4,
  query: null,
});
export const getAttachmentsPage = (query: string, cursor: string | null = null) =>
  postJson<AttachmentAdminRsp>('/api/admin/attachments/page', { query, cursor, limit: 50 });
export const saveAttachmentSettings = (settings: AttachmentSettings) =>
  postJson<AttachmentSettings>('/api/admin/attachments/settings', settings);
export const readAttachment = (req: AttachmentReadReq) =>
  postJson<AttachmentReadRsp>('/api/attachments/read', req);
export const retryAttachment = (mediaId: string) =>
  postJson<AttachmentReadRsp>('/api/admin/attachments/retry', attachmentReadRequest(mediaId));
