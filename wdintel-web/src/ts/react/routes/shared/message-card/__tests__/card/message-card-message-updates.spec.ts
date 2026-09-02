import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../../../../Bindings';
import { mergeUpdatedDutyFeedMessages } from '../../message-card-message-updates';

function inboxMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    id: 0,
    text: '',
    createdAt: 0,
    updatedAt: 0,
    tags: [],
    inboxTags: [],
    networkIds: [],
    ...overrides,
  } as InboxMessage;
}

// @test-scope safeguard: prevents refreshed duty-feed messages from losing metadata or retaining deleted rows.
describe('mergeUpdatedDutyFeedMessages', () => {
  it('replaces refreshed messages and preserves feed metadata', () => {
    const first = inboxMessage({ text: 'one' });
    const second = inboxMessage({
      text: 'two',
      textMarked: [{ CNTextC: { text: 'old marked' } }] as never,
      keywordTokens: [{ text: 'old keyword' }] as never,
      pointTokens: [{ text: 'old point', etalon: 'old-point' }] as never,
    });
    const refreshedSecond = inboxMessage({
      text: 'two-updated',
      textMarked: [{ CNTextC: { text: 'new marked' } }] as never,
      keywordTokens: [{ text: 'new keyword' }] as never,
      pointTokens: [{ text: 'new point', etalon: 'new-point' }] as never,
    });
    const feeds = [
      {
        id: 'a',
        unreadCount: 3,
        readIds: new Set<number>([1]),
        items: [
          [1, first],
          [2, second],
        ] as Array<[number, InboxMessage]>,
      },
      {
        id: 'b',
        items: [[2, second]] as Array<[number, InboxMessage]>,
        unreadCount: 1,
        readIds: new Set<number>(),
      },
    ];

    const next = mergeUpdatedDutyFeedMessages(feeds, 'a', [2], [[2, refreshedSecond]]);

    expect(next[0].items).toEqual([
      [1, first],
      [2, refreshedSecond],
    ]);
    expect(next[1].items).toEqual([[2, second]]);
    expect(next[0].unreadCount).toBe(3);
    expect(next[0].readIds).toBe(feeds[0].readIds);
    expect(next[0].items[1]?.[1].textMarked).toBe(refreshedSecond.textMarked);
    expect(next[0].items[1]?.[1].keywordTokens).toBe(refreshedSecond.keywordTokens);
    expect(next[0].items[1]?.[1].pointTokens).toBe(refreshedSecond.pointTokens);
  });

  it('removes requested items when the backend omits them and updates runtime state', () => {
    const feeds = [
      {
        id: 'a',
        items: [
          [1, inboxMessage({ text: 'one' })],
          [2, inboxMessage({ text: 'two' })],
          [3, inboxMessage({ text: 'three' })],
        ] as Array<[number, InboxMessage]>,
        unreadCount: 2,
        readIds: new Set<number>([1, 3]),
      },
    ];

    const next = mergeUpdatedDutyFeedMessages(feeds, 'a', [2, 3], []);

    expect(next[0].items).toEqual([[1, feeds[0].items[0][1]]]);
    expect(next[0].unreadCount).toBe(1);
    expect(next[0].readIds).toEqual(new Set<number>([1]));
  });
});
