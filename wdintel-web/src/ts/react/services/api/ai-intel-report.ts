import type {
  AiIntelReportAttemptListReq,
  AiIntelReportAttemptListRsp,
  AiIntelReportSettingsItem,
  QuickIntelReportSuggestionReq,
  QuickIntelReportSuggestionRsp,
  SaveAiIntelReportSettingsReq,
} from '../../../../Bindings';
import { getJson, postJson, type RequestOptions } from './client';

export async function getAiIntelReportSettings(): Promise<AiIntelReportSettingsItem> {
  return getJson<AiIntelReportSettingsItem>('/api/admin/ai-intel-report/settings');
}

export async function saveAiIntelReportSettings(
  req: SaveAiIntelReportSettingsReq,
): Promise<AiIntelReportSettingsItem> {
  return postJson<AiIntelReportSettingsItem>('/api/admin/ai-intel-report/settings', req);
}

export async function listAiIntelReportAttempts(
  pageStartId: string | null = null,
): Promise<AiIntelReportAttemptListRsp> {
  const req: AiIntelReportAttemptListReq = { pageStartId };
  return postJson<AiIntelReportAttemptListRsp>('/api/admin/ai-intel-report/attempts/list', req);
}

export async function quickIntelReportSuggestion(
  messageId: number,
  options?: RequestOptions,
): Promise<QuickIntelReportSuggestionRsp | null> {
  const req: QuickIntelReportSuggestionReq = { messageId };
  return (
    (await postJson<QuickIntelReportSuggestionRsp | undefined>(
      '/api/1.1/intelligence-reports/quick-suggestion',
      req,
      options,
    )) ?? null
  );
}
