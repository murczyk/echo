/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import type { InboxMessage, MessageMediaInfo } from '../../../../../Bindings';
import {
  collectMessageDocuments,
  deriveDocumentDownloadName,
  deriveDocumentFileName,
  isDocxAttachment,
  isDocumentPreviewAttachment,
  isPdfAttachment,
  isXlsxAttachment,
} from './message-card-document-utils';

describe('message-card document utils', () => {
  it('detects supported document attachments by MIME type and extension', () => {
    expect(
      isPdfAttachment({
        href: 'https://example.test/report',
        contentType: 'application/pdf',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isDocxAttachment({
        href: 'https://example.test/report.docx',
        contentType: 'application/octet-stream',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isXlsxAttachment({
        href: 'https://example.test/report.xlsx',
        contentType: 'application/octet-stream',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isDocumentPreviewAttachment({
        href: 'https://example.test/report.txt',
        contentType: 'text/plain',
      } as MessageMediaInfo),
    ).toBe(false);
  });

  it('collects supported documents and derives stable file names', () => {
    const msg = {
      media: [
        {
          id: 'pdf-1',
          href: 'https://example.test/files/report.pdf',
          contentType: 'application/pdf',
          fileName: 'report.pdf',
          sizeBytes: 1024,
        },
        {
          id: 'xlsx-1',
          href: 'https://example.test/files/sheet.xlsx',
          contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          fileName: 'sheet.xlsx',
          sizeBytes: 2048,
        },
      ] as InboxMessage['media'],
    } as InboxMessage;

    const documents = collectMessageDocuments(msg);

    expect(documents).toHaveLength(2);
    expect(deriveDocumentFileName(documents[0]!, 0)).toBe('report.pdf');
    expect(deriveDocumentDownloadName(documents[1]!, 1)).toBe('sheet.xlsx');
  });
});
