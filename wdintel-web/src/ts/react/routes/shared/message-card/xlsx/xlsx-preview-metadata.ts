import { unzipSync } from 'fflate';

export function extractWorkbookSheetNames(buffer: ArrayBuffer): string[] {
  try {
    const files = unzipSync(new Uint8Array(buffer), {
      filter: (file) => file.name === 'xl/workbook.xml',
    });
    const workbookXml = files['xl/workbook.xml'];
    if (workbookXml == null) return [];

    const workbookText = new TextDecoder('utf-8').decode(workbookXml);
    if (!isLikelyWorkbookXml(workbookText)) return [];
    const sheetNames: string[] = [];
    const sheetPattern = /<sheet\b([^>]*)\/?>/g;
    const namePattern = /\bname=(["'])(.*?)\1/;

    for (const match of workbookText.matchAll(sheetPattern)) {
      const attributes = match[1] ?? '';
      const nameMatch = attributes.match(namePattern);
      if (nameMatch == null) continue;
      const sheetName = decodeXmlEntities(nameMatch[2] ?? '');
      if (sheetName !== '') {
        sheetNames.push(sheetName);
      }
    }

    return sheetNames;
  } catch {
    return [];
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (entity) => {
    switch (entity) {
      case '&amp;':
        return '&';
      case '&lt;':
        return '<';
      case '&gt;':
        return '>';
      case '&quot;':
        return '"';
      case '&apos;':
        return "'";
      default:
        return decodeNumericEntity(entity);
    }
  });
}

function decodeNumericEntity(entity: string): string {
  if (!entity.startsWith('&#')) return entity;

  const isHex = entity.startsWith('&#x') || entity.startsWith('&#X');
  const body = entity.slice(isHex ? 3 : 2, -1);
  const codePoint = Number.parseInt(body, isHex ? 16 : 10);

  if (!Number.isFinite(codePoint)) return entity;
  try {
    return String.fromCodePoint(codePoint);
  } catch {
    return entity;
  }
}

function isLikelyWorkbookXml(workbookText: string): boolean {
  return (
    /<workbook\b[\s\S]*<\/workbook>/i.test(workbookText) &&
    /<sheets\b[\s\S]*<\/sheets>/i.test(workbookText)
  );
}
