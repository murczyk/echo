import type {
  BookmarkAddReq,
  BookmarkRmReq,
  ImportantAddReq,
  ImportantMutationRsp,
  ImportantRmReq,
  InboxCommentSaveReq,
  InboxDeleteReq,
  InboxMessageTagsAddReq,
  InboxMessageTagModelErrorReq,
  InboxMessageTagsRmReq,
} from '../../../../Bindings';
import { transformSnakeToCamel } from '../../../snake-to-camel';
import { postJson, postVoid } from './client';

const EVENT_ORIGIN_HEADER = 'X-Echo-Event-Origin';

type TagMutationOptions = {
  eventOrigin?: string;
};

function tagMutationRequestOptions(options?: TagMutationOptions) {
  if (options?.eventOrigin == null) return undefined;
  return { headers: { [EVENT_ORIGIN_HEADER]: options.eventOrigin } };
}

export async function bookmarkAdd(req: BookmarkAddReq): Promise<void> {
  await postVoid('/api/rer/bookmark/add', { message_id: req.messageId });
}

export async function bookmarkRemove(req: BookmarkRmReq): Promise<void> {
  await postVoid('/api/rer/bookmark/delete', { message_id: req.messageId });
}

export async function importantAdd(req: ImportantAddReq): Promise<boolean> {
  const raw = await postJson<unknown>('/api/rer/important/add', {
    message_id: req.messageId,
    group_master_key: req.groupMasterKey,
    notify_group: req.notifyGroup,
    operation_id: req.operationId,
  });
  return transformSnakeToCamel<ImportantMutationRsp>(raw).important;
}

export async function importantRemove(req: ImportantRmReq): Promise<boolean> {
  const raw = await postJson<unknown>('/api/rer/important/delete', { message_id: req.messageId });
  return transformSnakeToCamel<ImportantMutationRsp>(raw).important;
}

export async function deleteMessage(req: InboxDeleteReq): Promise<void> {
  await postVoid('/api/rer-importer/delete-message', { id: req.id });
}

export async function commentSave(req: InboxCommentSaveReq): Promise<void> {
  await postVoid('/api/rer-importer/comment-save', {
    message_id: req.messageId,
    comment: req.comment,
  });
}

export async function inboxMessageTagsAdd(
  req: InboxMessageTagsAddReq,
  options?: TagMutationOptions,
): Promise<void> {
  await postVoid(
    '/api/tags/tags-add',
    { message_id: req.messageId, tag_id: req.tagId },
    tagMutationRequestOptions(options),
  );
}

export async function inboxMessageTagsRm(
  req: InboxMessageTagsRmReq,
  options?: TagMutationOptions,
): Promise<void> {
  await postVoid(
    '/api/tags/tags-rm',
    { message_id: req.messageId, tag_id: req.tagId },
    tagMutationRequestOptions(options),
  );
}

export async function inboxMessageTagsModelError(
  req: InboxMessageTagModelErrorReq,
  options?: TagMutationOptions,
): Promise<void> {
  await postVoid(
    '/api/tags/tag-model-error',
    { message_id: req.messageId, tag_id: req.tagId },
    tagMutationRequestOptions(options),
  );
}
