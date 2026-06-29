import { describe, expect, it } from 'vitest';

import { previewXlsxRows } from './xlsx-preview-utils';

describe('previewXlsxRows', () => {
  it('reports truncation when a sheet has more than 100 columns', () => {
    const rawRows = [
      Array.from({ length: 101 }, (_, index) => index + 1),
      ['tail'],
    ];

    const preview = previewXlsxRows(rawRows);

    expect(preview.rowCount).toBe(2);
    expect(preview.columnCount).toBe(101);
    expect(preview.truncated).toBe(true);
    expect(preview.rows[0]).toHaveLength(100);
  });

  it('reports truncation when a sheet has more than 5000 rows', () => {
    const rawRows = Array.from({ length: 5001 }, (_, index) => [index + 1]);

    const preview = previewXlsxRows(rawRows);

    expect(preview.rowCount).toBe(5001);
    expect(preview.columnCount).toBe(1);
    expect(preview.truncated).toBe(true);
    expect(preview.rows).toHaveLength(5000);
  });
});
