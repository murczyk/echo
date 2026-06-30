import { readSheet } from 'read-excel-file/web-worker';
import { extractWorkbookSheetNames } from './xlsx-preview-metadata';

// `read-excel-file` does not support row-range parsing, so the file-size cap
// plus worker isolation are the primary DoS mitigations for previewing.
export const MAX_XLSX_FILE_MB = 10;
export const MAX_XLSX_FILE_BYTES = MAX_XLSX_FILE_MB * 1024 * 1024;
export const MAX_XLSX_SHEETS = 10;
export const MAX_XLSX_ROWS = 5000;
export const MAX_XLSX_COLUMNS = 100;

export type XlsxPreviewSheet = {
  name: string;
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

export type XlsxPreviewResult = {
  sheets: XlsxPreviewSheet[];
};

export type XlsxPreviewErrorCode =
  | 'XLSX_FILE_TOO_LARGE'
  | 'XLSX_MALFORMED_WORKBOOK'
  | 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE';

export class XlsxPreviewError extends Error {
  constructor(
    public readonly code: XlsxPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'XlsxPreviewError';
  }
}

export function formatXlsxPreviewErrorMessage(error: string | null): string {
  switch (error) {
    case 'XLSX_FILE_TOO_LARGE':
      return `Файл XLSX завеликий для попереднього перегляду. Максимум: ${MAX_XLSX_FILE_MB} МБ.`;
    case 'XLSX_MALFORMED_WORKBOOK':
      return 'Не вдалося відкрити XLSX: файл пошкоджено.';
    case 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE':
      return 'Не вдалося відкрити XLSX: структура книги не підтримується.';
    default:
      return error ?? 'XLSX недоступний';
  }
}

export function previewXlsxRows(rawRows: unknown[][]): Pick<
  XlsxPreviewSheet,
  'rows' | 'rowCount' | 'columnCount' | 'truncated'
> {
  const rowCount = rawRows.length;
  const rawColumnCount = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = rawRows.slice(0, MAX_XLSX_ROWS).map((row) => row.slice(0, MAX_XLSX_COLUMNS).map(normalizeCellValue));

  return {
    rows,
    rowCount,
    columnCount: rawColumnCount,
    truncated: rowCount > MAX_XLSX_ROWS || rawColumnCount > MAX_XLSX_COLUMNS,
  };
}

export async function buildXlsxPreview(buffer: ArrayBuffer): Promise<XlsxPreviewResult> {
  if (buffer.byteLength > MAX_XLSX_FILE_BYTES) {
    throw new XlsxPreviewError('XLSX_FILE_TOO_LARGE', 'XLSX file is too large');
  }

  try {
    const sheetNames = extractWorkbookSheetNames(buffer);
    return await buildXlsxPreviewFromIndexedSheets(buffer, sheetNames);
  } catch (error) {
    throw error;
  }
}

async function buildXlsxPreviewFromIndexedSheets(
  buffer: ArrayBuffer,
  sheetNames: string[],
): Promise<XlsxPreviewResult> {
  const sheets: XlsxPreviewSheet[] = [];

  for (let sheetIndex = 1; sheetIndex <= MAX_XLSX_SHEETS; sheetIndex += 1) {
    try {
      const rows = await readSheet(buffer, sheetIndex);
      const preview = previewXlsxRows(rows);
      sheets.push({
        name: sheetNames[sheetIndex - 1] ?? `Sheet ${sheetIndex}`,
        rows: preview.rows,
        rowCount: preview.rowCount,
        columnCount: preview.columnCount,
        truncated: preview.truncated,
      });
    } catch (error) {
      if (isOutOfBoundsSheetError(error)) {
        break;
      }
      throw new XlsxPreviewError(classifyXlsxError(error), messageFromError(error, 'Не вдалося відкрити XLSX'));
    }
  }

  if (sheets.length === 0) {
    throw new XlsxPreviewError('XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE', 'XLSX workbook structure is unsupported');
  }

  const previewLimitedBySheetCap =
    sheetNames.length > MAX_XLSX_SHEETS ||
    (sheetNames.length === 0 && sheets.length === MAX_XLSX_SHEETS);

  return {
    sheets: sheets.map((sheet) => ({
      ...sheet,
      truncated: sheet.truncated || previewLimitedBySheetCap,
    })),
  };
}

function normalizeCellValue(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

function isOutOfBoundsSheetError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('sheet number out of bounds');
}

function classifyXlsxError(error: unknown): XlsxPreviewErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (message.includes('invalid zip data') || (message.includes('zip') && message.includes('invalid'))) {
    return 'XLSX_MALFORMED_WORKBOOK';
  }

  if (
    message.includes('missing') ||
    message.includes('not found') ||
    message.includes('structure') ||
    message.includes('sheet') ||
    message.includes('worksheet') ||
    message.includes('workbook') ||
    message.includes('rels') ||
    message.includes('xml')
  ) {
    return 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE';
  }

  return 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE';
}

function messageFromError(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallbackMessage;
}
