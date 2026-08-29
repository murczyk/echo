/**
 * @vitest-environment happy-dom
 */
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { FeedColumnProps } from './FeedColumn';
import { minimalInboxMessage } from './inbox-message-mocks';
import { MAX_MESSAGE_FEEDS } from './utils';
import { beginDutyScrollDebugActivity, setDutyScrollDebugEnabled } from './duty-scroll-debug';

const notificationApi = vi.hoisted(() => ({
  getStored: vi.fn(() => ({ soundEnabled: false, browserEnabled: false })),
  getBellState: vi.fn(() => 'off'),
  setStored: vi.fn(() => ({ ok: true as const })),
  requestPermission: vi.fn(async () => 'granted' as NotificationPermission),
  resumeAudio: vi.fn(async () => 'ready'),
}));

vi.mock('./notifications', () => ({
  getStoredDutyNotificationSettingsForFeed: notificationApi.getStored,
  getDutyNotificationBellState: notificationApi.getBellState,
  setStoredDutyNotificationSettingsForFeed: notificationApi.setStored,
  requestBrowserNotificationPermission: notificationApi.requestPermission,
  resumeDutyNotificationAudioFromUserGesture: notificationApi.resumeAudio,
}));

vi.mock('./FeedFilterPanel', () => ({
  FeedFilterPanel: () => <div data-testid="feed-filter-panel" />,
}));

vi.mock('./FeedNotificationPanel', () => ({
  FeedNotificationPanel: (props: { storageError: string | null }) => (
    <div data-testid="feed-notification-panel">{props.storageError}</div>
  ),
}));

vi.mock('./FeedKeywordsPanel', () => ({
  FeedKeywordsPanel: () => <div data-testid="feed-keywords-panel" />,
}));

vi.mock('../shared/message-card/MessageCard', () => ({
  DutyMessageCard: (props: {
    id: number;
    messageTextPreviewLines?: 20 | 40 | null;
    botTagAction?: { messageId: number; tagId: number } | null;
    onCopyEtalon?: () => void;
    onCopyLocation?: () => void;
    onEditDetails?: () => void;
  }) => (
    <div
      data-testid="message-card"
      data-message-text-preview-lines={props.messageTextPreviewLines ?? 'off'}
    >
      <span data-testid={`bot-action-${props.id}`}>{props.botTagAction?.messageId ?? ''}</span>
      {props.onCopyEtalon != null ? <span data-testid="copy-etalon">copy-etalon</span> : null}
      {props.onCopyLocation != null ? <span data-testid="copy-location">copy-location</span> : null}
      {props.onEditDetails != null ? (
        <button type="button" data-testid="edit-message" onClick={props.onEditDetails} />
      ) : null}
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
        windowedUnreadItems: new Map<number, number>(),
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
          onGroupsModeTransfer: vi.fn(),
          onSendersChange: vi.fn(),
          onDeniedSendersChange: vi.fn(),
          onSendersModeTransfer: vi.fn(),
          onFreqsChange: vi.fn(),
          onFreqsDeniedChange: vi.fn(),
          onFreqsModeTransfer: vi.fn(),
          onPostsModeTransfer: vi.fn(),
          onUnitsModeTransfer: vi.fn(),
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
        messageTextPreviewLines: 20,
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
        onMessageCreateReport: vi.fn(),
        onMessageEditReport: vi.fn(),
        onMessageExcludeEntity: vi.fn(),
        onMessageToggleTag: vi.fn(),
        onMessageEdit: vi.fn(),
        onCreateFeed: vi.fn(),
        onArrowClick: vi.fn(),
      },
    },
  };
}

