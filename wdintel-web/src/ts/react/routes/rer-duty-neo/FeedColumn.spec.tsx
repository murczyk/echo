/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnProps } from './FeedColumn';
import { minimalInboxMessage } from './inbox-message-mocks';

vi.mock('./FeedFilterPanel', () => ({
  FeedFilterPanel: () => <div data-testid="feed-filter-panel" />,
}));

vi.mock('./FeedNotificationPanel', () => ({
  FeedNotificationPanel: () => <div data-testid="feed-notification-panel" />,
}));

vi.mock('./FeedKeywordsPanel', () => ({
  FeedKeywordsPanel: () => <div data-testid="feed-keywords-panel" />,
}));

vi.mock('../shared/message-card/MessageCard', () => ({
  DutyMessageCard: (props: {
    id: number;
    botTagAction?: { messageId: number; tagId: number } | null;
    onCopyEtalon?: () => void;
    onCopyLocation?: () => void;
  }) => (
    <div data-testid="message-card">
      <span data-testid={`bot-action-${props.id}`}>{props.botTagAction?.messageId ?? ''}</span>
      {props.onCopyEtalon != null ? <span data-testid="copy-etalon">copy-etalon</span> : null}
      {props.onCopyLocation != null ? <span data-testid="copy-location">copy-location</span> : null}
    </div>
  ),
}));

vi.mock('../../components/PowerChip', () => ({
  PowerChip: (props: { label?: unknown; 'data-duty-scroll-unread-badge'?: boolean }) => (
    <div
      data-testid="power-chip"
      data-duty-scroll-unread-badge={props['data-duty-scroll-unread-badge'] || undefined}
    >
      {props.label as any}
    </div>
  ),
}));

import { FeedColumn } from './FeedColumn';

function buildProps(): FeedColumnProps {
  return {
    column: {
      feed: {
        id: 'feed-1',
        filter: {
          groupsSelected: null,
          groupsDenied: null,
          sendersSelected: null,
          deniedSenders: null,
          freqsSelected: null,
          freqsDenied: null,
          postsSelected: null,
          postsDenied: null,
          unitsSelected: null,
          unitsDenied: null,
          unitsExactMatchOnly: false,
          lastViewedMessageId: null,
          highlightKeywordsEnabled: false,
          highlightKeywordSetId: null,
        },
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
      },
      view: {
        narrowScreen: false,
        feedCount: 1,
        canRemove: false,
        maxWidth: '100%',
        isWatchMode: false,
        loadingNewer: false,
        arrowResultMessage: null,
        bottomUnreadCount: 0,
        physicallyAtBottom: true,
        tailAvailability: 'available',
      },
      filterPanel: {
        feedId: 'feed-1',
        filterState: {
          groupsSelected: [],
          deniedGroups: [],
          sendersSelected: [],
          deniedSenders: [],
          freqsSelected: [],
          freqsDenied: [],
          postsSelected: [],
          postsDenied: [],
        },
        sources: {
          groupsList: [],
          groupInfos: {},
          profiles: {},
          senderOptions: [],
          freqs: [],
          postsList: [],
        },
        toggles: {
          adjacentFreqsRange: 0,
          highlightSignalsEnabled: false,
          onlyMyUnitTagsEnabled: false,
          reloadFreqsLoading: false,
        },
        savedFilters: {
          savedFilters: [],
          selectedSavedId: null,
          saveFilterName: '',
        },
        actions: {
          onGroupsChange: vi.fn(),
          onDeniedGroupsChange: vi.fn(),
          onSendersChange: vi.fn(),
          onDeniedSendersChange: vi.fn(),
          onFreqsChange: vi.fn(),
          onFreqsDeniedChange: vi.fn(),
          onPostsChange: vi.fn(),
          onPostsDeniedChange: vi.fn(),
          onAdjacentFreqsRangeChange: vi.fn(),
          onHighlightSignalsChange: vi.fn(),
          onOnlyMyUnitTagsChange: vi.fn(),
          onReloadFreqs: vi.fn(),
          onSavedFilterSelect: vi.fn(),
          onSaveFilterNameChange: vi.fn(),
          onSaveFilter: vi.fn(async () => true),
          onUpdateSelectedSavedFilter: vi.fn(async () => {}),
          onRenameSelectedSavedFilter: vi.fn(async () => true),
          onDeleteSelectedSavedFilter: vi.fn(async () => {}),
          onApplySavedFilter: vi.fn(),
        },
      },
      keywordsPanel: {
        keywordSets: [],
        onFilterChange: vi.fn(),
        onKeywordSetsReload: vi.fn(async () => {}),
      },
      messageCard: {
        authUserName: null,
        copiedFeedbackId: null,
        networkDisplayMap: {},
        networkMap: {},
        unitsMap: {},
        callsignInfoMap: {},
        groupInfos: {},
        profiles: {},
        featureStrictNetworks: false,
        tagsLayout: 'compact',
        tagsMap: {},
        tagsOrder: [],
        botTagAction: null,
        onCancelBotTagAction: vi.fn(),
        onMarkBotTagWrong: vi.fn(),
      },
      actions: {
        onLoadOlder: vi.fn(),
        onRemoveColumn: vi.fn(),
        onMessageBookmark: vi.fn(),
        onMessageImportant: vi.fn(),
        onMessageAddFrequencyToFilter: vi.fn(),
        onMessageCopy: vi.fn(),
        onMessageComment: vi.fn(),
        onMessageExcludeEntity: vi.fn(),
        onMessageToggleTag: vi.fn(),
        onCreateMessageFeed: vi.fn(),
        onArrowClick: vi.fn(),
      },
    },
  };
}

