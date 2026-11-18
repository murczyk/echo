import type { MessengersMessageItem } from '../../../../Bindings';

// Shorter queries are not sent: one letter matches half of the chat.
export const CHAT_SEARCH_MIN_LENGTH = 2;

export type HeadlinePart = { text: string; match: boolean };

// `headline` is plain text with each match between U+E000 and U+E001 (`MESSENGERS_HEADLINE_START` / `_STOP`).
// Parts, not HTML, so the text never has to be escaped.
export function splitHeadline(headline: string): HeadlinePart[] {
  const parts: HeadlinePart[] = [];
  let match = false;
  for (const piece of headline.split(/([])/)) {
    if (piece === '') match = true;
    else if (piece === '') match = false;
    else if (piece !== '') parts.push({ text: piece, match });
  }
  return parts;
}

// Where a jump to a day lands, in the messages around the start of the day (oldest first): the first message sent on or
// after it, else the newest one before it, so a day without messages still lands next to where it would be and the reader
// never taps and stays in place. null only for an empty chat.
export function pickJumpTarget(
  items: readonly MessengersMessageItem[],
  dayStartMs: number,
): MessengersMessageItem | null {
  return items.find((item) => item.sentAt >= dayStartMs) ?? items.at(-1) ?? null;
}

export function isInRange(item: MessengersMessageItem, fromMs: number, toMs: number): boolean {
  return item.sentAt >= fromMs && item.sentAt <= toMs;
}