describe('FeedColumn', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    notificationApi.getStored.mockReset();
    notificationApi.getStored.mockReturnValue({ soundEnabled: false, browserEnabled: false });
    notificationApi.getBellState.mockReset();
    notificationApi.getBellState.mockReturnValue('off');
    notificationApi.setStored.mockReset();
    notificationApi.setStored.mockReturnValue({ ok: true });
    notificationApi.requestPermission.mockReset();
    notificationApi.requestPermission.mockResolvedValue('granted');
    notificationApi.resumeAudio.mockReset();
    notificationApi.resumeAudio.mockResolvedValue('ready');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      setDutyScrollDebugEnabled(false);
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('loads newer messages before reaching the physical bottom', async () => {
    const props = buildProps();
    const onLoadNewer = vi.fn();
    const onReachedBottom = vi.fn();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.actions.onLoadNewer = onLoadNewer;
    props.column.actions.onReachedBottom = onReachedBottom;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const scroller = container.querySelector('[data-duty-feed-scroller]') as HTMLElement;
    Object.defineProperties(scroller, {
      scrollTop: { value: 300, writable: true, configurable: true },
      clientHeight: { value: 500, configurable: true },
      scrollHeight: { value: 1400, configurable: true },
    });
    onReachedBottom.mockClear();

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
    // Near-bottom (not physical bottom) defers onLoadNewer until scroll idle (~140ms).
    expect(onLoadNewer).not.toHaveBeenCalled();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 160));
    });

    expect(onLoadNewer).toHaveBeenCalledTimes(1);
    expect(onReachedBottom).not.toHaveBeenCalled();
  });

  it('mounts the full message window in the duty feed list', async () => {
    const props = buildProps();
    props.column.feed.items = [
      [1, minimalInboxMessage({ timestamp: 100 })],
      [2, minimalInboxMessage({ timestamp: 200 })],
    ];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-duty-feed-list]')).not.toBeNull();
    expect(container.querySelectorAll('[data-duty-message-id]')).toHaveLength(2);
  });

  it('updates mounted message cards when the preview limit changes', async () => {
    const props = buildProps();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.messageCard.messageTextPreviewLines = 20;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });
    expect(
      container
        .querySelector('[data-testid="message-card"]')
        ?.getAttribute('data-message-text-preview-lines'),
    ).toBe('20');

    for (const [value, renderedValue] of [
      [40, '40'],
      [null, 'off'],
      [20, '20'],
    ] as const) {
      const updatedColumn = {
        ...props.column,
        messageCard: {
          ...props.column.messageCard,
          messageTextPreviewLines: value,
        },
      };
      await act(async () => {
        root.render(<FeedColumn column={updatedColumn} />);
      });

      expect(
        container
          .querySelector('[data-testid="message-card"]')
          ?.getAttribute('data-message-text-preview-lines'),
      ).toBe(renderedValue);
    }
  });

  it('shows waterfall debug info after eight quick bell presses', async () => {
    const props = buildProps();
    props.column.view.feedCount = 4;
    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const bell = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Сповіщення — Сповіщення вимкнені для стрічки"]',
    );
    expect(bell).not.toBeNull();

    await act(async () => {
      for (let press = 0; press < 8; press += 1) {
        bell?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      }
    });

    const panel = container.querySelector('[data-duty-scroll-debug-panel]');
    expect(panel).not.toBeNull();
    expect(panel?.textContent).toContain('counter HTTP');
    expect(panel?.textContent).toContain('newer messages HTTP');
    expect(panel?.querySelector('[data-duty-scroll-debug-events]')).not.toBeNull();

    let finishCounter!: (result: string) => void;
    let finishMessages!: (result: string) => void;
    await act(async () => {
      finishCounter = beginDutyScrollDebugActivity('feed-1', 'unreadCount', 'test counter');
      finishMessages = beginDutyScrollDebugActivity('feed-1', 'newerMessages', 'test messages');
    });
    expect(panel?.querySelector('[data-duty-debug-counter-status]')?.textContent).toContain(
      'LOADING',
    );
    expect(panel?.querySelector('[data-duty-debug-newer-messages-status]')?.textContent).toContain(
      'LOADING',
    );

    await act(async () => {
      finishCounter('ok');
      finishMessages('ok');
    });
  });

  it('opens the panel and preserves Off when enabling notifications cannot be stored', async () => {
    notificationApi.setStored.mockReturnValue({ ok: false, error: 'quota exceeded' });

    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const bell = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Сповіщення вимкнені для стрічки"]',
    );
    expect(bell).not.toBeNull();
    await act(async () => {
      bell?.click();
    });

    expect(notificationApi.setStored).toHaveBeenCalledWith('feed-1', {
      soundEnabled: true,
      browserEnabled: true,
    });
    expect(notificationApi.resumeAudio).toHaveBeenCalledTimes(1);
    expect(notificationApi.requestPermission).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="feed-notification-panel"]')?.textContent).toBe(
      'quota exceeded',
    );
    expect(bell?.getAttribute('aria-label')).toBe('Сповіщення вимкнені для стрічки');
    expect(bell?.getAttribute('aria-pressed')).toBe('false');
  });

  it('opens the panel and preserves Ready when disabling notifications cannot be stored', async () => {
    notificationApi.getStored.mockReturnValue({ soundEnabled: true, browserEnabled: true });
    notificationApi.getBellState.mockReturnValue('ready');
    notificationApi.setStored.mockReturnValue({ ok: false, error: 'storage blocked' });

    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const bell = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Сповіщення готові; вимкнути для стрічки"]',
    );
    expect(bell).not.toBeNull();
    await act(async () => {
      bell?.click();
    });

    expect(notificationApi.setStored).toHaveBeenCalledWith('feed-1', {
      soundEnabled: false,
      browserEnabled: false,
    });
    expect(container.querySelector('[data-testid="feed-notification-panel"]')?.textContent).toBe(
      'storage blocked',
    );
    expect(bell?.getAttribute('aria-label')).toBe('Сповіщення готові; вимкнути для стрічки');
    expect(bell?.getAttribute('aria-pressed')).toBe('true');
  });

  it('clears the storage error after a successful bell retry', async () => {
    notificationApi.setStored
      .mockReturnValueOnce({ ok: false, error: 'quota exceeded' })
      .mockReturnValueOnce({ ok: true });

    await act(async () => {
      root.render(<FeedColumn column={buildProps().column} />);
    });

    const bell = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Сповіщення вимкнені для стрічки"]',
    );
    expect(bell).not.toBeNull();
    await act(async () => {
      bell?.click();
    });
    expect(container.querySelector('[data-testid="feed-notification-panel"]')?.textContent).toBe(
      'quota exceeded',
    );

    await act(async () => {
      bell?.click();
    });
    expect(notificationApi.setStored).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="feed-notification-panel"]')?.textContent).toBe(
      '',
    );
  });

  it.each([
    ['off', 'Сповіщення — Сповіщення вимкнені для стрічки'],
    ['ready', 'Сповіщення — Сповіщення готові; вимкнути для стрічки'],
    ['degraded', 'Сповіщення — Сповіщення потребують налаштування або взаємодії'],
    ['unsupported', 'Сповіщення — Запитані сповіщення не підтримуються'],
  ] as const)('renders the exact narrow notification label for %s', async (state, label) => {
    notificationApi.getBellState.mockReturnValue(state);
    const props = buildProps();
    props.column.view.feedCount = 4;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const toggle = container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
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

  it('passes the message id and message to the Duty edit action', async () => {
    const props = buildProps();
    const message = minimalInboxMessage({ text: 'edit me' });
    const onMessageEdit = vi.fn();
    props.column.feed.items = [[42, message]];
    props.column.actions.onMessageEdit = onMessageEdit;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });
    await act(async () => {
      (container.querySelector('[data-testid="edit-message"]') as HTMLButtonElement).click();
    });

    expect(onMessageEdit).toHaveBeenCalledWith(42, message);
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

  it('renders a single explicit header action container with the narrow add action', async () => {
    const narrowProps = buildProps();
    narrowProps.column.view.narrowScreen = true;
    narrowProps.column.view.feedCount = 1;
    narrowProps.column.view.canRemove = false;
    narrowProps.column.actions.onCreateFeed = vi.fn();

    await act(async () => {
      root.render(<FeedColumn column={narrowProps.column} />);
    });

    const actionContainer = container.querySelector('[data-duty-feed-header-actions]');
    expect(actionContainer).not.toBeNull();
    expect(actionContainer?.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector('[data-duty-feed-header-layout="flex"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Додати стрічку"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Закрити стрічку"]')).toBeNull();
    expect(container.querySelector('[data-duty-feed-footer-spacer]')).toBeNull();
    expect(container.querySelector('[data-duty-message-create-button]')).toBeNull();
  });

  it('renders the add-feed action in a desktop header before close', async () => {
    const props = buildProps();
    props.column.actions.onCreateFeed = vi.fn();
    props.column.view.canRemove = true;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const buttons = Array.from(
      container.querySelectorAll('[data-duty-feed-header-actions] button'),
    ).map((button) => button.getAttribute('aria-label'));
    expect(buttons).toEqual(['Додати стрічку', 'Закрити стрічку']);
  });

  it('shows add and remove actions together on the active narrow feed when multiple feeds exist', async () => {
    const narrowProps = buildProps();
    narrowProps.column.view.narrowScreen = true;
    narrowProps.column.view.feedCount = 2;
    narrowProps.column.view.canRemove = true;
    narrowProps.column.actions.onCreateFeed = vi.fn();

    await act(async () => {
      root.render(<FeedColumn column={narrowProps.column} />);
    });

    const actionContainer = container.querySelector('[data-duty-feed-header-actions]');
    expect(actionContainer?.querySelectorAll('button')).toHaveLength(2);
    expect(container.querySelector('button[aria-label="Додати стрічку"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Закрити стрічку"]')).not.toBeNull();
  });

  it('hides add feed at the maximum while keeping remove visible', async () => {
    const props = buildProps();
    props.column.view.narrowScreen = true;
    props.column.view.feedCount = MAX_MESSAGE_FEEDS;
    props.column.view.canRemove = true;
    props.column.actions.onCreateFeed = undefined;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const actionContainer = container.querySelector('[data-duty-feed-header-actions]');
    expect(actionContainer?.querySelectorAll('button')).toHaveLength(1);
    expect(container.querySelector('button[aria-label="Додати стрічку"]')).toBeNull();
    expect(container.querySelector('button[aria-label="Закрити стрічку"]')).not.toBeNull();
  });

  it('does not reserve extra footer space when the add action is unavailable', async () => {
    const props = buildProps();
    props.column.view.narrowScreen = true;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-duty-feed-footer-spacer]')).toBeNull();
  });

  it('keeps narrow scroll placement vertically stacked and horizontally aligned', async () => {
    const props = buildProps();
    props.column.view.narrowScreen = true;
    props.column.view.bottomUnreadCount = 2;
    props.column.view.tailAvailability = 'available';
    props.column.actions.onArrowClick = vi.fn();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.view.workspaceFabAvoidance = 'above';

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const scrollWrapper = container.querySelector('[data-duty-feed-scroll-button]') as HTMLElement;

    expect(container.querySelector('[data-duty-message-create-button]')).toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(scrollWrapper.getAttribute('data-duty-bottom-offset')).toBe(
      'calc(max(12px, env(safe-area-inset-bottom, 0px)) + 47px)',
    );
    expect(scrollWrapper.getAttribute('data-duty-right-offset')).toBe(
      'max(12px, env(safe-area-inset-right, 0px))',
    );
  });

  it('keeps the desktop scroll action left of the workspace FAB and independently clickable', async () => {
    const props = buildProps();
    const onArrowClick = vi.fn();
    props.column.actions.onArrowClick = onArrowClick;
    props.column.view.workspaceFabAvoidance = 'left';
    props.column.view.bottomUnreadCount = 2;
    props.column.view.tailAvailability = 'available';
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    const scrollWrapper = container.querySelector('[data-duty-feed-scroll-button]') as HTMLElement;

    expect(container.querySelector('[data-duty-message-create-button]')).toBeNull();
    expect(scrollWrapper).not.toBeNull();
    expect(container.querySelector('[data-duty-feed-footer-spacer]')).toBeNull();
    expect(scrollWrapper.getAttribute('data-duty-bottom-offset')).toBe('12px');
    expect(scrollWrapper.getAttribute('data-duty-right-offset')).toBe('59px');
    expect(scrollWrapper.style.bottom).toBe(scrollWrapper.getAttribute('data-duty-bottom-offset'));
    expect(scrollWrapper.style.right).toBe(scrollWrapper.getAttribute('data-duty-right-offset'));

    await act(async () => {
      scrollWrapper
        .querySelector('button')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(onArrowClick).toHaveBeenCalledTimes(1);
  });

  it('keeps the desktop scroll action at its original offset without create action', async () => {
    const props = buildProps();
    props.column.actions.onArrowClick = vi.fn();
    props.column.view.workspaceFabAvoidance = 'none';
    props.column.view.bottomUnreadCount = 1;
    props.column.view.tailAvailability = 'available';
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    expect(container.querySelector('[data-duty-message-create-button]')).toBeNull();
    expect(
      container
        .querySelector('[data-duty-feed-scroll-button]')
        ?.getAttribute('data-duty-bottom-offset'),
    ).toBe('12px');
    expect(
      container
        .querySelector('[data-duty-feed-scroll-button]')
        ?.getAttribute('data-duty-right-offset'),
    ).toBe('20px');
  });

  it('does not show the bottom button for stale unread data at an exhausted tail', async () => {
    const props = buildProps();
    props.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    props.column.view.bottomUnreadCount = 3;
    props.column.view.tailAvailability = 'exhausted';
    await act(async () => root.render(<FeedColumn column={props.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).toBeNull();
  });

  it('does not show bottom controls for an empty settled feed with incomplete geometry', async () => {
    const props = buildProps();
    props.column.feed.items = [];
    props.column.feed.unreadCount = 1;
    props.column.view.loadingNewer = true;
    props.column.view.physicallyAtBottom = false;
    props.column.view.bottomUnreadCount = 1;
    props.column.view.tailAvailability = 'available';
    await act(async () => root.render(<FeedColumn column={props.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).toBeNull();
    expect(container.querySelector('[data-duty-feed-scroll-button] svg')).toBeNull();
    expect(container.querySelector('[data-duty-new-message-badge]')).toBeNull();
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

  it('shows a spinner while newer mail is loading and keeps the unread badge', async () => {
    const idle = buildProps();
    idle.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    idle.column.view.loadingNewer = false;
    idle.column.view.bottomUnreadCount = 0;
    await act(async () => root.render(<FeedColumn column={idle.column} />));
    expect(container.querySelector('[data-duty-feed-scroll-button]')).not.toBeNull();
    expect(container.querySelector('[role="progressbar"]')).toBeNull();

    const loading = buildProps();
    loading.column.feed.items = [[1, minimalInboxMessage({ timestamp: 100 })]];
    loading.column.view.loadingNewer = true;
    loading.column.view.bottomUnreadCount = 12;
    loading.column.view.isWatchMode = false;
    loading.column.view.physicallyAtBottom = false;
    await act(async () => root.render(<FeedColumn column={loading.column} />));
    expect(container.querySelector('[role="progressbar"]')).not.toBeNull();
    expect(container.querySelector('[data-duty-scroll-unread-badge]')?.textContent).toContain('12');
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

  it('closes open settings instead of removing the feed', async () => {
    const props = buildProps();
    props.column.view.canRemove = true;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });

    await act(async () => {
      container
        .querySelector('button[aria-label="Фільтри"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Закрити стрічку"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(container.querySelector('[data-testid="feed-filter-panel"]')).toBeNull();
    expect(props.column.actions.onRemoveColumn).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain('Ви впевнені, що хочете видалити цю стрічку?');
  });

  it('confirms before removing a feed', async () => {
    const props = buildProps();
    props.column.view.canRemove = true;

    await act(async () => {
      root.render(<FeedColumn column={props.column} />);
    });
    await act(async () => {
      container
        .querySelector('button[aria-label="Закрити стрічку"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(props.column.actions.onRemoveColumn).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Ви впевнені, що хочете видалити цю стрічку?');

    const confirmButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent === 'Видалити',
    );
    await act(async () => {
      confirmButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(props.column.actions.onRemoveColumn).toHaveBeenCalledTimes(1);
  });
});
