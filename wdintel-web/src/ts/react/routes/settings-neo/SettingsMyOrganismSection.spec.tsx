/**
 * @vitest-environment happy-dom
 */
import React from 'react';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TagAdmin } from '../../../../Bindings';

const listCurrentOrganismTagsMock = vi.hoisted(() => vi.fn());

vi.mock('@mui/material', () => ({
  Box: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  CircularProgress: () => <span>loading</span>,
  Stack: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));

type MrtColumn = {
  header?: ReactNode;
  accessorKey?: string;
  accessorFn?: (row: Record<string, unknown>) => ReactNode;
};

vi.mock('./SettingsNeoTable', () => ({
  SettingsNeoTable: ({
    columns,
    data,
  }: {
    columns: MrtColumn[];
    data: Array<Record<string, unknown>>;
  }) => (
    <table>
      <tbody>
        {data.map((row, rowIndex) => (
          <tr key={rowIndex}>
            {columns.map((column, columnIndex) => (
              <td key={columnIndex}>
                {column.accessorFn
                  ? column.accessorFn(row)
                  : column.accessorKey
                    ? String(row[column.accessorKey] ?? '')
                    : null}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  ),
}));

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  useTableStateContext: () => ({ globalFilter: '', onChangeGlobalFilter: () => {} }),
}));

vi.mock(
  '../../components/mui-customized/table/components/table-top-toolbar/components/global-filter-text-field',
  () => ({
    GlobalFilterTextField: ({ globalFilter }: { globalFilter: string }) => (
      <input aria-label="Пошук" value={globalFilter} readOnly />
    ),
  }),
);

vi.mock('../../services/api/tags', () => ({
  listCurrentOrganismTags: listCurrentOrganismTagsMock,
}));

import { SettingsMyOrganismSection } from './SettingsMyOrganismSection';

function renderSection() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  return { container, root };
}

const organismTag: TagAdmin = {
  tagId: 10,
  label: 'оброблено',
  extra: true,
  ord: 1,
  enabled: true,
  keywords: [],
  isPalitra: false,
  ownerOrganismId: 7,
};

describe('SettingsMyOrganismSection', () => {
  let view: ReturnType<typeof renderSection>;

  beforeEach(() => {
    listCurrentOrganismTagsMock.mockReset();
    view = renderSection();
  });

  afterEach(async () => {
    await act(async () => {
      view.root.unmount();
      await Promise.resolve();
    });
    view.container.remove();
  });

  it('shows help text and enabled organism tags in an MRT table', async () => {
    listCurrentOrganismTagsMock.mockResolvedValueOnce([organismTag]);

    await act(async () => {
      view.root.render(<SettingsMyOrganismSection />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('Теги організму — це спільні теги');
    expect(view.container.textContent).toContain('оброблено');
    expect(view.container.textContent).toContain('так'); // extra: true
    expect(view.container.textContent).toContain('ні'); // isPalitra: false
    expect(view.container.querySelector('table')).not.toBeNull();
  });

  it('shows an empty state when there are no organism tags', async () => {
    listCurrentOrganismTagsMock.mockResolvedValueOnce([]);

    await act(async () => {
      view.root.render(<SettingsMyOrganismSection />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain('У вашого організму ще немає активних тегів');
  });

  it('shows an error state when loading fails', async () => {
    listCurrentOrganismTagsMock.mockRejectedValueOnce(new Error('No organism'));

    await act(async () => {
      view.root.render(<SettingsMyOrganismSection />);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(view.container.textContent).toContain(
      'Помилка завантаження тегів організму: No organism',
    );
  });
});
