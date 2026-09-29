import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';
import { buildXlsPreview } from './xls-preview';
import type { XlsPreviewResult } from './legacy-office-preview.types';

type Request = { requestId: string; request: { buffer: ArrayBuffer } };
type Response = { requestId: string; ok: boolean; value?: XlsPreviewResult; error?: string };

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { requestId, request } = event.data;
  try {
    const value = buildXlsPreview(request.buffer);
    self.postMessage({ requestId, ok: true, value } satisfies Response);
  } catch (error) {
    const code =
      error instanceof LegacyOfficePreviewError
        ? error.code
        : LegacyOfficePreviewErrorCode.Malformed;
    self.postMessage({ requestId, ok: false, error: code } satisfies Response);
  }
});
