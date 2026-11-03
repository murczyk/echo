import { describe, expect, it } from 'vitest';

import { normalizeColumnOrder } from '../../../components/mui-customized/table/table-state-provider.tsx';
import {
  customFieldColumnId,
  isCustomFieldColumnId,
  mergeCustomFieldColumnOrder,
} from '../helpers';

const DEFAULT_ORDER = ['mrt-row-numbers', 'mrt-row-actions', 'name', 'rating', 'tags'];
const DEVICE_ID = customFieldColumnId('device_id');
const SERIAL = customFieldColumnId('serial');

describe('mergeCustomFieldColumnOrder', () => {
  it('places new custom field columns right after name by default', () => {
    expect(mergeCustomFieldColumnOrder(DEFAULT_ORDER, [DEVICE_ID, SERIAL])).toEqual([
      'mrt-row-numbers',
      'mrt-row-actions',
      'name',
      DEVICE_ID,
      SERIAL,
      'rating',
      'tags',
    ]);
  });

  it('keeps stored custom field positions and appends new keys after the last one', () => {
    const stored = ['mrt-row-numbers', 'mrt-row-actions', 'name', 'rating', 'tags', DEVICE_ID];

    expect(mergeCustomFieldColumnOrder(stored, [DEVICE_ID, SERIAL])).toEqual([...stored, SERIAL]);
  });

  it('drops columns of custom field keys that no longer exist', () => {
    const stored = ['mrt-row-numbers', 'mrt-row-actions', 'name', SERIAL, 'rating', 'tags'];

    expect(mergeCustomFieldColumnOrder(stored, [])).toEqual(DEFAULT_ORDER);
  });
});

describe('normalizeColumnOrder with dynamic custom field columns', () => {
  it('preserves the stored position of custom field columns', () => {
    const stored = ['mrt-row-numbers', 'mrt-row-actions', 'tags', 'name', DEVICE_ID, 'rating'];

    expect(normalizeColumnOrder(stored, DEFAULT_ORDER, isCustomFieldColumnId)).toEqual(stored);
  });

  it('still falls back to the default when static columns changed', () => {
    const stored = ['mrt-row-numbers', 'mrt-row-actions', 'name', DEVICE_ID, 'rating'];

    expect(normalizeColumnOrder(stored, DEFAULT_ORDER, isCustomFieldColumnId)).toEqual(
      DEFAULT_ORDER,
    );
  });

  it('resets unknown columns when no dynamic predicate is given', () => {
    const stored = ['mrt-row-numbers', 'mrt-row-actions', 'name', DEVICE_ID, 'rating', 'tags'];

    expect(normalizeColumnOrder(stored, DEFAULT_ORDER)).toEqual(DEFAULT_ORDER);
  });
});
