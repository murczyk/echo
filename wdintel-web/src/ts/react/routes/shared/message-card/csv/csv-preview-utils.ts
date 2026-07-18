import { MAX_DOCUMENT_PREVIEW_COLUMNS, MAX_DOCUMENT_PREVIEW_ROWS } from '../document-grid-limits';

export const MAX_CSV_FILE_MB = 10;
export const MAX_CSV_FILE_BYTES = MAX_CSV_FILE_MB * 1024 * 1024;

export type CsvPreviewResult = {
  rows: string[][];
  rowCount: number;
  columnCount: number;
  truncated: boolean;
};

export type CsvPreviewErrorCode = 'CSV_FILE_TOO_LARGE' | 'CSV_FILE_BINARY' | 'CSV_MALFORMED';

export class CsvPreviewError extends Error {
  constructor(
    public readonly code: CsvPreviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CsvPreviewError';
  }
}

export function formatCsvPreviewErrorMessage(error: string | null): string {
  switch (error) {
    case 'CSV_FILE_TOO_LARGE':
      return `Файл CSV завеликий для попереднього перегляду. Максимум: ${MAX_CSV_FILE_MB} МБ.`;
    case 'CSV_FILE_BINARY':
      return 'Схоже, це не текстовий CSV-файл.';
    case 'CSV_MALFORMED':
      return 'Не вдалося відкрити CSV: файл має некоректний формат.';
    default:
      return error ?? 'CSV недоступний';
  }
}

export function parseCsvText(text: string): CsvPreviewResult {
  const delimiter = detectCsvDelimiter(text);
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  let afterQuote = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          cell += '"';
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        cell += character;
      }
      continue;
    }

    if (afterQuote) {
      if (character === delimiter) {
        row.push(cell);
        cell = '';
        afterQuote = false;
      } else if (character === '\r' || character === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
        afterQuote = false;
        if (character === '\r' && text[index + 1] === '\n') index += 1;
      } else if (character !== ' ' && character !== '\t') {
        throw new CsvPreviewError('CSV_MALFORMED', 'Unexpected character after quoted CSV field');
      }
      continue;
    }

    if (character === '"') {
      if (cell.trim() !== '') throw new CsvPreviewError('CSV_MALFORMED', 'Invalid quoted field');
      quoted = true;
    } else if (character === delimiter) {
      row.push(cell);
      cell = '';
    } else if (character === '\r' || character === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      cell += character;
    }
  }

  if (quoted) throw new CsvPreviewError('CSV_MALFORMED', 'Unclosed quoted CSV field');
  if (afterQuote || cell !== '' || row.length > 0 || text.endsWith(delimiter)) {
    row.push(cell);
    rows.push(row);
  }

  const columnCount = rows.reduce((max, currentRow) => Math.max(max, currentRow.length), 0);
  return {
    rows: rows
      .slice(0, MAX_DOCUMENT_PREVIEW_ROWS)
      .map((currentRow) => currentRow.slice(0, MAX_DOCUMENT_PREVIEW_COLUMNS)),
    rowCount: rows.length,
    columnCount,
    truncated:
      rows.length > MAX_DOCUMENT_PREVIEW_ROWS || columnCount > MAX_DOCUMENT_PREVIEW_COLUMNS,
  };
}

export function detectCsvDelimiter(text: string): ',' | ';' | '\t' | '|' {
  const candidates = [',', ';', '\t', '|'] as const;
  const counts = candidates.map((candidate) => countDelimiter(text, candidate));
  let bestIndex = 0;
  for (let index = 1; index < counts.length; index += 1) {
    if (counts[index] > counts[bestIndex]) bestIndex = index;
  }
  return candidates[bestIndex];
}

function countDelimiter(text: string, delimiter: string): number {
  let count = 0;
  let quoted = false;
  let records = 0;
  for (let index = 0; index < text.length && records < 10; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && character === delimiter) {
      count += 1;
    } else if (!quoted && (character === '\n' || character === '\r')) {
      records += 1;
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    }
  }
  return count;
}

export function decodeCsvBytes(bytes: Uint8Array, contentType: string | null): string {
  let encoding = 'utf-8';
  let offset = 0;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    offset = 2;
  } else if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    offset = 2;
  } else if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    offset = 3;
  } else {
    const charset = contentType?.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1]?.toLowerCase();
    if (charset === 'utf-16' || charset === 'utf16') encoding = 'utf-16le';
    else if (charset != null) {
      try {
        new TextDecoder(charset);
        encoding = charset;
      } catch {
        throw new CsvPreviewError('CSV_MALFORMED', 'Unsupported CSV character encoding');
      }
    }
  }
  return new TextDecoder(encoding).decode(bytes.subarray(offset)).replace(/^\uFEFF/, '');
}

export function isUtf16Csv(bytes: Uint8Array, contentType: string | null): boolean {
  if ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff)) {
    return true;
  }
  const charset = contentType?.match(/charset\s*=\s*"?([^";\s]+)"?/i)?.[1]?.toLowerCase();
  return charset === 'utf-16' || charset === 'utf-16le' || charset === 'utf-16be';
}

export function isProbablyBinaryCsv(bytes: Uint8Array): boolean {
  if (bytes.length === 0) return false;
  const sampleLength = Math.min(bytes.length, 4096);
  let controlCount = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    const byte = bytes[index] ?? 0;
    if (byte === 0) return true;
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) controlCount += 1;
  }
  return controlCount / sampleLength > 0.3;
}
