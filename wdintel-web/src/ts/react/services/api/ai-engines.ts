import type {
  AiChatDetail,
  AiChatGetReq,
  AiChatListReq,
  AiChatListRsp,
  AiEngineIdReq,
  AiEngineItem,
  AiEngineListRsp,
  CreateAiEngineReq,
  SendAiChatMessageReq,
  UpdateAiEngineReq,
} from '../../../../Bindings';
import { postJson, postVoid } from './client';

export async function listAiEngines(): Promise<AiEngineItem[]> {
  const data = await postJson<AiEngineListRsp>('/api/admin/ai-engines/list');
  return data.items;
}

export async function getAiEngine(id: string): Promise<AiEngineItem> {
  const req: AiEngineIdReq = { id };
  return postJson<AiEngineItem>('/api/admin/ai-engines/get', req);
}

export async function createAiEngine(req: CreateAiEngineReq): Promise<AiEngineItem> {
  return postJson<AiEngineItem>('/api/admin/ai-engines/create', req);
}

export async function updateAiEngine(req: UpdateAiEngineReq): Promise<AiEngineItem> {
  return postJson<AiEngineItem>('/api/admin/ai-engines/update', req);
}

export async function deleteAiEngine(id: string): Promise<void> {
  const req: AiEngineIdReq = { id };
  await postVoid('/api/admin/ai-engines/delete', req);
}

export async function listAiChats(aiEngineId: string): Promise<AiChatListRsp> {
  const req: AiChatListReq = { aiEngineId };
  return postJson<AiChatListRsp>('/api/admin/ai-engines/chats/list', req);
}

export async function getAiChat(aiEngineId: string, chatId: string): Promise<AiChatDetail> {
  const req: AiChatGetReq = { aiEngineId, chatId };
  return postJson<AiChatDetail>('/api/admin/ai-engines/chats/get', req);
}

export async function sendAiChatMessage(req: SendAiChatMessageReq): Promise<AiChatDetail> {
  return postJson<AiChatDetail>('/api/admin/ai-engines/chats/send', req);
}
