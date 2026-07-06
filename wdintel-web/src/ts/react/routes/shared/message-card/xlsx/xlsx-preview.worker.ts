import { buildXlsxPreview, XlsxPreviewError } from './xlsx-preview-utils';
import { debugDocumentPreview } from '../document-preview-debug';

type XlsxPreviewRequest = {
  requestId: string;
  request: {
    buffer: ArrayBuffer;
  };
};

type XlsxPreviewResponse = {
  requestId: string;
  ok: boolean;
  value?: {
    sheets: Array<{
      name: string;
      rows: string[][];
      rowCount: number;
      columnCount: number;
      truncated: boolean;
    }>;
  };
  error?: string;
};

self.addEventListener('message', async (event: MessageEvent<XlsxPreviewRequest>) => {
  const { requestId, request } = event.data;

  try {
    debugDocumentPreview('xlsx-worker', 'start', {
      requestId,
      bufferByteLength: request.buffer.byteLength,
    });
    const value = await buildXlsxPreview(request.buffer);
    debugDocumentPreview('xlsx-worker', 'success', {
      requestId,
      sheetCount: value.sheets.length,
    });
    const response: XlsxPreviewResponse = { requestId, ok: true, value };
    self.postMessage(response);
  } catch (error) {
    debugDocumentPreview(
      'xlsx-worker',
      'failed',
      {
        requestId,
        code: error instanceof XlsxPreviewError ? error.code : null,
        message: error instanceof Error ? error.message : String(error),
        rawError: error,
      },
      'error',
    );
    const response: XlsxPreviewResponse = {
      requestId,
      ok: false,
      error: error instanceof XlsxPreviewError ? error.code : 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE',
    };
    self.postMessage(response);
  }
});
