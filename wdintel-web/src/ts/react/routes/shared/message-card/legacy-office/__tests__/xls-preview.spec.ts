import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';
import { validateCfbContainer } from '../cfb-validation';
import { buildXlsPreview } from '../xls-preview';
import { LEGACY_OFFICE_MAX_CELLS } from '../legacy-office-limits';
import * as XLSX from '../vendor/sheetjs/xlsx-0.20.3.mjs';

async function fixtureBuffer(name: string): Promise<ArrayBuffer> {
  const file = await readFile(resolve(process.cwd(), `tests/fixtures/legacy-office/${name}`));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('legacy BIFF8 XLS preview', () => {
  it('reads the retained Apache POI BIFF8 cache fixture after CFB preflight', async () => {
    const preview = buildXlsPreview(await fixtureBuffer('3dFormulas.xls'));

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['Sheet1', 'S2', 'Sh3']);
    expect(preview.sheets[0]?.rows[4]?.[0]).toBe('S2-A1');
    expect(preview.sheets[0]?.rows[6]?.[0]).toBe('165');
  });

  it('retains the Apache POI date and number-format assertions', async () => {
    const datePreview = buildXlsPreview(await fixtureBuffer('DateFormats.xls'));
    const numberPreview = buildXlsPreview(await fixtureBuffer('SimpleWithDataFormat.xls'));

    expect(datePreview.sheets[0]?.rows[3]?.[1]).toBe('Friday, August 10, 2007');
    expect(numberPreview.sheets[0]?.rows[0]?.[0]).toBe('1.3');
  });

  it('reads the bounded LibreOffice Calc drawing records without exposing them', async () => {
    const preview = buildXlsPreview(await fixtureBuffer('formatted-workbook.xls'));

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['Дані', 'Sparse']);
    expect(preview.sheets[0]?.rows[1]?.[0]).toBe('00123');
    expect(preview.sheets[0]?.rows[1]?.[1]).toBe('$1,234.50');
    expect(preview.sheets[0]?.rows[1]?.[2]).toBe('2025-09-29');
    expect(preview.sheets[0]?.rows[2]?.[1]).toBe('25.00%');
    expect(preview.sheets[0]?.rows[2]?.[2]).toBe('TRUE');
    expect(preview.sheets[0]?.rows[3]?.[1]).toBe('$1,234.75');
    expect(preview.sheets[0]?.rows[5]?.[0]).toBe('Об’єднана комірка');
    expect(preview.sheets[1]?.rows[5]?.[3]).toBe('Кінець');
  });

  it('caps sparse workbook slots before materializing more than the transfer limit', () => {
    const sheet = XLSX.utils.aoa_to_sheet([['kept']]);
    sheet['!ref'] = 'A1:CV5000';
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, sheet, 'Sparse');
    const preview = buildXlsPreview(XLSX.write(workbook, { type: 'array', bookType: 'xls' }));

    expect(preview.truncated).toBe(true);
    expect(preview.sheets[0]?.truncated).toBe(true);
    expect(
      preview.sheets.flatMap((item) => item.rows).reduce((sum, row) => sum + row.length, 0),
    ).toBe(LEGACY_OFFICE_MAX_CELLS);
    expect(preview.sheets[0]?.rows[0]?.[0]).toBe('kept');
  });

  it('rejects non-CFB bytes before the candidate parser is invoked', () => {
    expect(() => buildXlsPreview(new TextEncoder().encode('a,b\n1,2').buffer)).toThrow(
      LegacyOfficePreviewError,
    );
    try {
      buildXlsPreview(new TextEncoder().encode('a,b\n1,2').buffer);
    } catch (error) {
      expect((error as LegacyOfficePreviewError).code).toBe(
        LegacyOfficePreviewErrorCode.InvalidCfb,
      );
    }
  });

  it('rejects a repeated DIFAT directly in the patched SheetJS candidate', async () => {
    const bytes = new Uint8Array(await fixtureBuffer('3dFormulas.xls'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(68, 0, true);
    view.setUint32(72, 5_000, true);
    view.setUint32(512 + 127 * 4, 0, true);

    expect(() => XLSX.read(bytes, { type: 'array' })).toThrow();
  });

  it.each([
    ['a truncated header', (bytes: Uint8Array) => bytes.slice(0, 511)],
    [
      'an invalid sector shift',
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint16(30, 10, true);
        return bytes;
      },
    ],
    [
      'an invalid mini-sector shift',
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint16(32, 7, true);
        return bytes;
      },
    ],
    [
      'a cyclic DIFAT chain',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        view.setUint32(68, 0, true);
        view.setUint32(72, 5_000, true);
        view.setUint32(512 + 127 * 4, 0, true);
        return bytes;
      },
    ],
    [
      'a duplicated FAT sector',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        view.setUint32(44, 2, true);
        view.setUint32(80, view.getUint32(76, true), true);
        return bytes;
      },
    ],
    [
      'an out-of-range FAT sector',
      (bytes: Uint8Array) => {
        new DataView(bytes.buffer).setUint32(76, (bytes.byteLength - 512) / 512, true);
        return bytes;
      },
    ],
    [
      'a self-referential root directory child',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const directorySector = view.getUint32(48, true);
        view.setUint32(512 + directorySector * 512 + 76, 0, true);
        return bytes;
      },
    ],
  ])('rejects %s during CFB preflight', async (_, mutate) => {
    const bytes = new Uint8Array(await fixtureBuffer('3dFormulas.xls'));

    const malformed = mutate(bytes);
    expect(() =>
      validateCfbContainer(
        malformed.buffer.slice(malformed.byteOffset, malformed.byteOffset + malformed.byteLength),
      ),
    ).toThrow(LegacyOfficePreviewError);
  });

  it.each([
    [
      'a hidden non-free header DIFAT entry',
      (bytes: Uint8Array) => new DataView(bytes.buffer).setUint32(80, 0, true),
    ],
    [
      'an incorrect FAT sector marker',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const fatSector = view.getUint32(76, true);
        view.setUint32(512 + fatSector * 512 + fatSector * 4, 0xffffffff, true);
      },
    ],
    [
      'two mini streams reusing one mini sector',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const directorySector = view.getUint32(48, true);
        const firstStream = 512 + directorySector * 512 + 128;
        const secondStream = firstStream + 128;
        view.setUint32(secondStream + 116, view.getUint32(firstStream + 116, true), true);
      },
    ],
    [
      'two mini streams partially overlapping',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const directorySector = view.getUint32(48, true);
        const firstStream = 512 + directorySector * 512 + 128;
        const secondStream = firstStream + 128;
        view.setUint32(secondStream + 116, view.getUint32(firstStream + 116, true) + 1, true);
      },
    ],
    [
      'a FAT link inside the FAT array but outside the physical file',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const directorySector = view.getUint32(48, true);
        view.setUint32(512 + directorySector * 512 + 116, 100, true);
      },
    ],
    [
      'a case-equivalent duplicate Workbook stream name',
      (bytes: Uint8Array) => {
        const view = new DataView(bytes.buffer);
        const directorySector = view.getUint32(48, true);
        const duplicate = 512 + directorySector * 512 + 128 * 2;
        for (const [index, character] of [...'wORKBOOK'].entries())
          view.setUint16(duplicate + index * 2, character.charCodeAt(0), true);
        view.setUint16(duplicate + 16, 0, true);
        view.setUint16(duplicate + 64, 18, true);
      },
    ],
  ])('rejects %s during CFB ownership validation', async (_, mutate) => {
    const bytes = new Uint8Array(await fixtureBuffer('3dFormulas.xls'));
    mutate(bytes);

    try {
      validateCfbContainer(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(LegacyOfficePreviewError);
      expect((error as LegacyOfficePreviewError).code).toBe(
        LegacyOfficePreviewErrorCode.InvalidCfb,
      );
      return;
    }
    throw new Error('Expected CFB ownership validation to reject the mutation');
  });
});
