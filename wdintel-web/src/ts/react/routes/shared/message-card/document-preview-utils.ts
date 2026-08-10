export const DOCUMENT_PREVIEW_ZOOM_MIN = 50;
export const DOCUMENT_PREVIEW_ZOOM_MAX = 300;
export const DOCUMENT_PREVIEW_ZOOM_STEP = 25;

export const DOCUMENT_PREVIEW_ZOOM_MARKS = [
  { value: 50, label: '50%' },
  { value: 100, label: '100%' },
  { value: 150, label: '150%' },
  { value: 200, label: '200%' },
  { value: 300, label: '300%' },
];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizePreviewIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

export function shouldIgnoreArrowNavigation(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return Boolean(
    target.closest('input, textarea, select, [contenteditable="true"], [role="slider"]'),
  );
}

export type CachedDocumentResponse = {
  buffer: ArrayBuffer;
  contentType: string | null;
  contentLength: number | null;
};

export const DOCUMENT_CACHE_LIMIT = 50;
export const DOCUMENT_CACHE_MAX_BYTES = 32 * 1024 * 1024;
const documentResponseCache = new Map<string, CachedDocumentResponse>();
let documentResponseCacheBytes = 0;

function deleteCachedDocumentResponse(href: string): boolean {
  const entry = documentResponseCache.get(href);
  if (entry == null) return false;
  documentResponseCache.delete(href);
  documentResponseCacheBytes -= entry.buffer.byteLength;
  return true;
}

function cacheDocumentResponse(href: string, entry: CachedDocumentResponse): void {
  deleteCachedDocumentResponse(href);

  if (entry.buffer.byteLength > DOCUMENT_CACHE_MAX_BYTES) return;

  while (
    documentResponseCache.size >= DOCUMENT_CACHE_LIMIT ||
    documentResponseCacheBytes + entry.buffer.byteLength > DOCUMENT_CACHE_MAX_BYTES
  ) {
    const oldestKey = documentResponseCache.keys().next().value;
    if (oldestKey === undefined || !deleteCachedDocumentResponse(oldestKey)) break;
  }

  documentResponseCache.set(href, entry);
  documentResponseCacheBytes += entry.buffer.byteLength;
}

export async function fetchCachedDocumentResponse(
  href: string,
  maxBytes: number,
  tooLargeError: string,
  signal?: AbortSignal,
): Promise<CachedDocumentResponse> {
  const cached = documentResponseCache.get(href);
  if (cached) {
    if (
      cached.buffer.byteLength > maxBytes ||
      (cached.contentLength != null && cached.contentLength > maxBytes)
    ) {
      throw new Error(tooLargeError);
    }
    documentResponseCache.delete(href);
    documentResponseCache.set(href, cached);
    return {
      buffer: cached.buffer.slice(0),
      contentType: cached.contentType,
      contentLength: cached.contentLength,
    };
  }

  const response = await fetch(href, { signal });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const contentType = response.headers.get('content-type');
  const rawContentLength = response.headers.get('content-length');
  const parsedContentLength = rawContentLength == null ? null : Number(rawContentLength);
  const contentLength =
    parsedContentLength != null &&
    Number.isSafeInteger(parsedContentLength) &&
    parsedContentLength >= 0
      ? parsedContentLength
      : null;

  if (contentLength != null && contentLength > maxBytes) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort stop of the underlying stream.
    }
    throw new Error(tooLargeError);
  }

  const buffer = await readBoundedResponseBody(response, maxBytes, tooLargeError, signal);

  const entry: CachedDocumentResponse = {
    buffer,
    contentType,
    contentLength,
  };

  cacheDocumentResponse(href, entry);

  return {
    buffer: buffer.slice(0),
    contentType,
    contentLength,
  };
}

async function readBoundedResponseBody(
  response: Response,
  maxBytes: number,
  tooLargeError: string,
  signal?: AbortSignal,
): Promise<ArrayBuffer> {
  if (response.body == null) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > maxBytes) throw new Error(tooLargeError);
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

      const { done, value } = await reader.read();
      if (done) break;
      if (value == null) continue;

      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stop of the underlying stream.
        }
        throw new Error(tooLargeError);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const buffer = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    buffer.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return buffer.buffer;
}
