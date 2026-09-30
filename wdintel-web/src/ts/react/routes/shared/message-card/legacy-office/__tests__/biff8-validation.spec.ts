import { describe, expect, it } from 'vitest';

import { validateBiff8Workbook } from '../biff8-validation';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';

type Record = readonly [type: number, payload?: readonly number[]];

function workbook(records: readonly Record[]): Uint8Array {
  const length = records.reduce((total, [, payload = []]) => total + 4 + payload.length, 0);
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const [type, payload = []] of records) {
    view.setUint16(offset, type, true);
    view.setUint16(offset + 2, payload.length, true);
    bytes.set(payload, offset + 4);
    offset += 4 + payload.length;
  }
  return bytes;
}

function uint32(value: number): number[] {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return [...bytes];
}

function uint16(value: number): number[] {
  const bytes = new Uint8Array(2);
  new DataView(bytes.buffer).setUint16(0, value, true);
  return [...bytes];
}

const workbookBof: Record = [0x0809, [0, 6, 5, 0]];
const eof: Record = [0x000a];

function drawingWorkbook(worksheetRecords: readonly Record[]): Uint8Array {
  const globalRecords: Record[] = [
    workbookBof,
    [0x0085, new Array(9).fill(0)],
    [0x00eb, new Array(8).fill(0)],
    eof,
  ];
  const worksheetOffset = globalRecords.reduce(
    (total, [, payload = []]) => total + 4 + payload.length,
    0,
  );
  const boundsheet = globalRecords[1]![1] as number[];
  boundsheet.splice(0, 4, ...uint32(worksheetOffset));
  boundsheet[5] = 0;
  boundsheet[6] = 1;
  boundsheet[7] = 0;
  boundsheet[8] = 83;
  return workbook([...globalRecords, [0x0809, [0, 6, 16, 0]], ...worksheetRecords, eof]);
}

function expectRejected(bytes: Uint8Array, code: LegacyOfficePreviewErrorCode): void {
  try {
    validateBiff8Workbook(bytes);
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyOfficePreviewError);
    expect((error as LegacyOfficePreviewError).code).toBe(code);
    return;
  }
  throw new Error('Expected BIFF8 preflight to reject the input');
}

describe('BIFF8 workbook preflight', () => {
  it('accepts a bounded BIFF8 workbook-globals stream', () => {
    expect(() => validateBiff8Workbook(workbook([workbookBof, eof]))).not.toThrow();
  });

  it('rejects a non-BIFF8 workbook before SheetJS can parse it', () => {
    expectRejected(
      workbook([[0x0809, [0, 5, 5, 0]], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedVersion,
    );
  });

  it('rejects worksheet BOFs before workbook globals close', () => {
    expectRejected(
      workbook([workbookBof, [0x0809, [0, 6, 16, 0]], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
  });

  it('rejects a truncated record', () => {
    expectRejected(
      new Uint8Array([0x09, 0x08, 0x04, 0x00, 0x00]),
      LegacyOfficePreviewErrorCode.Malformed,
    );
  });

  it('rejects encrypted and unsupported record types with a typed reason', () => {
    expectRejected(workbook([workbookBof, [0x002f], eof]), LegacyOfficePreviewErrorCode.Encrypted);
    expectRejected(
      workbook([workbookBof, [0x005d], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
  });

  it('rejects external references and out-of-preview cell coordinates while scanning records', () => {
    expectRejected(
      workbook([workbookBof, [0x01ae, [...uint16(1), ...uint16(0)]], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
    expectRejected(
      workbook([workbookBof, [0x01b8, new Array(32).fill(0)], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
    expectRejected(
      workbook([
        workbookBof,
        [0x0203, [...uint16(5_000), ...uint16(0), ...new Array(10).fill(0)]],
        eof,
      ]),
      LegacyOfficePreviewErrorCode.ResourceLimit,
    );
    expectRejected(
      workbook([
        workbookBof,
        [0x00bd, [...uint16(0), ...uint16(99), ...new Array(12).fill(0), ...uint16(100)]],
        eof,
      ]),
      LegacyOfficePreviewErrorCode.ResourceLimit,
    );
  });

  it('rejects declared sheet bounds and shared-string budgets over preview limits', () => {
    const dimensions = [...uint32(0), ...uint32(5_001), ...uint16(0), ...uint16(1), ...uint16(0)];
    const sst = [...uint32(250_001), ...uint32(250_001)];

    expectRejected(
      workbook([workbookBof, [0x0200, dimensions], eof]),
      LegacyOfficePreviewErrorCode.ResourceLimit,
    );
    expectRejected(
      workbook([workbookBof, [0x00fc, sst], eof]),
      LegacyOfficePreviewErrorCode.ResourceLimit,
    );
  });

  it('permits only bounded, framed drawing records in their valid substreams', () => {
    expect(() =>
      validateBiff8Workbook(drawingWorkbook([[0x00ec, new Array(8).fill(0)]])),
    ).not.toThrow();

    expectRejected(
      drawingWorkbook([[0x00ec, new Array(7).fill(0)]]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
    expectRejected(
      workbook([workbookBof, [0x00ec, new Array(8).fill(0)], eof]),
      LegacyOfficePreviewErrorCode.UnsupportedStructure,
    );
  });

  it('rejects excessive drawing records before SheetJS can parse them', () => {
    expectRejected(
      drawingWorkbook(Array.from({ length: 101 }, () => [0x00ec, new Array(8).fill(0)])),
      LegacyOfficePreviewErrorCode.ResourceLimit,
    );
  });
});
