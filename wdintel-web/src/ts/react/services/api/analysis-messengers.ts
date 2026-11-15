import type {
  MessengersAccountUpdateReq,
  MessengersAttachmentsCountsReq,
  MessengersAttachmentsCountsRsp,
  MessengersAttachmentsListReq,
  MessengersAttachmentsListRsp,
  MessengersAccountsListRsp,
  MessengersChatReadState,
  MessengersChatReadStateUpdateReq,
  MessengersChatsListReq,
  MessengersChatsMarkAllReadReq,
  MessengersChatMembersListReq,
  MessengersChatMembersListRsp,
  MessengersChatsListRsp,
  MessengersContactsListReq,
  MessengersContactsListRsp,
  MessengersMessagesListReq,
  MessengersMessagesListRsp,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, postVoid } from './client';
import type { RequestOptions } from './client';

// Read-only analysis messenger viewer API, `/api/messengers`. Requires the CyberMessengers role.

export async function listMessengersAccounts(
  options?: RequestOptions,
): Promise<MessengersAccountsListRsp> {
  return transformSnakeToCamel<MessengersAccountsListRsp>(
    await postJson<unknown>('/api/messengers/accounts/list', {}, options),
  );
}

// Full state: every editable field is replaced and a null one is cleared.
export async function updateMessengersAccount(
  req: MessengersAccountUpdateReq,
  options?: RequestOptions,
): Promise<void> {
  await postVoid('/api/messengers/accounts/update', transformCamelToSnake(req), options);
}

export async function listMessengersChats(
  req: MessengersChatsListReq,
  options?: RequestOptions,
): Promise<MessengersChatsListRsp> {
  return transformSnakeToCamel<MessengersChatsListRsp>(
    await postJson<unknown>('/api/messengers/chats/list', transformCamelToSnake(req), options),
  );
}

// Marks the messages sent within `[oldestReadAt, newestReadAt]` (epoch ms) as read for this login. The stored span only
// widens, and the answer is the merged state with the new unread count.
export async function updateMessengersChatReadState(
  req: MessengersChatReadStateUpdateReq,
  options?: RequestOptions,
): Promise<MessengersChatReadState> {
  return transformSnakeToCamel<MessengersChatReadState>(
    await postJson<unknown>(
      '/api/messengers/chats/read-state/update',
      transformCamelToSnake(req),
      options,
    ),
  );
}

// Marks every chat of the account read for this login; read the counts again with `listMessengersChats`.
export async function markAllMessengersChatsRead(
  req: MessengersChatsMarkAllReadReq,
  options?: RequestOptions,
): Promise<void> {
  await postVoid('/api/messengers/chats/mark-all-read', transformCamelToSnake(req), options);
}

export async function listMessengersChatMembers(
  req: MessengersChatMembersListReq,
  options?: RequestOptions,
): Promise<MessengersChatMembersListRsp> {
  return transformSnakeToCamel<MessengersChatMembersListRsp>(
    await postJson<unknown>(
      '/api/messengers/chats/members/list',
      transformCamelToSnake(req),
      options,
    ),
  );
}

// One page of analysis messenger messages, newest first. Cursors are opaque; see docs/MESSENGERS_API.md for the paging modes.
export async function listMessengersMessages(
  req: MessengersMessagesListReq,
  options?: RequestOptions,
): Promise<MessengersMessagesListRsp> {
  return transformSnakeToCamel<MessengersMessagesListRsp>(
    await postJson<unknown>('/api/messengers/messages/list', transformCamelToSnake(req), options),
  );
}

// One page of an account's address book (pages from 1, at most 100 per page). There is no search: filter what is loaded.
export async function listMessengersContacts(
  req: MessengersContactsListReq,
  options?: RequestOptions,
): Promise<MessengersContactsListRsp> {
  return transformSnakeToCamel<MessengersContactsListRsp>(
    await postJson<unknown>('/api/messengers/contacts/list', transformCamelToSnake(req), options),
  );
}

// One page of the attachments of a chat (or of every chat of an account when `chatId` is null), newest first.
export async function listMessengersAttachments(
  req: MessengersAttachmentsListReq,
  options?: RequestOptions,
): Promise<MessengersAttachmentsListRsp> {
  return transformSnakeToCamel<MessengersAttachmentsListRsp>(
    await postJson<unknown>(
      '/api/messengers/attachments/list',
      transformCamelToSnake(req),
      options,
    ),
  );
}

// The number of attachments of a chat (or of an account when `chatId` is null) for each Telegram media type.
export async function countMessengersAttachments(
  req: MessengersAttachmentsCountsReq,
  options?: RequestOptions,
): Promise<MessengersAttachmentsCountsRsp> {
  return transformSnakeToCamel<MessengersAttachmentsCountsRsp>(
    await postJson<unknown>(
      '/api/messengers/attachments/count',
      transformCamelToSnake(req),
      options,
    ),
  );
}
