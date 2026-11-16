import { describe, expect, it } from 'vitest';

import type { MessengersMessageItem, MessengersMessagesListRsp } from '../../../../../Bindings';
import {
  aroundPage,
  aroundSentAtPage,
  appendNewer,
  hasMoreAbove,
  hasMoreBelow,
  MESSENGER_MAX_PAGES,
  newestPage,
  oldestPage,
  prependOlder,
  windowMessages,
} from '../messenger-chat-window';

const message = (id: string): MessengersMessageItem => ({
  id,
  externalId: id,
  sentAt: 0,
  text: id,
  isOutgoing: null,
  hasMedia: null,
  senderChatMemberId: null,
  attachments: [],
  telegram: null,
});

// The API sends newest first.
const rsp = (
  ids: string[],
  olderCursor: string | null,
  newerCursor: string | null,
): MessengersMessagesListRsp => ({ items: ids.map(message), olderCursor, newerCursor });

const ids = (pages: Parameters<typeof windowMessages>[0]) => windowMessages(pages).map((m) => m.id);

describe('messenger chat window', () => {
  it('turns the newest page into display order and marks it as the chat end', () => {
    const page = newestPage(rsp(['c', 'b', 'a'], 'older', 'newer'));
    expect(ids([page])).toEqual(['a', 'b', 'c']);
    expect(hasMoreAbove([page])).toBe(true);
    expect(hasMoreBelow([page])).toBe(false);
  });

  it('has nothing above when the older cursor is gone', () => {
    expect(hasMoreAbove([newestPage(rsp(['a'], null, 'n'))])).toBe(false);
  });

  it('reports no more in either direction for an empty window', () => {
    expect(hasMoreAbove([])).toBe(false);
    expect(hasMoreBelow([])).toBe(false);
  });

  describe('oldest page', () => {
    it('has nothing above and more below when it is full', () => {
      const page = oldestPage(rsp(['c', 'b', 'a'], null, 'n'), 3);
      expect(ids([page])).toEqual(['a', 'b', 'c']);
      expect(hasMoreAbove([page])).toBe(false);
      expect(hasMoreBelow([page])).toBe(true);
    });

    it('is the whole chat when the page is short', () => {
      const page = oldestPage(rsp(['b', 'a'], null, 'n'), 3);
      expect(hasMoreAbove([page])).toBe(false);
      expect(hasMoreBelow([page])).toBe(false);
    });
  });

  describe('around pages', () => {
    it('keeps loading below while the newer side is full', () => {
      const page = aroundPage(rsp(['e', 'd', 'c', 'b', 'a'], 'o', 'n'), 'c', 4);
      // two newer messages (e, d) is exactly limit / 2
      expect(hasMoreBelow([page])).toBe(true);
    });

    it('marks the chat end when the newer side is short', () => {
      const page = aroundPage(rsp(['d', 'c', 'b', 'a'], 'o', 'n'), 'c', 4);
      expect(hasMoreBelow([page])).toBe(false);
    });

    it('marks the chat end when the anchor is the newest message', () => {
      expect(hasMoreBelow([aroundPage(rsp(['c', 'b', 'a'], 'o', 'n'), 'c', 4)])).toBe(false);
    });

    it('does not claim the chat end when the anchor is missing from the page', () => {
      expect(hasMoreBelow([aroundPage(rsp(['b', 'a'], 'o', 'n'), 'zzz', 4)])).toBe(true);
    });
  });

  describe('pages around a time', () => {
    const at = (sentAt: number, id: string): MessengersMessageItem => ({ ...message(id), sentAt });
    const rspAt = (...items: MessengersMessageItem[]): MessengersMessagesListRsp => ({
      items,
      olderCursor: 'o',
      newerCursor: 'n',
    });

    it('keeps loading below while the newer side is full', () => {
      const page = aroundSentAtPage(rspAt(at(5, 'e'), at(4, 'd'), at(3, 'c'), at(2, 'b')), 3, 4);
      expect(hasMoreBelow([page])).toBe(true);
    });

    it('marks the chat end when the newer side is short, or when nothing is newer', () => {
      expect(
        hasMoreBelow([aroundSentAtPage(rspAt(at(4, 'd'), at(3, 'c'), at(2, 'b')), 3, 4)]),
      ).toBe(false);
      expect(hasMoreBelow([aroundSentAtPage(rspAt(at(3, 'c'), at(2, 'b')), 3, 4)])).toBe(false);
    });

    it('does not count a message sent at the read time as newer', () => {
      const page = aroundSentAtPage(rspAt(at(3, 'd'), at(3, 'c'), at(3, 'b')), 3, 4);
      expect(hasMoreBelow([page])).toBe(false);
    });
  });

  describe('older pages', () => {
    it('prepends the page in display order', () => {
      const pages = prependOlder(
        [newestPage(rsp(['d', 'c'], 'o1', 'n1'))],
        rsp(['b', 'a'], 'o2', 'n2'),
      );
      expect(ids(pages)).toEqual(['a', 'b', 'c', 'd']);
      expect(pages[0].olderCursor).toBe('o2');
    });

    it('drops the newest page beyond the window limit and then has more below', () => {
      let pages = [newestPage(rsp(['p0'], 'o0', 'n0'))];
      for (let k = 1; k <= MESSENGER_MAX_PAGES; k++) {
        pages = prependOlder(pages, rsp([`p${k}`], `o${k}`, `n${k}`));
      }
      expect(pages).toHaveLength(MESSENGER_MAX_PAGES);
      expect(ids(pages)).not.toContain('p0');
      expect(ids(pages)[0]).toBe(`p${MESSENGER_MAX_PAGES}`);
      expect(hasMoreBelow(pages)).toBe(true);
    });

    it('treats an empty page as the start of the chat', () => {
      const pages = prependOlder([newestPage(rsp(['b', 'a'], 'o1', 'n1'))], rsp([], 'o1', 'n1'));
      expect(ids(pages)).toEqual(['a', 'b']);
      expect(hasMoreAbove(pages)).toBe(false);
    });
  });

  describe('newer pages', () => {
    const around = () => aroundPage(rsp(['d', 'c', 'b', 'a'], 'o1', 'n1'), 'a', 2);

    it('appends a full page and keeps loading below', () => {
      const pages = appendNewer([around()], rsp(['f', 'e'], 'o2', 'n2'), 2);
      expect(ids(pages)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      expect(hasMoreBelow(pages)).toBe(true);
    });

    it('marks the chat end when the page is short', () => {
      const pages = appendNewer([around()], rsp(['e'], 'o2', 'n2'), 2);
      expect(hasMoreBelow(pages)).toBe(false);
    });

    it('marks the chat end on an empty page without adding a page', () => {
      const pages = appendNewer([around()], rsp([], 'o1', 'n1'), 2);
      expect(pages).toHaveLength(1);
      expect(hasMoreBelow(pages)).toBe(false);
    });

    it('drops the oldest page beyond the window limit and then has more above', () => {
      let pages = [around()];
      for (let k = 1; k <= MESSENGER_MAX_PAGES; k++) {
        pages = appendNewer(pages, rsp([`q${k}`], `o${k}`, `n${k}`), 1);
      }
      expect(pages).toHaveLength(MESSENGER_MAX_PAGES);
      expect(ids(pages)).not.toContain('a');
      expect(ids(pages)[0]).toBe('q1');
      expect(hasMoreAbove(pages)).toBe(true);
      expect(pages[0].olderCursor).toBe('o1');
    });
  });
});
