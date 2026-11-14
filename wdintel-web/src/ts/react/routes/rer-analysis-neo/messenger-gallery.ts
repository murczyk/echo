import type { MessengersAttachmentItem } from '../../../../Bindings';
import {
  countMessengersAttachments,
  listMessengersAttachments,
} from '../../services/api/analysis-messengers';

export type GalleryTab = 'photo' | 'video' | 'audio' | 'document';
export const GALLERY_TABS: readonly GalleryTab[] = ['photo', 'video', 'audio', 'document'];
export const GALLERY_TAB_LABELS: Record<GalleryTab, string> = {
  photo: 'Фото',
  video: 'Відео',
  audio: 'Аудіо',
  document: 'Документи',
};

export type GalleryCounts = Record<GalleryTab, number>;
// `chatId` null is every chat of the account (the sidebar's "Галерея", not wired yet).
export type GalleryScope = { accountId: string; chatId: string | null };
export type GalleryPage = { items: MessengersAttachmentItem[]; olderCursor: string | null };

// What the gallery needs from the backend. The routes behind `counts`, `ids` and `zip` do not exist yet (plan,
// "Media gallery: blocked on the backend"), so they are optional: the UI hides what is missing, and the day a route
// arrives only the source below changes. Media ids are the identity of an item everywhere.
export type GalleryDataSource = {
  // One page of one tab, newest first.
  list(
    scope: GalleryScope,
    tab: GalleryTab,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<GalleryPage>;
  // Items per tab, for the labels of the tabs.
  counts?(scope: GalleryScope, signal: AbortSignal): Promise<GalleryCounts>;
  // Every media id of a tab, loaded or not, for "select all".
  ids?(scope: GalleryScope, tab: GalleryTab, signal: AbortSignal): Promise<string[]>;
  // The archive of the given media ids.
  zip?(scope: GalleryScope, mediaIds: string[], signal: AbortSignal): Promise<Blob>;
};

// A small first page paints sooner; the pages after it are the size the route allows.
export const GALLERY_FIRST_PAGE_SIZE = 40;
export const GALLERY_PAGE_SIZE = 100;

// The Telegram media types of each tab (kontur's rules: a video note is a video, a voice message is audio). All the types of a
// tab go in one request, so a page is never short of the tab's items. `document` is only what Telegram calls a document: the
// filter has no "everything else", so a type that is in no tab (an animation, say) is not shown at all.
export const GALLERY_TAB_TELEGRAM_TYPES: Record<GalleryTab, string[]> = {
  photo: ['photo'],
  video: ['video', 'video_note'],
  audio: ['voice', 'audio'],
  document: ['document'],
};

// `ids` and `zip` are added when their routes exist (plan, B3 and B4).
export const messengerGallerySource: GalleryDataSource = {
  async list(scope, tab, cursor, signal) {
    const rsp = await listMessengersAttachments(
      {
        accountId: scope.accountId,
        chatId: scope.chatId,
        cursor,
        limit: cursor == null ? GALLERY_FIRST_PAGE_SIZE : GALLERY_PAGE_SIZE,
        direction: null,
        telegramMediaTypes: GALLERY_TAB_TELEGRAM_TYPES[tab],
      },
      { signal },
    );
    return { items: rsp.items, olderCursor: rsp.olderCursor };
  },
  // The route counts by Telegram type; the tabs add up their own types (so the grouping stays in one place, above).
  async counts(scope, signal) {
    const rsp = await countMessengersAttachments(
      { accountId: scope.accountId, chatId: scope.chatId },
      { signal },
    );
    const byType = new Map(rsp.items.map((entry) => [entry.telegramMediaType, entry.count]));
    return Object.fromEntries(
      GALLERY_TABS.map((tab) => [
        tab,
        GALLERY_TAB_TELEGRAM_TYPES[tab].reduce((sum, type) => sum + (byType.get(type) ?? 0), 0),
      ]),
    ) as GalleryCounts;
  },
};
