/**
 * @vitest-environment node
 */
import { zipSync, strToU8 } from 'fflate';
import { describe, expect, it } from 'vitest';

import { extractWorkbookSheetNames } from './xlsx-preview-metadata';

describe('extractWorkbookSheetNames', () => {
  it('extracts sheet names and decodes XML entities without DOMParser', () => {
    expect(typeof DOMParser).toBe('undefined');

    const buffer = makeWorkbookBuffer(['A &amp; B', 'X &lt; Y', 'Quote &quot; Z', 'Apostrophe &apos; Q', 'Hex &#x41;']);

    expect(extractWorkbookSheetNames(buffer)).toEqual(['A & B', 'X < Y', 'Quote " Z', "Apostrophe ' Q", 'Hex A']);
  });

  it('preserves trailing whitespace in sheet names', () => {
    const buffer = makeWorkbookBuffer(['Trailing ']);

    expect(extractWorkbookSheetNames(buffer)).toEqual(['Trailing ']);
  });

  it('returns an empty list for broken metadata', () => {
    const files: Record<string, Uint8Array> = {
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="Broken"></sheets>'),
    };

    const zipped = zipSync(files, { level: 0 });
    const buffer = zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);

    expect(extractWorkbookSheetNames(buffer)).toEqual([]);
  });
});

function makeWorkbookBuffer(sheetNames: string[]): ArrayBuffer {
  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
</Types>`),
    '_rels/.rels': strToU8(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`),
    'xl/workbook.xml': strToU8(buildWorkbookXml(sheetNames)),
    'xl/_rels/workbook.xml.rels': strToU8(buildWorkbookRelsXml(sheetNames.length)),
  };

  const zipped = zipSync(files, { level: 0 });
  return zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength);
}

function buildWorkbookXml(sheetNames: string[]): string {
  const sheetEntries = sheetNames
    .map((sheetName, index) => `<sheet name="${sheetName}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheetEntries}</sheets>
</workbook>`;
}

function buildWorkbookRelsXml(sheetCount: number): string {
  const relationships = Array.from({ length: sheetCount }, (_value, index) =>
    `<Relationship Id="rId${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
  ).join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${relationships}
</Relationships>`;
}
