import type {
  KpiActivityRsp,
  KpiNotificationsRsp,
  KpiPeriod,
  KpiReportsRsp,
  KpiRequestsRsp,
} from '../../../../Bindings';
import { postJson } from './client';

export const getKpiReports = (period: KpiPeriod) =>
  postJson<KpiReportsRsp>('/api/kpi/reports', period);
export const getKpiNotifications = (period: KpiPeriod) =>
  postJson<KpiNotificationsRsp>('/api/kpi/notifications', period);
export const getKpiActivity = (period: KpiPeriod) =>
  postJson<KpiActivityRsp>('/api/kpi/activity', period);
export const getKpiRequests = (period: KpiPeriod) =>
  postJson<KpiRequestsRsp>('/api/kpi/requests', period);
