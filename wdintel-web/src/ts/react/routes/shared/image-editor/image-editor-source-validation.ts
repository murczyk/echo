import type { ImageEditorSource } from './image-editor.types';

export const MAX_IMAGE_EDITOR_SIDE = 8_192;
export const MAX_IMAGE_EDITOR_PIXELS = 24_000_000;
export const MAX_IMAGE_EDITOR_SOURCE_BYTES = 64 * 1024 * 1024;
export const MAX_IMAGE_EDITOR_HEADER_BYTES = 1024 * 1024;

export const IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR =
  'Зображення завелике для редагування у браузері. Його все ще можна переглянути або завантажити.';
export const IMAGE_EDITOR_DIMENSIONS_TOO_LARGE_ERROR = IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR;
export const IMAGE_EDITOR_MALFORMED_SOURCE_ERROR =
  'Не вдалося безпечно прочитати параметри зображення для редагування.';
export const IMAGE_EDITOR_ANIMATED_WEBP_ERROR =
  'Анімовані WebP-зображення доступні лише для перегляду';
export const IMAGE_EDITOR_ANIMATED_PNG_ERROR =
  'Анімовані PNG-зображення доступні лише для перегляду';

type ImageMetadata = {
  format: 'jpeg' | 'png' | 'webp';
  width: number;
  height: number;
  animated: boolean;
};

function fail(message = IMAGE_EDITOR_MALFORMED_SOURCE_ERROR): never {
  throw new Error(message);
}

function u24le(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
}

function png(bytes: Uint8Array, sourceSize: number): ImageMetadata | null {
  if (
    bytes.length < 8 ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)
  )
    return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunkType = (offset: number) => String.fromCharCode(...bytes.slice(offset + 4, offset + 8));
  const chunkEnd = (offset: number) => {
    if (offset > bytes.length - 8) fail();
    const length = view.getUint32(offset);
    if (length > sourceSize - offset - 12) fail();
    return offset + 12 + length;
  };
  const ihdrEnd = chunkEnd(8);
  if (view.getUint32(8) !== 13 || chunkType(8) !== 'IHDR') fail();
  const metadata = {
    format: 'png' as const,
    width: view.getUint32(16),
    height: view.getUint32(20),
  };
  for (let offset = ihdrEnd; ;) {
    const nextOffset = chunkEnd(offset);
    const type = chunkType(offset);
    if (type === 'acTL') return { ...metadata, animated: true };
    if (type === 'IDAT') return { ...metadata, animated: false };
    if (type === 'IEND') fail();
    offset = nextOffset;
  }
}

function jpeg(bytes: Uint8Array): ImageMetadata | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  for (let offset = 2; offset < bytes.length;) {
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker == null || marker === 0xda || marker === 0xd9) break;
    if ((marker >= 0xd0 && marker <= 0xd7) || marker === 0x01) continue;
    if (offset + 2 > bytes.length) fail();
    const length = (bytes[offset] << 8) | bytes[offset + 1];
    if (length < 2 || offset + length > bytes.length) fail();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8) fail();
      return {
        format: 'jpeg',
        width: (bytes[offset + 5] << 8) | bytes[offset + 6],
        height: (bytes[offset + 3] << 8) | bytes[offset + 4],
        animated: false,
      };
    }
    offset += length;
  }
  fail();
}

function webp(bytes: Uint8Array, sourceSize: number): ImageMetadata | null {
  if (
    bytes.length < 12 ||
    String.fromCharCode(...bytes.slice(0, 4)) !== 'RIFF' ||
    String.fromCharCode(...bytes.slice(8, 12)) !== 'WEBP'
  )
    return null;
  for (let offset = 12; offset + 8 <= bytes.length;) {
    const kind = String.fromCharCode(...bytes.slice(offset, offset + 4));
    const length = new DataView(bytes.buffer, bytes.byteOffset).getUint32(offset + 4, true);
    const data = offset + 8;
    if (data + length > sourceSize) fail();
    if (kind === 'VP8X') {
      if (length < 10 || data + 10 > bytes.length) fail();
      return {
        format: 'webp',
        width: u24le(bytes, data + 4) + 1,
        height: u24le(bytes, data + 7) + 1,
        animated: Boolean(bytes[data] & 0x02),
      };
    }
    if (kind === 'VP8 ') {
      if (
        length < 10 ||
        data + 10 > bytes.length ||
        bytes[data + 3] !== 0x9d ||
        bytes[data + 4] !== 0x01 ||
        bytes[data + 5] !== 0x2a
      )
        fail();
      return {
        format: 'webp',
        width: ((bytes[data + 7] << 8) | bytes[data + 6]) & 0x3fff,
        height: ((bytes[data + 9] << 8) | bytes[data + 8]) & 0x3fff,
        animated: false,
      };
    }
    if (kind === 'VP8L') {
      if (length < 5 || data + 5 > bytes.length || bytes[data] !== 0x2f) fail();
      const packed =
        bytes[data + 1] |
        (bytes[data + 2] << 8) |
        (bytes[data + 3] << 16) |
        (bytes[data + 4] << 24);
      return {
        format: 'webp',
        width: (packed & 0x3fff) + 1,
        height: ((packed >> 14) & 0x3fff) + 1,
        animated: false,
      };
    }
    offset = data + length + (length % 2);
  }
  fail();
}

export async function validateImageEditorSource(source: ImageEditorSource): Promise<ImageMetadata> {
  if (source.blob.size > MAX_IMAGE_EDITOR_SOURCE_BYTES) fail(IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR);
  const bytes = new Uint8Array(
    await source.blob.slice(0, MAX_IMAGE_EDITOR_HEADER_BYTES).arrayBuffer(),
  );
  const metadata =
    png(bytes, source.blob.size) ?? jpeg(bytes) ?? webp(bytes, source.blob.size) ?? fail();
  if (!metadata.width || !metadata.height) fail();
  if (metadata.animated)
    fail(
      metadata.format === 'png'
        ? IMAGE_EDITOR_ANIMATED_PNG_ERROR
        : IMAGE_EDITOR_ANIMATED_WEBP_ERROR,
    );
  if (
    metadata.width > MAX_IMAGE_EDITOR_SIDE ||
    metadata.height > MAX_IMAGE_EDITOR_SIDE ||
    metadata.width * metadata.height > MAX_IMAGE_EDITOR_PIXELS
  )
    fail(IMAGE_EDITOR_DIMENSIONS_TOO_LARGE_ERROR);
  return metadata;
}

export async function readBoundedImageEditorResponse(
  response: Response,
  signal?: AbortSignal,
): Promise<Blob> {
  const contentLength = Number(response.headers.get('Content-Length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_IMAGE_EDITOR_SOURCE_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // Best-effort stop of the response body.
    }
    fail(IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR);
  }
  if (!response.body) fail();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_IMAGE_EDITOR_SOURCE_BYTES) {
        try {
          await reader.cancel();
        } catch {
          // Best-effort stop of the response body.
        }
        fail(IMAGE_EDITOR_SOURCE_TOO_LARGE_ERROR);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(
    chunks.map(
      (chunk) =>
        chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength) as ArrayBuffer,
    ),
    { type: response.headers.get('Content-Type') ?? '' },
  );
}
