/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const useRerDutyFeedsMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const nextCreatedResponse = vi.hoisted(() => ({
  value: null as null | { signal_message_id: number },
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
vi.mock('../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: notifyMock }),
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
    onCreated?: (result: { signal_message_id: number }) => Promise<void> | void;
  }) =>
    open ? (
      <div role="dialog" data-testid="composer">
        <button type="button" aria-label="Закрити повідомлення" onClick={onClose}>
          Закрити
        </button>
        <button type="button" aria-label="Симулювати помилку">
          Помилка
        </button>
        <button
          type="button"
          aria-label="Створити повідомлення"
          onClick={async () => {
            if (nextCreatedResponse.value) {
              onClose();
              await onCreated?.(nextCreatedResponse.value);
            }
          }}
        >
          Створити
        </button>
      </div>
    ) : null,
}));
vi.mock('./CommentDialog', () => ({ CommentDialog: () => null }));
vi.mock('./DeleteConfirmDialog', () => ({ DeleteConfirmDialog: () => null }));
vi.mock('./dialogs', () => ({ CommentDialog: () => null, DeleteConfirmDialog: () => null }));
vi.mock('../../components/PowerAlert', () => ({
  PowerAlert: ({
    children,
    autoHideDuration,
    ...props
  }: { children?: ReactNode; autoHideDuration?: number } & Record<string, unknown>) => {
    const [visible, setVisible] = useState(true);
    useEffect(() => {
      if (autoHideDuration == null) return;
      const timeoutId = window.setTimeout(() => setVisible(false), autoHideDuration);
      return () => window.clearTimeout(timeoutId);
    }, [autoHideDuration]);
    return visible ? <div {...props}>{children}</div> : null;
  },
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
      {
        id: 'feed-2',
        filter: { ...feedFilter, groupsSelected: ['g-2'] },
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
    ],
    createMessageFeed: vi.fn(),
    removeMessageFeed: vi.fn(),
    loadFeedInitialMessages: vi.fn(),
    reloadEmptyFeeds: vi.fn(),
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
    useRerDutyFeedsMock.mockReset();
    notifyMock.mockReset();
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

  it('enqueues success Snackbar and reloads empty feeds after creation', async () => {
    nextCreatedResponse.value = { signal_message_id: 101 };
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();

    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));

    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(notifyMock).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Повідомлення успішно створено.',
      severity: 'success',
    });
    expect(state.createMessageFeed).not.toHaveBeenCalled();
    expect(state.removeMessageFeed).not.toHaveBeenCalled();
    expect(state.loadFeedInitialMessages).not.toHaveBeenCalled();
    expect(state.reloadEmptyFeeds).toHaveBeenCalledTimes(1);
    expect(state.loadFeedOlderMessages).not.toHaveBeenCalled();
    expect(state.applyFilter).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('enqueues separate Snackbar notifications for repeated creations', async () => {
    nextCreatedResponse.value = { signal_message_id: 202 };
    const { container, root } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
    });

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    expect(notifyMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      root.unmount();
    });
  });

  it('does not notify or reload when creation is cancelled', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Закрити повідомлення"]'));

    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(state.reloadEmptyFeeds).not.toHaveBeenCalled();
    root.unmount();
  });

  it('keeps the composer open after failed submission without a success notification', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Симулювати помилку"]'));

    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    expect(notifyMock).not.toHaveBeenCalled();
    expect(state.reloadEmptyFeeds).not.toHaveBeenCalled();
    root.unmount();
  });
});
