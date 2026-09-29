import {
  LEGACY_OFFICE_MAX_FILE_BYTES,
  LEGACY_OFFICE_MAX_DOC_RUNS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from './legacy-office-limits';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from './legacy-office-errors';

const WORD_DOCUMENT_SIGNATURE = 0xa5ec;
const WORD_97_TO_2003_FIBS = new Set([0x00c1, 0x00d9, 0x0101, 0x010c]);
const FIB_BASE_LENGTH = 0x20;
const FIB_CCP_TEXT_INDEX = 3;
const FIB_CLX_PAIR_INDEX = 33;

function reject(code = LegacyOfficePreviewErrorCode.Malformed): never {
  throw new LegacyOfficePreviewError(code);
}

function validatePieceTable(
  wordDocument: Uint8Array,
  table: Uint8Array,
  fcClx: number,
  lcbClx: number,
  ccpText: number,
): void {
  const view = new DataView(table.buffer, table.byteOffset, table.byteLength);
  const end = fcClx + lcbClx;
  let offset = fcClx;
  while (offset < end) {
    const type = view.getUint8(offset);
    if (type === 0x01) {
      if (offset + 3 > end) reject();
      const length = view.getUint16(offset + 1, true);
      offset += 3 + length;
      if (offset > end) reject();
      continue;
    }
    if (type !== 0x02 || offset + 5 > end) reject();
    const plcLength = view.getUint32(offset + 1, true);
    const plcOffset = offset + 5;
    if (plcLength < 16 || plcOffset + plcLength !== end || (plcLength - 4) % 12 !== 0) reject();
    const pieceCount = (plcLength - 4) / 12;
    if (pieceCount <= 0 || pieceCount > LEGACY_OFFICE_MAX_DOC_RUNS) {
      reject(LegacyOfficePreviewErrorCode.ResourceLimit);
    }
    const pcdOffset = plcOffset + (pieceCount + 1) * 4;
    let previousCp = view.getUint32(plcOffset, true);
    if (previousCp !== 0) reject();
    for (let index = 0; index < pieceCount; index += 1) {
      const nextCp = view.getUint32(plcOffset + (index + 1) * 4, true);
      if (nextCp <= previousCp) reject();
      const fc = view.getUint32(pcdOffset + index * 8 + 2, true);
      const compressed = (fc & 0x40000000) !== 0;
      const byteOffset = compressed ? (fc & 0x3fffffff) >>> 1 : fc & 0x3fffffff;
      const byteLength = (nextCp - previousCp) * (compressed ? 1 : 2);
      if (byteLength > wordDocument.byteLength || byteOffset > wordDocument.byteLength - byteLength)
        reject();
      previousCp = nextCp;
    }
    if (previousCp < ccpText) reject();
    return;
  }
  reject();
}

export function validateWordDocument(
  wordDocument: Uint8Array,
  table: Uint8Array,
): '0Table' | '1Table' {
  if (wordDocument.byteLength < FIB_BASE_LENGTH) reject();
  const view = new DataView(wordDocument.buffer, wordDocument.byteOffset, wordDocument.byteLength);
  if (view.getUint16(0, true) !== WORD_DOCUMENT_SIGNATURE) reject();
  if (!WORD_97_TO_2003_FIBS.has(view.getUint16(2, true))) {
    reject(LegacyOfficePreviewErrorCode.UnsupportedVersion);
  }
  const flags = view.getUint16(10, true);
  if ((flags & 0x8100) !== 0) reject(LegacyOfficePreviewErrorCode.Encrypted);
  let offset = FIB_BASE_LENGTH;
  if (offset + 2 > wordDocument.byteLength) reject();
  const fibRgWLength = view.getUint16(offset, true);
  offset += 2 + fibRgWLength * 2;
  if (offset + 2 > wordDocument.byteLength) reject();
  const fibRgLwLength = view.getUint16(offset, true);
  offset += 2;
  if (
    fibRgLwLength <= FIB_CCP_TEXT_INDEX ||
    offset + fibRgLwLength * 4 + 2 > wordDocument.byteLength
  )
    reject();
  const ccpText = view.getUint32(offset + FIB_CCP_TEXT_INDEX * 4, true);
  if (ccpText > LEGACY_OFFICE_MAX_TEXT_CODE_UNITS)
    reject(LegacyOfficePreviewErrorCode.ResourceLimit);
  offset += fibRgLwLength * 4;
  const fibRgFcLcbLength = view.getUint16(offset, true);
  offset += 2;
  const clxOffset = offset + FIB_CLX_PAIR_INDEX * 8;
  if (
    fibRgFcLcbLength <= FIB_CLX_PAIR_INDEX ||
    offset + fibRgFcLcbLength * 8 > wordDocument.byteLength ||
    clxOffset + 8 > wordDocument.byteLength
  )
    reject();
  const fcClx = view.getUint32(clxOffset, true);
  const lcbClx = view.getUint32(clxOffset + 4, true);
  if (
    lcbClx === 0 ||
    fcClx > table.byteLength ||
    lcbClx > table.byteLength - fcClx ||
    wordDocument.byteLength > LEGACY_OFFICE_MAX_FILE_BYTES
  )
    reject();
  validatePieceTable(wordDocument, table, fcClx, lcbClx, ccpText);
  return (flags & 0x0200) === 0 ? '0Table' : '1Table';
}
