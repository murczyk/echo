import type {
  KpiActivityRsp,
  KpiCount,
  KpiNotificationsRsp,
  KpiPeriod,
  KpiReportsRsp,
  KpiRequestsRsp,
} from '../../../../Bindings';
import { postJson } from './client';

const KPI_REQUESTS_CHUNK_MS = 6 * 60 * 60 * 1000;

export const getKpiReports = (period: KpiPeriod) =>
  postJson<KpiReportsRsp>('/api/kpi/reports', period);
export const getKpiNotifications = (period: KpiPeriod) =>
  postJson<KpiNotificationsRsp>('/api/kpi/notifications', period);
export const getKpiActivity = (period: KpiPeriod) =>
  postJson<KpiActivityRsp>('/api/kpi/activity', period);
export async function getKpiRequests(
  period: KpiPeriod,
  signal: AbortSignal,
): Promise<KpiRequestsRsp> {
  const result: KpiRequestsRsp = {
    period,
    available: false,
    reason: null,
    total: null,
    serverErrors: null,
    clientErrors: null,
    byStatus: [],
  };
  const byStatus = new Map<string, KpiCount>();
  for (let since = period.since; since < period.until; since += KPI_REQUESTS_CHUNK_MS) {
    signal.throwIfAborted();
    const chunk = await postJson<KpiRequestsRsp>(
      '/api/kpi/requests',
      { since, until: Math.min(since + KPI_REQUESTS_CHUNK_MS, period.until) },
      { signal },
    );
    result.reason ??= chunk.reason;
    if (!chunk.available) continue;
    result.available = true;
    result.total = (result.total ?? 0) + (chunk.total ?? 0);
    result.serverErrors = (result.serverErrors ?? 0) + (chunk.serverErrors ?? 0);
    result.clientErrors = (result.clientErrors ?? 0) + (chunk.clientErrors ?? 0);
    for (const row of chunk.byStatus) {
      byStatus.set(row.id, { ...row, count: (byStatus.get(row.id)?.count ?? 0) + row.count });
    }
  }
  if (result.available) result.reason = null;
  result.byStatus = [...byStatus.values()].sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
