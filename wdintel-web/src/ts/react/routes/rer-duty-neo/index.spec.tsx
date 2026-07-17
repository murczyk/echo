/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '../../../../Bindings';

const fetchMessagesByIds = vi.hoisted(() => vi.fn());
const useRerDutyFeedsMock = vi.hoisted(() => vi.fn());
const nextCreatedResponse = vi.hoisted(() => ({
  value: null as null | { signal_message_id: number; message?: InboxMessage },
}));

vi.mock('../../services/api/inbox-messages', () => ({
  fetchMessagesByIds,
}));
vi.mock('../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: vi.fn().mockResolvedValue({ tagsLayout: 'compact' }),
}));
vi.mock('../../services/api/user', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: vi.fn().mockResolvedValue({ devicesSectionEnabled: false }),
}));
vi.mock('./useRerDutyFeeds', () => ({
  useRerDutyFeeds: useRerDutyFeedsMock,
}));
vi.mock('./RerDutyNeoWorkspace', () => ({
  RerDutyNeoWorkspace: ({
    activeFeedId,
    createMessageFeed,
    openCreateMessageComposer,
  }: {
    activeFeedId: string | null;
    createMessageFeed: () => void;
    openCreateMessageComposer: () => void;
  }) => (
    <div>
      <div data-testid="active-feed">{activeFeedId}</div>
      <button type="button" aria-label="Додати повідомлення" onClick={openCreateMessageComposer}>
        Додати повідомлення
      </button>
      <button type="button" aria-label="Додати стрічку" onClick={createMessageFeed}>
        Додати стрічку
      </button>
    </div>
  ),
}));
vi.mock('../shared/manage-message/ManageMessageDrawer', () => ({
  ManageMessageDrawer: ({
    open,
    onClose,
    onCreated,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated?: (result: {
      signal_message_id: number;
      message?: InboxMessage;
    }) => Promise<void> | void;
  }) =>
    open ? (
      <div role="dialog" data-testid="composer">
        <button
          type="button"
          aria-label="Створити повідомлення"
          onClick={async () => {
            onClose();
            if (nextCreatedResponse.value) {
              await onCreated?.(nextCreatedResponse.value);
            }
          }}
        >
          Створити
        </button>
      </div>
    ) : null,
}));
vi.mock('../shared/message-card/MessageCard', () => ({
  DutyMessageCard: (props: { id: number; msg: InboxMessage }) => (
    <div data-testid="message-card">
      <span data-testid="message-text">{props.msg.text}</span>
      <span data-testid="message-id">{String(props.id)}</span>
    </div>
  ),
}));
vi.mock('./CommentDialog', () => ({ CommentDialog: () => null }));
vi.mock('./DeleteConfirmDialog', () => ({ DeleteConfirmDialog: () => null }));
vi.mock('./dialogs', () => ({ CommentDialog: () => null, DeleteConfirmDialog: () => null }));
vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@mui/material', () => ({
  Box: ({
    children,
    component = 'div',
    ...props
  }: { children?: ReactNode; component?: string } & Record<string, unknown>) => {
    const Component = component as keyof HTMLElementTagNameMap;
    return <Component {...props}>{children}</Component>;
  },
  Button: ({
    children,
    onClick,
    type = 'button',
    ...props
  }: { children?: ReactNode; onClick?: () => void; type?: 'button' | 'submit' } & Record<
    string,
    unknown
  >) => (
    <button type={type} onClick={onClick} {...props}>
      {children}
    </button>
  ),
  Drawer: ({ children, open }: { children?: ReactNode; open?: boolean }) =>
    open ? <div role="dialog">{children}</div> : null,
  IconButton: ({
    children,
    onClick,
    'aria-label': ariaLabel,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    'aria-label'?: string;
  }) => (
    <button type="button" aria-label={ariaLabel} onClick={onClick}>
      {children}
    </button>
  ),
  Stack: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Typography: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  useMediaQuery: () => false,
  useTheme: () => ({ breakpoints: { down: () => false } }),
}));

import { RerDutyNeoPage } from './index';

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    messageUid: 'm-1',
    text: 'created preview body',
    freq: '149.500',
    bookmarked: false,
    important: false,
    extendedForm: 'note',
    sender: 'sender-a',
    groupMasterKey: 'g-1',
    networkIds: [7],
    tags: [3],
    inboxTags: null,
    metadata: [],
    textMarked: null,
    pointTokens: null,
    media: [],
    images: [],
    imageRecognized: [],
    date: '2026-07-17',
    time: '12:00',
    timestamp: null,
    post: 'post-a',
    unit: 'unit-a',
    callsigns: [],
    callsignsAlg2: [],
    checked: false,
    comment: null,
    location: null,
    coords: null,
    noHeadersBody: null,
    messageComments: [],
    ...overrides,
  } as InboxMessage;
}

