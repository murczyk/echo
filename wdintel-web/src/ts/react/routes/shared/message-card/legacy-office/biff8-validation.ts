import {
  LEGACY_OFFICE_MAX_CELLS,
  LEGACY_OFFICE_MAX_BIFF_FORMATS,
  LEGACY_OFFICE_MAX_BIFF_MERGES,
  LEGACY_OFFICE_MAX_BIFF_DRAWING_BYTES,
  LEGACY_OFFICE_MAX_BIFF_DRAWING_RECORDS,
  LEGACY_OFFICE_MAX_BIFF_RECORDS,
  LEGACY_OFFICE_MAX_BIFF_SHARED_STRINGS,
  LEGACY_OFFICE_MAX_COLUMNS,
  LEGACY_OFFICE_MAX_ROWS,
  LEGACY_OFFICE_MAX_SHEETS,
} from './legacy-office-limits';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';

const BOF = 0x0809;
const EOF = 0x000a;
const BOUNDSHEET = 0x0085;
const FILEPASS = 0x002f;
const DIMENSIONS = 0x0200;
const SST = 0x00fc;
const FORMAT = 0x041e;
const MERGEDCELLS = 0x00e5;
const OBJ = 0x005d;
const MSODRAWING = 0x00ec;
const MSODRAWINGGROUP = 0x00eb;
const CONTINUE = 0x003c;
const BOUNDSHEET_TYPE_WORKSHEET = 0x00;
const EXTERNNAME = 0x0023;
const SUPBOOK = 0x01ae;
const HLINK = 0x01b8;
const XF = 0x00e0;
const LABEL = 0x0204;
const NUMBER = 0x0203;
const BOOLERR = 0x0205;
const FORMULA = 0x0006;
const STRING = 0x0207;
const BLANK = 0x0201;
const MULBLANK = 0x00be;
const RK = 0x027e;
const MULRK = 0x00bd;
const LABELSST = 0x00fd;

type CellPosition = { row: number; column: number; count?: number };

function reject(code = LegacyOfficePreviewErrorCode.Malformed): never {
  throw new LegacyOfficePreviewError(code);
}

