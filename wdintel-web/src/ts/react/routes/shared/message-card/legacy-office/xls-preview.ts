import * as XLSX from './vendor/sheetjs/xlsx-0.20.3.mjs';

import { validateBiff8Workbook } from './biff8-validation';
import { validateCfbContainer } from './cfb-validation';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';
import {
  LEGACY_OFFICE_MAX_CELLS,
  LEGACY_OFFICE_MAX_COLUMNS,
  LEGACY_OFFICE_MAX_FILE_BYTES,
  LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
  LEGACY_OFFICE_MAX_ROWS,
  LEGACY_OFFICE_MAX_SHEETS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from './legacy-office-limits';
import type { XlsPreviewResult } from './legacy-office-preview.types';

type SheetCell = { w?: unknown; v?: unknown; t?: unknown };
type Sheet = Record<string, SheetCell | unknown> & { '!ref'?: string };
type Workbook = { SheetNames?: unknown; Sheets?: Record<string, Sheet> };

export function buildXlsPreview(
  buffer: ArrayBuffer,
  maxBytes = LEGACY_OFFICE_MAX_FILE_BYTES,
): XlsPreviewResult {
  if (buffer.byteLength > maxBytes) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.FileTooLarge);
  }
  const cfb = validateCfbContainer(buffer, maxBytes);
  if (
    cfb.streams.has('Book') ||
    cfb.streams.has('EncryptedPackage') ||
    cfb.streams.has('EncryptionInfo')
  ) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedVersion);
  }
  if (!cfb.streams.has('Workbook')) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  }
  validateBiff8Workbook(cfb.readStream('Workbook'));
  let workbook: Workbook;
  try {
    workbook = XLSX.read(buffer, {
      type: 'array',
      cellFormula: false,
      cellHTML: false,
      cellNF: false,
      cellStyles: false,
      bookDeps: false,
      bookFiles: false,
      bookVBA: false,
      dense: false,
    }) as Workbook;
  } catch {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.Malformed);
  }
  const names = workbook.SheetNames;
  if (
    !Array.isArray(names) ||
    names.length === 0 ||
    names.some((name) => typeof name !== 'string')
  ) {
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  }
  const sheets: XlsPreviewResult['sheets'] = [];
  let materializedSlots = 0;
  let emittedText = 0;
  let truncated = names.length > LEGACY_OFFICE_MAX_SHEETS;
  for (const name of names.slice(0, LEGACY_OFFICE_MAX_SHEETS)) {
    const sheet = workbook.Sheets?.[name];
    if (sheet == null || typeof sheet['!ref'] !== 'string') {
      sheets.push({ name, rows: [], rowCount: 0, columnCount: 0, truncated: false });
      continue;
    }
    let range: { s: { r: number; c: number }; e: { r: number; c: number } };
    try {
      range = XLSX.utils.decode_range(sheet['!ref']);
    } catch {
      throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.Malformed);
    }
    if (range.s.r < 0 || range.s.c < 0 || range.e.r < range.s.r || range.e.c < range.s.c) {
      throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.Malformed);
    }
    const rowCount = range.e.r + 1;
    const columnCount = range.e.c + 1;
    const keepRows = Math.min(rowCount, LEGACY_OFFICE_MAX_ROWS);
    const keepColumns = Math.min(columnCount, LEGACY_OFFICE_MAX_COLUMNS);
    const rows: string[][] = [];
    let sheetTruncated = rowCount > keepRows || columnCount > keepColumns;
    for (let row = 0; row < keepRows; row += 1) {
      const values: string[] = [];
      for (let column = 0; column < keepColumns; column += 1) {
        if (materializedSlots >= LEGACY_OFFICE_MAX_CELLS) {
          sheetTruncated = true;
          truncated = true;
          break;
        }
        const address = XLSX.utils.encode_cell({ r: row, c: column });
        const cell = sheet[address] as SheetCell | undefined;
        let text = cell?.w ?? cell?.v ?? '';
        if (typeof text === 'boolean') text = text ? 'TRUE' : 'FALSE';
        if (typeof text !== 'string' && typeof text !== 'number') text = '';
        let display = String(text);
        if (display.length > LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) {
          display = display.slice(0, LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS);
          sheetTruncated = true;
        }
        emittedText += display.length;
        if (emittedText > LEGACY_OFFICE_MAX_TEXT_CODE_UNITS) {
          sheetTruncated = true;
          truncated = true;
          break;
        }
        values.push(display);
        materializedSlots += 1;
      }
      rows.push(values);
      if (truncated) break;
    }
    sheets.push({ name, rows, rowCount, columnCount, truncated: sheetTruncated || truncated });
    if (truncated) break;
  }
  if (sheets.length === 0)
    throw new LegacyOfficePreviewError(LegacyOfficePreviewErrorCode.UnsupportedStructure);
  return { sheets, truncated };
}
