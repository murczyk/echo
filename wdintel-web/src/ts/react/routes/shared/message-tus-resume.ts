import { defaultOptions } from 'tus-js-client';

export const MESSAGE_TUS_ENDPOINT = '/api/sigint/file-upload/tus';

// Mirrors @uppy/tus browser fingerprinting so replacement preserves its Uppy file ID.
export function messageTusFingerprint(fileId: string) {
  return ['tus', fileId, MESSAGE_TUS_ENDPOINT].join('-');
}

export type MessageTusUrlStorage = Pick<
  typeof defaultOptions.urlStorage,
  'findUploadsByFingerprint' | 'removeUpload'
>;

export async function invalidateMessageTusResumeRecords(
  fileId: string,
  urlStorage: MessageTusUrlStorage = defaultOptions.urlStorage,
) {
  const uploads = [...(await urlStorage.findUploadsByFingerprint(messageTusFingerprint(fileId)))];
  for (const upload of uploads) await urlStorage.removeUpload(upload.urlStorageKey);
}
