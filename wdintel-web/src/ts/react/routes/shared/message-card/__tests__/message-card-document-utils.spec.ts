/**
 * @vitest-environment happy-dom
 */
// @test-scope parser: document attachment type, MIME-parameter, and filename derivation fixtures
import { describe, expect, it } from 'vitest';

import type { InboxMessage, MessageMediaInfo } from '../../../../../../Bindings';
import {
  collectMessageDocuments,
  deriveDocumentDownloadName,
  deriveDocumentFileName,
  isMarkdownAttachment,
  isDocxAttachment,
  isDocumentPreviewAttachment,
  isPdfAttachment,
  isTxtAttachment,
  isXlsxAttachment,
  isCsvAttachment,
} from '../message-card-document-utils';

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
      isCsvAttachment({
        href: 'https://example.test/report',
        contentType: 'text/csv; charset=utf-8',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isCsvAttachment({
        href: 'https://example.test/report.csv?download=1',
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
      isXlsxAttachment({
        href: 'https://example.test/report.xls',
        contentType: 'application/vnd.ms-excel',
      } as MessageMediaInfo),
    ).toBe(false);
    expect(
      isDocumentPreviewAttachment({
        href: 'https://example.test/report.txt',
        contentType: 'text/plain',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isTxtAttachment({
        href: 'https://example.test/report.txt?download=1',
        contentType: 'application/octet-stream',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isMarkdownAttachment({
        href: 'https://example.test/report.markdown',
        contentType: 'text/x-markdown',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isPdfAttachment({
        href: 'https://example.test/report',
        contentType: 'application/pdf; charset=utf-8',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isDocxAttachment({
        href: 'https://example.test/report',
        contentType:
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document; charset=utf-8',
      } as MessageMediaInfo),
    ).toBe(true);
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
        {
          id: 'xls-1',
          href: 'https://example.test/files/legacy.xls',
          contentType: 'application/vnd.ms-excel',
          fileName: 'legacy.xls',
          sizeBytes: 4096,
        },
        {
          id: 'txt-1',
          href: 'https://example.test/files/notes.txt',
          contentType: 'text/plain',
          fileName: 'notes.txt',
          sizeBytes: 512,
        },
        {
          id: 'md-1',
          href: 'https://example.test/files/readme.markdown',
          contentType: 'text/markdown',
          fileName: 'readme.markdown',
          sizeBytes: 256,
        },
        {
          id: 'csv-1',
          href: 'https://example.test/files/data.csv',
          contentType: 'text/csv; charset=utf-8',
          fileName: 'data.csv',
          sizeBytes: 128,
        },
      ] as InboxMessage['media'],
    } as InboxMessage;

    const documents = collectMessageDocuments(msg);

    expect(documents).toHaveLength(6);
    expect(deriveDocumentFileName(documents[0]!, 0)).toBe('report.pdf');
    expect(deriveDocumentDownloadName(documents[1]!, 1)).toBe('sheet.xlsx');
    expect(documents[2]?.kind).toBe('unsupported');
    expect(documents[3]?.kind).toBe('txt');
    expect(documents[4]?.kind).toBe('md');
    expect(documents[5]?.kind).toBe('csv');
    expect(documents.map((document) => document.kind)).toEqual([
      'pdf',
      'xlsx',
      'unsupported',
      'txt',
      'md',
      'csv',
    ]);
  });

  it('recognizes extensionless attachments from parameterized MIME types', () => {
    expect(
      isTxtAttachment({
        href: 'https://example.test/files/plain',
        contentType: 'text/plain; charset=utf-8',
      } as MessageMediaInfo),
    ).toBe(true);
    expect(
      isMarkdownAttachment({
        href: 'https://example.test/files/markdown',
        contentType: 'text/markdown; charset=utf-8',
      } as MessageMediaInfo),
    ).toBe(true);

    const msg = {
      media: [
        {
          id: 'txt-1',
          href: 'https://example.test/files/plain',
          contentType: 'text/plain; charset=utf-8',
          sizeBytes: 128,
        },
        {
          id: 'md-1',
          href: 'https://example.test/files/markdown',
          contentType: 'text/markdown; charset=utf-8',
          sizeBytes: 256,
        },
        {
          id: 'pdf-1',
          href: 'https://example.test/files/report',
          contentType: 'application/pdf; charset=utf-8',
          sizeBytes: 512,
        },
      ] as InboxMessage['media'],
    } as InboxMessage;

    const documents = collectMessageDocuments(msg);

    expect(documents.map((document) => document.kind)).toEqual(['txt', 'md', 'pdf']);
  });
});
