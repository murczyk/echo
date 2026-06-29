/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Network } from '../../../../Bindings';
import { EMPTY_STATE } from './use-rer-network-details-neo-page.types';
import { createDefaultNetworkEtalonkaReportState } from './use-rer-network-details-neo-page.etalonka-report';
import { useRerNetworkDetailsNeoPageReportActions } from './use-rer-network-details-neo-page.report-actions';
import { NETWORK_STATUS_ACTIVE } from './network-status';

const apiMock = vi.hoisted(() => ({
  launchNetworkEtalonkaBatchReportTask: vi.fn(),
  downloadNetworkEtalonkaReportTaskResult: vi.fn(),
}));

const bgtaskMock = vi.hoisted(() => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
}));

const reportHistoryMock = vi.hoisted(() => ({
  fetchReportHistoryStatus: vi.fn(),
  parseUtcDateTime: (value: string | null | undefined) => {
    if (value == null || value.trim() === '') return null;
    const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
    const date = new Date(normalized);
    return Number.isNaN(date.getTime()) ? null : date;
  },
}));

const downloadBlobMock = vi.hoisted(() => vi.fn());

vi.mock('../../services/api/networks', () => ({
  launchNetworkEtalonkaBatchReportTask: apiMock.launchNetworkEtalonkaBatchReportTask,
  downloadNetworkEtalonkaReportTaskResult: apiMock.downloadNetworkEtalonkaReportTaskResult,
}));

vi.mock('../../services/api/bgtask', () => ({
  fetchBgtaskStatusAndLogs: bgtaskMock.fetchBgtaskStatusAndLogs,
  getBgtaskProgress: (loglines: string[]) => {
    let stage: string | null = null;
    for (let index = loglines.length - 1; index >= 0; index -= 1) {
      if (/^\[(\d+)\/(\d+)\]/.test(loglines[index])) {
        stage = loglines[index];
        break;
      }
    }
    const match = stage ? /^\[(\d+)\/(\d+)\]/.exec(stage) : null;
    return match ? { curr: Number(match[1]), overall: Number(match[2]) } : { curr: 1, overall: 4 };
  },
  getBgtaskProgressFromPercent: (loglines: string[], progress?: number) => {
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      return { curr: Math.max(0, Math.min(100, Math.round(progress))), overall: 100 };
    }
    let stage: string | null = null;
    for (let index = loglines.length - 1; index >= 0; index -= 1) {
      if (/^\[(\d+)\/(\d+)\]/.test(loglines[index])) {
        stage = loglines[index];
        break;
      }
    }
    const match = stage ? /^\[(\d+)\/(\d+)\]/.exec(stage) : null;
    return match ? { curr: Number(match[1]), overall: Number(match[2]) } : { curr: 1, overall: 4 };
  },
}));

vi.mock('../../services/api/report-history', () => ({
  fetchReportHistoryStatus: reportHistoryMock.fetchReportHistoryStatus,
  isCancelledReportHistory: (row: { status: string; lastError: string | null | undefined }) =>
    row.status === 'failed' && row.lastError === 'Скасовано користувачем',
  parseUtcDateTime: reportHistoryMock.parseUtcDateTime,
}));

vi.mock('../../utils/download-blob', () => ({
  downloadBlob: downloadBlobMock,
}));

type ReportActions = ReturnType<typeof useRerNetworkDetailsNeoPageReportActions>;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let latestActions: ReportActions | null = null;
let latestState: typeof EMPTY_STATE | null = null;

function buildNetwork(id: number): Network {
  return {
    id,
    freqs: [],
    unitIds: [],
    aorIds: [],
    name: `Network ${id}`,
    location: '',
    radioStation: null,
    createdAt: 1,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    doNotArchive: false,
    lastUpdatedAt: 1,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
    status: NETWORK_STATUS_ACTIVE,
  } as Network;
}

function Harness() {
  const [state, setState] = useState(() => ({
    ...EMPTY_STATE,
    network: buildNetwork(77),
    etalonkaReport: createDefaultNetworkEtalonkaReportState(),
  }));

  latestState = state;
  latestActions = useRerNetworkDetailsNeoPageReportActions({ state, setState });
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  apiMock.launchNetworkEtalonkaBatchReportTask.mockReset();
  apiMock.downloadNetworkEtalonkaReportTaskResult.mockReset();
  bgtaskMock.fetchBgtaskStatusAndLogs.mockReset();
  reportHistoryMock.fetchReportHistoryStatus.mockReset();
  downloadBlobMock.mockReset();
  apiMock.launchNetworkEtalonkaBatchReportTask.mockResolvedValue(555);
  apiMock.downloadNetworkEtalonkaReportTaskResult.mockResolvedValue(new Blob(['report']));
  reportHistoryMock.fetchReportHistoryStatus
    .mockResolvedValueOnce({
      id: 555,
      reportKind: 'etalonka',
      requestedBy: 'user',
      createdAt: '2026-05-01T10:00:00',
      startedAt: null,
      plannedForTs: null,
      queuePosition: 1,
      status: 'planned',
      completedAt: null,
      hasFile: false,
      fileName: null,
      contentType: null,
      bgtaskId: null,
      lastError: null,
      details: '',
      progress: 0,
      errorLog: null,
    })
    .mockResolvedValueOnce({
      id: 555,
      reportKind: 'etalonka',
      requestedBy: 'user',
      createdAt: '2026-05-01T10:00:00',
      startedAt: '2026-05-01T10:00:02',
      plannedForTs: null,
      queuePosition: null,
      status: 'in_progress',
      completedAt: null,
      hasFile: false,
      fileName: null,
      contentType: null,
      bgtaskId: 91,
      lastError: null,
      details: '',
      progress: 12,
      errorLog: null,
    })
    .mockResolvedValueOnce({
      id: 555,
      reportKind: 'etalonka',
      requestedBy: 'user',
      createdAt: '2026-05-01T10:00:00',
      startedAt: '2026-05-01T10:00:02',
      plannedForTs: null,
      queuePosition: null,
      status: 'done',
      completedAt: '2026-05-01T10:00:10',
      hasFile: true,
      fileName: 'etalonka_network_77.docx',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      bgtaskId: 91,
      lastError: null,
      details: '',
      progress: 100,
      errorLog: null,
    });
  bgtaskMock.fetchBgtaskStatusAndLogs
    .mockResolvedValueOnce({
      running: true,
      loglines: ['backend step'],
      finishedWithError: null,
      finishedWithErrorCode: null,
      progress: 12,
    })
    .mockResolvedValueOnce({
      running: false,
      loglines: [],
      finishedWithError: null,
      finishedWithErrorCode: null,
      progress: 100,
    });

  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(Harness));
  });
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
  latestActions = null;
  latestState = null;
  vi.useRealTimers();
});

