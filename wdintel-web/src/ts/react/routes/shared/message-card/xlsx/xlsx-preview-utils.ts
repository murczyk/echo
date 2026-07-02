import readXlsxFile from 'read-excel-file/web-worker';
import { extractWorkbookSheetNames } from './xlsx-preview-metadata';

// read-excel-file's runtime parser supports options.sheets and filters sheet
// IDs before parseSheet(), but the package typings omit that option. Keep this
// local typed wrapper so MAX_XLSX_SHEETS is enforced before sheet XML parsing.
type ReadXlsxFileWithRuntimeSheetsOption = (
  input: ArrayBuffer,
  options?: {
    sheets?: Array<number | string>;
  },
) => Promise<Array<{ sheet: string; data: unknown[][] }>>;

const readXlsxFileWithRuntimeSheetsOption =
  readXlsxFile as unknown as ReadXlsxFileWithRuntimeSheetsOption;

// `read-excel-file` does not support row-range parsing, so the file-size cap
// plus worker isolation are the primary DoS mitigations for previewing.
export const MAX_XLSX_FILE_MB = 10;
export const MAX_XLSX_FILE_BYTES = MAX_XLSX_FILE_MB * 1024 * 1024;
export const MAX_XLSX_SHEETS = 20;
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
  'XLSX_FILE_TOO_LARGE' | 'XLSX_MALFORMED_WORKBOOK' | 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE';

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

export function previewXlsxRows(
  rawRows: unknown[][],
): Pick<XlsxPreviewSheet, 'rows' | 'rowCount' | 'columnCount' | 'truncated'> {
  const rowCount = rawRows.length;
  const rawColumnCount = rawRows.reduce((max, row) => Math.max(max, row.length), 0);
  const rows = rawRows
    .slice(0, MAX_XLSX_ROWS)
    .map((row) => row.slice(0, MAX_XLSX_COLUMNS).map(normalizeCellValue));

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
    return await buildXlsxPreviewFromWorkbook(buffer, sheetNames);
  } catch (error) {
    throw error;
  }
}

async function buildXlsxPreviewFromWorkbook(
  buffer: ArrayBuffer,
  sheetNames: string[],
): Promise<XlsxPreviewResult> {
  // Use the workbook reader once with an explicit capped sheet list so the
  // archive and metadata are parsed a single time instead of per tab.
  // read-excel-file returns cached formula values; it does not evaluate formulas.
  const sheetsToRead =
    sheetNames.length > 0
      ? sheetNames.slice(0, MAX_XLSX_SHEETS)
      : Array.from({ length: MAX_XLSX_SHEETS }, (_, index) => index + 1);
  let sourceSheetCount: number | null = sheetNames.length > 0 ? sheetNames.length : null;

  let workbookSheets: Array<{ sheet: string; data: unknown[][] }>;
  try {
    workbookSheets = await readXlsxFileWithRuntimeSheetsOption(buffer, { sheets: sheetsToRead });
  } catch (error) {
    if (sheetNames.length === 0) {
      const availableSheetCount = parseAvailableSheetCount(error);
      if (availableSheetCount != null && availableSheetCount > 0) {
        sourceSheetCount = availableSheetCount;
        try {
          workbookSheets = await readXlsxFileWithRuntimeSheetsOption(buffer, {
            sheets: Array.from(
              { length: Math.min(availableSheetCount, MAX_XLSX_SHEETS) },
              (_, index) => index + 1,
            ),
          });
        } catch (retryError) {
          throw new XlsxPreviewError(
            classifyXlsxError(retryError),
            messageFromError(retryError, 'Не вдалося відкрити XLSX'),
          );
        }
      } else {
        throw new XlsxPreviewError(
          classifyXlsxError(error),
          messageFromError(error, 'Не вдалося відкрити XLSX'),
        );
      }
    } else {
      throw new XlsxPreviewError(
        classifyXlsxError(error),
        messageFromError(error, 'Не вдалося відкрити XLSX'),
      );
    }
  }

  if (
    sheetNames.length === 0 &&
    workbookSheets.length === MAX_XLSX_SHEETS &&
    sourceSheetCount == null
  ) {
    try {
      await readXlsxFileWithRuntimeSheetsOption(buffer, { sheets: [MAX_XLSX_SHEETS + 1] });
      sourceSheetCount = MAX_XLSX_SHEETS + 1;
    } catch {
      // Ignore probe failures. The first capped pass already produced a usable preview.
    }
  }

  const sheets = workbookSheets.map((currentSheet, index) => {
    const preview = previewXlsxRows(currentSheet.data);
    return {
      name:
        sheetNames.length > 0
          ? (currentSheet.sheet ?? sheetNames[index] ?? `Sheet ${index + 1}`)
          : `Sheet ${index + 1}`,
      rows: preview.rows,
      rowCount: preview.rowCount,
      columnCount: preview.columnCount,
      truncated: preview.truncated,
    };
  });

  if (sheets.length === 0) {
    throw new XlsxPreviewError(
      'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE',
      'XLSX workbook structure is unsupported',
    );
  }

  const previewLimitedBySheetCap = sourceSheetCount != null && sourceSheetCount > MAX_XLSX_SHEETS;

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

function classifyXlsxError(error: unknown): XlsxPreviewErrorCode {
  const message = error instanceof Error ? error.message.toLowerCase() : '';

  if (
    message.includes('invalid zip data') ||
    (message.includes('zip') && message.includes('invalid'))
  ) {
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

function parseAvailableSheetCount(error: unknown): number | null {
  const message = error instanceof Error ? error.message : '';
  const match = message.match(/available sheets count:\s*(\d+)/i);
  if (match == null) return null;

  const count = Number.parseInt(match[1] ?? '', 10);
  return Number.isFinite(count) ? count : null;
}

function messageFromError(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message.trim() !== '' ? error.message : fallbackMessage;
}
