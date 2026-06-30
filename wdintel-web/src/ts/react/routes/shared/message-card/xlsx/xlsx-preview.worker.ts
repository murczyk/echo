import { buildXlsxPreview, XlsxPreviewError } from './xlsx-preview-utils';

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
    const value = await buildXlsxPreview(request.buffer);
    const response: XlsxPreviewResponse = { requestId, ok: true, value };
    self.postMessage(response);
  } catch (error) {
    const response: XlsxPreviewResponse = {
      requestId,
      ok: false,
      error: error instanceof XlsxPreviewError ? error.code : 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE',
    };
    self.postMessage(response);
  }
});
