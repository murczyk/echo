/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnProps } from './FeedColumn';
import { minimalInboxMessage } from './inbox-message-mocks';

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef<
    HTMLDivElement,
    {
      data?: Array<[number, unknown]>;
      itemContent?: (index: number, item: [number, unknown]) => ReactNode;
    }
  >(function Virtuoso({ data, itemContent }, ref) {
    return (
      <div ref={ref} data-testid="virtuoso">
        {(data ?? []).map((item, index) => (
          <div key={String(index)}>{itemContent?.(index, item)}</div>
        ))}
      </div>
    );
  }),
}));

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
  PowerChip: () => <div data-testid="power-chip" />,
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
        unreadCount: 0,
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
});
