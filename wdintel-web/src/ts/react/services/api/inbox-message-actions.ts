import type {
  BookmarkAddReq,
  BookmarkRmReq,
  ImportantAddReq,
  ImportantRmReq,
  InboxCommentSaveReq,
  InboxDeleteReq,
  InboxMessageTagsAddReq,
  InboxMessageTagModelErrorReq,
  InboxMessageTagsRmReq,
} from '../../../../Bindings';
import { postVoid } from './client';

export async function bookmarkAdd(req: BookmarkAddReq): Promise<void> {
  await postVoid('/api/rer/bookmark/add', { message_id: req.messageId });
}

export async function bookmarkRemove(req: BookmarkRmReq): Promise<void> {
  await postVoid('/api/rer/bookmark/delete', { message_id: req.messageId });
}

export async function importantAdd(req: ImportantAddReq): Promise<void> {
  await postVoid('/api/rer/important/add', { message_id: req.messageId });
}

export async function importantRemove(req: ImportantRmReq): Promise<void> {
  await postVoid('/api/rer/important/delete', { message_id: req.messageId });
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

export async function inboxMessageTagsAdd(req: InboxMessageTagsAddReq): Promise<void> {
  await postVoid('/api/tags/tags-add', { message_id: req.messageId, tag_id: req.tagId });
}

export async function inboxMessageTagsRm(req: InboxMessageTagsRmReq): Promise<void> {
  await postVoid('/api/tags/tags-rm', { message_id: req.messageId, tag_id: req.tagId });
}

export async function inboxMessageTagsModelError(req: InboxMessageTagModelErrorReq): Promise<void> {
  await postVoid('/api/tags/tag-model-error', { message_id: req.messageId, tag_id: req.tagId });
}
