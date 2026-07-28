/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DeviceFileJournalEntry } from '../../../../../Bindings';
import type { DeviceFileJournalState } from '../use-device-file-journal';
import { DeviceFileJournal } from './DeviceFileJournal';

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
    if (data.length === 0) {
      const renderEmptyRowsFallback = table.renderEmptyRowsFallback as (props: {
        table: Record<string, unknown>;
      }) => ReactNode;
      return renderEmptyRowsFallback({
        table: {
          getState: () => ({ globalFilter: '', columnFilters: [] }),
          setColumnFilters: vi.fn(),
          setGlobalFilter: vi.fn(),
        },
      });
    }
    return (
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
  },
}));

vi.mock('../../../components/mui-customized/table/custom-styles', () => ({
  getDefaultMrtPaperProps: () => ({ sx: {} }),
  getDefaultMrtContainerProps: () => ({ sx: {} }),
}));

vi.mock('../../../components/mui-customized/table/get-default-table-options', () => ({
  getDefaultMRTOptions: () => ({}),
  renderDefaultMrtEmptyRowsFallback: ({ noDataMessage }: { noDataMessage: string }) => (
    <div>{noDataMessage}</div>
  ),
}));

const entry: DeviceFileJournalEntry = {
  fileId: '018f0000-0000-7000-8000-000000000001',
  name: 'report.log',
  absolutePath: '/var/log/report.log',
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
    root?.render(<DeviceFileJournal journal={journal} />);
  });
}

describe('DeviceFileJournal', () => {
  it('renders exactly the requested technical columns and file values', () => {
    renderJournal(journalState());

    const headers = Array.from(container?.querySelectorAll('th') ?? []).map(
      (header) => header.textContent,
    );
    expect(headers).toEqual(['Назва файлу', 'Шлях до файлу', 'Дата й час синхронізації']);
    expect(container?.textContent).toContain('report.log');
    expect(container?.textContent).toContain('/var/log/report.log');
    expect(container?.textContent).not.toContain(entry.synchronizedAt);
    const countStatus = container?.querySelector('[role="status"]');
    expect(countStatus?.getAttribute('aria-label')?.replace(/\s/g, ' ')).toBe(
      'Показано 1 з 12 345 файлів',
    );
    expect(countStatus?.textContent?.replace(/\s/g, ' ')).toContain('1 з 12 345 файлів');
  });

  it('shows the empty state when no files have been synchronized', () => {
    renderJournal(journalState({ entries: [], totalCount: 0 }));

    expect(container?.textContent).toContain('Синхронізованих файлів ще немає');
  });

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

  it('loads the next journal page on demand', () => {
    const loadMore = vi.fn().mockResolvedValue(undefined);
    renderJournal(journalState({ totalCount: 2, nextCursor: 'next', loadMore }));

    const loadMoreButton = Array.from(container?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent === 'Завантажити ще',
    );
    act(() => loadMoreButton?.click());
    expect(loadMore).toHaveBeenCalledTimes(1);
  });
});
