import { strToU8, unzipSync, zipSync } from 'fflate';

export type XlsxPreviewNormalizationResult = {
  buffer: ArrayBuffer;
  changedWorksheetCount: number;
  changedCellCount: number;
};

export function normalizeXlsxPreviewWorkbook(buffer: ArrayBuffer): XlsxPreviewNormalizationResult {
  try {
    const files = unzipSync(new Uint8Array(buffer));
    const normalizedFiles: Record<string, Uint8Array> = {};
    let changedWorksheetCount = 0;
    let changedCellCount = 0;

    for (const [name, file] of Object.entries(files)) {
      if (!isWorksheetXmlPath(name)) {
        normalizedFiles[name] = file;
        continue;
      }

      const worksheetXml = new TextDecoder('utf-8').decode(file);
      const normalizedWorksheet = normalizeWorksheetXml(worksheetXml);
      if (normalizedWorksheet.changedCellCount > 0) {
        changedWorksheetCount += 1;
        changedCellCount += normalizedWorksheet.changedCellCount;
        normalizedFiles[name] = strToU8(normalizedWorksheet.xml);
      } else {
        normalizedFiles[name] = file;
      }
    }

    if (changedCellCount === 0) {
      return { buffer, changedWorksheetCount: 0, changedCellCount: 0 };
    }

    const zipped = zipSync(normalizedFiles, { level: 0 });
    return {
      buffer: zipped.buffer.slice(zipped.byteOffset, zipped.byteOffset + zipped.byteLength),
      changedWorksheetCount,
      changedCellCount,
    };
  } catch {
    return { buffer, changedWorksheetCount: 0, changedCellCount: 0 };
  }
}

function normalizeWorksheetXml(worksheetXml: string): { xml: string; changedCellCount: number } {
  let changedCellCount = 0;

  const xml = worksheetXml
    .replace(
      /<c\b([^>]*)\bt=(["'])inlineStr\2([^>]*)>(\s*)<\/c>/g,
      (match, before, quote, after) => {
        if (/<is\b/i.test(match)) return match;
        changedCellCount += 1;
        return `<c${removeInlineStringTypeAttribute(`${before} t=${quote}inlineStr${quote}${after}`)}></c>`;
      },
    )
    .replace(/<c\b([^>]*)\bt=(["'])inlineStr\2([^>]*)\s*\/>/g, (match, before, quote, after) => {
      if (/<is\b/i.test(match)) return match;
      changedCellCount += 1;
      return `<c${removeInlineStringTypeAttribute(`${before} t=${quote}inlineStr${quote}${after}`)}/>`;
    });

  return { xml, changedCellCount };
}

function removeInlineStringTypeAttribute(attributes: string): string {
  return attributes.replace(/\s+t=(["'])inlineStr\1(?=\s|$)/, '');
}

function isWorksheetXmlPath(name: string): boolean {
  return /^xl\/worksheets\/.+\.xml$/i.test(name);
}
