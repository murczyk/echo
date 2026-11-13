import { parseKmzPreview } from './kmz-preview-parser';
import type { NativeMapFormat } from './kmz-preview-utils';

type Request = { buffer: ArrayBuffer; format: NativeMapFormat; maxBytes?: number };

self.addEventListener('message', (event: MessageEvent<{ requestId: string; request: Request }>) => {
  const { requestId, request } = event.data;
  try {
    self.postMessage({
      requestId,
      ok: true,
      value: parseKmzPreview(request.buffer, request.format, request.maxBytes),
    });
  } catch (error) {
    self.postMessage({
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'KMZ_MALFORMED',
    });
  }
});
