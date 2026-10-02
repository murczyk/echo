import type {
  AiPositionKnowledgeListReq,
  AiPositionKnowledgeListRsp,
  AiPositionMentionListReq,
  AiPositionMentionListRsp,
  AiPositionPageRsp,
  AiPositionPromptState,
  AiPositionWorkerSettingsItem,
  EnqueueAiPositionBackfillReq,
  EnqueueAiPositionBackfillRsp,
  SaveAiPositionPromptReq,
  SaveAiPositionWorkerSettingsReq,
  TestAiPositionReq,
  TestAiPositionRsp,
} from '../../../../Bindings';
import { postJson } from './client';

export function getAiPositionPage(): Promise<AiPositionPageRsp> {
  return postJson<AiPositionPageRsp>('/api/admin/ai-positions/page');
}

export function saveAiPositionPrompt(req: SaveAiPositionPromptReq): Promise<AiPositionPromptState> {
  return postJson<AiPositionPromptState>('/api/admin/ai-positions/prompt/save', req);
}

export function saveAiPositionWorkerSettings(
  req: SaveAiPositionWorkerSettingsReq,
): Promise<AiPositionWorkerSettingsItem> {
  return postJson<AiPositionWorkerSettingsItem>('/api/admin/ai-positions/worker/save', req);
}

export function testAiPositions(req: TestAiPositionReq): Promise<TestAiPositionRsp> {
  return postJson<TestAiPositionRsp>('/api/admin/ai-positions/test', req);
}

export function enqueueAiPositionBackfill(
  req: EnqueueAiPositionBackfillReq,
): Promise<EnqueueAiPositionBackfillRsp> {
  return postJson<EnqueueAiPositionBackfillRsp>('/api/admin/ai-positions/backfill', req);
}

export function listAiPositionMentions(
  req: AiPositionMentionListReq,
  signal?: AbortSignal,
): Promise<AiPositionMentionListRsp> {
  return postJson<AiPositionMentionListRsp>('/api/admin/ai-positions/mentions/list', req, {
    signal,
  });
}

export function listAiPositionKnowledge(
  req: AiPositionKnowledgeListReq,
  signal?: AbortSignal,
): Promise<AiPositionKnowledgeListRsp> {
  return postJson<AiPositionKnowledgeListRsp>('/api/admin/ai-positions/knowledge/list', req, {
    signal,
  });
}
