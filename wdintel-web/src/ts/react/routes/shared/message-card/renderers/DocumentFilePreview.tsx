import { useCallback } from 'react';
import { Box } from '@mui/material';

import type {
  FilePreviewLifecycleProps,
  FilePreviewSource,
} from '../attachment-preview/file-preview-source';
import { FilePreviewRenderError } from '../attachment-preview/file-preview-source';
import { HttpRequestError } from '../../../../services/api/client';
import { formatCsvPreviewErrorMessage } from '../csv/csv-preview-utils';
import { formatXlsxPreviewErrorMessage } from '../xlsx/xlsx-preview-utils';
import { formatLegacyOfficePreviewError } from '../legacy-office/legacy-office-errors';
import { getDocumentFileKind } from '../document-file-kind';
import { getDocumentPreviewCapabilities } from '../document-preview-capabilities';
import type { MessageCardDocumentKind } from '../document-preview.types';
import {
  formatTextPreviewErrorMessage,
  MarkdownDocumentPreview,
  TxtDocumentPreview,
} from '../text-document-preview';
import { CsvDocumentPreview } from './CsvDocumentPreview';
import { DocxDocumentPreview, formatDocxPreviewErrorMessage } from './DocxDocumentPreview';
import { LegacyOfficeDocumentPreview } from './LegacyOfficeDocumentPreview';
import { PdfDocumentPreview, formatPdfPreviewErrorMessage } from './PdfDocumentPreview';
import { UnsupportedDocumentPreview } from './UnsupportedDocumentPreview';
import { XlsxDocumentPreview } from './XlsxDocumentPreview';

export function DocumentFilePreview({
  source,
  zoom = 100,
  lifecycle,
  kind = getDocumentFileKind(source),
}: {
  source: FilePreviewSource;
  zoom?: number;
  lifecycle?: FilePreviewLifecycleProps;
  kind?: MessageCardDocumentKind;
}) {
  const onError = lifecycle?.onError;
  const isCurrent = lifecycle?.isCurrent;
  const signal = lifecycle?.signal;
  const reportError = useCallback(
    (error: unknown) => {
      if (signal?.aborted || isCurrent?.() === false) return;
      if (error instanceof HttpRequestError) {
        onError?.(error);
        return;
      }
      const details = error instanceof Error ? error.message : null;
      const message =
        kind === 'txt' || kind === 'md'
          ? formatTextPreviewErrorMessage(kind === 'txt' ? 'TXT' : 'Markdown', details)
          : kind === 'doc' || kind === 'xls'
            ? formatLegacyOfficePreviewError(details, kind === 'doc' ? 'DOC' : 'XLS')
            : kind === 'xlsx'
              ? formatXlsxPreviewErrorMessage(details)
              : kind === 'csv'
                ? formatCsvPreviewErrorMessage(details)
                : kind === 'docx'
                  ? formatDocxPreviewErrorMessage(details)
                  : formatPdfPreviewErrorMessage(details);
      const copy =
        message === details && !/[А-Яа-яІіЇїЄєҐґ]/.test(message)
          ? `Не вдалося відкрити файл ${kind.toUpperCase()}. Скачайте оригінал.`
          : message;
      onError?.(new FilePreviewRenderError(copy, /timeout|час|очікування/i.test(details ?? '')));
    },
    [signal, isCurrent, onError, kind],
  );
  const props = {
    href: source.originalHref,
    sizeBytes: source.sizeBytes,
    zoom: getDocumentPreviewCapabilities(kind).zoomable ? zoom : 100,
    signal,
    onError: onError ? reportError : undefined,
  };

  return (
    <Box
      key={`${source.key}:${kind}`}
      data-document-preview-content
      sx={{ flex: '1 1 auto', minHeight: 0, width: '100%', height: '100%' }}
    >
      {kind === 'pdf' ? (
        <PdfDocumentPreview {...props} />
      ) : kind === 'doc' || kind === 'xls' ? (
        <LegacyOfficeDocumentPreview {...props} kind={kind} />
      ) : kind === 'docx' ? (
        <DocxDocumentPreview {...props} />
      ) : kind === 'xlsx' ? (
        <XlsxDocumentPreview {...props} />
      ) : kind === 'csv' ? (
        <CsvDocumentPreview {...props} contentType={source.contentType} />
      ) : kind === 'txt' ? (
        <TxtDocumentPreview {...props} />
      ) : kind === 'md' ? (
        <MarkdownDocumentPreview {...props} />
      ) : (
        <UnsupportedDocumentPreview fileName={source.fileName || source.originalHref} />
      )}
    </Box>
  );
}
