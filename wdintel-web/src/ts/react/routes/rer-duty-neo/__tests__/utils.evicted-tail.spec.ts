import { describe, expect, it } from 'vitest';
import type { InboxMessage } from '../../../../../Bindings';
import type { MessageFeedState } from '../utils';
import { appendNewerItemsToFeed, emptyFilter, feedHasUnloadedEvictedNewerTail } from '../utils';

function indicatorFeed(overrides: Partial<MessageFeedState>): MessageFeedState {
  return {
    id: 'mf-0',
    messageSortBy: 'IMSTimestamp',
    filter: emptyFilter(),
    items: [],
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
    ...overrides,
  };
}

// @test-scope regression: https://github.com/echoua/echo/issues/3496
describe('evicted Duty feed tail', () => {
  it('clears the evicted tail when a nolimit page restores it before trimming', () => {
    const feed = indicatorFeed({
      items: Array.from({ length: 40 }, (_, index) => [
        index + 1,
        { timestamp: (index + 1) * 100 } as InboxMessage,
      ]),
      evictedNewerTailId: 60,
    });
    const restored = appendNewerItemsToFeed(
      feed,
      Array.from({ length: 60 }, (_, index) => [
        index + 41,
        { timestamp: (index + 41) * 100 } as InboxMessage,
      ]),
    );

    expect(restored.items.at(0)?.[0]).toBe(61);
    expect(restored.items.at(-1)?.[0]).toBe(100);
    expect(restored.evictedNewerTailId).toBeNull();
  });

  it('does not treat a higher older ID as the evicted chronological tail', () => {
    const feed = indicatorFeed({
      items: [[100, { timestamp: 100 } as InboxMessage]],
      evictedNewerTailId: 60,
      pendingNewerItems: [[101, { timestamp: 200 } as InboxMessage]],
    });

    expect(feedHasUnloadedEvictedNewerTail(feed)).toBe(true);
  });
});
