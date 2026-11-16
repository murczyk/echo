import type { MessengersMessageItem } from '../../../../Bindings';

export const STOPPED_HERE_LABEL = 'Ви зупинились тут';
export const UNREAD_ABOVE_LABEL = 'Вище — непрочитані';

// The read span of a chat as it was when the chat was opened, epoch ms. Messages outside it are unread.
export type ReadSpan = { oldest: number; newest: number };

export type UnreadMarks = {
  // The first message sent after the span: the reader stopped above it.
  afterId: string | null;
  // The first message of the span, with unread history (older than the span) above it.
  beforeId: string | null;
  // The newest of that unread history, the message right above `beforeId`.
  aboveId: string | null;
};

// Where the unread messages meet the read ones in the loaded window (oldest first). A boundary that is not loaded has no
// mark: a window that begins with an unread message has the boundary above it, and its first message gets no divider.
export function findUnreadMarks(
  messages: readonly MessengersMessageItem[],
  span: ReadSpan | null,
): UnreadMarks {
  const marks: UnreadMarks = { afterId: null, beforeId: null, aboveId: null };
  if (span == null) return marks;
  const after = messages.findIndex((message) => message.sentAt > span.newest);
  if (after > 0) marks.afterId = messages[after].id;
  const first = messages.findIndex((message) => message.sentAt >= span.oldest);
  // Without a message inside the span the two boundaries are the same place, and "stopped here" says it.
  if (first > 0 && first !== after) {
    marks.beforeId = messages[first].id;
    marks.aboveId = messages[first - 1].id;
  }
  return marks;
}
