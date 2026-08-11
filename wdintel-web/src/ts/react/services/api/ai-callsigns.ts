import type {
  AiCallsignPageRsp,
  AiCallsignParsingRsp,
  AiCallsignPromptState,
  AiCallsignTestMessageIdReq,
  AiCallsignTestMessageItem,
  AiCallsignWorkerSettingsItem,
  CreateAiCallsignTestMessageReq,
  RunAiCallsignParsingReq,
  SaveAiCallsignParsingReq,
  SaveAiCallsignWorkerSettingsReq,
  UpdateAiCallsignTestMessageReq,
} from '../../../../Bindings';
import { postJson, postVoid } from './client';

export function getAiCallsignPage(): Promise<AiCallsignPageRsp> {
  return postJson<AiCallsignPageRsp>('/api/admin/ai-callsigns/page');
}

export function resetAiCallsignPrompt(): Promise<AiCallsignPromptState> {
  return postJson<AiCallsignPromptState>('/api/admin/ai-callsigns/prompt/reset');
}

export function createAiCallsignTestMessage(
  req: CreateAiCallsignTestMessageReq,
): Promise<AiCallsignTestMessageItem> {
  return postJson<AiCallsignTestMessageItem>('/api/admin/ai-callsigns/messages/create', req);
}

export function updateAiCallsignTestMessage(
  req: UpdateAiCallsignTestMessageReq,
): Promise<AiCallsignTestMessageItem> {
  return postJson<AiCallsignTestMessageItem>('/api/admin/ai-callsigns/messages/update', req);
}

export async function deleteAiCallsignTestMessage(id: string): Promise<void> {
  const req: AiCallsignTestMessageIdReq = { id };
  await postVoid('/api/admin/ai-callsigns/messages/delete', req);
}

export function testAiCallsignParsing(req: RunAiCallsignParsingReq): Promise<AiCallsignParsingRsp> {
  return postJson<AiCallsignParsingRsp>('/api/admin/ai-callsigns/test', req);
}

export function saveAiCallsignParsing(
  req: SaveAiCallsignParsingReq,
): Promise<AiCallsignParsingRsp> {
  return postJson<AiCallsignParsingRsp>('/api/admin/ai-callsigns/save', req);
}

export function recalculateAiCallsignParsing(
  req: RunAiCallsignParsingReq,
): Promise<AiCallsignParsingRsp> {
  return postJson<AiCallsignParsingRsp>('/api/admin/ai-callsigns/recalculate', req);
}

export function saveAiCallsignWorkerSettings(
  req: SaveAiCallsignWorkerSettingsReq,
): Promise<AiCallsignWorkerSettingsItem> {
  return postJson<AiCallsignWorkerSettingsItem>('/api/admin/ai-callsigns/worker/save', req);
}
