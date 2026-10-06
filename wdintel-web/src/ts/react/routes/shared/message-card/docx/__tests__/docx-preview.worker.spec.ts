/**
 * @vitest-environment happy-dom
 */
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('mammoth', async () => {
  const mammoth = await import('mammoth/mammoth.browser.js');
  return { default: mammoth.default };
});

const CONTENT_TYPES_XML = `<?xml version="1.0"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml" />
  <Default Extension="xml" ContentType="application/xml" />
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml" />
</Types>`;
const PACKAGE_RELATIONSHIPS_XML = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml" />
</Relationships>`;
const DOCUMENT_RELATIONSHIPS_XML = `<?xml version="1.0"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships" />`;

function createDocx(documentXml: string): ArrayBuffer {
  const archive = zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES_XML),
    '_rels/.rels': strToU8(PACKAGE_RELATIONSHIPS_XML),
    'word/document.xml': strToU8(documentXml),
    'word/_rels/document.xml.rels': strToU8(DOCUMENT_RELATIONSHIPS_XML),
  });

  return archive.buffer.slice(
    archive.byteOffset,
    archive.byteOffset + archive.byteLength,
  ) as ArrayBuffer;
}

function createLandscapeDocx(): ArrayBuffer {
  return createDocx(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Landscape document</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape" /></w:sectPr>
  </w:body>
</w:document>`);
}

describe('docx preview worker', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns the landscape document page size', async () => {
    let messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
    vi.spyOn(self, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') {
        messageHandler = listener as unknown as (event: MessageEvent) => Promise<void>;
      }
    });
    const postMessage = vi.spyOn(self, 'postMessage').mockImplementation(() => {});

    await import('../docx-preview.worker');
    expect(messageHandler).not.toBeNull();

    await messageHandler?.(
      new MessageEvent('message', {
        data: {
          requestId: 'landscape',
          request: { buffer: createLandscapeDocx() },
        },
      }),
    );

    expect(postMessage).toHaveBeenCalledWith({
      requestId: 'landscape',
      ok: true,
      value: {
        html: '<p>Landscape document</p>',
        pageSize: { widthTwips: 16838, heightTwips: 11906 },
      },
    });
  });

  it('keeps the complete preview when section metadata is absent', async () => {
    let messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
    vi.spyOn(self, 'addEventListener').mockImplementation((type, listener) => {
      if (type === 'message') {
        messageHandler = listener as unknown as (event: MessageEvent) => Promise<void>;
      }
    });
    const postMessage = vi.spyOn(self, 'postMessage').mockImplementation(() => {});

    await import('../docx-preview.worker');
    await messageHandler?.(
      new MessageEvent('message', {
        data: {
          requestId: 'no-section-metadata',
          request: {
            buffer: createDocx(`<?xml version="1.0"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>Fallback document</w:t></w:r></w:p></w:body>
</w:document>`),
          },
        },
      }),
    );

    expect(postMessage).toHaveBeenCalledWith({
      requestId: 'no-section-metadata',
      ok: true,
      value: {
        html: '<p>Fallback document</p>',
        pageSize: null,
      },
    });
  });
});
