import type { ReportHistoryIdReq, ReportHistoryRow } from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postBytes, postJson } from './client';
import { fetchBgtaskStatusAndLogs, type BgtaskStatusAndLogsRsp } from './bgtask';

export async function listReportHistory(options?: { signal?: AbortSignal }): Promise<ReportHistoryRow[]> {
  const raw = await postJson<unknown>('/api/report-history/list', undefined, options);
  return transformSnakeToCamel<ReportHistoryRow[]>(raw) ?? [];
}

export async function fetchReportHistoryStatus(id: number): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>('/api/report-history/status', transformCamelToSnake(req));
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export async function retryReportHistory(id: number): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>('/api/report-history/retry', transformCamelToSnake(req));
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export async function downloadReportHistory(id: number): Promise<Blob> {
  const req: ReportHistoryIdReq = { id };
  return postBytes('/api/report-history/download', transformCamelToSnake(req));
}

export async function fetchReportHistoryTaskStatus(id: number, skip: number): Promise<BgtaskStatusAndLogsRsp> {
  const row = await fetchReportHistoryStatus(id);

  if (row.status === 'planned') {
    return {
      running: true,
      loglines: skip === 0 ? ['[1/3] В черзі...'] : [],
      finishedWithError: null,
      finishedWithErrorCode: null,
    };
  }

  if (row.status === 'in_progress') {
    if (row.bgtaskId === null) {
      return {
        running: true,
        loglines: skip === 0 ? ['[1/3] Формування звіту'] : [],
        finishedWithError: null,
        finishedWithErrorCode: null,
      };
    }
    return fetchBgtaskStatusAndLogs(row.bgtaskId, skip);
  }

  if (row.status === 'failed') {
    return {
      running: false,
      loglines: [],
      finishedWithError: 'Помилка',
      finishedWithErrorCode: null,
    };
  }

  return {
    running: false,
    loglines: [],
    finishedWithError: null,
    finishedWithErrorCode: null,
  };
}
