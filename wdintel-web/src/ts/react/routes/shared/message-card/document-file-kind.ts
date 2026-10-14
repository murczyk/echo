import { normalizeFilePreviewMetadata } from './attachment-preview/file-preview-source';
import type { MessageCardDocumentKind } from './document-preview.types';

const ZIP_CONTENT_TYPES = new Set([
  'application/zip',
  'application/x-zip-compressed',
  'application/x-zip',
]);

export function getDocumentFileKind(metadata: {
  fileName: string;
  extension?: string | null;
  contentType?: string | null;
}): MessageCardDocumentKind {
  return getDocumentMetadataKind(normalizeFilePreviewMetadata(metadata));
}

export function getDocumentMetadataKind({
  contentType,
  fileName,
  href = '',
  extension = '',
}: {
  contentType: string;
  fileName: string;
  href?: string;
  extension?: string;
}): MessageCardDocumentKind {
  const hasExtension = (suffix: string) =>
    fileName.toLowerCase().endsWith(`.${suffix}`) ||
    extension === suffix ||
    new RegExp(`\\.${suffix}(\\?|#|$)`, 'i').test(href);

  if (hasExtension('kmz')) return 'unsupported';
  if (ZIP_CONTENT_TYPES.has(contentType)) {
    if (hasExtension('docx')) return 'docx';
    if (hasExtension('xlsx')) return 'xlsx';
    return 'zip';
  }
  if (contentType === 'application/pdf' || hasExtension('pdf')) return 'pdf';
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    hasExtension('docx')
  )
    return 'docx';
  if (contentType === 'application/msword' || hasExtension('doc')) return 'doc';
  if (
    contentType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    hasExtension('xlsx')
  )
    return 'xlsx';
  if (contentType === 'application/vnd.ms-excel' || hasExtension('xls')) return 'xls';
  if (contentType === 'text/csv' || hasExtension('csv')) return 'csv';
  if (
    hasExtension('md') ||
    hasExtension('markdown') ||
    contentType === 'text/markdown' ||
    contentType === 'text/x-markdown'
  )
    return 'md';
  if (hasExtension('txt') || contentType === 'text/plain') return 'txt';
  if (hasExtension('zip')) return 'zip';
  return 'unsupported';
}
