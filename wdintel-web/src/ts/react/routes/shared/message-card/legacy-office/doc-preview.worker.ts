import { buildDocPreview } from './doc-preview';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';
import type { DocPreviewResult } from './legacy-office-preview.types';

type Request = { requestId: string; request: { buffer: ArrayBuffer } };
type Response = { requestId: string; ok: boolean; value?: DocPreviewResult; error?: string };

self.addEventListener('message', (event: MessageEvent<Request>) => {
  const { requestId, request } = event.data;
  try {
    self.postMessage({
      requestId,
      ok: true,
      value: buildDocPreview(request.buffer),
    } satisfies Response);
  } catch (error) {
    const code =
      error instanceof LegacyOfficePreviewError
        ? error.code
        : LegacyOfficePreviewErrorCode.Malformed;
    self.postMessage({ requestId, ok: false, error: code } satisfies Response);
  }
});
