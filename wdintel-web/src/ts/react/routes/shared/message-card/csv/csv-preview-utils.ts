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
  let retainedRow: string[] = [];
  let rowCount = 0;
  let currentColumnCount = 0;
  let columnCount = 0;
  let cell = '';
  let hasCellContent = false;
  let quoted = false;
  let afterQuote = false;
  let rowStarted = false;

  const finishCell = () => {
    currentColumnCount += 1;
    if (
      rowCount < MAX_DOCUMENT_PREVIEW_ROWS &&
      currentColumnCount <= MAX_DOCUMENT_PREVIEW_COLUMNS
    ) {
      retainedRow.push(cell);
    }
    cell = '';
    hasCellContent = false;
  };

  const finishRow = () => {
    finishCell();
    columnCount = Math.max(columnCount, currentColumnCount);
    if (rowCount < MAX_DOCUMENT_PREVIEW_ROWS) rows.push(retainedRow);
    rowCount += 1;
    retainedRow = [];
    currentColumnCount = 0;
    rowStarted = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          if (
            rowCount < MAX_DOCUMENT_PREVIEW_ROWS &&
            currentColumnCount < MAX_DOCUMENT_PREVIEW_COLUMNS
          ) {
            cell += '"';
          }
          index += 1;
        } else {
          quoted = false;
          afterQuote = true;
        }
      } else {
        if (
          rowCount < MAX_DOCUMENT_PREVIEW_ROWS &&
          currentColumnCount < MAX_DOCUMENT_PREVIEW_COLUMNS
        ) {
          cell += character;
        }
      }
      continue;
    }

    if (afterQuote) {
      if (character === delimiter) {
        finishCell();
        rowStarted = true;
        afterQuote = false;
      } else if (character === '\r' || character === '\n') {
        finishRow();
        afterQuote = false;
        if (character === '\r' && text[index + 1] === '\n') index += 1;
      } else if (character !== ' ' && character !== '\t') {
        throw new CsvPreviewError('CSV_MALFORMED', 'Unexpected character after quoted CSV field');
      }
      continue;
    }

    if (character === '"') {
      if (hasCellContent) throw new CsvPreviewError('CSV_MALFORMED', 'Invalid quoted field');
      quoted = true;
      rowStarted = true;
    } else if (character === delimiter) {
      finishCell();
      rowStarted = true;
    } else if (character === '\r' || character === '\n') {
      finishRow();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      if (
        rowCount < MAX_DOCUMENT_PREVIEW_ROWS &&
        currentColumnCount < MAX_DOCUMENT_PREVIEW_COLUMNS
      ) {
        cell += character;
      }
      if (character.trim() !== '') hasCellContent = true;
      rowStarted = true;
    }
  }

  if (quoted) throw new CsvPreviewError('CSV_MALFORMED', 'Unclosed quoted CSV field');
  if (rowStarted || afterQuote) finishRow();
  return {
    rows,
    rowCount,
    columnCount,
    truncated: rowCount > MAX_DOCUMENT_PREVIEW_ROWS || columnCount > MAX_DOCUMENT_PREVIEW_COLUMNS,
  };
}

export function detectCsvDelimiter(text: string): ',' | ';' | '\t' | '|' {
  const candidates = [',', ';', '\t', '|'] as const;
  let bestIndex = 0;
  let bestScore: DelimiterScore = {
    consistentRecordCount: 0,
    decimalCommaCellCount: 0,
  };
  for (let index = 0; index < candidates.length; index += 1) {
    const score = scoreDelimiter(text, candidates[index]);
    if (isBetterDelimiterScore(score, bestScore)) {
      bestIndex = index;
      bestScore = score;
    }
  }
  return candidates[bestIndex];
}

type DelimiterScore = {
  consistentRecordCount: number;
  decimalCommaCellCount: number;
};

function scoreDelimiter(text: string, delimiter: string): DelimiterScore {
  const fieldCounts: number[] = [];
  let recordFieldCount = 1;
  let recordCount = 0;
  let decimalState: DecimalState = 'start';
  let decimalCommaCellCount = 0;
  let quoted = false;
  let recordStarted = false;

  const finishField = (isCandidateDelimiter: boolean) => {
    if (decimalState === 'fraction') decimalCommaCellCount += 1;
    decimalState = 'start';
    if (isCandidateDelimiter) recordFieldCount += 1;
  };

  const finishRecord = () => {
    finishField(false);
    if (fieldCounts.length < 10) fieldCounts.push(recordFieldCount);
    recordCount += 1;
    recordFieldCount = 1;
    recordStarted = false;
  };

  for (let index = 0; index < text.length && recordCount < 10; index += 1) {
    const character = text[index];
    if (character === '"') {
      if (quoted && text[index + 1] === '"') {
        decimalState = updateDecimalState(decimalState, '"');
        index += 1;
      } else {
        quoted = !quoted;
      }
      recordStarted = true;
    } else if (!quoted && character === delimiter) {
      finishField(true);
      recordStarted = true;
    } else if (!quoted && (character === '\n' || character === '\r')) {
      finishRecord();
      if (character === '\r' && text[index + 1] === '\n') index += 1;
    } else {
      decimalState = updateDecimalState(decimalState, character);
      recordStarted = true;
    }
  }

  if (recordCount < 10 && recordStarted) finishRecord();

  const frequencies = new Map<number, number>();
  for (const fieldCount of fieldCounts) {
    if (fieldCount <= 1) continue;
    frequencies.set(fieldCount, (frequencies.get(fieldCount) ?? 0) + 1);
  }
  const consistentRecordCount = Math.max(0, ...frequencies.values());
  return {
    consistentRecordCount,
    decimalCommaCellCount,
  };
}

type DecimalState = 'start' | 'minus' | 'integer' | 'comma' | 'fraction' | 'invalid';

function updateDecimalState(state: DecimalState, character: string): DecimalState {
  if (state === 'invalid') return state;
  const isDigit = character >= '0' && character <= '9';
  if (state === 'start') return character === '-' ? 'minus' : isDigit ? 'integer' : 'invalid';
  if (state === 'minus') return isDigit ? 'integer' : 'invalid';
  if (state === 'integer') {
    if (isDigit) return state;
    return character === ',' ? 'comma' : 'invalid';
  }
  if (state === 'comma') return isDigit ? 'fraction' : 'invalid';
  return isDigit ? 'fraction' : 'invalid';
}

function isBetterDelimiterScore(candidate: DelimiterScore, current: DelimiterScore): boolean {
  if (candidate.consistentRecordCount !== current.consistentRecordCount) {
    return candidate.consistentRecordCount > current.consistentRecordCount;
  }
  return candidate.decimalCommaCellCount > current.decimalCommaCellCount;
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
