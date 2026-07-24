/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessagesReq } from '../../../../Bindings';
import { useAnalysisReport } from './use-analysis-report';

const analysisApiMock = vi.hoisted(() => ({
  downloadAnalysisReportTaskResult: vi.fn(),
  fetchAnalysisReportTaskStatus: vi.fn(),
  launchAnalysisGeojsonTask: vi.fn(),
  launchAnalysisKmzTask: vi.fn(),
  launchAnalysisReportTask: vi.fn(),
  launchAnalysisSummaryTableTask: vi.fn(),
}));

const bgtaskApiMock = vi.hoisted(() => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
  getBgtaskProgressFromPercent: vi.fn(() => ({ curr: 0, overall: 100 })),
}));

const reportHistoryApiMock = vi.hoisted(() => ({
  fetchReportHistoryStatus: vi.fn(),
  isCancelledReportHistory: vi.fn(),
}));

vi.mock('../../services/api/analysis', () => analysisApiMock);
vi.mock('../../services/api/bgtask', () => bgtaskApiMock);
vi.mock('../../services/api/report-history', () => reportHistoryApiMock);
vi.mock('../../utils/download-blob', () => ({
  downloadBlob: vi.fn(),
}));

type HookResult = ReturnType<typeof useAnalysisReport>;

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: HookResult | null = null;
const onError = vi.fn();
const onUnauthorized = vi.fn(() => false);

function Harness() {
  latest = useAnalysisReport({
    analysisReq: null,
    fromDateTimeStr: '2026-06-01T10:00',
    inboxReq: { limit: 50 } as unknown as InboxMessagesReq,
    onError,
    onUnauthorized,
    toDateTimeStr: '2026-06-01T11:00',
  });
  return null;
}

function renderHook() {
  if (container == null) throw new Error('container not initialized');

  root = createRoot(container);
  act(() => {
    root?.render(createElement(Harness));
  });

  if (!latest) throw new Error('Hook did not render');
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  latest = null;
  analysisApiMock.downloadAnalysisReportTaskResult.mockReset();
  analysisApiMock.fetchAnalysisReportTaskStatus.mockReset();
  analysisApiMock.launchAnalysisGeojsonTask.mockReset();
  analysisApiMock.launchAnalysisKmzTask.mockReset();
  analysisApiMock.launchAnalysisReportTask.mockReset();
  analysisApiMock.launchAnalysisSummaryTableTask.mockReset();
  bgtaskApiMock.fetchBgtaskStatusAndLogs.mockReset();
  bgtaskApiMock.getBgtaskProgressFromPercent.mockClear();
  reportHistoryApiMock.fetchReportHistoryStatus.mockReset();
  reportHistoryApiMock.isCancelledReportHistory.mockReset();
  onError.mockReset();
  onUnauthorized.mockClear();
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latest = null;
  vi.clearAllMocks();
});

