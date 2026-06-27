import * as XLSX from 'xlsx';

const MAX_ROWS = 5000;
const MAX_COLUMNS = 100;

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

function normalizeCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

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
      const rowCount = rawRows.length;
      const slicedRows = rawRows.slice(0, MAX_ROWS).map((row) => row.slice(0, MAX_COLUMNS).map(normalizeCellValue));
      const columnCount = slicedRows.reduce((max, row) => Math.max(max, row.length), 0);

      return {
        name,
        rows: slicedRows,
        rowCount,
        columnCount,
        truncated: rowCount > MAX_ROWS || columnCount > MAX_COLUMNS,
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

