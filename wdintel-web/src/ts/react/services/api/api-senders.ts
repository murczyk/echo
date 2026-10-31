import type { ApiSender, DeleteApiSenderReq, UpsertApiSenderReq } from '../../../../Bindings';
import { postJson } from './client';

type ApiSenderResponse = {
  api_id: ApiSender['apiId'];
  display_name: ApiSender['displayName'];
  sender_uuid: ApiSender['senderUuid'];
  login_id: ApiSender['loginId'];
};

function normalizeSender(sender: ApiSenderResponse): ApiSender {
  return {
    apiId: sender.api_id,
    displayName: sender.display_name,
    senderUuid: sender.sender_uuid,
    loginId: sender.login_id,
  };
}

export async function listApiSenders(apiId: string, signal?: AbortSignal): Promise<ApiSender[]> {
  const senders = await postJson<ApiSenderResponse[]>(
    '/api/admin/api-senders',
    { api_id: apiId },
    { signal },
  );
  return senders.map(normalizeSender);
}

export async function saveApiSender(sender: UpsertApiSenderReq): Promise<ApiSender> {
  const result = await postJson<ApiSenderResponse>('/api/admin/api-senders/upsert', {
    api_id: sender.apiId,
    display_name: sender.displayName,
    sender_uuid: sender.senderUuid,
    login_id: sender.loginId,
  });
  return normalizeSender(result);
}

export function deleteApiSender(sender: DeleteApiSenderReq): Promise<void> {
  return postJson('/api/admin/api-senders/delete', {
    api_id: sender.apiId,
    sender_uuid: sender.senderUuid,
  });
}
