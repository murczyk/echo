/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minimalInboxMessage } from './inbox-message-mocks';
import {
  type DutyFeedColumnActionsDeps,
  useDutyFeedColumnActions,
} from './useDutyFeedColumnActions';
import { ScrollNavigationIntent } from './windowed-feed-scroll-shared';
import type { FeedColumnModel } from './types';
import type { MessageFeedState } from './utils';

describe('useDutyFeedColumnActions', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  it('preserves an evicted-tail boundary only for reader scrolling, not explicit navigation', async () => {
    const cancelFollowTail = vi.fn();
    const ensureFollowTail = vi.fn(() => 7);
    const setWatchModeByFeedId = vi.fn();
    const handleVisibleMessageIds = vi.fn(() => vi.fn());
    const loadFeedNewerMessages = vi.fn();
    const flushPendingNewerMessages = vi.fn();
    const feed = {
      id: 'mf-0',
      messageSortBy: 'IMSTimestamp',
      filter: {},
      items: [[40, minimalInboxMessage()]],
      loading: false,
      loadingOlder: false,
      hasReachedStart: false,
      evictedNewerTailId: 60,
      referenceTimeMs: null,
      readIds: new Set([40]),
      windowedUnreadItems: new Map(),
      unreadCount: 0,
      pendingNewerItems: [],
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    } as unknown as MessageFeedState;
    const deps = {
      feeds: {
        messageFeeds: [feed],
        loadFeedOlderMessages: vi.fn(),
        loadFeedNewerMessages,
        flushPendingNewerMessages,
        removeMessageFeed: vi.fn(),
        handleMessageBookmark: vi.fn(),
        handleMessageImportant: vi.fn(),
        handleMessageCopy: vi.fn(),
        applyFilter: vi.fn(),
        handleToggleTag: vi.fn(),
        cancelFollowTail,
        ensureFollowTail,
        setWatchModeByFeedId,
        tailAvailabilityByFeedId: {},
        confirmedTailPreviewByFeedId: {},
        dutyDisableAutoScroll: false,
        nearBottomByFeedIdRef: { current: {} },
        atBottomByFeedIdRef: { current: {} },
        physicallyAtBottomByFeedIdRef: { current: {} },
        handleArrowClick: vi.fn(),
        handleVisibleMessageIds,
      },
      openReportEditor: vi.fn(),
      openMessageEditor: vi.fn(),
      openReportComposer: vi.fn(),
    } as unknown as DutyFeedColumnActionsDeps;
    let actions: FeedColumnModel['actions'] | null = null;

    function Harness() {
      actions = useDutyFeedColumnActions(deps)(feed);
      return null;
    }

    await act(async () => root.render(<Harness />));

    expect(
      actions!.onReachedBottom?.({
        hasSeenNotAtBottom: true,
        navigationIntent: ScrollNavigationIntent.Explicit,
      }),
    ).toBe(true);
    expect(cancelFollowTail).not.toHaveBeenCalled();
    expect(ensureFollowTail).toHaveBeenCalledWith('mf-0');

    expect(actions!.onReachedBottom?.({ hasSeenNotAtBottom: true, navigationIntent: null })).toBe(
      false,
    );
    expect(cancelFollowTail).toHaveBeenCalledWith('mf-0');
    expect(setWatchModeByFeedId).toHaveBeenCalledTimes(2);

    vi.clearAllMocks();
    feed.pendingNewerItems = [[60, minimalInboxMessage()]];
    expect(actions!.onReachedBottom?.({ hasSeenNotAtBottom: true, navigationIntent: null })).toBe(
      false,
    );
    expect(cancelFollowTail).not.toHaveBeenCalled();
    expect(flushPendingNewerMessages).toHaveBeenCalledWith('mf-0', { urgent: true });
    expect(loadFeedNewerMessages).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({ scrollToEndAfterLoad: true }),
    );
  });
});
