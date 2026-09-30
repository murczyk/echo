import { describe, expect, it } from 'vitest';

import { validateWordDocument } from '../doc-validation';
import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';

function wordDocument(): Uint8Array {
  const bytes = new Uint8Array(0x162);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, 0xa5ec, true);
  view.setUint16(2, 0x00c1, true);
  view.setUint16(0x20, 0, true);
  view.setUint16(0x22, 11, true);
  view.setUint32(0x24 + 3 * 4, 1, true);
  view.setUint16(0x50, 34, true);
  view.setUint32(0x52 + 33 * 8, 0, true);
  view.setUint32(0x52 + 33 * 8 + 4, 21, true);
  return bytes;
}

function table(): Uint8Array {
  const bytes = new Uint8Array(21);
  const view = new DataView(bytes.buffer);
  bytes[0] = 0x02;
  view.setUint32(1, 16, true);
  view.setUint32(5, 0, true);
  view.setUint32(9, 1, true);
  view.setUint32(15, 0x40000200, true);
  return bytes;
}

function expectRejected(bytes: Uint8Array, code: LegacyOfficePreviewErrorCode): void {
  try {
    validateWordDocument(bytes, table());
  } catch (error) {
    expect(error).toBeInstanceOf(LegacyOfficePreviewError);
    expect((error as LegacyOfficePreviewError).code).toBe(code);
    return;
  }
  throw new Error('Expected Word FIB preflight to reject the input');
}

describe('Word 97–2003 FIB preflight', () => {
  it('accepts a bounded Word 97 FIB and selects its table stream', () => {
    expect(validateWordDocument(wordDocument(), table())).toBe('0Table');
  });

  it('returns typed rejections for unsupported and encrypted files', () => {
    const unsupported = wordDocument();
    new DataView(unsupported.buffer).setUint16(2, 0x00c0, true);
    expectRejected(unsupported, LegacyOfficePreviewErrorCode.UnsupportedVersion);

    const encrypted = wordDocument();
    new DataView(encrypted.buffer).setUint16(10, 0x8100, true);
    expectRejected(encrypted, LegacyOfficePreviewErrorCode.Encrypted);
  });

  it('rejects oversized body text and CLX offsets before the candidate reader runs', () => {
    const oversized = wordDocument();
    new DataView(oversized.buffer).setUint32(0x24 + 3 * 4, 2_000_001, true);
    expectRejected(oversized, LegacyOfficePreviewErrorCode.ResourceLimit);

    const badClx = wordDocument();
    new DataView(badClx.buffer).setUint32(0x52 + 33 * 8, 1, true);
    expectRejected(badClx, LegacyOfficePreviewErrorCode.Malformed);

    const malformedPieces = table();
    new DataView(malformedPieces.buffer).setUint32(9, 0, true);
    expect(() => validateWordDocument(wordDocument(), malformedPieces)).toThrow(
      LegacyOfficePreviewError,
    );
  });
});
