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
    ['a,b\n1,2\n3,4', ','],
    ['a;b\n1;2\n3;4', ';'],
    ['a\tb\n1\t2\n3\t4', '\t'],
    ['a|b\n1|2\n3|4', '|'],
  ])('detects %s delimiter', (text, delimiter) => {
    expect(detectCsvDelimiter(text)).toBe(delimiter);
  });

  it('prefers consistent semicolon fields over decimal commas', () => {
    expect(
      detectCsvDelimiter('name;price;total\nApple;12,50;25,00\nPear;3,20;6,40\nPlum;4,10;8,20'),
    ).toBe(';');
  });

  it('selects and parses a no-header semicolon CSV with decimal commas', () => {
    const text = 'Apple;12,50;25,00\nPear;3,20;6,40\nPlum;4,10;8,20';

    expect(detectCsvDelimiter(text)).toBe(';');
    expect(parseCsvText(text).rows).toEqual([
      ['Apple', '12,50', '25,00'],
      ['Pear', '3,20', '6,40'],
      ['Plum', '4,10', '8,20'],
    ]);
  });

  it('ignores candidate delimiters inside quoted cells', () => {
    expect(detectCsvDelimiter('name,description\nA,"one; two | three"')).toBe(',');
    expect(detectCsvDelimiter('name;description\nA;"one, two | three"')).toBe(';');
  });

  it('detects a delimiter in a very wide row without retaining fields', () => {
    const text = Array.from({ length: 100_001 }, () => 'x').join(',');

    expect(detectCsvDelimiter(text)).toBe(',');
  });

  it('uses comma as a deterministic fallback for ambiguous single-record input', () => {
    expect(detectCsvDelimiter('single value')).toBe(',');
    expect(detectCsvDelimiter('one,two;three')).toBe(',');
    expect(detectCsvDelimiter('one,two;three\nfour,five;six')).toBe(',');
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
  });

  it('retains 5000 rows while counting every source row', () => {
    const result = parseCsvText(
      Array.from({ length: 5001 }, (_, index) => `${index},x`).join('\n'),
    );

    expect(result.rowCount).toBe(5001);
    expect(result.rows).toHaveLength(5000);
    expect(result.truncated).toBe(true);
  });

  it('retains 100 cells while counting every source column', () => {
    const result = parseCsvText(Array.from({ length: 101 }, (_, index) => `c${index}`).join(','));

    expect(result.columnCount).toBe(101);
    expect(result.rows[0]).toHaveLength(100);
    expect(result.truncated).toBe(true);
  });

  it('keeps bounded preview output while preserving large source dimensions', () => {
    const source = Array.from({ length: 5001 }, () =>
      Array.from({ length: 101 }, (_, index) => `v${index}`).join(','),
    ).join('\n');
    const result = parseCsvText(source);

    expect(result.rowCount).toBe(5001);
    expect(result.columnCount).toBe(101);
    expect(result.rows).toHaveLength(5000);
    expect(result.rows.every((row) => row.length === 100)).toBe(true);
    expect(result.truncated).toBe(true);
  });

  it('validates malformed quoted fields after the retained preview bounds', () => {
    expect(() => parseCsvText(`${'ok,ok\n'.repeat(5000)}bad,"unterminated`)).toThrowError(
      expect.objectContaining({ code: 'CSV_MALFORMED' }),
    );
    expect(() =>
      parseCsvText(`${Array.from({ length: 100 }, (_, index) => `c${index}`).join(',')},"bad`),
    ).toThrowError(expect.objectContaining({ code: 'CSV_MALFORMED' }));
  });
});
