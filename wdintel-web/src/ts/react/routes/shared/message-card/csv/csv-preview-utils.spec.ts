import { describe, expect, it } from 'vitest';

import {
  decodeCsvBytes,
  detectCsvDelimiter,
  isProbablyBinaryCsv,
  isUtf16Csv,
  parseCsvText,
} from './csv-preview-utils';

function utf16Bytes(text: string, littleEndian: boolean): Uint8Array {
  const bytes = new Uint8Array(text.length * 2);
  text.split('').forEach((character, index) => {
    const code = character.charCodeAt(0);
    bytes[index * 2] = littleEndian ? code & 0xff : code >> 8;
    bytes[index * 2 + 1] = littleEndian ? code >> 8 : code & 0xff;
  });
  return bytes;
}

describe('csv-preview-utils', () => {
  it('parses quoted fields, escaped quotes, and embedded newlines', () => {
    expect(parseCsvText('name;note\r\nAlice;"hello; world"\r\nBob;"line 1\nline 2"')).toMatchObject(
      {
        rows: [
          ['name', 'note'],
          ['Alice', 'hello; world'],
          ['Bob', 'line 1\nline 2'],
        ],
        rowCount: 3,
        columnCount: 2,
      },
    );
    expect(parseCsvText('a,b\n"x""y",z').rows[1]).toEqual(['x"y', 'z']);
  });

  it.each([
    ['a,b\n1,2', ','],
    ['a;b\n1;2', ';'],
    ['a\tb\n1\t2', '\t'],
    ['a|b\n1|2', '|'],
  ])('detects %s delimiter', (text, delimiter) => {
    expect(detectCsvDelimiter(text)).toBe(delimiter);
  });

  it('decodes UTF-8 and UTF-16 BOMs', () => {
    expect(decodeCsvBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]), null)).toBe('a');
    expect(decodeCsvBytes(new Uint8Array([0xff, 0xfe, 0x61, 0x00]), null)).toBe('a');
    expect(decodeCsvBytes(new Uint8Array([0xfe, 0xff, 0x00, 0x61]), null)).toBe('a');
  });

  it.each([
    ['utf-16le', true],
    ['utf-16be', false],
  ])('decodes BOM-less UTF-16%s CSV before binary detection', (charset, littleEndian) => {
    const bytes = utf16Bytes('name,value\nAlice,1', littleEndian);
    expect(isUtf16Csv(bytes, `text/csv; charset=${charset}`)).toBe(true);
    expect(isProbablyBinaryCsv(bytes)).toBe(true);
    expect(parseCsvText(decodeCsvBytes(bytes, `text/csv; charset=${charset}`)).rows).toEqual([
      ['name', 'value'],
      ['Alice', '1'],
    ]);
  });

  it('keeps rejecting actual binary input', () => {
    const binary = new Uint8Array([0x00, 0x01, 0x02, 0x7f, 0x00]);
    expect(isUtf16Csv(binary, 'text/csv; charset=utf-8')).toBe(false);
    expect(isProbablyBinaryCsv(binary)).toBe(true);
  });

  it('rejects malformed quoted fields and truncates display dimensions', () => {
    expect(() => parseCsvText('a,"unterminated')).toThrow('Unclosed');
    expect(
      parseCsvText(`${Array.from({ length: 5001 }, (_, index) => `${index},x`).join('\n')}`)
        .truncated,
    ).toBe(true);
  });
});