describe('useAnalysisReport', () => {
  it('maps the mouse report limit code to frontend-owned text', async () => {
    renderHook();

    analysisApiMock.launchAnalysisReportTask.mockResolvedValueOnce(123);
    reportHistoryApiMock.fetchReportHistoryStatus.mockResolvedValueOnce({
      id: 123,
      reportKind: 'mouse',
      requestedBy: 'tester',
      createdAt: '2026-06-01 10:00:00',
      startedAt: '2026-06-01 10:00:05',
      plannedForTs: null,
      queuePosition: null,
      blockedByReportId: null,
      blockedByStartedAt: null,
      blockedByBgtaskId: null,
      status: 'failed',
      completedAt: '2026-06-01 10:02:00',
      hasFile: false,
      fileName: null,
      contentType: null,
      bgtaskId: 77,
      lastError: 'BL { msg: "mouse_report_message_limit" }',
      isCancelled: false,
      details: '',
      progress: 0,
      errorLog: null,
    });
    reportHistoryApiMock.isCancelledReportHistory.mockReturnValue(false);

    await act(async () => {
      await latest?.downloadReport();
      await Promise.resolve();
    });

    const message = 'Звіт містить понад 10 000 повідомлень. Зменшіть період або звузьте фільтри.';
    expect(onError).toHaveBeenCalledWith(message);
    expect(latest?.reportTaskRuns[0]?.error).toBe(message);
    expect(onError).not.toHaveBeenCalledWith(expect.stringContaining('BL {'));
  });

  it('marks a failed report as cancelled without surfacing an error', async () => {
    renderHook();

    analysisApiMock.launchAnalysisReportTask.mockResolvedValueOnce(123);
    reportHistoryApiMock.fetchReportHistoryStatus.mockResolvedValueOnce({
      id: 123,
      reportKind: 'tags',
      requestedBy: 'tester',
      createdAt: '2026-06-01 10:00:00',
      startedAt: null,
      plannedForTs: null,
      queuePosition: 1,
      blockedByReportId: null,
      blockedByStartedAt: null,
      blockedByBgtaskId: null,
      status: 'failed',
      completedAt: '2026-06-01 10:02:00',
      hasFile: false,
      fileName: null,
      contentType: null,
      bgtaskId: null,
      lastError: null,
      isCancelled: true,
      details: '',
      progress: 0,
      errorLog: null,
    });
    reportHistoryApiMock.isCancelledReportHistory.mockReturnValue(true);

    await act(async () => {
      await latest?.downloadReport();
      await Promise.resolve();
    });

    expect(reportHistoryApiMock.fetchReportHistoryStatus).toHaveBeenCalledWith(123);
    expect(latest?.reportTaskRuns).toHaveLength(1);
    expect(latest?.reportTaskRuns[0]?.cancelled).toBe(true);
    expect(latest?.reportTaskRuns[0]?.error).toBeNull();
    expect(latest?.reportTaskRuns[0]?.finishedAt).toBeTruthy();
    expect(analysisApiMock.downloadAnalysisReportTaskResult).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('');
    expect(onError.mock.calls.filter(([message]) => message !== '')).toEqual([]);
  });

  it('keeps a report cancelled when bgtask stops with a stale error', async () => {
    renderHook();

    analysisApiMock.launchAnalysisReportTask.mockResolvedValueOnce(123);
    reportHistoryApiMock.fetchReportHistoryStatus
      .mockResolvedValueOnce({
        id: 123,
        reportKind: 'tags',
        requestedBy: 'tester',
        createdAt: '2026-06-01 10:00:00',
        startedAt: '2026-06-01 10:00:05',
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
        details: '',
        progress: 45,
        errorLog: null,
      })
      .mockResolvedValueOnce({
        id: 123,
        reportKind: 'tags',
        requestedBy: 'tester',
        createdAt: '2026-06-01 10:00:00',
        startedAt: '2026-06-01 10:00:05',
        plannedForTs: null,
        queuePosition: 1,
        blockedByReportId: null,
        blockedByStartedAt: null,
        blockedByBgtaskId: null,
        status: 'failed',
        completedAt: '2026-06-01 10:02:00',
        hasFile: false,
        fileName: null,
        contentType: null,
        bgtaskId: 77,
        lastError: 'Скасовано користувачем',
        isCancelled: true,
        details: '',
        progress: 45,
        errorLog: null,
      });
    reportHistoryApiMock.isCancelledReportHistory.mockImplementation(
      (row) => row.status === 'failed' && row.isCancelled === true,
    );
    bgtaskApiMock.fetchBgtaskStatusAndLogs.mockResolvedValueOnce({
      running: false,
      loglines: [],
      finishedWithError: 'BL { msg: "Скасовано користувачем" }',
      finishedWithErrorCode: null,
      progress: 45,
    });

    await act(async () => {
      await latest?.downloadReport();
      await Promise.resolve();
    });

    expect(reportHistoryApiMock.fetchReportHistoryStatus).toHaveBeenCalledTimes(2);
    expect(latest?.reportTaskRuns).toHaveLength(1);
    expect(latest?.reportTaskRuns[0]?.cancelled).toBe(true);
    expect(latest?.reportTaskRuns[0]?.error).toBeNull();
    expect(analysisApiMock.downloadAnalysisReportTaskResult).not.toHaveBeenCalled();
    expect(onError.mock.calls.filter(([message]) => message !== '')).toEqual([]);
  });
});
