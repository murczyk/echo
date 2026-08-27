const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function normalizedEditableImageMimeType(
  contentType?: string | null,
  fileName?: string | null,
) {
  const mimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  if (SUPPORTED_MIME_TYPES.has(mimeType)) return mimeType;
  if (mimeType !== '' && mimeType !== 'application/octet-stream') return null;
  const name = fileName?.trim().toLowerCase() ?? '';
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
  if (name.endsWith('.png')) return 'image/png';
  if (name.endsWith('.webp')) return 'image/webp';
  return null;
}

export function isSupportedEditableImage(contentType?: string | null, fileName?: string | null) {
  return normalizedEditableImageMimeType(contentType, fileName) !== null;
}
