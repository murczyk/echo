/**
 * @vitest-environment happy-dom
 */
import { act, createElement, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minimalInboxMessage } from '../inbox-message-mocks';
import { clearActiveFeedFilter, emptyFilter } from '../utils';

const useRerDutyFeedsMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const fetchInboxItemContextMock = vi.hoisted(() => vi.fn());
const fetchMessagesByIdsMock = vi.hoisted(() => vi.fn());
const nextCreatedResponse = vi.hoisted(() => ({
  value: null as null | { signal_message_id: number },
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

vi.mock('../../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: vi.fn().mockResolvedValue({ tagsLayout: 'compact' }),
}));
vi.mock('../../../services/api/user', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue(null),
}));
vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: vi
    .fn()
    .mockResolvedValue({ devicesSectionEnabled: false, enableAudioTranscription: true }),
}));
vi.mock('../../../services/api/inbox-messages', () => ({
  fetchInboxItemContext: fetchInboxItemContextMock,
  fetchMessagesByIds: fetchMessagesByIdsMock,
}));
vi.mock('../useRerDutyFeeds', () => ({
  useRerDutyFeeds: useRerDutyFeedsMock,
}));
vi.mock('../../../components/PowerSnackbar', () => ({
  usePowerSnackbar: () => ({ notify: notifyMock }),
}));
vi.mock('../RerDutyNeoWorkspace', () => ({
  RerDutyNeoWorkspace: ({
    activeFeedId,
    createMessageFeed,
    openCreateMessageComposer,
    buildFeedColumnModel,
    messageFeeds,
  }: {
    activeFeedId: string | null;
    createMessageFeed: () => void;
    openCreateMessageComposer: () => void;
    buildFeedColumnModel: (feed: any) => any;
    messageFeeds: any[];
  }) => (
    <div>
      <div data-testid="active-feed">{activeFeedId}</div>
      <button type="button" aria-label="Додати повідомлення" onClick={openCreateMessageComposer}>
        Додати повідомлення
      </button>
      <button type="button" aria-label="Додати стрічку" onClick={createMessageFeed}>
        Додати стрічку
      </button>
      <button
        type="button"
        aria-label="Лише теги мого підрозділу"
        onClick={() =>
          buildFeedColumnModel(messageFeeds[0]).filterPanel.actions.onOnlyMyUnitTagsChange(true)
        }
      />
      <button
        type="button"
        aria-label="Перенести частоти до лише"
        onClick={() =>
          buildFeedColumnModel(messageFeeds[0]).filterPanel.actions.onFreqsModeTransfer({
            includeValues: ['153.6250', '154.0000'],
            excludeValues: [],
          })
        }
      />
      <button
        type="button"
        aria-label="Перенести частоти до окрім"
        onClick={() =>
          buildFeedColumnModel(messageFeeds[0]).filterPanel.actions.onFreqsModeTransfer({
            includeValues: [],
            excludeValues: ['153.6250', '154.0000'],
          })
        }
      />
      <button
        type="button"
        aria-label="Скинути поточний фільтр"
        onClick={() =>
          buildFeedColumnModel(messageFeeds[0]).filterPanel.actions.onDiscardCurrentFilter()
        }
      />
      <button
        type="button"
        aria-label="Змінити діапазон частот"
        onClick={() =>
          buildFeedColumnModel(messageFeeds[0]).filterPanel.actions.onAdjacentFreqsRangeChange(
            0.005,
          )
        }
      />
      {messageFeeds[0]?.items[0] ? (
        <>
          <button
            type="button"
            aria-label="Редагувати повідомлення"
            onClick={() => {
              const [id, message] = messageFeeds[0].items[0];
              buildFeedColumnModel(messageFeeds[0]).actions.onMessageEdit(id, message);
            }}
          />
          <button
            type="button"
            aria-label="Редагувати розвіддонесення"
            onClick={() => buildFeedColumnModel(messageFeeds[0]).actions.onMessageEditReport(91)}
          />
          <button
            type="button"
            aria-label="Створити розвіддонесення"
            onClick={() => {
              const [id, message] = messageFeeds[0].items[0];
              buildFeedColumnModel(messageFeeds[0]).actions.onMessageCreateReport(id, message);
            }}
          />
        </>
      ) : null}
    </div>
  ),
}));
vi.mock('../../shared/manage-message/ManageMessageDrawer', () => ({
  ManageMessageDrawer: ({
    open,
    onClose,
    onCreated,
    editTarget,
    editAsReport,
    editTargetLoadState,
    reportSource,
    onSubmitEdit,
    onEditSuccess,
    onDeleteSuccess,
  }: {
    open: boolean;
    onClose: () => void;
    onCreated?: (result: { signal_message_id: number }) => Promise<void> | void;
    editTarget?: { id: number; message: any } | null;
    editAsReport?: boolean;
    editTargetLoadState?: { status: string; reportId?: number };
    reportSource?: { id: number; message: any } | null;
    onSubmitEdit?: (id: number, message: any) => Promise<void> | void;
    onEditSuccess?: (result: { signal_message_id: number }) => Promise<void> | void;
    onDeleteSuccess?: (messageId: number) => Promise<void> | void;
  }) =>
    open ? (
      <div
        role="dialog"
        data-testid="composer"
        data-edit-as-report={editAsReport ? 'true' : 'false'}
        data-edit-target-load-status={editTargetLoadState?.status ?? ''}
        data-edit-target-id={editTarget?.id ?? ''}
        data-report-source-id={reportSource?.id ?? ''}
      >
        <button type="button" aria-label="Закрити повідомлення" onClick={onClose}>
          Закрити
        </button>
        <button type="button" aria-label="Симулювати помилку">
          Помилка
        </button>
        {editTarget ? (
          <>
            <button
              type="button"
              aria-label="Зберегти редагування"
              onClick={async () => {
                if (onSubmitEdit) {
                  await onSubmitEdit(editTarget.id, editTarget.message);
                } else {
                  await onEditSuccess?.({ signal_message_id: editTarget.id });
                }
                onClose();
              }}
            />
            <button
              type="button"
              aria-label="Видалити через редактор"
              onClick={async () => {
                onClose();
                await onDeleteSuccess?.(editTarget.id);
              }}
            />
          </>
        ) : null}
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
vi.mock('../dialogs', () => ({ DeleteConfirmDialog: () => null }));
vi.mock('../../../components/PowerAlert', () => ({
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

import { RerDutyNeoPage } from '../index';

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
        items: [[42, minimalInboxMessage({ text: 'original' })]],
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
        items: [[42, minimalInboxMessage({ text: 'original' })]],
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
    setMessageFeeds: vi.fn(),
    createMessageFeed: vi.fn(),
    removeMessageFeed: vi.fn(),
    loadFeedInitialMessages: vi.fn(),
    reloadEmptyFeeds: vi.fn(),
    reloadFeeds: vi.fn(),
    flushPendingNewerMessages: vi.fn(),
    reloadEditedFeeds: vi.fn(),
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
    handleEditedMessage: vi.fn(),
    handleOpenPointsOnMap: vi.fn(),
    handleDeleteConfirm: vi.fn(),
    setDeleteConfirmId: vi.fn(),
    setDeleteConfirmFeedId: vi.fn(),
    handleToggleTag: vi.fn(),
    botTagAction: null,
    onCancelBotTagAction: vi.fn(),
    onMarkBotTagWrong: vi.fn(),
    handleArrowClick: vi.fn(),
    handleVisibleMessageIds: vi.fn(),
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
    loadingNewerFeedIds: new Set<string>(),
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
    physicallyAtBottomByFeedIdRef: { current: {} },
    tailAvailabilityByFeedId: {},
    confirmedTailPreviewByFeedId: {},
    beginFollowTail: vi.fn(),
    ensureFollowTail: vi.fn(),
    cancelFollowTail: vi.fn(),
    dutyDisableAutoScroll: false,
  };
}

async function renderPage(configureState?: (state: ReturnType<typeof buildFeedsState>) => void) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);

  const state = buildFeedsState();
  configureState?.(state);
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

// @test-scope safeguard: prevents message creation and edit callbacks from updating the wrong Duty feed or report mode.
describe('RerDutyNeoPage creation workflow', () => {
  beforeEach(() => {
    useRerDutyFeedsMock.mockReset();
    notifyMock.mockReset();
    fetchInboxItemContextMock.mockReset();
    fetchMessagesByIdsMock.mockReset();
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

  it('opens edit mode, submits the returned message, and closes the drawer', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();

    await click(container.querySelector('button[aria-label="Зберегти редагування"]'));

    expect(state.handleEditedMessage).toHaveBeenCalledTimes(1);
    expect(state.reloadEditedFeeds).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  // @test-scope safeguard: prevents editing an own report through the message flow and losing report-specific handling.
  it('opens an own report card from the header edit action in report mode', async () => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    const state = buildFeedsState();
    state.messageFeeds[0].items = [
      [
        91,
        minimalInboxMessage({
          text: 'report body',
          groupMasterKey: null,
          parentMessages: [
            {
              id: 42,
              isAccessible: false,
              isDeleted: false,
              text: '',
              attachmentsCount: 0,
              timestamp: null,
              date: null,
              time: null,
              groupName: null,
              groupMasterKey: null,
            },
          ],
        }),
      ],
    ];
    useRerDutyFeedsMock.mockReturnValue(state as never);

    await act(async () => {
      root.render(<RerDutyNeoPage authUserName="tester" />);
    });

    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-edit-as-report'),
    ).toBe('true');

    await click(container.querySelector('button[aria-label="Зберегти редагування"]'));

    expect(state.handleEditedMessage).not.toHaveBeenCalled();
    expect(state.reloadFeeds).toHaveBeenCalledTimes(1);
    expect(state.reloadEditedFeeds).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
  });

  it('refreshes all feeds after deletion from the editor', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Видалити через редактор"]'));

    expect(state.reloadFeeds).toHaveBeenCalledTimes(1);
    expect(state.reloadEditedFeeds).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Розвіддонесення успішно видалено.',
      severity: 'success',
    });
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();

    await act(async () => root.unmount());
  });

  // @test-scope safeguard: prevents creating a report from discarding already loaded duty feeds
  it('opens report mode and keeps populated feeds without a full reload after creation', async () => {
    nextCreatedResponse.value = { signal_message_id: 91 };
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Створити розвіддонесення"]'));
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-report-source-id'),
    ).toBe('42');

    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));

    expect(state.reloadEmptyFeeds).toHaveBeenCalledTimes(1);
    expect(state.reloadFeeds).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Розвіддонесення успішно створено.',
      severity: 'success',
    });

    await act(async () => root.unmount());
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

  it('changes the own-unit tag display without reloading messages', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Лише теги мого підрозділу"]'));

    expect(state.setMessageFeeds).toHaveBeenCalledTimes(1);
    expect(state.loadFeedInitialMessages).not.toHaveBeenCalled();

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

  it('applies each frequency mode transfer as one complete filter update', async () => {
    const { container, root, state } = await renderPage();
    state.messageFeeds[0].filter.freqsDenied = ['153.6250', '154.0000'];

    await click(container.querySelector('button[aria-label="Перенести частоти до лише"]'));
    expect(state.applyFilter).toHaveBeenCalledTimes(1);
    expect(state.applyFilter).toHaveBeenLastCalledWith('feed-1', {
      ...state.messageFeeds[0].filter,
      freqsSelected: ['153.6250', '154.0000'],
      freqsDenied: null,
    });

    state.applyFilter.mockClear();
    await click(container.querySelector('button[aria-label="Перенести частоти до окрім"]'));
    expect(state.applyFilter).toHaveBeenCalledTimes(1);
    expect(state.applyFilter).toHaveBeenLastCalledWith('feed-1', {
      ...state.messageFeeds[0].filter,
      freqsSelected: null,
      freqsDenied: ['153.6250', '154.0000'],
    });

    root.unmount();
  });

  it('discards the current filter and its saved-filter selection', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Скинути поточний фільтр"]'));

    expect(state.setSelectedSavedIdByFeedId).toHaveBeenCalledOnce();
    expect(state.setSaveFilterNameByFeedId).toHaveBeenCalledOnce();
    expect(state.applyFilter).toHaveBeenCalledWith(
      'feed-1',
      clearActiveFeedFilter(state.messageFeeds[0].filter),
    );
    const updateFeeds = state.setMessageFeeds.mock.calls[0]?.[0];
    const updatedFeeds = updateFeeds(
      state.messageFeeds.map((feed) => ({
        ...feed,
        adjacentFreqsRange: 0.005,
        highlightSignalsEnabled: true,
        onlyMyUnitTagsEnabled: true,
      })),
    );
    expect(updatedFeeds[0]).toMatchObject({
      adjacentFreqsRange: 0,
      highlightSignalsEnabled: false,
      onlyMyUnitTagsEnabled: false,
    });
    expect(updatedFeeds[1]).toMatchObject({
      adjacentFreqsRange: 0.005,
      highlightSignalsEnabled: true,
      onlyMyUnitTagsEnabled: true,
    });

    root.unmount();
  });

  it('reloads when discarding signal highlighting as the only active option', async () => {
    const { container, root, state } = await renderPage((feedState) => {
      feedState.messageFeeds[0].filter = emptyFilter();
      feedState.messageFeeds[0].highlightSignalsEnabled = true;
    });

    await click(container.querySelector('button[aria-label="Скинути поточний фільтр"]'));

    expect(state.applyFilter).toHaveBeenCalledWith('feed-1', emptyFilter(), true);

    root.unmount();
  });

  it('reloads the feed when adjacent-frequency expansion changes', async () => {
    const { container, root, state } = await renderPage((feedState) => {
      feedState.messageFeeds[0].filter.freqsSelected = ['153.6250'];
    });

    await click(container.querySelector('button[aria-label="Змінити діапазон частот"]'));

    expect(state.applyFilter).toHaveBeenCalledWith('feed-1', state.messageFeeds[0].filter, true);
    const updateFeeds = state.setMessageFeeds.mock.calls[0]?.[0];
    expect(updateFeeds(state.messageFeeds)[0].adjacentFreqsRange).toBe(0.005);
    expect(updateFeeds(state.messageFeeds)[1].adjacentFreqsRange).toBe(0);

    root.unmount();
  });

  it('opens and dismisses a loading report editor without applying a stale result', async () => {
    const request = deferred<Array<[number, any]>>();
    fetchMessagesByIdsMock.mockReturnValueOnce(request.promise);
    const { container, root } = await renderPage();

    await click(container.querySelector('button[aria-label="Редагувати розвіддонесення"]'));
    const drawer = container.querySelector('[data-testid="composer"]');
    expect(drawer).not.toBeNull();
    expect(drawer?.getAttribute('data-edit-target-load-status')).toBe('loading');
    expect(drawer?.getAttribute('data-edit-as-report')).toBe('true');
    expect(drawer?.getAttribute('data-edit-target-id')).toBe('');
    const signal = fetchMessagesByIdsMock.mock.calls[0]?.[2]?.signal as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);

    await click(container.querySelector('button[aria-label="Закрити повідомлення"]'));
    expect(signal.aborted).toBe(true);
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();

    await act(async () => {
      request.resolve([[91, minimalInboxMessage({ text: 'stale' })]]);
      await request.promise;
    });
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    root.unmount();
  });

  it('keeps a regular editor active when a stale report load resolves', async () => {
    const request = deferred<Array<[number, any]>>();
    fetchMessagesByIdsMock.mockReturnValueOnce(request.promise);
    const { container, root } = await renderPage();
    await click(container.querySelector('button[aria-label="Редагувати розвіддонесення"]'));
    const signal = fetchMessagesByIdsMock.mock.calls[0]?.[2]?.signal as AbortSignal;
    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    const drawer = container.querySelector('[data-testid="composer"]');
    expect(signal.aborted).toBe(true);
    expect(drawer?.getAttribute('data-edit-target-load-status')).toBe('idle');
    expect(drawer?.getAttribute('data-edit-target-id')).toBe('42');

    await act(async () => {
      request.resolve([[91, minimalInboxMessage({ text: 'stale' })]]);
      await request.promise;
    });
    expect(drawer?.getAttribute('data-edit-target-id')).toBe('42');
    expect(drawer?.getAttribute('data-edit-target-load-status')).toBe('idle');
    root.unmount();
  });
});
