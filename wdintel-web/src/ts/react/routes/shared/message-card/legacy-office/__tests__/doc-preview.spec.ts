import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { LegacyOfficePreviewError, LegacyOfficePreviewErrorCode } from '../legacy-office-errors';
import { buildDocPreview } from '../doc-preview';
import {
  LEGACY_OFFICE_MAX_DOC_TABLE_CELLS,
  LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
  LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from '../legacy-office-limits';
import { validateDocPreviewResult } from '../legacy-office-preview.types';

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
    const buffer = await fixtureBuffer('structured-document.doc');
    const preview = buildDocPreview(buffer);
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
    const lists = preview.blocks.filter((block) => block.type === 'list');
    expect(lists.flatMap((list) => list.items.map((item) => item.marker))).toEqual(
      expect.arrayContaining(['1.', '2.', '•']),
    );
  });

  it('keeps multi-paragraph table cells and surrounding paragraphs in the generated DOC fixture', async () => {
    const buffer = await fixtureBuffer('table-cell-paragraphs.doc');
    const candidate = (
      globalThis as typeof globalThis & {
        __echoLegacyDocToText?: { model?: (input: ArrayBuffer) => { body?: unknown } | null };
      }
    ).__echoLegacyDocToText;
    const body = candidate?.model?.(buffer)?.body as
      Array<{ kind?: string; runs?: Array<{ text?: string }> }> | undefined;
    const preview = buildDocPreview(buffer);

    expect(
      body?.map((paragraph) => ({
        kind: paragraph.kind,
        text: paragraph.runs?.map((run) => run.text ?? '').join(''),
      })),
    ).toEqual([
      { kind: 'p', text: 'Before the table' },
      { kind: 'cellPart', text: 'First cell paragraph one' },
      { kind: 'cell', text: 'First cell paragraph two' },
      { kind: 'cell', text: 'Middle cell' },
      { kind: 'rowEnd', text: 'Last cell' },
      { kind: 'cell', text: '' },
      { kind: 'rowEnd', text: 'Second row cell' },
      { kind: 'p', text: 'After the table' },
    ]);
    expect(preview.blocks).toContainEqual({ type: 'paragraph', text: 'Before the table' });
    expect(preview.blocks).toContainEqual({ type: 'paragraph', text: 'After the table' });
    expect(preview.blocks).toContainEqual({
      type: 'table',
      rows: [
        [
          { text: 'First cell paragraph one\nFirst cell paragraph two' },
          { text: 'Middle cell' },
          { text: 'Last cell' },
        ],
        [{ text: '' }, { text: 'Second row cell' }],
      ],
    });
  });

  it('retains the exact row widths of the existing DOC fixtures', async () => {
    const widths = async (name: string) =>
      buildDocPreview(await fixtureBuffer(name))
        .blocks.filter((block) => block.type === 'table')
        .map((block) => block.rows.map((row) => row.length));

    await expect(widths('jsdoc-feature-showcase.doc')).resolves.toEqual([[1, 3, 3, 3, 3, 2]]);
    await expect(widths('structured-document.doc')).resolves.toEqual([[2, 2], [2]]);
  });

  it('keeps surrounding paragraphs outside tables and joins cell paragraphs safely', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    const reader = Object.assign(() => null, {
      model: () => ({
        body: [
          { kind: 'p', runs: [{ text: 'До таблиці' }] },
          { kind: 'cellPart', runs: [{ text: 'Перший абзац' }] },
          { kind: 'cell', runs: [{ text: 'Другий абзац' }] },
          { kind: 'rowEnd', runs: [{ text: 'Інша комірка' }] },
          { kind: 'p', runs: [{ text: 'Після таблиці' }] },
        ],
      }),
    });
    globalReader.__echoLegacyDocToText = reader;
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      expect(preview.blocks).toEqual([
        { type: 'paragraph', text: 'До таблиці' },
        {
          type: 'table',
          rows: [[{ text: 'Перший абзац\nДругий абзац' }, { text: 'Інша комірка' }]],
        },
        { type: 'paragraph', text: 'Після таблиці' },
      ]);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  // Regression: ECHO-2769
  it('preserves generated list markers without inferring their format', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    globalReader.__echoLegacyDocToText = Object.assign(() => null, {
      model: () => ({
        body: [
          { kind: 'p', list: { kind: 'number', ilvl: 0, marker: '5.' }, runs: [{ text: 'five' }] },
          { kind: 'p', list: { kind: 'number', ilvl: 1, marker: 'B)' }, runs: [{ text: 'beta' }] },
        ],
      }),
    });
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      expect(preview.blocks).toEqual([
        {
          type: 'list',
          ordered: true,
          items: [
            { level: 0, marker: '5.', text: 'five' },
            { level: 1, marker: 'B)', text: 'beta' },
          ],
        },
      ]);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  it('truncates combined cell text and prevents the 50,001st cell from crossing the boundary', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    const reader = Object.assign(() => null, {
      model: () => ({
        body: [
          {
            kind: 'cellPart',
            runs: [{ text: 'a'.repeat(LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) }],
          },
          { kind: 'rowEnd', runs: [{ text: 'b' }] },
          ...Array.from({ length: LEGACY_OFFICE_MAX_DOC_TABLE_CELLS }, () => ({
            kind: 'rowEnd',
            runs: [{ text: 'c' }],
          })),
        ],
      }),
    });
    globalReader.__echoLegacyDocToText = reader;
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      const cells = preview.blocks
        .filter((block) => block.type === 'table')
        .flatMap((block) => block.rows.flat());
      expect(cells).toHaveLength(LEGACY_OFFICE_MAX_DOC_TABLE_CELLS);
      expect(cells[0]?.text).toHaveLength(LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS);
      expect(preview.truncated).toBe(true);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  it('bounds joined cell paragraphs by the remaining global text capacity', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    const precedingTextLength = LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - 10;
    const precedingParagraphs = Array.from(
      { length: Math.ceil(precedingTextLength / LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) },
      (_, index) => ({
        kind: 'p',
        runs: [
          {
            text: 'a'.repeat(
              Math.min(
                LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
                precedingTextLength - index * LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
              ),
            ),
          },
        ],
      }),
    );
    const reader = Object.assign(() => null, {
      model: () => ({
        body: [
          ...precedingParagraphs,
          { kind: 'cellPart', runs: [{ text: 'aaaaa' }] },
          { kind: 'rowEnd', runs: [{ text: 'bbbbb' }] },
          { kind: 'p', runs: [{ text: 'must not be emitted' }] },
        ],
      }),
    });
    globalReader.__echoLegacyDocToText = reader;
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      const emittedText = preview.blocks.reduce(
        (total, block) =>
          total +
          (block.type === 'paragraph'
            ? block.text.length
            : block.type === 'list'
              ? block.items.reduce((itemTotal, item) => itemTotal + item.text.length, 0)
              : block.rows.flat().reduce((cellTotal, cell) => cellTotal + cell.text.length, 0)),
        0,
      );

      expect(emittedText).toBe(LEGACY_OFFICE_MAX_TEXT_CODE_UNITS);
      expect(preview.blocks.at(-1)).toEqual({
        type: 'table',
        rows: [[{ text: 'aaaaa\nbbbb' }]],
      });
      expect(preview.truncated).toBe(true);
      expect(validateDocPreviewResult(preview)).toEqual(preview);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  it.each([
    [
      'paragraph',
      { kind: 'p', runs: [{ text: 'final' }] },
      { kind: 'p', runs: [{ text: 'later' }] },
    ],
    [
      'list item',
      { kind: 'p', list: { kind: 'bullet', ilvl: 0 }, runs: [{ text: 'final' }] },
      { kind: 'p', list: { kind: 'bullet', ilvl: 0 }, runs: [{ text: 'later' }] },
    ],
  ])('bounds the final %s by the global text capacity', async (_name, finalBlock, laterBlock) => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    const precedingTextLength = LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - 3;
    const precedingParagraphs = Array.from(
      { length: Math.ceil(precedingTextLength / LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) },
      (_, index) => ({
        kind: 'p',
        runs: [
          {
            text: 'a'.repeat(
              Math.min(
                LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
                precedingTextLength - index * LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
              ),
            ),
          },
        ],
      }),
    );
    const reader = Object.assign(() => null, {
      model: () => ({ body: [...precedingParagraphs, finalBlock, laterBlock] }),
    });
    globalReader.__echoLegacyDocToText = reader;
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      const emittedText = preview.blocks.reduce(
        (total, block) =>
          total +
          (block.type === 'paragraph'
            ? block.text.length
            : block.type === 'list'
              ? block.items.reduce((itemTotal, item) => itemTotal + item.text.length, 0)
              : block.rows.flat().reduce((cellTotal, cell) => cellTotal + cell.text.length, 0)),
        0,
      );

      expect(emittedText).toBe(LEGACY_OFFICE_MAX_TEXT_CODE_UNITS);
      expect(preview.blocks.at(-1)).toEqual(
        finalBlock.list == null
          ? { type: 'paragraph', text: 'fin' }
          : { type: 'list', ordered: false, items: [{ level: 0, marker: '', text: 'fin' }] },
      );
      expect(JSON.stringify(preview)).not.toContain('later');
      expect(preview.truncated).toBe(true);
      expect(validateDocPreviewResult(preview)).toEqual(preview);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  // Regression: ECHO-2769
  it('truncates list text after counting its marker against the global budget', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    const length = LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - 4;
    const preceding = Array.from(
      { length: Math.ceil(length / LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS) },
      (_, index) => ({
        kind: 'p',
        runs: [
          {
            text: 'a'.repeat(
              Math.min(
                LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
                length - index * LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
              ),
            ),
          },
        ],
      }),
    );
    globalReader.__echoLegacyDocToText = Object.assign(() => null, {
      model: () => ({
        body: [
          ...preceding,
          { kind: 'p', list: { kind: 'number', ilvl: 0, marker: '5.' }, runs: [{ text: 'final' }] },
          { kind: 'p', runs: [{ text: 'later' }] },
        ],
      }),
    });
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      expect(preview.blocks.at(-1)).toEqual({
        type: 'list',
        ordered: true,
        items: [{ level: 0, marker: '5.', text: 'fi' }],
      });
      expect(preview.truncated).toBe(true);
      expect(JSON.stringify(preview)).not.toContain('later');
      expect(validateDocPreviewResult(preview)).toEqual(preview);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
  });

  it('truncates oversized list markers independently of item text', async () => {
    const globalReader = globalThis as typeof globalThis & { __echoLegacyDocToText?: unknown };
    const originalReader = globalReader.__echoLegacyDocToText;
    globalReader.__echoLegacyDocToText = Object.assign(() => null, {
      model: () => ({
        body: [
          {
            kind: 'p',
            list: {
              kind: 'number',
              ilvl: 0,
              marker: 'x'.repeat(LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS + 1),
            },
            runs: [{ text: 'safe' }],
          },
        ],
      }),
    });
    try {
      const preview = buildDocPreview(await fixtureBuffer('structured-document.doc'));
      expect(preview).toEqual({
        blocks: [
          {
            type: 'list',
            ordered: true,
            items: [
              {
                level: 0,
                marker: 'x'.repeat(LEGACY_OFFICE_MAX_LIST_MARKER_CODE_UNITS),
                text: 'safe',
              },
            ],
          },
        ],
        truncated: true,
      });
      expect(validateDocPreviewResult(preview)).toEqual(preview);
    } finally {
      globalReader.__echoLegacyDocToText = originalReader;
    }
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