function buildFeedsState() {
  const feedFilter = {
    groupsSelected: ['g-1'],
    groupsDenied: [],
    sendersSelected: [],
    deniedSenders: [],
    freqsSelected: [],
    freqsDenied: [],
    postsSelected: [],
    postsDenied: [],
    unitsSelected: [],
    unitsDenied: [],
    unitsExactMatchOnly: false,
    lastViewedMessageId: null,
    highlightKeywordsEnabled: false,
    highlightKeywordSetId: null,
  };

  return {
    messageFeeds: [
      {
        id: 'feed-1',
        filter: feedFilter,
        items: [[1, buildMessage()]] as Array<[number, InboxMessage]>,
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
      {
        id: 'feed-2',
        filter: { ...feedFilter, groupsSelected: ['g-2'] },
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
    ],
    createMessageFeed: vi.fn(),
    removeMessageFeed: vi.fn(),
    loadFeedInitialMessages: vi.fn(),
    loadFeedOlderMessages: vi.fn(),
    applyFilter: vi.fn(),
    addFrequencyToFilter: vi.fn(),
    toggleGroup: vi.fn(),
    selectAllGroups: vi.fn(),
    handleSaveFilter: vi.fn(),
    handleApplySavedFilter: vi.fn(),
    handleUpdateSelectedSavedFilter: vi.fn(),
    handleRenameSelectedSavedFilter: vi.fn(),
    handleDeleteSelectedSavedFilter: vi.fn(),
    handleDeleteSavedFilter: vi.fn(),
    handleMessageBookmark: vi.fn(),
    handleMessageImportant: vi.fn(),
    handleMessageCopy: vi.fn(),
    handleOpenPointsOnMap: vi.fn(),
    handleDeleteConfirm: vi.fn(),
    setDeleteConfirmId: vi.fn(),
    setDeleteConfirmFeedId: vi.fn(),
    openCommentDialog: vi.fn(),
    commentMessagePreview: null,
    handleCommentSave: vi.fn(),
    handleToggleTag: vi.fn(),
    botTagAction: null,
    onCancelBotTagAction: vi.fn(),
    onMarkBotTagWrong: vi.fn(),
    handleArrowClick: vi.fn(),
    handleVisibleMessageIds: vi.fn(),
    commentMessageId: null,
    commentText: '',
    setCommentText: vi.fn(),
    setCommentMessageId: vi.fn(),
    setCommentFeedId: vi.fn(),
    deleteConfirmId: null,
    deleteConfirmFeedId: null,
    profiles: {
      'sender-a': { givenName: 'Sender', familyName: 'Alpha' } as any,
    },
    senderOptions: [],
    freqs: [],
    postsList: [],
    groupsList: ['g-1', 'g-2'],
    groupInfos: {
      'g-1': { name: 'Group Alpha' } as any,
      'g-2': { name: 'Group Beta' } as any,
    },
    tagsMap: { 3: { id: 3, label: 'tag-3', isPalitra: false } as any },
    tagsOrder: [3],
    tagIdsList: [3],
    savedFilters: [],
    selectedSavedIdByFeedId: {},
    setSelectedSavedIdByFeedId: vi.fn(),
    saveFilterNameByFeedId: {},
    setSaveFilterNameByFeedId: vi.fn(),
    reloadFreqsLoading: false,
    reloadLatestFrequencies: vi.fn(),
    networkDisplayMap: { 7: 'Network 7' },
    networkMap: { 7: { id: 7, name: 'Network 7' } as any },
    unitsMap: { 1: { id: 1, name: 'Unit 1' } as any },
    callsignInfoMap: {},
    featureStrictNetworks: false,
    watchModeByFeedId: {},
    setWatchModeByFeedId: vi.fn(),
    loadingNewerFeedId: null,
    arrowResultByFeedId: {},
    copiedFeedbackId: null,
    keywordSets: [],
    reloadKeywordSets: vi.fn(),
    error: null,
    clearDutyError: vi.fn(),
    authUserName: 'tester',
    columnRefsRef: { current: {} },
    nearBottomByFeedIdRef: { current: {} },
    atBottomByFeedIdRef: { current: {} },
    dutyDisableAutoScroll: false,
  };
}

async function renderPage() {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const state = buildFeedsState();
  useRerDutyFeedsMock.mockReturnValue(state as never);

  await act(async () => {
    root.render(<RerDutyNeoPage authUserName="tester" />);
  });

  return { container, root, state };
}

async function click(element: Element | null) {
  if (!element) throw new Error('Missing element');
  await act(async () => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

describe('RerDutyNeoPage creation workflow', () => {
  beforeEach(() => {
    fetchMessagesByIds.mockReset();
    useRerDutyFeedsMock.mockReset();
    nextCreatedResponse.value = null;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('closes the composer before showing a response-message preview', async () => {
    nextCreatedResponse.value = { signal_message_id: 101, message: buildMessage() };
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();

    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.textContent).toContain('Додане повідомлення');
    expect(container.textContent).toContain('101');
    expect(container.querySelector('[data-testid="message-text"]')?.textContent).toBe(
      'created preview body',
    );
    expect(state.createMessageFeed).not.toHaveBeenCalled();
    expect(state.removeMessageFeed).not.toHaveBeenCalled();
    expect(state.loadFeedInitialMessages).not.toHaveBeenCalled();
    expect(state.loadFeedOlderMessages).not.toHaveBeenCalled();
    expect(state.applyFilter).not.toHaveBeenCalled();

    await click(container.querySelector('button[aria-label="Закрити"]'));
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.textContent).toContain('feed-1');

    await act(async () => {
      root.unmount();
    });
  });

  it('fetches once for fallback preview when the response omits the message', async () => {
    nextCreatedResponse.value = { signal_message_id: 202 };
    fetchMessagesByIds.mockResolvedValueOnce([[202, buildMessage()]]);
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(fetchMessagesByIds).toHaveBeenCalledTimes(1);
    expect(fetchMessagesByIds).toHaveBeenCalledWith([202]);
    expect(container.textContent).toContain('Додане повідомлення');
    expect(container.textContent).toContain('202');
    expect(state.createMessageFeed).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('shows receipt state when the fallback is empty or fails', async () => {
    nextCreatedResponse.value = { signal_message_id: 303 };
    fetchMessagesByIds.mockResolvedValueOnce([]);
    const { container, root } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    await act(async () => {
      await vi.runAllTimersAsync();
    });

    expect(container.textContent).toContain('Повідомлення створено.');
    expect(container.textContent).toContain('ID повідомлення: 303');
    expect(container.textContent).toContain('попередній перегляд не вдалося завантажити');
    expect(container.querySelector('[data-testid="message-card"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });
});