describe('useRerNetworkDetailsNeoPageReportActions', () => {
  it('updates the etalonka report progress flag through a focused setter', async () => {
    if (!latestActions) throw new Error('actions not ready');

    await act(async () => {
      latestActions?.setEtalonkaReportProgressExpanded(true);
    });
    await flush();

    expect(latestState?.etalonkaReport.progressExpanded).toBe(true);
    expect((latestState as typeof EMPTY_STATE & { progressExpanded?: boolean })?.progressExpanded).toBeUndefined();
  });

  it('polls queue state and waits for a real bgtask before showing progress', async () => {
    if (!latestActions) throw new Error('actions not ready');

    const promise = latestActions.downloadEtalonkaReport();
    await flush();

    await act(async () => {
      latestActions?.setEtalonkaReportProgressExpanded(false);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await promise;
    });

    expect(apiMock.launchNetworkEtalonkaBatchReportTask).toHaveBeenCalledWith({
      networkIds: [77],
      sortBy: null,
      etalonkaType: {
        AccordingToTheForm: {
          activeFreqsOnly: true,
          includeSigintSigns: true,
          includeConfirmation: true,
        },
      },
    });
    expect(reportHistoryMock.fetchReportHistoryStatus).toHaveBeenNthCalledWith(1, 555);
    expect(reportHistoryMock.fetchReportHistoryStatus).toHaveBeenNthCalledWith(2, 555);
    expect(reportHistoryMock.fetchReportHistoryStatus).toHaveBeenNthCalledWith(3, 555);
    expect(bgtaskMock.fetchBgtaskStatusAndLogs).toHaveBeenNthCalledWith(1, 91, 0);
    expect(bgtaskMock.fetchBgtaskStatusAndLogs).toHaveBeenNthCalledWith(2, 91, 1);
    expect(apiMock.downloadNetworkEtalonkaReportTaskResult).toHaveBeenCalledWith(555);
    expect(downloadBlobMock).toHaveBeenCalledWith(expect.any(Blob), 'etalonka_network_77.docx');
    expect(latestState?.etalonkaReport.progressExpanded).toBe(false);
  });

  it('stops polling with a cancelled message when the report is cancelled', async () => {
    if (!latestActions) throw new Error('actions not ready');

    reportHistoryMock.fetchReportHistoryStatus.mockReset();
    reportHistoryMock.fetchReportHistoryStatus
      .mockResolvedValueOnce({
        id: 555,
        reportKind: 'etalonka',
        requestedBy: 'user',
        createdAt: '2026-05-01T10:00:00',
        startedAt: null,
        plannedForTs: null,
        queuePosition: 1,
        status: 'planned',
        completedAt: null,
        hasFile: false,
        fileName: null,
        contentType: null,
        bgtaskId: null,
        lastError: null,
        details: '',
        progress: 0,
        errorLog: null,
      })
      .mockResolvedValueOnce({
        id: 555,
        reportKind: 'etalonka',
        requestedBy: 'user',
        createdAt: '2026-05-01T10:00:00',
        startedAt: '2026-05-01T10:00:02',
        plannedForTs: null,
        queuePosition: 1,
        status: 'failed',
        completedAt: '2026-05-01T10:00:10',
        hasFile: false,
        fileName: null,
        contentType: null,
        bgtaskId: 91,
        lastError: 'Скасовано користувачем',
        details: '',
        progress: 0,
        errorLog: null,
      });
    bgtaskMock.fetchBgtaskStatusAndLogs.mockReset();
    apiMock.downloadNetworkEtalonkaReportTaskResult.mockReset();

    const promise = latestActions.downloadEtalonkaReport();
    await flush();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
      await promise;
    });

    expect(latestState?.etalonkaReport.running).toBe(false);
    expect(latestState?.etalonkaReport.error).toBe('Звіт скасовано в Моїх звітах.');
    expect(apiMock.downloadNetworkEtalonkaReportTaskResult).not.toHaveBeenCalled();
  });
});
