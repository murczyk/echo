import type { MessengersChatMemberItem } from '../../../../Bindings';
import { senderName } from './use-messenger-chat';

export const isPrivateChat = (chatType: string | null | undefined) =>
  chatType?.toLowerCase() === 'private';

export type SenderUiState = {
  // Shown above the message text.
  showName: boolean;
  // Used as `name: text` prefix when a selection from a private chat is copied.
  copyName: string | null;
  needsCopyPrefix: boolean;
};

// Same rules as kontur, for analysis messenger chats: a private chat shows no names except for a sender that is not one of its
// members, and a copied private-chat selection gets the names that the screen hides.
export function getSenderUiState({
  isOutgoing,
  chatType,
  member,
  accountName,
}: {
  isOutgoing: boolean | null;
  chatType: string | null | undefined;
  member: MessengersChatMemberItem | undefined;
  accountName: string;
}): SenderUiState {
  const outgoing = isOutgoing === true;
  const isPrivate = isPrivateChat(chatType);
  const externalSender = isPrivate && !outgoing && member == null;
  const memberName = member == null ? null : senderName(member);
  const copyName = outgoing ? accountName || null : memberName;
  return {
    showName: !outgoing && memberName != null && (!isPrivate || externalSender),
    copyName,
    needsCopyPrefix: isPrivate && copyName != null && (outgoing || member != null),
  };
}

// A message is visible before its attachments arrive, so a missing attachment of a fresh message is
// most likely still on its way.
const ATTACHMENT_ARRIVAL_WINDOW_MS = 10 * 60_000;

export function missingAttachmentNotice(sentAt: number, now: number = Date.now()): string {
  return now - sentAt < ATTACHMENT_ARRIVAL_WINDOW_MS
    ? 'Вкладення завантажується…'
    : 'Вкладення недоступне';
}

const DAY_MS = 86_400_000;

// Date pill over the analysis messenger feed: today, yesterday, or day and month (with the year for other years).
export function formatRelativeDateLabel(ms: number, now: Date = new Date()): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const dayDiff = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
  if (dayDiff === 0) return 'Сьогодні';
  if (dayDiff === 1) return 'Вчора';
  return new Intl.DateTimeFormat('uk-UA', {
    day: 'numeric',
    month: 'long',
    ...(date.getFullYear() !== now.getFullYear() ? { year: 'numeric' as const } : {}),
  }).format(date);
}

function intersectRange(range: Range, element: Element): Range | null {
  const elementRange = document.createRange();
  elementRange.selectNodeContents(element);
  const intersects =
    range.compareBoundaryPoints(Range.END_TO_START, elementRange) < 0 &&
    range.compareBoundaryPoints(Range.START_TO_END, elementRange) > 0;
  if (!intersects) return null;
  const part = range.cloneRange();
  if (range.compareBoundaryPoints(Range.START_TO_START, elementRange) < 0) {
    part.setStart(elementRange.startContainer, elementRange.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, elementRange) > 0) {
    part.setEnd(elementRange.endContainer, elementRange.endOffset);
  }
  return part;
}

// Prepends the hidden sender names to the copied analysis messenger messages of a private chat. Returns null when the
// browser's own copy should be kept (nothing selected, or no message text in the selection).
export function buildPrivateChatCopyText(container: Element, selection: Selection): string | null {
  if (!selection.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  const parts: string[] = [];
  container.querySelectorAll<HTMLElement>('[data-messenger-copy-text]').forEach((element) => {
    const part = intersectRange(range, element);
    const text = part?.toString() ?? '';
    if (!text.trim()) return;
    const name = element.dataset.copySender;
    parts.push(name ? `${name}: ${text}` : text);
  });
  return parts.length > 0 ? parts.join('\n\n') : null;
}
