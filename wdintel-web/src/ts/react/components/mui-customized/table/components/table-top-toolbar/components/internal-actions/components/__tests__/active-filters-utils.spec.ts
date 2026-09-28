import { describe, expect, it } from 'vitest';

import type { MRT_TableInstance } from 'material-react-table';

import { getActiveTableFilters } from '../active-filters-utils.ts';

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
  it('collects column and global filters', () => {
    const table = buildTable();

    expect(
      getActiveTableFilters(table, [{ id: 'status', value: ['open', 'closed'] }], 'search text'),
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

  it('uses the active-filter formatter from column meta when available', () => {
    const table = buildTable({
      getState: () => ({
        columnFilters: [{ id: 'status', value: ['open', 'closed'] }],
        globalFilter: '',
      }),
      getColumn: (columnId: string) =>
        columnId === 'status'
          ? ({
              columnDef: {
                header: 'Статус',
                meta: {
                  activeFilterValueFormatter: (value: unknown) =>
                    Array.isArray(value)
                      ? value.map((item) => String(item).toUpperCase()).join(', ')
                      : String(value),
                },
              },
            } as any)
          : undefined,
    });

    expect(getActiveTableFilters(table, [{ id: 'status', value: ['open', 'closed'] }], '')).toEqual(
      [
        {
          id: 'status',
          label: 'Статус',
          value: ['open', 'closed'],
          valuePreview: 'OPEN, CLOSED',
          isGlobalFilter: false,
        },
      ],
    );
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

    expect(getActiveTableFilters(table, [{ id: 'developing', value: ['Відомий'] }], '')).toEqual(
      [],
    );
  });
});
