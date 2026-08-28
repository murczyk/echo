/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReportHistoryTableSection, SettingsMyReportsSection } from './SettingsMyReportsSection';
import {
  downloadReportHistory,
  isCancelledReportHistory,
  rerunSuccessfulReportHistory,
} from '../../services/api/report-history';
import { downloadBlob } from '../../utils/download-blob';

const sampleRunningRow = {
  id: 1501,
  reportKind: 'etalonka',
  requestedBy: 'alice',
  createdAt: '2026-06-26 16:45:00',
  status: 'in_progress',
  errorStatus: '',
  completedAt: null,
  hasFile: false,
  fileName: null,
  contentType: null,
  bgtaskId: 1347,
  lastError: null,
  isCancelled: false,
  details: 'desc',
  reportPeriod: null,
  progress: 20,
  errorLog: null,
  startedAt: '2026-06-26 16:45:00',
  plannedForTs: null,
  queuePosition: 1,
  blockedByReportId: null,
  blockedByStartedAt: null,
  blockedByBgtaskId: null,
};

let sampleActionRow = sampleRunningRow;

let capturedTableStateProviderProps: Record<string, unknown> | null = null;
let capturedSettingsNeoTableProps: Record<string, unknown> | null = null;
let capturedDangerDialogProps: Record<string, unknown> | null = null;

vi.mock('../../services/api/report-history', () => ({
  listReportHistory: vi.fn(async () => []),
  downloadReportHistory: vi.fn(),
  retryReportHistory: vi.fn(),
  rerunSuccessfulReportHistory: vi.fn(),
  cancelReportHistory: vi.fn(),
  isCancelledReportHistory: (row: {
    status: string;
    lastError: string | null | undefined;
    isCancelled: boolean;
  }) =>
    row.isCancelled === true ||
    (row.status === 'failed' && (row.lastError ?? '').includes('Скасовано користувачем')),
  parseUtcDateTime: vi.fn((value: string | null) => {
    if (value === null || value.trim() === '') return null;
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  }),
}));

vi.mock('../../utils/download-blob', () => ({
  downloadBlob: vi.fn(),
}));

vi.mock('../rer-network-details-neo/use-rer-network-details-neo-page.helpers', () => ({
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'error'),
}));

vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));

vi.mock('../../components/MrtRowActionButton', () => ({
  MrtRowActionButton: ({ label, onClick }: { label: string; onClick: () => void }) => (
    <button type="button" aria-label={label} onClick={onClick}>
      {label}
    </button>
  ),
  MrtRowActions: ({ children }: { children?: ReactNode }) => <div aria-label="Дії">{children}</div>,
  mrtRowActionsColumnSize: () => 64,
}));

vi.mock('../../components/ConfirmDangerDialog', () => ({
  ConfirmDangerDialog: (props: Record<string, unknown>) => {
    capturedDangerDialogProps = props;
    return <div data-testid="confirm-danger-dialog" />;
  },
}));

vi.mock('../../components/mui-customized/table/table-state-provider', () => ({
  TableStateProvider: (props: { children?: ReactNode; [key: string]: unknown }) => {
    capturedTableStateProviderProps = props;
    return <>{props.children}</>;
  },
}));

vi.mock(
  '../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions',
  () => ({
    InternalTableActions: ({ children }: { children?: ReactNode }) => (
      <div data-testid="table-actions">{children}</div>
    ),
  }),
);

