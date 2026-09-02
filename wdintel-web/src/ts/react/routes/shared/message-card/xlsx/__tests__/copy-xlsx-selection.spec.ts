import { describe, expect, it } from 'vitest';

import { copyXlsxSelection } from '../copy-xlsx-selection';

// @test-scope safeguard: prevents spreadsheet selection copy from silently dropping structured cell content.
describe('copyXlsxSelection', () => {
  it('serializes the selected cell range as TSV', () => {
    expect(
      copyXlsxSelection(
        [
          ['A1', 'B1'],
          ['A2', 'B2'],
        ],
        { startRow: 0, endRow: 1, startColumn: 0, endColumn: 1 },
      ),
    ).toBe('A1\tB1\nA2\tB2');
  });
});
