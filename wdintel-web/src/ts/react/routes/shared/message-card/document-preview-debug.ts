export const DOCUMENT_PREVIEW_DEBUG = false;

type DocumentPreviewDebugLevel = 'info' | 'warn' | 'error';

// Shared debug hook for document previews. XLSX currently uses it, but the
// scope stays reusable for later DOCX/PDF debugging.
export function debugDocumentPreview(
  scope: string,
  message: string,
  data?: unknown,
  level: DocumentPreviewDebugLevel = 'info',
): void {
  if (!DOCUMENT_PREVIEW_DEBUG) return;

  const logger = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  logger(`[document-preview:${scope}] ${message}`, data);
}
