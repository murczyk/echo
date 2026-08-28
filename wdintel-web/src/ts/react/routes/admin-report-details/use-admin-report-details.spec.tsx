/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fetchBgtaskStatusAndLogs } from '../../services/api/bgtask';
import { fetchReportHistoryStatus } from '../../services/api/report-history';
import { useAdminReportDetails } from './use-admin-report-details';

vi.mock('../../services/api/bgtask', () => ({ fetchBgtaskStatusAndLogs: vi.fn() }));
vi.mock('../../services/api/report-history', () => ({ fetchReportHistoryStatus: vi.fn() }));
vi.mock('../rer-network-details-neo/use-rer-network-details-neo-page.helpers', () => ({
  formatErrorMessage: (error: unknown) => (error instanceof Error ? error.message : 'error'),
}));

const runningRow = {
  id: 1501,
  reportKind: 'etalonka',
  requestedBy: 'alice',
  createdAt: '2026-08-24 12:00:00',
  startedAt: '2026-08-24 12:00:01',
  plannedForTs: null,
  queuePosition: 1,
  blockedByReportId: null,
  blockedByStartedAt: null,
  blockedByBgtaskId: null,
  status: 'in_progress',
  completedAt: null,
  hasFile: false,
  fileName: null,
  contentType: null,
  bgtaskId: 77,
  lastError: null,
  isCancelled: false,
  details: 'network',
  reportPeriod: null,
  progress: 10,
  errorLog: null,
};

function Probe() {
  const state = useAdminReportDetails(runningRow.id);
  return <div>{JSON.stringify(state)}</div>;
}

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('useAdminReportDetails', () => {
  // @test-scope safeguard: prevents a completed report task from continuing to poll or duplicating log entries
  it('polls incremental task logs and stops after the report finishes', async () => {
    vi.useFakeTimers();
    vi.mocked(fetchReportHistoryStatus)
      .mockResolvedValueOnce(runningRow)
      .mockResolvedValueOnce({ ...runningRow, status: 'done', progress: 100 });
    vi.mocked(fetchBgtaskStatusAndLogs)
      .mockResolvedValueOnce({
        running: true,
        loglines: ['[1/3] Формування звіту'],
        finishedWithError: null,
        finishedWithErrorCode: null,
        progress: 20,
      })
      .mockResolvedValueOnce({
        running: false,
        loglines: ['[3/3] Готово'],
        finishedWithError: null,
        finishedWithErrorCode: null,
        progress: 100,
      });
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.textContent).toContain('[1/3] Формування звіту');
    expect(fetchBgtaskStatusAndLogs).toHaveBeenLastCalledWith(
      runningRow.bgtaskId,
      0,
      expect.anything(),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(container.textContent).toContain('[3/3] Готово');
    expect(container.textContent).toContain('"progress":100');
    expect(container.textContent).toContain('"taskRunning":false');
    expect(fetchBgtaskStatusAndLogs).toHaveBeenLastCalledWith(
      runningRow.bgtaskId,
      1,
      expect.anything(),
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchReportHistoryStatus).toHaveBeenCalledTimes(2);

    act(() => root.unmount());
  });
});
