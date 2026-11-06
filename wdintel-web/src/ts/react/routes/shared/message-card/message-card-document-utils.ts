import type { InboxMessage, MessageMediaInfo } from '../../../../../Bindings';
import { mediaAttachmentContentType } from './MessageCardMedia';
import { deriveFileNameFromHref, sanitizeDerivedFileName } from './message-card-image-utils';
import type { MessageCardDocument, MessageCardDocumentKind } from './document-preview.types';
import { getDocumentMetadataKind } from './document-file-kind';

export { getDocumentFileKind } from './document-file-kind';

type MessageMediaInfoRaw = MessageMediaInfo & {
  content_type?: string | null;
  file_name?: string | null;
};

const DOCUMENT_DOWNLOAD_EXTENSION_RE = /\.(pdf|docx?|xlsx?|csv|zip)(\?|#|$)/i;
const LEGACY_WORD_CONTENT_TYPES = new Set(['application/msword']);
const LEGACY_SPREADSHEET_CONTENT_TYPES = new Set(['application/vnd.ms-excel']);

function mediaAttachmentDisplayName(m: MessageMediaInfo): string {
  const raw = m as MessageMediaInfoRaw;
  const s = (m.fileName ?? raw.file_name ?? '').trim();
  if (s !== '') return s;
  return '';
}

function resolveMediaFileName(m: MessageMediaInfo, fallbackName: string): string {
  const fileName = mediaAttachmentDisplayName(m);
  if (fileName !== '') return sanitizeDerivedFileName(fileName, fallbackName);
  return deriveFileNameFromHref(String(m.href ?? ''), fallbackName);
}

export function getDocumentKind(m: MessageMediaInfo): MessageCardDocumentKind {
  return getDocumentMetadataKind({
    contentType: mediaAttachmentContentType(m),
    fileName: mediaAttachmentDisplayName(m),
    href: String(m.href ?? ''),
  });
}

export function isPdfAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'pdf';
}

export function isDocxAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'docx';
}

export function isDocAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'doc';
}

export function isXlsxAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'xlsx';
}

export function isXlsAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'xls';
}

export function isCsvAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'csv';
}

export function isTxtAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'txt';
}

export function isMarkdownAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) === 'md';
}

export function isDocumentPreviewAttachment(m: MessageMediaInfo): boolean {
  return getDocumentKind(m) !== 'unsupported';
}

export function collectMessageDocuments(msg: Pick<InboxMessage, 'media'>): MessageCardDocument[] {
  const documentsByHref = new Map<string, MessageCardDocument>();

  const add = (document: MessageCardDocument) => {
    const href = document.href.trim();
    if (href === '') return;
    const existing = documentsByHref.get(href);
    documentsByHref.set(
      href,
      existing == null ? { ...document, href } : { ...existing, ...document, href },
    );
  };

  for (const attachment of msg.media ?? []) {
    const kind = getDocumentKind(attachment);
    if (kind === 'unsupported' && !isRecognizedDocumentAttachment(attachment)) continue;

    const index = documentsByHref.size;
    add({
      id: attachment.id ?? null,
      href: String(attachment.href ?? ''),
      fileName: resolveMediaFileName(attachment, `document-${index + 1}`),
      sizeBytes: attachment.sizeBytes ?? null,
      contentType: attachment.contentType ?? null,
      kind,
      ocr: attachment.ocr ?? null,
      summary: attachment.summary ?? null,
    });
  }

  return Array.from(documentsByHref.values());
}

function isRecognizedDocumentAttachment(m: MessageMediaInfo): boolean {
  return (
    DOCUMENT_DOWNLOAD_EXTENSION_RE.test(String(m.href ?? '').toLowerCase()) ||
    isLegacyWordAttachment(m) ||
    isLegacySpreadsheetAttachment(m)
  );
}

function isLegacyWordAttachment(m: MessageMediaInfo): boolean {
  const fileName = mediaAttachmentDisplayName(m).toLowerCase();
  const href = String(m.href ?? '').toLowerCase();
  const contentType = mediaAttachmentContentType(m);

  return (
    LEGACY_WORD_CONTENT_TYPES.has(contentType) ||
    fileName.endsWith('.doc') ||
    /\.doc(\?|#|$)/i.test(href)
  );
}

function isLegacySpreadsheetAttachment(m: MessageMediaInfo): boolean {
  const fileName = mediaAttachmentDisplayName(m).toLowerCase();
  const href = String(m.href ?? '').toLowerCase();
  const contentType = mediaAttachmentContentType(m);

  return (
    LEGACY_SPREADSHEET_CONTENT_TYPES.has(contentType) ||
    fileName.endsWith('.xls') ||
    /\.xls(\?|#|$)/i.test(href)
  );
}

export function deriveDocumentFileName(document: MessageCardDocument, index: number): string {
  const fallbackName = `document-${index + 1}`;
  const fileName = document.fileName?.trim() ?? '';
  if (fileName !== '') return sanitizeDerivedFileName(fileName, fallbackName);
  return deriveFileNameFromHref(document.href, fallbackName);
}

export function deriveDocumentDownloadName(document: MessageCardDocument, index: number): string {
  const fallbackName = `document-${index + 1}`;
  return sanitizeDerivedFileName(deriveDocumentFileName(document, index), fallbackName);
}
