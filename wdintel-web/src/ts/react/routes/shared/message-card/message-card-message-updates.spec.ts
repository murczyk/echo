import { describe, expect, it } from 'vitest';

import type { InboxMessage } from '../../../../../Bindings';
import {
  mergeUpdatedDutyFeedMessageTags,
  mergeUpdatedVisibleMessageTags,
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

describe('mergeUpdatedVisibleMessageTags', () => {
  it('keeps the same array when none of the fetched messages are visible', () => {
    const current = [[1, inboxMessage({ text: 'one' })]] as Array<[number, InboxMessage]>;
    const updates = [[2, inboxMessage({ text: 'two' })]] as Array<[number, InboxMessage]>;

    expect(mergeUpdatedVisibleMessageTags(current, updates)).toBe(current);
  });

  it('updates only tag fields and preserves unrelated message data', () => {
    const first = inboxMessage({
      text: 'one',
      keywordTokens: [{ text: 'kw' }] as never,
      textMarked: [{ CNTextC: { text: 'marked' } }] as never,
    });
    const second = inboxMessage({
      text: 'two',
      keywordTokens: [{ text: 'old kw' }] as never,
      textMarked: [{ CNTextC: { text: 'old marked' } }] as never,
      tags: [1],
      inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    });
    const current = [
      [1, first],
      [2, second],
    ] as Array<[number, InboxMessage]>;
    const updatedSecond = inboxMessage({
      text: 'two-updated',
      keywordTokens: [{ text: 'new kw' }] as never,
      textMarked: [{ CNTextC: { text: 'new marked' } }] as never,
      tags: [2],
      inboxTags: [{ id: 2, tagId: 2, confidence: 1, login: null, model: null, organismId: null }],
    });

    const next = mergeUpdatedVisibleMessageTags(current, [[2, updatedSecond]]);

    expect(next).toEqual([
      [1, first],
      [
        2,
        {
          ...second,
          tags: [2],
          inboxTags: [
            {
              id: 2,
              tagId: 2,
              confidence: 1,
              login: null,
              model: null,
              organismId: null,
            },
          ],
          text: 'two',
        },
      ],
    ]);
    expect(next).not.toBe(current);
    expect(next[1][1].keywordTokens).toBe(second.keywordTokens);
    expect(next[1][1].textMarked).toBe(second.textMarked);
    expect(next[1][1].text).toBe('two');
  });

  it('drops model tags when withoutModelTags is enabled and rebuilds tags from remaining inbox tags', () => {
    const current = inboxMessage({
      tags: [3, 4],
      inboxTags: [
        { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
        { id: 2, tagId: 4, confidence: 1, login: null, model: 'bot', organismId: null },
      ],
    });
    const updated = inboxMessage({
      tags: [3, 4, 5],
      inboxTags: [
        { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
        { id: 2, tagId: 4, confidence: 1, login: null, model: 'bot', organismId: null },
        { id: 3, tagId: 5, confidence: 1, login: null, model: null, organismId: null },
      ],
    });

    const next = mergeUpdatedVisibleMessageTags([[1, current]], [[1, updated]], {
      withoutModelTags: true,
    });

    expect(next[0][1].inboxTags).toEqual([
      { id: 1, tagId: 3, confidence: 1, login: null, model: null, organismId: null },
      { id: 3, tagId: 5, confidence: 1, login: null, model: null, organismId: null },
    ]);
    expect(next[0][1].tags).toEqual([3, 5]);
  });
});

describe('mergeUpdatedDutyFeedMessageTags', () => {
  it('merges tag fields into every feed that contains the fetched message id', () => {
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

    const next = mergeUpdatedDutyFeedMessageTags(feeds, [[2, nextMessage]]);

    expect(next[0].items).toEqual([
      [1, first],
      [2, second],
    ]);
    expect(next[1].items).toEqual([[2, second]]);
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

    expect(mergeUpdatedDutyFeedMessageTags(feeds, [[2, inboxMessage({ text: 'two' })]])).toBe(
      feeds,
    );
  });
});
