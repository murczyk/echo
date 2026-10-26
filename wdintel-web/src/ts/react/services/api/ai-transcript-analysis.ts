import type {
  AiTranscriptPage,
  AiTranscriptPrompt,
  AiTranscriptMessageReq,
  AiTranscriptTestMessage,
  AiTranscriptRunReq,
  AiTranscriptRunRsp,
  AiTranscriptSaveReq,
  AiTranscriptWorkerSettings,
  AiTranscriptQueueReq,
  AiTranscriptQueueRsp,
} from '../../../../Bindings';
import { postJson, postVoid } from './client';

const path = '/api/admin/ai-transcript-analysis';
export const getTranscriptAnalysisPage = () => postJson<AiTranscriptPage>(`${path}/page`);
export const getTranscriptAnalysisQueue = (req: AiTranscriptQueueReq, signal?: AbortSignal) =>
  postJson<AiTranscriptQueueRsp>(`${path}/queue`, req, { signal });
export const resetTranscriptAnalysisPrompt = () =>
  postJson<AiTranscriptPrompt>(`${path}/prompt/reset`);
export const saveTranscriptTestMessage = (req: AiTranscriptMessageReq) =>
  postJson<AiTranscriptTestMessage>(`${path}/messages/save`, req);
export const deleteTranscriptTestMessage = (id: string) =>
  postVoid(`${path}/messages/delete`, { id });
export const testTranscriptAnalysis = (req: AiTranscriptRunReq) =>
  postJson<AiTranscriptRunRsp>(`${path}/test`, req);
export const recalculateTranscriptAnalysis = (req: AiTranscriptRunReq) =>
  postJson<AiTranscriptRunRsp>(`${path}/recalculate`, req);
export const saveTranscriptAnalysis = (req: AiTranscriptSaveReq) =>
  postJson<AiTranscriptRunRsp>(`${path}/save`, req);
export const saveTranscriptWorker = (req: AiTranscriptWorkerSettings) =>
  postJson<AiTranscriptWorkerSettings>(`${path}/worker/save`, req);
