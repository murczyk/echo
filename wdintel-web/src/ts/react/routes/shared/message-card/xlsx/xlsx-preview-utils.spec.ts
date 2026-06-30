/**
 * @vitest-environment happy-dom
 */
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import {
  buildXlsxPreview,
  MAX_XLSX_COLUMNS,
  MAX_XLSX_FILE_BYTES,
  MAX_XLSX_FILE_MB,
  MAX_XLSX_ROWS,
  MAX_XLSX_SHEETS,
  previewXlsxRows,
  XlsxPreviewError,
} from './xlsx-preview-utils';
import { extractWorkbookSheetNames } from './xlsx-preview-metadata';

describe('previewXlsxRows', () => {
  it('reports truncation when a sheet has more than 100 columns', () => {
    const rawRows = [
      Array.from({ length: MAX_XLSX_COLUMNS + 1 }, (_, index) => index + 1),
      ['tail'],
    ];

    const preview = previewXlsxRows(rawRows);

    expect(preview.rowCount).toBe(2);
    expect(preview.columnCount).toBe(MAX_XLSX_COLUMNS + 1);
    expect(preview.truncated).toBe(true);
    expect(preview.rows[0]).toHaveLength(MAX_XLSX_COLUMNS);
  });

  it('reports truncation when a sheet has more than 5000 rows', () => {
    const rawRows = Array.from({ length: MAX_XLSX_ROWS + 1 }, (_, index) => [index + 1]);

    const preview = previewXlsxRows(rawRows);

    expect(preview.rowCount).toBe(MAX_XLSX_ROWS + 1);
    expect(preview.columnCount).toBe(1);
    expect(preview.truncated).toBe(true);
    expect(preview.rows).toHaveLength(MAX_XLSX_ROWS);
  });
});

describe('buildXlsxPreview', () => {
  it('parses a simple workbook', async () => {
    const preview = await buildXlsxPreview(makeWorkbookBuffer([{ name: 'Sheet1', rows: [['Name', 'Age'], ['Alice', 30]] }]));

    expect(preview.sheets).toHaveLength(1);
    expect(preview.sheets[0]?.name).toBe('Sheet1');
    expect(preview.sheets[0]?.rows).toEqual([
      ['Name', 'Age'],
      ['Alice', '30'],
    ]);
    expect(preview.sheets[0]?.rowCount).toBe(2);
    expect(preview.sheets[0]?.columnCount).toBe(2);
    expect(preview.sheets[0]?.truncated).toBe(false);
  });

  it('parses multiple sheets', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer([
        { name: 'First', rows: [['A1'], ['A2']] },
        { name: 'Second', rows: [['B1'], ['B2']] },
      ]),
    );

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['First', 'Second']);
    expect(preview.sheets[1]?.rows[1]).toEqual(['B2']);
  });

  it('decodes escaped sheet names', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer([
        { name: 'A & B', rows: [['A1']] },
        { name: 'Quote "Sheet"', rows: [['B1']] },
      ]),
    );

    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(['A & B', 'Quote "Sheet"']);
  });

  it('truncates rows and columns after parsing', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer([
        {
          name: 'Wide',
          rows: [
            Array.from({ length: MAX_XLSX_COLUMNS + 1 }, (_, index) => `C${index + 1}`),
            ...Array.from({ length: MAX_XLSX_ROWS }, (_, index) => [index + 1]),
          ],
        },
      ]),
    );

    expect(preview.sheets[0]?.rowCount).toBe(MAX_XLSX_ROWS + 1);
    expect(preview.sheets[0]?.columnCount).toBe(MAX_XLSX_COLUMNS + 1);
    expect(preview.sheets[0]?.rows[0]).toHaveLength(MAX_XLSX_COLUMNS);
    expect(preview.sheets[0]?.rows).toHaveLength(MAX_XLSX_ROWS);
    expect(preview.sheets[0]?.truncated).toBe(true);
  });

  it('caps the parsed sheet count', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer(
        Array.from({ length: MAX_XLSX_SHEETS + 2 }, (_, index) => ({
          name: `Sheet${index + 1}`,
          rows: [[`S${index + 1}`]],
        })),
      ),
    );

    expect(preview.sheets).toHaveLength(MAX_XLSX_SHEETS);
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(
      Array.from({ length: MAX_XLSX_SHEETS }, (_, index) => `Sheet${index + 1}`),
    );
    expect(preview.sheets.every((sheet) => sheet.truncated)).toBe(true);
  });

  it('rejects oversized files before parsing', async () => {
    expect(MAX_XLSX_FILE_MB).toBe(10);
    await expect(buildXlsxPreview(new ArrayBuffer(MAX_XLSX_FILE_BYTES + 1))).rejects.toBeInstanceOf(XlsxPreviewError);
    await expect(buildXlsxPreview(new ArrayBuffer(MAX_XLSX_FILE_BYTES + 1))).rejects.toMatchObject({
      code: 'XLSX_FILE_TOO_LARGE',
    });
  });

  it('rejects malformed workbooks', async () => {
    await expect(buildXlsxPreview(new Uint8Array([1, 2, 3]).buffer)).rejects.toMatchObject({
      code: 'XLSX_MALFORMED_WORKBOOK',
    });
  });

  it('rejects unsupported workbook structure', async () => {
    await expect(
      buildXlsxPreview(
        makeWorkbookBuffer(
          [
            {
              name: 'Broken',
              rows: [['A1']],
            },
          ],
          { omitSheetFiles: true },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'XLSX_UNSUPPORTED_WORKBOOK_STRUCTURE',
    });
  });

  it('extracts workbook sheet names from metadata', () => {
    const buffer = makeWorkbookBuffer([
      { name: 'One', rows: [['1']] },
      { name: 'Two', rows: [['2']] },
    ]);

    expect(extractWorkbookSheetNames(buffer)).toEqual(['One', 'Two']);
  });
});

