import * as XLSX from 'xlsx';

import { previewXlsxRows } from './xlsx-preview-utils';

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
    const workbook = XLSX.read(new Uint8Array(request.buffer), {
      type: 'array',
      cellText: true,
      cellFormula: false,
      cellStyles: true,
    });

    const sheets = workbook.SheetNames.map((name) => {
      const sheet = workbook.Sheets[name];
      const rawRows = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: false, defval: '', blankrows: true });
      const { rows, rowCount, columnCount, truncated } = previewXlsxRows(rawRows);

      return {
        name,
        rows,
        rowCount,
        columnCount,
        truncated,
      };
    });

    const response: XlsxPreviewResponse = { requestId, ok: true, value: { sheets } };
    self.postMessage(response);
  } catch (error) {
    const response: XlsxPreviewResponse = {
      requestId,
      ok: false,
      error: error instanceof Error ? error.message : 'XLSX parsing failed',
    };
    self.postMessage(response);
  }
});
