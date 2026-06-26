/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isCancelledReport, SettingsMyReportsSection } from './SettingsMyReportsSection';

const sampleRunningRow = {
  id: 1501,
  reportKind: 'etalonka',
  requestedBy: 'alice',
  createdAt: '2026-06-26 16:45:00',
  status: 'in_progress',
  completedAt: null,
  hasFile: false,
  fileName: null,
  contentType: null,
  bgtaskId: 1347,
  lastError: null,
  details: 'desc',
  progress: 20,
  errorLog: null,
  startedAt: '2026-06-26 16:45:00',
  plannedForTs: null,
  queuePosition: 1,
  blockedByReportId: null,
  blockedByStartedAt: null,
  blockedByBgtaskId: null,
};

let capturedTableStateProviderProps: Record<string, unknown> | null = null;
let capturedSettingsNeoTableProps: Record<string, unknown> | null = null;
let capturedDangerDialogProps: Record<string, unknown> | null = null;

vi.mock('../../services/api/report-history', () => ({
  listReportHistory: vi.fn(async () => []),
  downloadReportHistory: vi.fn(),
  retryReportHistory: vi.fn(),
  cancelReportHistory: vi.fn(),
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

vi.mock('../../components/mui-customized/table/components/table-top-toolbar/components/internal-actions', () => ({
  InternalTableActions: ({ children }: { children?: ReactNode }) => <div data-testid="table-actions">{children}</div>,
}));

vi.mock('./SettingsNeoTable', () => ({
  SettingsNeoTable: (props: Record<string, unknown>) => {
    capturedSettingsNeoTableProps = props;
    const columns = (props.columns as Array<Record<string, any>>) ?? [];
    const actionsColumn = columns.find((column) => column.id === 'actions');
    const cell = typeof actionsColumn?.Cell === 'function' ? actionsColumn.Cell({ row: { original: sampleRunningRow } } as never) : null;
    return <div data-testid="settings-neo-table">{cell}</div>;
  },
}));

afterEach(() => {
  document.body.innerHTML = '';
  capturedTableStateProviderProps = null;
  capturedSettingsNeoTableProps = null;
  capturedDangerDialogProps = null;
});

describe('SettingsMyReportsSection', () => {
  it('uses a fixed actions column, toolbar controls, and a reset table id', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<SettingsMyReportsSection active />);
    });

    const columns = (capturedSettingsNeoTableProps?.columns as Array<Record<string, unknown>>) ?? [];
    const actionsColumn = columns.find((column) => column.id === 'actions') as Record<string, unknown> | undefined;
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

    expect(capturedTableStateProviderProps?.defaultColumnOrder).toEqual([
      'mrt-row-numbers',
      'actions',
      'reportKind',
      'details',
      'createdAt',
      'status',
      'plannedForTs',
      'startedAt',
      'queuePosition',
      'bgtaskId',
      'completedAt',
    ]);

    expect(capturedTableStateProviderProps?.defaultColumnVisibility).toMatchObject({
      actions: true,
      reportKind: true,
      details: true,
      createdAt: true,
      status: true,
      plannedForTs: false,
      startedAt: false,
      queuePosition: true,
      bgtaskId: false,
      completedAt: false,
    });

    expect(capturedTableStateProviderProps?.tableId).toBe('settings-neo-my-reports-v3');
    expect(capturedDangerDialogProps?.title).toBe('Скасування звіту');
    expect(capturedDangerDialogProps?.cancelLabel).toBe('Скасувати');
    expect(capturedDangerDialogProps?.confirmLabel).toBe('Підтвердити');
    expect(capturedDangerDialogProps?.description).toBe('Звіт буде скасовано і прибрано з черги.');

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('treats cancel-like reload rows as cancelled', () => {
    expect(
      isCancelledReport({
        status: 'failed',
        lastError: 'Скасовано користувачем',
      }),
    ).toBe(true);

    expect(
      isCancelledReport({
        status: 'failed',
        lastError: 'Скасовано користувачем: worker cleanup already ran',
      }),
    ).toBe(true);

    expect(
      isCancelledReport({
        status: 'failed',
        lastError: 'Some other failure',
      }),
    ).toBe(false);
  });
});
