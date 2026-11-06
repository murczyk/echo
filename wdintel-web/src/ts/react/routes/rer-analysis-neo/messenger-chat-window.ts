import type { MessengersMessageItem, MessengersMessagesListRsp } from '../../../../Bindings';

// Analysis messenger chat rooms have their own limits, separate from the Analysis feed.
export const MESSENGER_PAGE_SIZE = 50;
export const MESSENGER_WINDOW_LIMIT = 150;
// Whole pages stay mounted; the opposite edge is dropped as pages arrive.
export const MESSENGER_MAX_PAGES = Math.floor(MESSENGER_WINDOW_LIMIT / MESSENGER_PAGE_SIZE);

// One loaded page of an analysis messenger chat. Items are in display order (oldest first); the API sends newest first.
// The window keeps whole pages because a cursor only exists for the edges of a page.
export type MessengerChatPage = {
  items: MessengersMessageItem[];
  olderCursor: string | null;
  newerCursor: string | null;
  // Only the last page can reach the newest message of the chat.
  atNewest: boolean;
};

function toPage(rsp: MessengersMessagesListRsp, atNewest: boolean): MessengerChatPage {
  return {
    items: [...rsp.items].reverse(),
    olderCursor: rsp.olderCursor,
    newerCursor: rsp.newerCursor,
    atNewest,
  };
}

export function newestPage(rsp: MessengersMessagesListRsp): MessengerChatPage {
  return toPage(rsp, true);
}

// The API returns `limit / 2` newer messages, so a shorter newer side means the chat ends there.
export function aroundPage(
  rsp: MessengersMessagesListRsp,
  aroundMessageId: string,
  limit: number,
): MessengerChatPage {
  const newerCount = rsp.items.findIndex((item) => item.id === aroundMessageId);
  return toPage(rsp, newerCount >= 0 && newerCount < Math.floor(limit / 2));
}

export function prependOlder(
  pages: readonly MessengerChatPage[],
  rsp: MessengersMessagesListRsp,
): MessengerChatPage[] {
  // An empty page is the only proof that nothing older is left after a `Newer` page.
  if (rsp.items.length === 0) {
    return pages.map((page, index) => (index === 0 ? { ...page, olderCursor: null } : page));
  }
  return [toPage(rsp, false), ...pages].slice(0, MESSENGER_MAX_PAGES);
}

export function appendNewer(
  pages: readonly MessengerChatPage[],
  rsp: MessengersMessagesListRsp,
  limit: number,
): MessengerChatPage[] {
  if (rsp.items.length === 0) {
    return pages.map((page, index) =>
      index === pages.length - 1 ? { ...page, atNewest: true } : page,
    );
  }
  return [...pages, toPage(rsp, rsp.items.length < limit)].slice(-MESSENGER_MAX_PAGES);
}

export function windowMessages(pages: readonly MessengerChatPage[]): MessengersMessageItem[] {
  return pages.flatMap((page) => page.items);
}

export function hasMoreAbove(pages: readonly MessengerChatPage[]): boolean {
  return pages.length > 0 && pages[0].olderCursor !== null;
}

export function hasMoreBelow(pages: readonly MessengerChatPage[]): boolean {
  return pages.length > 0 && !pages[pages.length - 1].atNewest;
}
