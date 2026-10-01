import { describe, expect, it } from 'vitest';

import { validateDocPreviewResult, validateXlsPreviewResult } from '../legacy-office-preview.types';
import {
  LEGACY_OFFICE_MAX_CELLS,
  LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
  LEGACY_OFFICE_MAX_TEXT_CODE_UNITS,
} from '../legacy-office-limits';

describe('legacy Office worker response validation', () => {
  it('rejects unknown XLS response properties', () => {
    expect(
      validateXlsPreviewResult({
        sheets: [],
        truncated: false,
        unexpected: true,
      }),
    ).toBeNull();
  });

  it('counts empty XLS slots toward the transferable-cell limit', () => {
    const row = Array.from({ length: 100 }, () => '');
    const rows = Array.from({ length: LEGACY_OFFICE_MAX_CELLS / row.length + 1 }, () => row);
    expect(
      validateXlsPreviewResult({
        sheets: [
          {
            name: 'Sparse',
            rows,
            rowCount: rows.length,
            columnCount: row.length,
            truncated: true,
          },
        ],
        truncated: true,
      }),
    ).toBeNull();
  });

  it('rejects unknown DOC block properties', () => {
    expect(
      validateDocPreviewResult({
        blocks: [{ type: 'paragraph', text: 'safe', html: '<b>unsafe</b>' }],
        truncated: false,
      }),
    ).toBeNull();
  });

  it('rejects empty and extended nested DOC structures', () => {
    expect(
      validateDocPreviewResult({
        blocks: [{ type: 'list', ordered: false, items: [] }],
        truncated: false,
      }),
    ).toBeNull();
    expect(
      validateDocPreviewResult({
        blocks: [{ type: 'table', rows: [[{ text: 'safe', html: '<b>unsafe</b>' }]] }],
        truncated: false,
      }),
    ).toBeNull();
  });

  // Regression: ECHO-2769
  it('requires bounded list markers and counts them as text output', () => {
    const list = (marker: unknown) => ({
      blocks: [{ type: 'list', ordered: true, items: [{ level: 0, marker, text: 'safe' }] }],
      truncated: false,
    });
    expect(validateDocPreviewResult(list(undefined))).toBeNull();
    expect(validateDocPreviewResult(list(1))).toBeNull();
    expect(validateDocPreviewResult(list('a'.repeat(257)))).toBeNull();
    expect(
      validateDocPreviewResult({
        ...list('1.'),
        blocks: [
          {
            type: 'list',
            ordered: true,
            items: [{ level: 0, marker: '1.', text: 'safe', unexpected: true }],
          },
        ],
      }),
    ).toBeNull();
    const items = Array.from(
      {
        length: Math.ceil(
          LEGACY_OFFICE_MAX_TEXT_CODE_UNITS / LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
        ),
      },
      (_, index) => ({
        level: 0,
        marker: '',
        text: 'a'.repeat(
          Math.min(
            LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
            LEGACY_OFFICE_MAX_TEXT_CODE_UNITS - index * LEGACY_OFFICE_MAX_ITEM_TEXT_CODE_UNITS,
          ),
        ),
      }),
    );
    const bounded = { blocks: [{ type: 'list', ordered: true, items }], truncated: false };
    expect(validateDocPreviewResult(bounded)).toEqual(bounded);
    expect(
      validateDocPreviewResult({
        ...bounded,
        blocks: [
          { type: 'list', ordered: true, items: items.map((item) => ({ ...item, marker: '1' })) },
        ],
      }),
    ).toBeNull();
  });
});