describe('FeedColumn', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('closes the filters panel on outside click', async () => {
    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const filtersButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Фільтри'),
    );
    expect(filtersButton).not.toBeNull();

    await act(async () => {
      filtersButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).toBeNull();
  });

  it('closes the filters panel when clicking its trigger again', async () => {
    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const filtersButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Фільтри'),
    );
    expect(filtersButton).not.toBeNull();

    await act(async () => {
      filtersButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).not.toBeNull();

    await act(async () => {
      filtersButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).toBeNull();
  });

  it('scopes the bot tag prompt to the matching message card only', async () => {
    const props = buildProps();
    props.column.feed.items = [
      [1, minimalInboxMessage({ timestamp: 101 })],
      [2, minimalInboxMessage({ timestamp: 102 })],
    ];
    props.column.messageCard.botTagAction = { messageId: 1, tagId: 3 };

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-testid="bot-action-1"]')?.textContent).toBe('1');
    expect(container.querySelector('[data-testid="bot-action-2"]')?.textContent).toBe('');
  });

  it('closes the notifications panel on outside click', async () => {
    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const notificationsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Сповіщення'),
    );
    expect(notificationsButton).not.toBeNull();

    await act(async () => {
      notificationsButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).toBeNull();
  });

  it('renders the narrow feed create action inside the feed surface only when allowed', async () => {
    const narrowProps = buildProps();
    narrowProps.column.view.narrowScreen = true;
    narrowProps.column.actions.onCreateMessageFeed = vi.fn();
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    try {
      await act(async () => {
        root.render(<FeedColumn column={narrowProps.column} />);
      });

      const addButton = container.querySelector('button[aria-label="Додати стрічку"]');
      expect(addButton).not.toBeNull();
      expect(container.querySelector('[data-duty-feed-create-button]')).not.toBeNull();
      expect(container.querySelector('[data-duty-feed-footer-spacer]')).not.toBeNull();
      expect(addButton?.closest('[data-duty-feed-content-root]')).not.toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();

      await act(async () => {
        root.render(<FeedColumn column={buildProps().column} />);
      });

      expect(container.querySelector('button[aria-label="Додати стрічку"]')).toBeNull();
      expect(container.querySelector('[data-duty-feed-footer-spacer]')).toBeNull();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('does not reserve extra footer space when the add action is unavailable', async () => {
    const props = buildProps();
    props.column.view.narrowScreen = true;
    props.column.actions.onCreateMessageFeed = undefined;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-duty-feed-footer-spacer]')).toBeNull();
  });

  it('keeps narrow floating actions vertically separated at tablet widths', async () => {
    const props = buildProps();
    props.column.view.narrowScreen = true;
    props.column.view.bottomUnreadCount = 2;
    props.column.actions.onArrowClick = vi.fn();
    props.column.actions.onCreateMessageFeed = vi.fn();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const addWrapper = container.querySelector('[data-duty-feed-create-button]') as HTMLElement;
    const scrollWrapper = container.querySelector('[data-duty-feed-scroll-button]') as HTMLElement;

    expect(addWrapper).not.toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(addWrapper.getAttribute('data-duty-bottom-offset')).toBe(
      'max(12px, env(safe-area-inset-bottom, 0px))',
    );
    expect(scrollWrapper.getAttribute('data-duty-bottom-offset')).toBe(
      'calc(max(12px, env(safe-area-inset-bottom, 0px)) + 47px)',
    );
  });

  it('does not show the bottom button for stale unread data at an exhausted tail', async () => {
    const props = buildProps();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.view.bottomUnreadCount = 3;
    props.column.view.tailAvailability = 'exhausted';
    await act(async () => root.render(<FeedColumn column={props.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).toBeNull();
  });

  it('does not show a badge when raw unread exists but every loaded message is read', async () => {
    const props = buildProps();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.feed.readIds = new Set([1]);
    props.column.feed.unreadCount = 1;
    props.column.view.bottomUnreadCount = 0;
    props.column.view.physicallyAtBottom = false;
    await act(async () => root.render(<FeedColumn column={props.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).not.toBeNull();
    expect(container.querySelector('[data-duty-feed-scroll-button]')?.textContent).not.toContain(
      '1',
    );
  });

  it('shows the number of actual loaded unread messages', async () => {
    const props = buildProps();
    props.column.feed.items = [
      [1, minimalInboxMessage({ timestamp: 100 })],
      [2, minimalInboxMessage({ timestamp: 200 })],
    ];
    props.column.feed.readIds = new Set([1]);
    props.column.feed.unreadCount = 50;
    props.column.view.bottomUnreadCount = 1;
    props.column.view.physicallyAtBottom = false;
    props.column.view.isWatchMode = false;
    await act(async () => root.render(<FeedColumn column={props.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')?.textContent).toContain('1');
    expect(container.querySelector('[data-duty-scroll-unread-badge]')).not.toBeNull();
  });

  it('shows the bottom button only for available tail content or away from the bottom', async () => {
    const available = buildProps();
    available.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    available.column.view.tailAvailability = 'available';
    await act(async () => root.render(<FeedColumn column={available.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).not.toBeNull();

    const middle = buildProps();
    middle.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    middle.column.view.physicallyAtBottom = false;
    middle.column.view.tailAvailability = 'exhausted';
    await act(async () => root.render(<FeedColumn column={middle.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).not.toBeNull();
  });

  it('shows a spinner only for explicit newer loading', async () => {
    const background = buildProps();
    background.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    background.column.view.loadingNewer = false;
    await act(async () => root.render(<FeedColumn column={background.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    const explicit = buildProps();
    explicit.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    explicit.column.view.loadingNewer = true;
    await act(async () => root.render(<FeedColumn column={explicit.column} />));
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it('passes the copy menu etalon action into duty message cards', async () => {
    const props = buildProps();
    props.column.feed.items = [[7, minimalInboxMessage({ unit: '1-й танк' })]];
    props.column.messageCard.networkDisplayMap = {};
    props.column.messageCard.networkMap = {};
    props.column.messageCard.featureStrictNetworks = false;
    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-testid="copy-etalon"]')).not.toBeNull();
  });

  it('passes the copy menu location action into duty message cards when no networks resolve', async () => {
    const props = buildProps();
    props.column.feed.items = [[7, minimalInboxMessage({ networkIds: [], location: 'ПІЩАНКА' })]];
    props.column.messageCard.networkDisplayMap = {};
    props.column.messageCard.networkMap = {};
    props.column.messageCard.featureStrictNetworks = false;
    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-testid="copy-location"]')).not.toBeNull();
  });

  it('closes the notifications panel when clicking its trigger again', async () => {
    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const notificationsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Сповіщення'),
    );
    expect(notificationsButton).not.toBeNull();

    await act(async () => {
      notificationsButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).not.toBeNull();

    await act(async () => {
      notificationsButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).toBeNull();
  });

  it('closes other panels in the same feed when opening a different panel', async () => {
    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const filtersButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Фільтри'),
    );
    const keywordsButton = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Підсвітка'),
    );
    expect(filtersButton).not.toBeNull();
    expect(keywordsButton).not.toBeNull();

    await act(async () => {
      filtersButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });
    expect(container.querySelector('[data-testid="feed-filter-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feed-keywords-panel"]')).toBeNull();

    await act(async () => {
      keywordsButton?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });
    expect(container.querySelector('[data-testid="feed-keywords-panel"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="feed-filter-panel"]')).toBeNull();
  });

  it('keeps panels open in another feed column when opening a panel in one feed', async () => {
    const columnA = buildProps().column;
    const columnB = buildProps().column;
    columnB.feed.id = 'feed-2';
    columnB.filterPanel.feedId = 'feed-2';

    await act(async () => {
      root.render(
        <div>
          <FeedColumn column={columnA} />
          <FeedColumn column={columnB} />
        </div>,
      );
    });

    const containerEl = container;
    const filtersButtons = Array.from(containerEl.querySelectorAll('button')).filter((button) =>
      button.textContent?.includes('Фільтри'),
    );
    expect(filtersButtons).toHaveLength(2);

    await act(async () => {
      filtersButtons[0]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
      filtersButtons[1]?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true, view: window }),
      );
    });

    expect(containerEl.querySelectorAll('[data-testid="feed-filter-panel"]')).toHaveLength(2);
  });

  it('keeps the feed content visible while refreshing existing messages', async () => {
    const props = buildProps();
    props.column.feed.loading = true;
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-duty-feed-scroller="true"]')).not.toBeNull();
    expect(container.querySelector('[data-duty-feed-list="true"]')).not.toBeNull();
  });

  it('keeps the header close action available for multi-feed columns', async () => {
    const props = buildProps();
    props.column.view.canRemove = true;
    props.column.view.feedCount = 2;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('button[aria-label="Закрити стрічку"]')).not.toBeNull();
  });
});
