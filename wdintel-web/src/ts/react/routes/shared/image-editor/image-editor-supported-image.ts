const SUPPORTED_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export function normalizedEditableImageMimeType(
  contentType?: string | null,
  fileName?: string | null,
) {
  const rawMimeType = contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  const mimeType = rawMimeType === 'image/jpg' ? 'image/jpeg' : rawMimeType;
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
