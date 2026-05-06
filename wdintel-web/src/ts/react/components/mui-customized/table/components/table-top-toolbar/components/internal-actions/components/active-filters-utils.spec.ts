import { describe, expect, it } from 'vitest';

import type { MRT_TableInstance } from 'material-react-table';

import { formatFilterValuePreview, getActiveTableFilters, resolveFilterLabel } from './active-filters-utils';

function buildTable(overrides: Partial<MRT_TableInstance<any>> = {}): MRT_TableInstance<any> {
  const table = {
    getState: () => ({
      columnFilters: [{ id: 'status', value: ['open', 'closed'] }],
      globalFilter: 'search text',
    }),
    getColumn: (columnId: string) =>
      columnId === 'status'
        ? ({
            columnDef: {
              header: 'Статус',
            },
          } as any)
        : columnId === 'developing'
          ? ({
              columnDef: {
                header: 'Статус',
                meta: {
                  activeFilterDefaultValue: ['Відомий'],
                },
              },
            } as any)
        : undefined,
    ...overrides,
  };

  return table as MRT_TableInstance<any>;
}

describe('active-filters utils', () => {
  it('formats previews for common value shapes', () => {
    expect(formatFilterValuePreview('long text')).toBe('long text');
    expect(formatFilterValuePreview(['one', 'two', 'three', 'four'])).toBe('one, two, three +1');
    expect(formatFilterValuePreview({ foo: 'bar' })).toBe('Складене значення');
  });

  it('resolves column labels from MRT headers and falls back to ids', () => {
    const table = buildTable();

    expect(resolveFilterLabel(table, 'status')).toBe('Статус');
    expect(resolveFilterLabel(table, 'missing')).toBe('missing');
  });

  it('collects column and global filters', () => {
    const table = buildTable();

    expect(
      getActiveTableFilters(
        table,
        [
          { id: 'status', value: ['open', 'closed'] },
        ],
        'search text',
      ),
    ).toEqual([
      {
        id: 'status',
        label: 'Статус',
        value: ['open', 'closed'],
        valuePreview: 'open, closed',
        isGlobalFilter: false,
      },
      {
        id: '__global_filter__',
        label: 'Глобальний пошук',
        value: 'search text',
        valuePreview: 'search text',
        isGlobalFilter: true,
      },
    ]);
  });

  it('skips filters that match the configured default active value', () => {
    const table = buildTable({
      getState: () => ({
        columnFilters: [{ id: 'developing', value: ['Відомий'] }],
        globalFilter: '',
      }),
      getColumn: (columnId: string) =>
        columnId === 'developing'
          ? ({
              columnDef: {
                header: 'Статус',
                meta: {
                  activeFilterDefaultValue: ['Відомий'],
                },
              },
            } as any)
          : undefined,
    });

    expect(getActiveTableFilters(table, [{ id: 'developing', value: ['Відомий'] }], '')).toEqual([]);
  });
});
