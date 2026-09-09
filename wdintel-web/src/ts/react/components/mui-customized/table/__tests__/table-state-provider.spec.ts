/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { normalizeColumnOrder } from '../table-state-provider.tsx';

// @test-scope safeguard: prevents stale persisted table layouts from corrupting the visible data-column order
describe('normalizeColumnOrder', () => {
  it('keeps row numbers before actions while preserving the data column order', () => {
    expect(
      normalizeColumnOrder(
        ['mrt-row-actions', 'mrt-row-numbers', 'callsign', 'position'],
        ['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position'],
      ),
    ).toEqual(['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position']);
  });

  it('falls back to the default order when the column sets do not match', () => {
    expect(
      normalizeColumnOrder(
        ['mrt-row-actions', 'mrt-row-numbers', 'callsign'],
        ['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position'],
      ),
    ).toEqual(['mrt-row-numbers', 'mrt-row-actions', 'callsign', 'position']);
  });
});
