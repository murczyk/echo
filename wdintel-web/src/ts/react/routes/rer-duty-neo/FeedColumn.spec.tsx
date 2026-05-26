/**
 * @vitest-environment happy-dom
 */
import { act, forwardRef } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnProps } from './FeedColumn';
import { minimalInboxMessage } from './inbox-message-mocks';

vi.mock('react-virtuoso', () => ({
  Virtuoso: forwardRef(function Virtuoso(
    {
      data,
      itemContent,
    }: {
      data?: Array<[number, unknown]>;
      itemContent?: (index: number, item: [number, unknown]) => ReactNode;
    },
    ref,
  ) {
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
  DutyMessageCard: (props: { onCopyEtalon?: () => void; onCopyLocation?: () => void }) => (
    <div data-testid="message-card">
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
          lastViewedMessageId: null,
        },
        items: [],
        loading: false,
        loadingOlder: false,
        hasReachedStart: false,
        firstItemIndex: 0,
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
      filtersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
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
      filtersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).not.toBeNull();

    await act(async () => {
      filtersButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).toBeNull();
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
      notificationsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).not.toBeNull();

    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true, view: window }));
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
      notificationsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).not.toBeNull();

    await act(async () => {
      notificationsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    });

    expect(container.querySelector('[data-testid="feed-notification-panel"]')).toBeNull();
  });

  it('keeps the feed content visible while refreshing existing messages', async () => {
    const props = buildProps();
    props.column.feed.loading = true;
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-testid="virtuoso"]')).not.toBeNull();
  });
});
