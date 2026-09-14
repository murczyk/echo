import { getJson } from './client';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import type { Unit } from '../../../../Bindings';

export type BgtaskStatusAndLogsRsp = {
  running: boolean;
  loglines: string[];
  finishedWithError: string | null;
  finishedWithErrorCode: string | null;
  progress?: number;
};

export class BgtaskFailedError extends Error {}

export type PendingUnitMerge = {
  taskId: number;
  original: Unit;
  duplicate: Unit;
};

const PENDING_UNIT_MERGE_KEY = 'echo.pendingUnitMerge';

export function loadPendingUnitMerge(): PendingUnitMerge | null {
  try {
    const value = window.sessionStorage.getItem(PENDING_UNIT_MERGE_KEY);
    if (value === null) return null;
    const pending = JSON.parse(value) as PendingUnitMerge;
    if (
      !Number.isSafeInteger(pending.taskId) ||
      !Number.isSafeInteger(pending.original?.id) ||
      !Number.isSafeInteger(pending.duplicate?.id) ||
      typeof pending.original?.name !== 'string' ||
      typeof pending.duplicate?.name !== 'string'
    )
      return null;
    return pending;
  } catch {
    return null;
  }
}

export function savePendingUnitMerge(pending: PendingUnitMerge): void {
  try {
    window.sessionStorage.setItem(PENDING_UNIT_MERGE_KEY, JSON.stringify(pending));
  } catch {}
}

export function clearPendingUnitMerge(taskId: number): void {
  try {
    if (loadPendingUnitMerge()?.taskId === taskId)
      window.sessionStorage.removeItem(PENDING_UNIT_MERGE_KEY);
  } catch {}
}

export type BgtaskProgressStage = {
  index: number;
  overall: number;
  text: string;
};

export function parseBgtaskProgressStages(loglines: string[]): BgtaskProgressStage[] {
  const stages = new Map<number, BgtaskProgressStage>();
  for (const line of loglines) {
    const match = /^\[(\d+)\/(\d+)\]\s*(.*)$/.exec(line);
    if (!match) continue;
    const index = Number(match[1]);
    const overall = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(overall) || index <= 0 || overall <= 0)
      continue;
    stages.set(index, { index, overall, text: match[3] });
  }
  return [...stages.values()].sort((left, right) => left.index - right.index);
}

export function getBgtaskProgress(loglines: string[]): { curr: number; overall: number } {
  const stages = parseBgtaskProgressStages(loglines);
  if (stages.length === 0) {
    return { curr: 1, overall: 4 };
  }
  const lastStage = stages[stages.length - 1];
  return { curr: lastStage.index, overall: lastStage.overall };
}

export function getBgtaskProgressFromPercent(
  loglines: string[],
  progress?: number,
): { curr: number; overall: number } {
  if (typeof progress === 'number' && Number.isFinite(progress)) {
    return { curr: Math.max(0, Math.min(100, Math.round(progress))), overall: 100 };
  }
  return getBgtaskProgress(loglines);
}

export async function fetchBgtaskStatusAndLogs(
  taskId: number,
  skip: number,
  options?: { signal?: AbortSignal },
): Promise<BgtaskStatusAndLogsRsp> {
  const raw = await getJson<unknown>(`/api/bgtask/${taskId}/status-and-logs?skip=${skip}`, options);
  const rsp = transformSnakeToCamel<BgtaskStatusAndLogsRsp>(raw);
  return {
    ...rsp,
    finishedWithErrorCode: rsp.finishedWithErrorCode ?? null,
    progress: rsp.progress ?? 0,
  };
}

export async function waitForBgtaskCompletion(
  taskId: number,
  onProgress: (progress: number, logline: string | null) => void,
  options?: { signal?: AbortSignal },
): Promise<void> {
  let skip = 0;
  for (;;) {
    const status = await fetchBgtaskStatusAndLogs(taskId, skip, options);
    skip += status.loglines.length;
    onProgress(status.progress ?? 0, status.loglines.at(-1) ?? null);
    if (!status.running) {
      if (status.finishedWithError !== null) throw new BgtaskFailedError(status.finishedWithError);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        window.clearTimeout(timeoutId);
        reject(options?.signal?.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      const timeoutId = window.setTimeout(() => {
        options?.signal?.removeEventListener('abort', onAbort);
        resolve();
      }, 1000);
      if (options?.signal?.aborted) onAbort();
      else options?.signal?.addEventListener('abort', onAbort, { once: true });
    });
  }
}
