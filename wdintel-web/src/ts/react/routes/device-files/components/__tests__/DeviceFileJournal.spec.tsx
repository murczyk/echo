/**
 * @vitest-environment happy-dom
 */
import { act, type ComponentProps, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileJournalEntry } from '../../../../../../Bindings';
import type { DeviceFileJournalState } from '../../use-device-file-journal';
import { DeviceFileJournal } from '.././DeviceFileJournal';

vi.mock('material-react-table', () => ({
  useMaterialReactTable: (options: Record<string, unknown>) => options,
  MaterialReactTable: ({ table }: { table: Record<string, unknown> }) => {
    const columns = table.columns as Array<{
      accessorKey: keyof DeviceFileJournalEntry;
      header: string;
      Cell?: (props: {
        cell: { getValue: <T>() => T };
        row: { original: DeviceFileJournalEntry };
      }) => ReactNode;
    }>;
    const data = table.data as DeviceFileJournalEntry[];
    const tableContainerProps = table.muiTableContainerProps as ComponentProps<'div'>;
    const content =
      data.length === 0 ? (
        (table.renderEmptyRowsFallback as (props: { table: Record<string, unknown> }) => ReactNode)(
          {
            table: {
              getState: () => ({ globalFilter: '', columnFilters: [] }),
              setColumnFilters: vi.fn(),
              setGlobalFilter: vi.fn(),
            },
          },
        )
      ) : (
        <table aria-label="Журнал синхронізації файлів">
          <thead>
            <tr>
              {columns.map((column) => (
                <th key={column.accessorKey}>{column.header}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.map((row) => (
              <tr key={row.fileId}>
                {columns.map((column) => {
                  const value = row[column.accessorKey];
                  return (
                    <td key={column.accessorKey}>
                      {column.Cell
                        ? column.Cell({
                            cell: { getValue: <T,>() => value as T },
                            row: { original: row },
                          })
                        : String(value)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );

    return (
      <div {...tableContainerProps} data-testid="journal-table-container">
        {content}
      </div>
    );
  },
}));

vi.mock('../../../../components/mui-customized/table/custom-styles', () => ({
  getDefaultMrtPaperProps: () => ({ sx: {} }),
  getDefaultMrtContainerProps: () => ({}),
}));

vi.mock('../../../../components/mui-customized/table/get-default-table-options', () => ({
  getDefaultMRTOptions: () => ({}),
  mrtTextCell: ({ displayValue }: { displayValue: (props: unknown) => ReactNode }) => displayValue,
  mrtItemsCell:
    ({
      items,
      renderItem,
    }: {
      items: (props: any) => unknown[];
      renderItem: (item: any) => ReactNode;
    }) =>
    (props: any) => <>{items(props).map(renderItem)}</>,
  useAppMaterialReactTable: (options: Record<string, unknown>) => ({
    ...options,
    options,
    getState: () => ({ isFullScreen: false }),
  }),
  renderDefaultMrtEmptyRowsFallback: ({ noDataMessage }: { noDataMessage: string }) => (
    <div>{noDataMessage}</div>
  ),
}));

const entry: DeviceFileJournalEntry = {
  fileId: '018f0000-0000-7000-8000-000000000001',
  name: 'report.log',
  absolutePath: '/var/log/report.log',
  hasContent: true,
  tags: [{ id: '018f0000-0000-7000-8000-000000000101', name: 'Звіти' }],
  synchronizedAt: '2026-07-28T08:15:30Z',
};

function journalState(overrides: Partial<DeviceFileJournalState> = {}): DeviceFileJournalState {
  return {
    entries: [entry],
    totalCount: 12_345,
    nextCursor: null,
    loading: false,
    loadingMore: false,
    error: null,
    loadMoreError: null,
    reload: vi.fn().mockResolvedValue(undefined),
    loadMore: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function renderJournal(journal: DeviceFileJournalState) {
  act(() => {
    root?.render(
      <DeviceFileJournal
        journal={journal}
        tagsState={{ tags: entry.tags, loading: false, error: null, reload: vi.fn() }}
        tagFilter={{ tagIds: [], tagMatch: 'any', untagged: false }}
        onTagFilterChange={vi.fn()}
      />,
    );
  });
}

describe('DeviceFileJournal', () => {
  // @test-scope safeguard: keeps file-journal load failures recoverable instead of silently hiding them.
  it('keeps load errors visible and exposes retry actions', () => {
    const reload = vi.fn().mockResolvedValue(undefined);
    renderJournal(
      journalState({
        entries: [],
        totalCount: null,
        error: { message: 'Журнал недоступний', status: 500 },
        reload,
      }),
    );

    expect(container?.textContent).toContain('Журнал недоступний');
    const retryButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Спробувати ще раз',
    );
    act(() => retryButton?.click());
    expect(reload).toHaveBeenCalledTimes(1);
  });

  // @test-scope safeguard: prevents journal pagination from firing before the visible end of the loaded entries.
  it('shows the load-more action only at the end of the journal scroll', () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderJournal(journalState({ totalCount: 2, nextCursor: 'next', loadMore }));

    const tableContainer = container?.querySelector('[data-testid="journal-table-container"]');
    if (!(tableContainer instanceof HTMLDivElement)) {
      throw new Error('Journal table container not found');
    }
    Object.defineProperties(tableContainer, {
      scrollHeight: { configurable: true, value: 600 },
      clientHeight: { configurable: true, value: 200 },
      scrollTop: { configurable: true, writable: true, value: 0 },
    });

    act(() => tableContainer.dispatchEvent(new Event('scroll', { bubbles: true })));
    const loadMoreButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Завантажити ще',
    );
    expect(loadMoreButton?.style.visibility).toBe('hidden');
    expect(loadMoreButton?.getAttribute('aria-hidden')).toBe('true');

    act(() => {
      tableContainer.scrollTop = 400;
      tableContainer.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(loadMoreButton?.style.visibility).toBe('visible');
    expect(loadMoreButton?.getAttribute('aria-hidden')).toBeNull();

    act(() => loadMoreButton?.click());
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
