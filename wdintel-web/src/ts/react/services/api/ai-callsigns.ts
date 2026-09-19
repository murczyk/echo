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

export function listCallsignFeedback(req: import('../../../../Bindings').FeedbackListReq) {
  return postJson<import('../../../../Bindings').FeedbackItem[]>(
    '/api/admin/ai-callsigns/feedback/list',
    req,
  );
}

export function getCallsignFeedback(req: import('../../../../Bindings').FeedbackDetailsReq) {
  return postJson<import('../../../../Bindings').FeedbackDetail[]>(
    '/api/admin/ai-callsigns/feedback/details',
    req,
  );
}

export function getCallsignReparseRuns() {
  return postJson<import('../../../../Bindings').ReparseStatus[]>(
    '/api/admin/ai-callsigns/reparse/status',
  );
}

export function startCallsignReparse(req: import('../../../../Bindings').ReparseStartReq) {
  return postJson<import('../../../../Bindings').ReparseIdReq>(
    '/api/admin/ai-callsigns/reparse/start',
    req,
  );
}

export function cancelCallsignReparse(req: import('../../../../Bindings').ReparseIdReq) {
  return postVoid('/api/admin/ai-callsigns/reparse/cancel', req);
}

export function retryCallsignReparse(req: import('../../../../Bindings').ReparseIdReq) {
  return postVoid('/api/admin/ai-callsigns/reparse/retry', req);
}

export function getCallsignReparseFailures(req: import('../../../../Bindings').ReparseIdReq) {
  return postJson<import('../../../../Bindings').ReparseFailure[]>(
    '/api/admin/ai-callsigns/reparse/failures',
    req,
  );
}
