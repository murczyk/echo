import { describe, expect, it } from 'vitest';

import { validateDocPreviewResult, validateXlsPreviewResult } from '../legacy-office-preview.types';

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
});