export function validateBiff8Workbook(workbook: Uint8Array): void {
  if (workbook.byteLength < 8) reject();
  const view = new DataView(workbook.buffer, workbook.byteOffset, workbook.byteLength);
  let offset = 0;
  let recordCount = 0;
  let sheetCount = 0;
  let formatCount = 0;
  let xfCount = 0;
  let mergeCount = 0;
  let storedCells = 0;
  let lastRecordType: number | null = null;
  let substream: 'workbook' | 'worksheet' | null = null;
  let drawingRecordCount = 0;
  let drawingBytes = 0;
  let drawingContinuationActive = false;
  let workbookGlobalsEnded = false;
  let sawWorkbookBof = false;
  const worksheetOffsets = new Set<number>();
  const declaredSheetOffsets = new Set<number>();
  const validateCell = ({ row, column, count = 1 }: CellPosition) => {
    if (
      row >= LEGACY_OFFICE_MAX_ROWS ||
      column >= LEGACY_OFFICE_MAX_COLUMNS ||
      count <= 0 ||
      column + count > LEGACY_OFFICE_MAX_COLUMNS
    ) {
      reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    storedCells += count;
    if (storedCells > LEGACY_OFFICE_MAX_CELLS) reject(LegacyOfficePreviewErrorCode.ResourceLimit);
  };
  while (offset < workbook.byteLength) {
    if (workbook.byteLength - offset < 4) {
      if (lastRecordType !== EOF || !workbook.subarray(offset).every((byte) => byte === 0))
        reject();
      break;
    }
    const type = view.getUint16(offset, true);
    const length = view.getUint16(offset + 2, true);
    const dataOffset = offset + 4;
    const end = dataOffset + length;
    if (end > workbook.byteLength || end < dataOffset) reject();
    if (type === 0 && length === 0 && lastRecordType === EOF) {
      if (!workbook.subarray(offset).every((byte) => byte === 0)) reject();
      break;
    }
    recordCount += 1;
    if (recordCount > LEGACY_OFFICE_MAX_BIFF_RECORDS)
      reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    if (offset === 0) {
      if (
        type !== BOF ||
        length < 4 ||
        view.getUint16(dataOffset, true) !== 0x0600 ||
        view.getUint16(dataOffset + 2, true) !== 0x0005
      ) {
        reject(LegacyOfficePreviewErrorCode.UnsupportedVersion);
      }
      sawWorkbookBof = true;
    }
    if (type === FILEPASS) reject(LegacyOfficePreviewErrorCode.Encrypted);
    const drawingRecord = type === OBJ || type === MSODRAWING || type === MSODRAWINGGROUP;
    const drawingContinuation = type === CONTINUE && drawingContinuationActive;
    if (drawingRecord || drawingContinuation) {
      if (
        (type === MSODRAWING && substream !== 'worksheet') ||
        (type === OBJ && substream !== 'worksheet') ||
        (type === MSODRAWINGGROUP && substream !== 'workbook') ||
        (type === OBJ &&
          (length < 10 ||
            view.getUint16(dataOffset, true) !== 0x0015 ||
            view.getUint16(dataOffset + 2, true) < 6 ||
            view.getUint16(dataOffset + 2, true) + 4 > length)) ||
        ((type === MSODRAWING || type === MSODRAWINGGROUP) && length < 8)
      )
        reject(LegacyOfficePreviewErrorCode.UnsupportedStructure);
      drawingRecordCount += 1;
      drawingBytes += length;
      if (
        drawingRecordCount > LEGACY_OFFICE_MAX_BIFF_DRAWING_RECORDS ||
        drawingBytes > LEGACY_OFFICE_MAX_BIFF_DRAWING_BYTES
      )
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    if (
      type === EXTERNNAME ||
      type === HLINK ||
      (type === SUPBOOK && (length < 4 || view.getUint16(dataOffset + 2, true) !== 0x0401))
    )
      reject(LegacyOfficePreviewErrorCode.UnsupportedStructure);
    if (type === BOUNDSHEET) {
      if (
        substream !== 'workbook' ||
        length < 8 ||
        view.getUint8(dataOffset + 5) !== BOUNDSHEET_TYPE_WORKSHEET
      )
        reject(LegacyOfficePreviewErrorCode.UnsupportedStructure);
      const sheetOffset = view.getUint32(dataOffset, true);
      const nameLength = view.getUint8(dataOffset + 6);
      const nameFlags = view.getUint8(dataOffset + 7);
      const characterBytes = nameLength * (nameFlags & 0x01 ? 2 : 1);
      if (
        sheetOffset >= workbook.byteLength ||
        8 + characterBytes > length ||
        nameLength > 255 ||
        declaredSheetOffsets.has(sheetOffset)
      )
        reject();
      declaredSheetOffsets.add(sheetOffset);
      sheetCount += 1;
      if (sheetCount > LEGACY_OFFICE_MAX_SHEETS) reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    if (type === SST) {
      if (
        length < 8 ||
        view.getUint32(dataOffset + 4, true) > LEGACY_OFFICE_MAX_BIFF_SHARED_STRINGS
      ) {
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
      }
    }
    if (type === FORMAT) {
      formatCount += 1;
      if (formatCount > LEGACY_OFFICE_MAX_BIFF_FORMATS)
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    if (type === XF) {
      xfCount += 1;
      if (xfCount > LEGACY_OFFICE_MAX_BIFF_FORMATS)
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    if (type === MERGEDCELLS) {
      if (length < 2) reject();
      mergeCount += view.getUint16(dataOffset, true);
      if (mergeCount > LEGACY_OFFICE_MAX_BIFF_MERGES)
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    if (type === DIMENSIONS) {
      if (length !== 14) reject();
      const firstRow = view.getUint32(dataOffset, true);
      const lastRow = view.getUint32(dataOffset + 4, true);
      const firstColumn = view.getUint16(dataOffset + 8, true);
      const lastColumn = view.getUint16(dataOffset + 10, true);
      if (
        firstRow > lastRow ||
        firstColumn > lastColumn ||
        lastRow > LEGACY_OFFICE_MAX_ROWS ||
        lastColumn > LEGACY_OFFICE_MAX_COLUMNS
      ) {
        reject(LegacyOfficePreviewErrorCode.ResourceLimit);
      }
    }
    if (type === BOF && offset !== 0) {
      if (length < 4 || view.getUint16(dataOffset, true) !== 0x0600) {
        reject(LegacyOfficePreviewErrorCode.UnsupportedVersion);
      }
      if (
        view.getUint16(dataOffset + 2, true) !== 0x0010 ||
        !workbookGlobalsEnded ||
        substream != null
      ) {
        reject(LegacyOfficePreviewErrorCode.UnsupportedStructure);
      }
      substream = 'worksheet';
      worksheetOffsets.add(offset);
    }
    if (type === BOF && offset === 0) substream = 'workbook';
    if (type === EOF) {
      if (substream === 'workbook') workbookGlobalsEnded = true;
      substream = null;
    }
    if ([LABEL, NUMBER, BOOLERR, FORMULA, BLANK, RK, LABELSST].includes(type)) {
      const minimumLength =
        type === FORMULA
          ? 20
          : type === LABELSST
            ? 10
            : type === LABEL || type === BOOLERR
              ? 8
              : type === NUMBER
                ? 14
                : type === RK
                  ? 10
                  : 6;
      if (length < minimumLength) reject();
      validateCell({
        row: view.getUint16(dataOffset, true),
        column: view.getUint16(dataOffset + 2, true),
      });
    }
    if (type === MULRK || type === MULBLANK) {
      if (length < 6) reject();
      const firstColumn = view.getUint16(dataOffset + 2, true);
      const lastColumn = view.getUint16(end - 2, true);
      const count = lastColumn - firstColumn + 1;
      const expectedLength = 6 + count * (type === MULRK ? 6 : 2);
      if (lastColumn < firstColumn || expectedLength !== length) reject();
      validateCell({ row: view.getUint16(dataOffset, true), column: firstColumn, count });
    }
    if (type === STRING && length > LEGACY_OFFICE_MAX_BIFF_SHARED_STRINGS * 8) {
      reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    drawingContinuationActive =
      type === MSODRAWING || type === MSODRAWINGGROUP || drawingContinuation;
    lastRecordType = type;
    offset = end;
  }
  if (!sawWorkbookBof || recordCount === 0 || lastRecordType !== EOF) {
    reject();
  }
  if (
    worksheetOffsets.size !== declaredSheetOffsets.size ||
    [...declaredSheetOffsets].some((sheetOffset) => !worksheetOffsets.has(sheetOffset))
  )
    reject(LegacyOfficePreviewErrorCode.Malformed);
}