vi.mock('./SettingsNeoTable', () => ({
  SettingsNeoTable: (props: Record<string, unknown>) => {
    capturedSettingsNeoTableProps = props;
    const columns = (props.columns as Array<Record<string, any>>) ?? [];
    const actionsColumn = columns.find((column) => column.id === 'actions');
    const cell =
      typeof actionsColumn?.Cell === 'function'
        ? actionsColumn.Cell({ row: { original: sampleActionRow } } as never)
        : null;
    return <div data-testid="settings-neo-table">{cell}</div>;
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  capturedTableStateProviderProps = null;
  capturedSettingsNeoTableProps = null;
  capturedDangerDialogProps = null;
  sampleActionRow = sampleRunningRow;
  vi.mocked(downloadReportHistory).mockReset();
  vi.mocked(downloadBlob).mockReset();
  vi.mocked(rerunSuccessfulReportHistory).mockReset();
});

describe('SettingsMyReportsSection', () => {
  it('uses a fixed actions column, toolbar controls, and a reset table id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SettingsMyReportsSection active />);
    });

    const columns =
      (capturedSettingsNeoTableProps?.columns as Array<Record<string, unknown>>) ?? [];
    const actionsColumn = columns.find((column) => column.id === 'actions') as
      Record<string, unknown> | undefined;
    expect(capturedSettingsNeoTableProps?.enableRowActions).toBeUndefined();
    expect(capturedSettingsNeoTableProps?.showToolbarInternalActions).toBe(true);
    expect(capturedSettingsNeoTableProps?.enableTopToolbar).toBe(true);
    expect(capturedSettingsNeoTableProps?.toolbarFiltersHidden).toBe(true);
    expect(capturedSettingsNeoTableProps?.toolbarFullScreenEnabled).toBe(true);
    expect(capturedSettingsNeoTableProps?.toolbarAdditionalActions).toBeUndefined();
    expect(capturedSettingsNeoTableProps?.renderRowActions).toBeUndefined();
    expect(capturedSettingsNeoTableProps?.layoutMode).toBe('grid');
    expect(container.querySelector('[data-testid="table-actions"]')).toBeTruthy();
    expect(actionsColumn).toBeTruthy();
    expect(actionsColumn?.header).toBe('Дії');
    expect(actionsColumn?.enableResizing).toBe(false);
    expect(actionsColumn?.enableHiding).toBe(false);
    expect(container.querySelector('[aria-label="Дії"]')).toBeTruthy();
    expect(columns.some((column) => column.id === 'mrt-row-actions')).toBe(false);

    const plannedForTsColumn = columns.find((column) => column.accessorKey === 'plannedForTs');
    const startedAtColumn = columns.find((column) => column.accessorKey === 'startedAt');
    const queuePositionColumn = columns.find((column) => column.accessorKey === 'queuePosition');
    const createdAtColumn = columns.find((column) => column.accessorKey === 'createdAt');
    const statusColumn = columns.find((column) => column.id === 'status');
    const errorStatusColumn = columns.find((column) => column.accessorKey === 'errorStatus');
    const requestedByColumn = columns.find((column) => column.accessorKey === 'requestedBy');
    const bgtaskIdColumn = columns.find((column) => column.accessorKey === 'bgtaskId');
    const completedAtColumn = columns.find((column) => column.accessorKey === 'completedAt');
    const reportKindColumn = columns.find((column) => column.id === 'reportKind') as
      Record<string, any> | undefined;

    expect(plannedForTsColumn?.enableSorting).toBe(false);
    expect(plannedForTsColumn?.enableColumnFilter).toBe(false);
    expect(startedAtColumn?.enableSorting).toBe(false);
    expect(startedAtColumn?.enableColumnFilter).toBe(false);
    expect(queuePositionColumn?.enableSorting).toBe(false);
    expect(queuePositionColumn?.enableColumnFilter).toBe(false);

    expect(createdAtColumn?.enableSorting).not.toBe(false);
    expect(createdAtColumn?.enableColumnFilter).not.toBe(false);
    expect(statusColumn?.enableSorting).not.toBe(false);
    expect(statusColumn?.enableColumnFilter).not.toBe(false);
    expect(statusColumn?.size).toBe(90);
    expect(errorStatusColumn?.header).toBe('Статус помилки');
    expect(requestedByColumn?.enableSorting).not.toBe(false);
    expect(requestedByColumn?.enableColumnFilter).not.toBe(false);
    expect(bgtaskIdColumn?.enableSorting).not.toBe(false);
    expect(bgtaskIdColumn?.enableColumnFilter).not.toBe(false);
    expect(completedAtColumn?.enableSorting).not.toBe(false);
    expect(completedAtColumn?.enableColumnFilter).not.toBe(false);
    expect(reportKindColumn?.accessorFn?.({ ...sampleRunningRow, reportKind: 'report_125' })).toBe(
      'Звіт 1.2.5',
    );

    expect(capturedTableStateProviderProps?.defaultColumnOrder).toEqual([
      'mrt-row-numbers',
      'actions',
      'reportKind',
      'reportPeriod',
      'details',
      'createdAt',
      'status',
      'errorStatus',
      'plannedForTs',
      'startedAt',
      'queuePosition',
      'bgtaskId',
      'completedAt',
    ]);

    expect(capturedTableStateProviderProps?.defaultColumnVisibility).toMatchObject({
      actions: true,
      reportKind: true,
      reportPeriod: true,
      details: true,
      createdAt: true,
      status: true,
      errorStatus: true,
      plannedForTs: false,
      startedAt: false,
      queuePosition: true,
      bgtaskId: false,
      completedAt: false,
    });

    expect(capturedTableStateProviderProps?.tableId).toBe('settings-neo-my-reports-v4');
    expect(capturedDangerDialogProps?.title).toBe('Скасування звіту');
    expect(capturedDangerDialogProps?.cancelLabel).toBe('СКАСУВАТИ');
    expect(capturedDangerDialogProps?.confirmLabel).toBe('СКАСУВАТИ ЗВІТ');
    expect(capturedDangerDialogProps?.description).toBe('Звіт буде скасовано і прибрано з черги.');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('pages through batch report history with the analysis pagination control', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const loadReportHistoryBatch = vi.fn(async (req: { offset: number }) => ({
      rows: [sampleRunningRow],
      total: 401,
      hasMore: req.offset < 400,
      nextOffset: req.offset + 200,
    }));

    await act(async () => {
      root.render(
        <ReportHistoryTableSection
          active
          title="Всі звіти"
          tableId="admin-all-reports-v2"
          fullHeight
          loadReportHistoryBatch={loadReportHistoryBatch}
        />,
      );
      await Promise.resolve();
    });

    expect(container.textContent).toContain('1-1 з 401');
    expect(container.textContent).not.toContain('1/401');
    expect(capturedSettingsNeoTableProps?.enableBottomToolbar).toBe(false);

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Наступна сторінка"]')?.click();
      await Promise.resolve();
    });

    expect(loadReportHistoryBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 200, limit: 200 }),
      undefined,
    );
    expect(container.textContent).toContain('201-201 з 401');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('reruns successful reports only when the table opts into the admin action', async () => {
    const completedRow = {
      ...sampleRunningRow,
      status: 'done',
      completedAt: '2026-06-26 17:01:21',
      hasFile: true,
      progress: 100,
    };
    const rerunRow = {
      ...completedRow,
      id: 1502,
      status: 'planned',
      completedAt: null,
      hasFile: false,
      progress: 0,
    };
    sampleActionRow = completedRow;
    vi.mocked(rerunSuccessfulReportHistory).mockResolvedValue(rerunRow);
    const loadReportHistoryBatch = vi.fn(async () => ({
      rows: [completedRow],
      total: 1,
      hasMore: false,
      nextOffset: 1,
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReportHistoryTableSection
          active
          title="Всі звіти"
          tableId="admin-all-reports-v2"
          fullHeight
          loadReportHistoryBatch={loadReportHistoryBatch}
          allowSuccessfulRerun
        />,
      );
      await Promise.resolve();
    });

    const rerunAction = container.querySelector<HTMLButtonElement>(
      '[aria-label="Сформувати повторно"]',
    );
    expect(rerunAction).toBeTruthy();

    await act(async () => {
      rerunAction?.click();
      await Promise.resolve();
    });

    expect(rerunSuccessfulReportHistory).toHaveBeenCalledWith(completedRow.id);
    expect(loadReportHistoryBatch).toHaveBeenCalledTimes(2);
    expect(loadReportHistoryBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, limit: 200 }),
      undefined,
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  // @test-scope safeguard: prevents a completed report download from leaving its history row stale
  it('refreshes batch report history after downloading a report', async () => {
    const completedRow = {
      ...sampleRunningRow,
      status: 'done',
      completedAt: '2026-06-26 17:01:21',
      hasFile: true,
      fileName: 'report.xlsx',
      progress: 100,
    };
    sampleActionRow = completedRow;
    const blob = new Blob();
    vi.mocked(downloadReportHistory).mockResolvedValue(blob);
    const loadReportHistoryBatch = vi.fn(async () => ({
      rows: [completedRow],
      total: 1,
      hasMore: false,
      nextOffset: 1,
    }));
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ReportHistoryTableSection
          active
          title="Всі звіти"
          tableId="admin-all-reports-v2"
          fullHeight
          loadReportHistoryBatch={loadReportHistoryBatch}
        />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[aria-label="Завантажити"]')?.click();
      await Promise.resolve();
    });

    expect(downloadReportHistory).toHaveBeenCalledWith(completedRow.id);
    expect(downloadBlob).toHaveBeenCalledWith(blob, completedRow.fileName);
    expect(loadReportHistoryBatch).toHaveBeenCalledTimes(2);
    expect(loadReportHistoryBatch).toHaveBeenLastCalledWith(
      expect.objectContaining({ offset: 0, limit: 200 }),
      undefined,
    );

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('treats cancel-like reload rows as cancelled', () => {
    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Скасовано користувачем',
        isCancelled: false,
      }),
    ).toBe(true);

    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Скасовано користувачем: worker cleanup already ran',
        isCancelled: false,
      }),
    ).toBe(true);

    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: 'Some other failure',
        isCancelled: false,
      }),
    ).toBe(false);

    expect(
      isCancelledReportHistory({
        status: 'failed',
        lastError: null,
        isCancelled: true,
      }),
    ).toBe(true);
  });
});
