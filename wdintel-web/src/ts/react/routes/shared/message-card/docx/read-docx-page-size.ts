import { DOMParser } from '@xmldom/xmldom';
import { strFromU8, unzipSync } from 'fflate';

import type { DocxPageSize } from './docx-preview.types';

const DOCUMENT_XML_PATH = 'word/document.xml';
const ELEMENT_NODE = 1;

function childElements(element: Element): Element[] {
  return Array.from(element.childNodes).filter(
    (child): child is Element => child.nodeType === ELEMENT_NODE,
  );
}

function findChild(element: Element, localName: string): Element | null {
  return childElements(element).find((child) => child.localName === localName) ?? null;
}

function attributeByLocalName(element: Element, localName: string): string | null {
  return (
    Array.from(element.attributes).find((attribute) => attribute.localName === localName)?.value ??
    null
  );
}

function positiveInteger(value: string | null): number | null {
  if (value == null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function readDocxPageSize(buffer: ArrayBuffer): DocxPageSize | null {
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => file.name === DOCUMENT_XML_PATH,
  });
  const documentXml = files[DOCUMENT_XML_PATH];
  if (documentXml == null) return null;

  const document = new DOMParser().parseFromString(strFromU8(documentXml), 'application/xml');
  const sectionProperties = Array.from(document.getElementsByTagName('*'))
    .filter((element) => element.localName === 'sectPr')
    .at(-1);
  if (sectionProperties == null) return null;

  const pageSize = findChild(sectionProperties, 'pgSz');
  if (pageSize == null) return null;
  let widthTwips = positiveInteger(attributeByLocalName(pageSize, 'w'));
  let heightTwips = positiveInteger(attributeByLocalName(pageSize, 'h'));
  if (widthTwips == null || heightTwips == null) return null;

  const orientation = attributeByLocalName(pageSize, 'orient');
  if (
    (orientation === 'landscape' && widthTwips < heightTwips) ||
    (orientation === 'portrait' && widthTwips > heightTwips)
  ) {
    [widthTwips, heightTwips] = [heightTwips, widthTwips];
  }

  return { widthTwips, heightTwips };
}
