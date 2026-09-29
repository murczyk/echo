import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';
import { buildDocPreview } from '../doc-preview';

async function fixtureBuffer(name: string): Promise<ArrayBuffer> {
  const file = await readFile(resolve(process.cwd(), `tests/fixtures/legacy-office/${name}`));
  return file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength);
}

describe('legacy Word DOC preview', () => {
  it('does not expose the candidate HTML, image, or ancillary-story APIs', async () => {
    const source = await readFile(
      resolve(
        process.cwd(),
        'src/ts/react/routes/shared/message-card/legacy-office/vendor/jsdoc/docToText.js',
      ),
      'utf8',
    );

    expect(source).not.toContain('docToText.html');
    expect(source).not.toContain('docToText.images');
    expect(source).not.toContain('docToText.sections');
    expect(source).not.toContain('extractRangeStyled');
    expect(source).not.toContain('<span style=');
  });

  it('keeps body text in document order and emits application-owned blocks', async () => {
    const preview = buildDocPreview(await fixtureBuffer('jsdoc-feature-showcase.doc'));

    expect(preview.blocks.length).toBeGreaterThan(10);
    expect(preview.blocks.some((block) => block.type === 'paragraph')).toBe(true);
    expect(preview.blocks.some((block) => block.type === 'list')).toBe(true);
    expect(preview.blocks.some((block) => block.type === 'table')).toBe(true);
    expect(
      preview.blocks
        .filter((block) => block.type === 'table')
        .every((block) => block.rows.every((row) => row.length > 0)),
    ).toBe(true);
    expect(JSON.stringify(preview)).not.toContain('<table');
  });

  it('reads the locally generated LibreOffice Writer DOC fixture', async () => {
    const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
    const text = preview.blocks
      .flatMap((block) =>
        block.type === 'paragraph'
          ? [block.text]
          : block.type === 'list'
            ? block.items.map((item) => item.text)
            : block.rows.flat().map((cell) => cell.text),
      )
      .join('\n');

    expect(text).toContain('Український абзац');
    expect(text).toContain('Вкладений пункт');
    expect(text).toContain('Друга таблиця');
    expect(text).toContain('Фінальний абзац');
  });

  it('fails closed for bytes that are not a CFB DOC', () => {
    expect(() => buildDocPreview(new TextEncoder().encode('{\\rtf1}').buffer)).toThrow(
      LegacyOfficePreviewError,
    );
    try {
      buildDocPreview(new TextEncoder().encode('{\\rtf1}').buffer);
    } catch (error) {
      expect((error as LegacyOfficePreviewError).code).toBe(
        LegacyOfficePreviewErrorCode.InvalidCfb,
      );
    }
  });

  it('rejects a cyclic DIFAT directly in the candidate without building a model', async () => {
    const bytes = new Uint8Array(await fixtureBuffer('jsdoc-feature-showcase.doc'));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    view.setUint32(68, 0, true);
    view.setUint32(72, 5_000, true);
    view.setUint32(512 + 127 * 4, 0, true);
    const candidate = (
      globalThis as typeof globalThis & {
        __echoLegacyDocToText?: { model?: (input: ArrayBuffer) => unknown };
      }
    ).__echoLegacyDocToText;

    expect(
      candidate?.model?.(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)),
    ).toBeNull();
  });
});