function makeWorkbookBuffer(
  sheets: Array<{ name: string; rows: Array<Array<string | number>> }>,
  options: { omitSheetFiles?: boolean } = {},
): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(buildContentTypesXml(sheets.length)),
    '_rels/.rels': strToU8(buildRootRelsXml()),
    'xl/workbook.xml': strToU8(buildWorkbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(buildWorkbookRelsXml(sheets)),
  };

  if (!options.omitSheetFiles) {
    for (const [index, sheet] of sheets.entries()) {
      files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(buildSheetXml(sheet.rows));
    }
  }

  const zipped = zipSync(files, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

function buildContentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from({ length: sheetCount }, (_, index) =>
    `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  ${sheetOverrides}
</Types>`;
}

function buildRootRelsXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildWorkbookXml(sheets: Array<{ name: string }>): string {
  const sheetEntries = sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntries}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheets: Array<unknown>): string {
  const relationships = sheets
    .map(
      (_sheet, index) =>
        `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
    )
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships}
</Relationships>`;
}

function buildSheetXml(rows: Array<Array<string | number>>): string {
  const rowXml = rows
    .map((row, rowIndex) => {
      const cellXml = row
        .map((value, columnIndex) => {
          const cellRef = `${columnLabel(columnIndex)}${rowIndex + 1}`;
          if (typeof value === 'number') {
            return `<c r="${cellRef}"><v>${value}</v></c>`;
          }
          return `<c r="${cellRef}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cellXml}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <sheetData>${rowXml}</sheetData>
</worksheet>`;
}

function columnLabel(index: number): string {
  let value = index + 1;
  let label = '';

  while (value > 0) {
    const remainder = (value - 1) % 26;
    label = String.fromCharCode(65 + remainder) + label;
    value = Math.floor((value - 1) / 26);
  }

  return label;
}

function escapeXml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}
