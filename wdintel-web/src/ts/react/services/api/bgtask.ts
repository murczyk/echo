import { getJson } from './client';
import { transformSnakeToCamel } from '../../../snake-to-camel';

export type BgtaskStatusAndLogsRsp = {
  running: boolean;
  loglines: string[];
  finishedWithError: string | null;
  finishedWithErrorCode: string | null;
  progress?: number;
};

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
