import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import {
  mergeUpdatedDutyFeedMessages,
  mergeUpdatedVisibleMessages,
} from './message-card-message-updates';

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

describe('mergeUpdatedVisibleMessages', () => {
  it('keeps the same array when none of the fetched messages are visible', () => {
    const current = [[1, inboxMessage({ text: 'one' })]] as Array<[number, InboxMessage]>;
    const updates = [[2, inboxMessage({ text: 'two' })]] as Array<[number, InboxMessage]>;

    expect(mergeUpdatedVisibleMessages(current, updates)).toBe(current);
  });

  it('replaces only matching visible messages and preserves order', () => {
    const first = inboxMessage({ text: 'one' });
    const second = inboxMessage({ text: 'two' });
    const current = [
      [1, first],
      [2, second],
    ] as Array<[number, InboxMessage]>;
    const updatedSecond = inboxMessage({ text: 'two-updated' });

    const next = mergeUpdatedVisibleMessages(current, [[2, updatedSecond]]);

    expect(next).toEqual([
      [1, first],
      [2, updatedSecond],
    ]);
    expect(next).not.toBe(current);
  });
});

describe('mergeUpdatedDutyFeedMessages', () => {
  it('updates every feed that contains the fetched message id', () => {
    const first = inboxMessage({ text: 'one' });
    const second = inboxMessage({ text: 'two' });
    const nextMessage = inboxMessage({ text: 'two-updated' });
    const feeds = [
      {
        id: 'a',
        items: [
          [1, first],
          [2, second],
        ] as Array<[number, InboxMessage]>,
        unreadCount: 3,
        readIds: new Set<number>([1]),
      },
      {
        id: 'b',
        items: [[2, second]] as Array<[number, InboxMessage]>,
        unreadCount: 1,
        readIds: new Set<number>(),
      },
    ];

    const next = mergeUpdatedDutyFeedMessages(feeds, [[2, nextMessage]]);

    expect(next[0].items).toEqual([
      [1, first],
      [2, nextMessage],
    ]);
    expect(next[1].items).toEqual([[2, nextMessage]]);
    expect(next[0].unreadCount).toBe(3);
    expect(next[0].readIds).toBe(feeds[0].readIds);
  });

  it('keeps the same feed array when no visible feed contains the fetched message id', () => {
    const feeds = [
      {
        id: 'a',
        items: [[1, inboxMessage({ text: 'one' })]] as Array<[number, InboxMessage]>,
        unreadCount: 0,
        readIds: new Set<number>(),
      },
    ];

    expect(mergeUpdatedDutyFeedMessages(feeds, [[2, inboxMessage({ text: 'two' })]])).toBe(feeds);
  });
});
