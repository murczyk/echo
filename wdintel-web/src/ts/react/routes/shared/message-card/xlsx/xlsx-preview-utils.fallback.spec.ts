/**
 * @vitest-environment happy-dom
 */
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./xlsx-preview-metadata', () => ({
  extractWorkbookSheetNames: vi.fn(() => []),
}));

import { buildXlsxPreview } from './xlsx-preview-utils';

describe('buildXlsxPreview fallback names', () => {
  it('does not mark exactly capped fallback sheets as truncated', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer(
        Array.from({ length: 20 }, (_, index) => ({
          name: `Sheet ${index + 1}`,
          rows: [[`S${index + 1}`]],
        })),
      ),
    );

    expect(preview.sheets).toHaveLength(20);
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Sheet ${index + 1}`),
    );
    expect(preview.sheets.every((sheet) => sheet.truncated)).toBe(false);
  });

  it('marks fallback sheets as truncated when more than the cap exist', async () => {
    const preview = await buildXlsxPreview(
      makeWorkbookBuffer(
        Array.from({ length: 22 }, (_, index) => ({
          name: `Sheet ${index + 1}`,
          rows: [[`S${index + 1}`]],
        })),
      ),
    );

    expect(preview.sheets).toHaveLength(20);
    expect(preview.sheets.map((sheet) => sheet.name)).toEqual(
      Array.from({ length: 20 }, (_, index) => `Sheet ${index + 1}`),
    );
    expect(preview.sheets.every((sheet) => sheet.truncated)).toBe(true);
  });
});

function makeWorkbookBuffer(
  sheets: Array<{ name: string; rows: Array<Array<string | number>> }>,
): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(buildContentTypesXml(sheets.length)),
    '_rels/.rels': strToU8(buildRootRelsXml()),
    'xl/workbook.xml': strToU8(buildWorkbookXml(sheets)),
    'xl/_rels/workbook.xml.rels': strToU8(buildWorkbookRelsXml(sheets)),
  };

  for (const [index, sheet] of sheets.entries()) {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(buildSheetXml(sheet.rows));
  }

  const zipped = zipSync(files, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

function buildContentTypesXml(sheetCount: number): string {
  const sheetOverrides = Array.from(
    { length: sheetCount },
    (_, index) =>
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
        `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
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
          return `<c r="${cellRef}" t="inlineStr"><is><t>${value}</t></is></c>`;
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
