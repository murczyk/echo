import type {
  AiSettlementPageRsp,
  AiSettlementParsingRsp,
  AiSettlementPromptState,
  AiSettlementTestMessageIdReq,
  AiSettlementTestMessageItem,
  AiSettlementWorkerSettingsItem,
  CreateAiSettlementTestMessageReq,
  RunAiSettlementParsingReq,
  SaveAiSettlementParsingReq,
  SaveAiSettlementWorkerSettingsReq,
  UpdateAiSettlementTestMessageReq,
  ListSettlementAliasesRsp,
  SaveSettlementAliasReq,
  SettlementAliasItem,
  SettlementAliasSettlement,
} from '../../../../Bindings';
import { postJson, postVoid, type RequestOptions } from './client';

export function listSettlementAliases(afterId: string | null): Promise<ListSettlementAliasesRsp> {
  return postJson<ListSettlementAliasesRsp>('/api/admin/ai-settlements/aliases/list', { afterId });
}

export function searchAliasSettlements(
  query: string,
  options?: RequestOptions,
): Promise<SettlementAliasSettlement[]> {
  return postJson<SettlementAliasSettlement[]>(
    '/api/admin/ai-settlements/aliases/settlements',
    { query },
    options,
  );
}

export function saveSettlementAlias(req: SaveSettlementAliasReq): Promise<SettlementAliasItem> {
  return postJson<SettlementAliasItem>('/api/admin/ai-settlements/aliases/save', req);
}

export function deleteSettlementAlias(id: string): Promise<void> {
  return postVoid('/api/admin/ai-settlements/aliases/delete', { id });
}

export function getAiSettlementPage(): Promise<AiSettlementPageRsp> {
  return postJson<AiSettlementPageRsp>('/api/admin/ai-settlements/page');
}

export function resetAiSettlementPrompt(): Promise<AiSettlementPromptState> {
  return postJson<AiSettlementPromptState>('/api/admin/ai-settlements/prompt/reset');
}

export function createAiSettlementTestMessage(
  req: CreateAiSettlementTestMessageReq,
): Promise<AiSettlementTestMessageItem> {
  return postJson<AiSettlementTestMessageItem>('/api/admin/ai-settlements/messages/create', req);
}

export function updateAiSettlementTestMessage(
  req: UpdateAiSettlementTestMessageReq,
): Promise<AiSettlementTestMessageItem> {
  return postJson<AiSettlementTestMessageItem>('/api/admin/ai-settlements/messages/update', req);
}

export async function deleteAiSettlementTestMessage(id: string): Promise<void> {
  const req: AiSettlementTestMessageIdReq = { id };
  await postVoid('/api/admin/ai-settlements/messages/delete', req);
}

export function testAiSettlementParsing(
  req: RunAiSettlementParsingReq,
): Promise<AiSettlementParsingRsp> {
  return postJson<AiSettlementParsingRsp>('/api/admin/ai-settlements/test', req);
}

export function saveAiSettlementParsing(
  req: SaveAiSettlementParsingReq,
): Promise<AiSettlementParsingRsp> {
  return postJson<AiSettlementParsingRsp>('/api/admin/ai-settlements/save', req);
}

export function recalculateAiSettlementParsing(
  req: RunAiSettlementParsingReq,
): Promise<AiSettlementParsingRsp> {
  return postJson<AiSettlementParsingRsp>('/api/admin/ai-settlements/recalculate', req);
}

export function saveAiSettlementWorkerSettings(
  req: SaveAiSettlementWorkerSettingsReq,
): Promise<AiSettlementWorkerSettingsItem> {
  return postJson<AiSettlementWorkerSettingsItem>('/api/admin/ai-settlements/worker/save', req);
}
