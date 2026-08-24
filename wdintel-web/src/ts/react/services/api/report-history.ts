import type { ReportHistoryIdReq, ReportHistoryRow } from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postBytes, postJson } from './client';
import { fetchBgtaskStatusAndLogs, type BgtaskStatusAndLogsRsp } from './bgtask';

const REPORT_CANCELLED_TEXT = 'Скасовано користувачем';

export function parseUtcDateTime(value: string | null | undefined): Date | null {
  if (value == null || value.trim() === '') return null;
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

export async function listReportHistory(options?: {
  signal?: AbortSignal;
}): Promise<ReportHistoryRow[]> {
  const raw = await postJson<unknown>('/api/report-history/list', undefined, options);
  return transformSnakeToCamel<ReportHistoryRow[]>(raw) ?? [];
}

export type ReportHistoryQueryState = {
  globalFilter: string;
  columnFilters: Array<{ id: string; value: unknown }>;
  sorting: Array<{ id: string; desc: boolean }>;
};

export type ReportHistoryBatchReq = ReportHistoryQueryState & {
  offset: number;
  limit: number;
};

export type ReportHistoryBatchRsp = {
  rows: ReportHistoryRow[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
};

export async function listAllReportHistory(
  req: ReportHistoryBatchReq,
  options?: { signal?: AbortSignal },
): Promise<ReportHistoryBatchRsp> {
  const raw = await postJson<unknown>(
    '/api/admin/report-history/list',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ReportHistoryBatchRsp>(raw);
}

export async function fetchReportHistoryStatus(
  id: number,
  options?: { signal?: AbortSignal },
): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>(
    '/api/report-history/status',
    transformCamelToSnake(req),
    options,
  );
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export async function retryReportHistory(id: number): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>('/api/report-history/retry', transformCamelToSnake(req));
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export async function rerunSuccessfulReportHistory(id: number): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>(
    '/api/admin/report-history/rerun',
    transformCamelToSnake(req),
  );
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export function isCancelledReportHistory(
  row: Pick<ReportHistoryRow, 'status' | 'lastError' | 'isCancelled'>,
): boolean {
  if (row.isCancelled === true) {
    return true;
  }
  return row.status === 'failed' && isCancelledReportHistoryError(row.lastError);
}

export function isCancelledReportHistoryError(value: string | null | undefined): boolean {
  return value?.includes(REPORT_CANCELLED_TEXT) ?? false;
}

export async function cancelReportHistory(id: number): Promise<ReportHistoryRow> {
  const req: ReportHistoryIdReq = { id };
  const raw = await postJson<unknown>('/api/report-history/cancel', transformCamelToSnake(req));
  return transformSnakeToCamel<ReportHistoryRow>(raw);
}

export async function downloadReportHistory(id: number): Promise<Blob> {
  const req: ReportHistoryIdReq = { id };
  return postBytes('/api/report-history/download', transformCamelToSnake(req));
}

export async function fetchReportHistoryTaskStatus(
  id: number,
  skip: number,
): Promise<BgtaskStatusAndLogsRsp> {
  const row = await fetchReportHistoryStatus(id);

  if (row.status === 'planned' || (row.status === 'in_progress' && row.bgtaskId === null)) {
    return {
      running: true,
      loglines: [],
      finishedWithError: null,
      finishedWithErrorCode: null,
      progress: row.progress,
    };
  }

  if (row.status === 'in_progress' && row.bgtaskId !== null) {
    const rsp = await fetchBgtaskStatusAndLogs(row.bgtaskId, skip);
    return {
      ...rsp,
      finishedWithError: rsp.finishedWithError ? 'Помилка' : null,
      progress: rsp.progress ?? row.progress,
    };
  }

  if (row.status === 'failed') {
    return {
      running: false,
      loglines: [],
      finishedWithError: 'Помилка',
      finishedWithErrorCode: null,
      progress: row.progress,
    };
  }

  return {
    running: false,
    loglines: [],
    finishedWithError: null,
    finishedWithErrorCode: null,
    progress: row.progress,
  };
}
