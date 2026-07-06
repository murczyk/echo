import type { InboxMessage, InboxMessageTag } from '../../../../../Bindings';
import { isNullOrUndefined } from '../../../utils/misc';

export function getInboxTags(message: InboxMessage): InboxMessageTag[] {
  return message.inboxTags ?? [];
}

export function hasUserTag(message: InboxMessage, tagId: number, login: string | null): boolean {
  if (isNullOrUndefined(login) || login.trim() === '') return false;
  return getInboxTags(message).some(
    (tag) => tag.tagId === tagId && tag.model == null && tag.login === login,
  );
}

export function hasBotTag(message: InboxMessage, tagId: number): boolean {
  return getInboxTags(message).some((tag) => tag.tagId === tagId && tag.model != null);
}

export function tagIdsWithFallback(
  inboxTags: InboxMessageTag[],
  fallbackTags: number[] | null | undefined,
): number[] {
  const next: number[] = [];
  for (const tag of inboxTags) {
    if (!next.includes(tag.tagId)) next.push(tag.tagId);
  }
  for (const tagId of fallbackTags ?? []) {
    if (!next.includes(tagId)) next.push(tagId);
  }
  return next;
}

export function tagIdsWithoutTagId(
  inboxTags: InboxMessageTag[],
  fallbackTags: number[] | null | undefined,
  tagId: number,
): number[] {
  const next: number[] = [];
  for (const tag of inboxTags) {
    if (tag.tagId !== tagId && !next.includes(tag.tagId)) next.push(tag.tagId);
  }
  for (const fallbackTagId of fallbackTags ?? []) {
    if (fallbackTagId !== tagId && !next.includes(fallbackTagId)) next.push(fallbackTagId);
  }
  return next;
}

export function toggleHumanTag(
  message: InboxMessage,
  tagId: number,
  login: string | null,
  organismId: number | null,
): InboxMessage {
  const currentTags = getInboxTags(message);
  const remainingTags =
    login == null
      ? currentTags
      : currentTags.filter(
          (tag) => !(tag.tagId === tagId && tag.model == null && tag.login === login),
        );
  const hasRemoved = remainingTags.length !== currentTags.length;
  const added =
    login != null && !hasRemoved
      ? [
          {
            id: 0,
            tagId,
            confidence: 1,
            login,
            model: null,
            organismId,
          },
        ]
      : [];
  const inboxTags = [...added, ...remainingTags];
  const hasRemainingTag = inboxTags.some((tag) => tag.tagId === tagId);
  return {
    ...message,
    inboxTags,
    tags: hasRemainingTag
      ? tagIdsWithFallback(inboxTags, message.tags ?? [])
      : tagIdsWithoutTagId(inboxTags, message.tags ?? [], tagId),
  };
}

export function removeBotTags(message: InboxMessage, tagId: number): InboxMessage {
  const inboxTags = getInboxTags(message).filter(
    (tag) => !(tag.tagId === tagId && tag.model != null),
  );
  return {
    ...message,
    inboxTags,
    tags: tagIdsWithoutTagId(inboxTags, message.tags ?? [], tagId),
  };
}
