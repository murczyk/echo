import { describe, expect, it } from 'vitest';
import { emptyFilter, feedListRenderStateEqual, type MessageFeedState } from '../utils';
import { minimalInboxMessage } from '../inbox-message-mocks';

function baseFeed(overrides: Partial<MessageFeedState> = {}): MessageFeedState {
  const items: MessageFeedState['items'] = [[1, minimalInboxMessage({ createdAtOrder: 1 })]];
  return {
    id: 'mf-0',
    filter: emptyFilter(),
    items,
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: 1000,
    readIds: new Set<number>(),
    windowedUnreadItems: new Map(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
    ...overrides,
  };
}
describe('feedListRenderStateEqual', () => {
  it('treats unread/read metadata-only updates as equal', () => {
    const items: MessageFeedState['items'] = [[1, minimalInboxMessage({ createdAtOrder: 1 })]];
    const filter = emptyFilter();
    const prev = baseFeed({ items, filter, unreadCount: 3, readIds: new Set([1]) });
    const next = baseFeed({
      items,
      filter,
      unreadCount: 9,
      readIds: new Set([1, 2]),
      windowedUnreadItems: new Map([[3, 1]]),
    });

    expect(feedListRenderStateEqual(prev, next)).toBe(true);
  });

  it('treats item identity changes as unequal', () => {
    const prev = baseFeed();
    const next = baseFeed({
      items: [[2, minimalInboxMessage({ createdAtOrder: 2 })]],
    });

    expect(feedListRenderStateEqual(prev, next)).toBe(false);
  });

  it('treats loading flag changes as unequal', () => {
    const items: MessageFeedState['items'] = [[1, minimalInboxMessage({ createdAtOrder: 1 })]];
    const prev = baseFeed({ items, loadingOlder: false });
    const next = baseFeed({ items, loadingOlder: true });

    expect(feedListRenderStateEqual(prev, next)).toBe(false);
  });

  it('treats pendingNewerItems-only updates as equal', () => {
    const items: MessageFeedState['items'] = [[1, minimalInboxMessage({ createdAtOrder: 1 })]];
    const filter = emptyFilter();
    const prev = baseFeed({ items, filter });
    const next = baseFeed({
      items,
      filter,
      pendingNewerItems: [[2, minimalInboxMessage({ createdAtOrder: 2 })]],
    });

    expect(feedListRenderStateEqual(prev, next)).toBe(true);
  });
});
