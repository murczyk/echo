/**
 * @vitest-environment happy-dom
 */
import { act, createElement, forwardRef, useEffect, useImperativeHandle, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { minimalInboxMessage } from '../inbox-message-mocks';
import { buildInboxReq, clearActiveFeedFilter, emptyFilter } from '../utils';

const useRerDutyFeedsMock = vi.hoisted(() => vi.fn());
const notifyMock = vi.hoisted(() => vi.fn());
const fetchInboxItemContextMock = vi.hoisted(() => vi.fn());
const fetchMessagesByIdsMock = vi.hoisted(() => vi.fn());
const useMediaQueryMock = vi.hoisted(() => vi.fn(() => false));
const nextCreatedResponse = vi.hoisted(() => ({
  value: null as null | { signal_message_id: number },
}));
const editorGuardMocks = vi.hoisted(() => ({ dirty: false }));
const currentSystemSettingsMock = vi.hoisted(() => vi.fn());

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

const userSettingsMock = vi.hoisted(() => ({
  fetchUserSettings: vi.fn(),
}));

vi.mock('../../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: userSettingsMock.fetchUserSettings,
}));
vi.mock('../../../services/api/user', () => ({
  fetchCurrentUser: vi.fn().mockResolvedValue({ roles: ['Rer'], organismId: null }),
}));
vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: currentSystemSettingsMock,
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
    editorEmbeddedOpen,
  }: {
    activeFeedId: string | null;
    createMessageFeed: () => void;
    openCreateMessageComposer: (feedId: string) => void;
    buildFeedColumnModel: (feed: any) => any;
    messageFeeds: any[];
    editorEmbeddedOpen?: boolean;
  }) => (
    <div>
      <div data-testid="active-feed">{activeFeedId}</div>
      <output data-testid="editor-embedded-open">{String(editorEmbeddedOpen)}</output>
      {messageFeeds.map((feed) => (
        <div key={feed.id} data-duty-feed-column data-duty-feed-id={feed.id} />
      ))}
      <output data-testid="card-network-visibility">
        {String(buildFeedColumnModel(messageFeeds[0]).messageCard.hideNetworks)}
      </output>
      {messageFeeds.map((feed) => (
        <output
          key={feed.id}
          data-testid={`editor-highlight-${feed.id}`}
          data-unread-boundary={buildFeedColumnModel(feed).view.unreadBoundaryMessageId ?? 'none'}
        >
          {buildFeedColumnModel(feed).view.editorHighlightedMessageId ?? 'none'}
        </output>
      ))}
      <button
        type="button"
        aria-label="Додати повідомлення"
        onClick={() => openCreateMessageComposer(messageFeeds[0].id)}
      >
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
            onClick={() =>
              buildFeedColumnModel(messageFeeds[0]).actions.onMessageEditReport(
                91,
                messageFeeds[0].items[0][0],
              )
            }
          />
          <button
            type="button"
            aria-label="Створити розвіддонесення"
            onClick={(event) => {
              const [id, message] = messageFeeds[0].items[0];
              buildFeedColumnModel(messageFeeds[0]).actions.onMessageCreateReport(
                id,
                message,
                undefined,
                event.currentTarget,
              );
            }}
          />
        </>
      ) : null}
      {messageFeeds[1]?.items[0] ? (
        <button
          type="button"
          aria-label="Редагувати повідомлення стрічки 2"
          onClick={() => {
            const [id, message] = messageFeeds[1].items[0];
            buildFeedColumnModel(messageFeeds[1]).actions.onMessageEdit(id, message);
          }}
        />
      ) : null}
    </div>
  ),
}));
vi.mock('../../shared/manage-message/ManageMessageDrawer', () => ({
  ManageMessageDrawer: forwardRef(function ManageMessageDrawerMock(
    {
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
      intentKey,
      presentation,
      minimalReport,
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
      intentKey?: string;
      presentation?: 'modal' | 'embedded';
      minimalReport?: { host: HTMLElement | null; onExpand: () => void } | null;
    },
    ref,
  ) {
    const [pendingIntent, setPendingIntent] = useState<null | {
      key: string;
      commit: () => void;
    }>(null);
    useImperativeHandle(ref, () => ({
      requestIntentChange(change: { key: string; commit: () => void }) {
        if (change.key === intentKey) return;
        if (editorGuardMocks.dirty) setPendingIntent(change);
        else change.commit();
      },
      closeWithoutConfirmation: onClose,
      focus: () => {},
    }));
    return open ? (
      <div
        role="dialog"
        data-testid="composer"
        data-edit-as-report={editAsReport ? 'true' : 'false'}
        data-edit-target-load-status={editTargetLoadState?.status ?? ''}
        data-edit-target-id={editTarget?.id ?? ''}
        data-report-source-id={reportSource?.id ?? ''}
        data-minimal-host-feed={minimalReport?.host?.dataset.dutyFeedId ?? ''}
      >
        {minimalReport ? (
          <button type="button" aria-label="Розгорнути звіт" onClick={minimalReport.onExpand} />
        ) : null}
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
              if (presentation !== 'embedded') onClose();
              await onCreated?.(nextCreatedResponse.value);
            }
          }}
        >
          Створити
        </button>
        {pendingIntent ? (
          <div role="alertdialog">
            <button type="button" onClick={() => setPendingIntent(null)}>
              Продовжити редагування
            </button>
            <button
              type="button"
              onClick={() => {
                editorGuardMocks.dirty = false;
                setPendingIntent(null);
                pendingIntent.commit();
              }}
            >
              Відхилити зміни
            </button>
          </div>
        ) : null}
      </div>
    ) : null;
  }),
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
  useMediaQuery: useMediaQueryMock,
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
    setFeedInitialTarget: vi.fn(),
    buildReqForFeed: vi.fn((feed, options) => buildInboxReq({ ...options, filter: feed.filter })),
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
    isExplicitNavigationLoading: () => false,
    loadingNewerFeedId: null,
    arrowResultByFeedId: {},
    copiedFeedbackId: null,
    keywordSets: [],
    reloadKeywordSets: vi.fn(),
    error: null as string | null,
    errorNotificationVersion: 0,
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
describe('RerDutyNeoPage creation workflow', () => {
  beforeEach(() => {
    currentSystemSettingsMock.mockReset();
    currentSystemSettingsMock.mockResolvedValue({
      devicesSectionEnabled: false,
      enableAudioTranscription: true,
      hideNetworks: false,
    });
    useRerDutyFeedsMock.mockReset();
    useMediaQueryMock.mockReset();
    useMediaQueryMock.mockReturnValue(false);
    userSettingsMock.fetchUserSettings.mockReset();
    userSettingsMock.fetchUserSettings.mockResolvedValue({ tagsLayout: 'compact' });
    notifyMock.mockReset();
    fetchInboxItemContextMock.mockReset();
    fetchMessagesByIdsMock.mockReset();
    nextCreatedResponse.value = null;
    editorGuardMocks.dirty = false;
    vi.useFakeTimers();
    vi.stubGlobal('requestAnimationFrame', undefined);
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    window.history.replaceState({}, '', '/rer-duty-neo');
  });

  // Regression: https://github.com/echoua/echo/issues/3598
  it('hides card network presentation until settings resolve, then uses the resolved value', async () => {
    const settings = deferred<{
      devicesSectionEnabled: boolean;
      enableAudioTranscription: boolean;
      hideNetworks: boolean;
    }>();
    currentSystemSettingsMock.mockReturnValue(settings.promise);
    const { container, root } = await renderPage();

    expect(container.querySelector('[data-testid="card-network-visibility"]')?.textContent).toBe(
      'true',
    );

    await act(async () => {
      settings.resolve({
        devicesSectionEnabled: false,
        enableAudioTranscription: true,
        hideNetworks: false,
      });
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="card-network-visibility"]')?.textContent).toBe(
      'false',
    );

    await act(async () => root.unmount());
  });

  it('keeps card network presentation hidden after a settings failure', async () => {
    currentSystemSettingsMock.mockRejectedValue(new Error('settings unavailable'));
    const { container, root } = await renderPage();

    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(container.querySelector('[data-testid="card-network-visibility"]')?.textContent).toBe(
      'true',
    );

    await act(async () => root.unmount());
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

  it('keeps the embedded composer open after creation', async () => {
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    nextCreatedResponse.value = { signal_message_id: 101 };
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));

    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    expect(state.reloadEmptyFeeds).toHaveBeenCalledTimes(1);
    expect(notifyMock).toHaveBeenCalledWith({
      message: 'Повідомлення успішно створено.',
      severity: 'success',
    });

    await act(async () => root.unmount());
  });

  it('hides only the source column unread divider after successful creation (#3727)', async () => {
    const { container, root, state } = await renderPage((state) => {
      state.messageFeeds.forEach((feed) => {
        feed.unreadCount = 1;
      });
    });
    const boundary = (feedId: string) =>
      container
        .querySelector(`[data-testid="editor-highlight-${feedId}"]`)
        ?.getAttribute('data-unread-boundary');
    expect(boundary('feed-1')).toBe('42');
    expect(boundary('feed-2')).toBe('42');

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    expect(boundary('feed-1')).toBe('42');
    expect(boundary('feed-2')).toBe('42');

    nextCreatedResponse.value = { signal_message_id: 101 };
    await click(container.querySelector('button[aria-label="Створити повідомлення"]'));
    expect(boundary('feed-1')).toBe('none');
    expect(boundary('feed-2')).toBe('42');

    state.messageFeeds[0].filter = { ...state.messageFeeds[0].filter, groupsSelected: ['g-3'] };
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    expect(boundary('feed-1')).toBe('42');
    expect(boundary('feed-2')).toBe('42');

    await act(async () => root.unmount());
  });

  it('opens edit mode, submits the returned message, and closes the drawer', async () => {
    const { container, root, state } = await renderPage();

    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    expect(container.querySelector('[data-testid="composer"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="editor-highlight-feed-1"]')?.textContent).toBe(
      '42',
    );
    expect(container.querySelector('[data-testid="editor-highlight-feed-2"]')?.textContent).toBe(
      'none',
    );

    await click(container.querySelector('button[aria-label="Зберегти редагування"]'));

    expect(state.handleEditedMessage).toHaveBeenCalledTimes(1);
    expect(state.reloadEditedFeeds).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="composer"]')).toBeNull();
    expect(container.querySelector('[data-testid="editor-highlight-feed-1"]')?.textContent).toBe(
      'none',
    );

    await act(async () => {
      root.unmount();
    });
  });
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

  it('floats a report over its source column without reflowing the feeds', async () => {
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    userSettingsMock.fetchUserSettings.mockResolvedValue({
      tagsLayout: 'compact',
      minimalReportWindowEnabled: true,
    });
    const { container, root } = await renderPage();
    const composer = () => container.querySelector('[data-testid="composer"]');
    const embeddedOpen = () =>
      container.querySelector('[data-testid="editor-embedded-open"]')?.textContent;

    await click(container.querySelector('button[aria-label="Створити розвіддонесення"]'));

    expect(composer()?.getAttribute('data-minimal-host-feed')).toBe('feed-1');
    expect(embeddedOpen()).toBe('false');

    await click(container.querySelector('button[aria-label="Розгорнути звіт"]'));

    expect(composer()?.getAttribute('data-report-source-id')).toBe('42');
    expect(composer()?.getAttribute('data-minimal-host-feed')).toBe('');
    expect(embeddedOpen()).toBe('true');

    await click(container.querySelector('button[aria-label="Закрити повідомлення"]'));
    await click(container.querySelector('button[aria-label="Створити розвіддонесення"]'));

    expect(composer()?.getAttribute('data-minimal-host-feed')).toBe('feed-1');
    expect(embeddedOpen()).toBe('false');

    await act(async () => root.unmount());
  });

  it.each([
    ['the setting is off', { tagsLayout: 'compact' }, '(min-width:1024px)'],
    ['the viewport is narrow', { tagsLayout: 'compact', minimalReportWindowEnabled: true }, ''],
  ])('keeps the regular report editor when %s', async (_, settings, matchingQuery) => {
    useMediaQueryMock.mockImplementation((query) => query === matchingQuery);
    userSettingsMock.fetchUserSettings.mockResolvedValue(settings);
    const { container, root } = await renderPage();

    await click(container.querySelector('button[aria-label="Створити розвіддонесення"]'));

    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-minimal-host-feed'),
    ).toBe('');
    expect(container.querySelector('button[aria-label="Розгорнути звіт"]')).toBeNull();

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

  it('animates the embedded editor track without replacing the feed layout', async () => {
    useMediaQueryMock.mockImplementation((query) => query === '(min-width:1024px)');
    const { container, root } = await renderPage();
    const layout = container.querySelector<HTMLElement>('[data-duty-editor-layout]');

    expect(layout?.style.display).toBe('grid');
    expect(layout?.style.gridTemplateColumns).toBe('minmax(0, 1fr) minmax(0, 0fr)');
    expect(layout?.style.transition).toContain('grid-template-columns');

    await click(container.querySelector('button[aria-label="Додати повідомлення"]'));

    expect(layout?.style.gridTemplateColumns).toBe('minmax(0, 1fr) clamp(640px, 48%, 800px)');
    expect(layout?.style.columnGap).toBe('8px');
    await act(async () => root.unmount());
  });

  it('removes spatial editor layout motion when the user prefers reduced motion', async () => {
    useMediaQueryMock.mockImplementation(
      (query) => query === '(min-width:1024px)' || query === '(prefers-reduced-motion: reduce)',
    );
    const { container, root } = await renderPage();

    expect(
      container.querySelector<HTMLElement>('[data-duty-editor-layout]')?.style.transition,
    ).toBe('none');
    await act(async () => root.unmount());
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
    expect(container.querySelector('[data-testid="editor-highlight-feed-1"]')?.textContent).toBe(
      '42',
    );
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

  it('changes source feed and intent only after a dirty replacement is discarded', async () => {
    const { container, root } = await renderPage((state) => {
      state.messageFeeds[1].items = [[84, minimalInboxMessage({ text: 'feed two' })]];
    });

    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    expect(container.querySelector('[data-testid="active-feed"]')?.textContent).toBe('feed-1');
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-edit-target-id'),
    ).toBe('42');
    expect(container.querySelector('[data-testid="editor-highlight-feed-1"]')?.textContent).toBe(
      '42',
    );
    expect(container.querySelector('[data-testid="editor-highlight-feed-2"]')?.textContent).toBe(
      'none',
    );

    editorGuardMocks.dirty = true;
    await click(container.querySelector('button[aria-label="Редагувати повідомлення стрічки 2"]'));
    expect(container.querySelector('[data-testid="active-feed"]')?.textContent).toBe('feed-1');
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-edit-target-id'),
    ).toBe('42');

    await click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Продовжити редагування',
      ) ?? null,
    );
    expect(container.querySelector('[data-testid="active-feed"]')?.textContent).toBe('feed-1');

    await click(container.querySelector('button[aria-label="Редагувати повідомлення стрічки 2"]'));
    await click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Відхилити зміни',
      ) ?? null,
    );
    expect(container.querySelector('[data-testid="active-feed"]')?.textContent).toBe('feed-2');
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-edit-target-id'),
    ).toBe('84');
    expect(container.querySelector('[data-testid="editor-highlight-feed-1"]')?.textContent).toBe(
      'none',
    );
    expect(container.querySelector('[data-testid="editor-highlight-feed-2"]')?.textContent).toBe(
      '84',
    );
    root.unmount();
  });

  it('does not begin async report loading before dirty replacement confirmation', async () => {
    const request = deferred<Array<[number, any]>>();
    fetchMessagesByIdsMock.mockReturnValueOnce(request.promise);
    const { container, root } = await renderPage();
    await click(container.querySelector('button[aria-label="Редагувати повідомлення"]'));
    editorGuardMocks.dirty = true;

    await click(container.querySelector('button[aria-label="Редагувати розвіддонесення"]'));
    expect(fetchMessagesByIdsMock).not.toHaveBeenCalled();
    expect(
      container.querySelector('[data-testid="composer"]')?.getAttribute('data-edit-target-id'),
    ).toBe('42');

    await click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Відхилити зміни',
      ) ?? null,
    );
    expect(fetchMessagesByIdsMock).toHaveBeenCalledOnce();
    expect(
      container
        .querySelector('[data-testid="composer"]')
        ?.getAttribute('data-edit-target-load-status'),
    ).toBe('loading');

    await act(async () => root.unmount());
  });

  it('shows one privacy-safe error when a linked target is unavailable', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=hidden-41');
    fetchInboxItemContextMock.mockResolvedValueOnce({
      message: null,
      groupMasterKeys: [],
      sigintInboxItemIds: [],
      sinceTs: null,
      tillTs: null,
    });
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });

    await act(async () => Promise.resolve());

    expect(state.applyFilter).not.toHaveBeenCalled();
    expect(notifyMock).toHaveBeenCalledExactlyOnceWith({
      message: 'Повідомлення за посиланням не знайдено або воно недоступне.',
      severity: 'error',
    });
    await act(async () => root.unmount());
  });

  it('does not reload a linked target after the user changes its feed filter', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=target-41');
    const request = deferred<{
      message: [number, ReturnType<typeof minimalInboxMessage>];
      groupMasterKeys: string[];
      sigintInboxItemIds: number[];
      sinceTs: null;
      tillTs: null;
    }>();
    fetchInboxItemContextMock.mockReturnValueOnce(request.promise);
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });

    state.messageFeeds = [
      {
        ...state.messageFeeds[0],
        filter: { ...state.messageFeeds[0].filter, groupsSelected: ['different-group'] },
      },
    ];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    await act(async () => {
      request.resolve({
        message: [41, minimalInboxMessage({ messageUid: 'target-41' })],
        groupMasterKeys: [],
        sigintInboxItemIds: [41],
        sinceTs: null,
        tillTs: null,
      });
      await Promise.resolve();
    });

    expect(state.applyFilter).not.toHaveBeenCalled();
    expect(notifyMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('does not mistake an earlier error version for the linked feed reload error', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=target-41');
    const contextRequest = deferred<{
      message: [number, ReturnType<typeof minimalInboxMessage>];
      groupMasterKeys: string[];
      sigintInboxItemIds: number[];
      sinceTs: null;
      tillTs: null;
    }>();
    fetchInboxItemContextMock.mockReturnValueOnce(contextRequest.promise);
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });
    state.errorNotificationVersion = 1;
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    await act(async () => {
      contextRequest.resolve({
        message: [41, minimalInboxMessage({ messageUid: 'target-41' })],
        groupMasterKeys: [],
        sigintInboxItemIds: [41],
        sinceTs: null,
        tillTs: null,
      });
      await Promise.resolve();
    });
    expect(state.applyFilter).toHaveBeenCalledOnce();
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: true }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    state.error = 'earlier unrelated error';
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));

    expect(notifyMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('lands the exact numeric linked message after the focused feed reload', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=41');
    fetchInboxItemContextMock.mockResolvedValueOnce({
      message: [41, minimalInboxMessage({ messageUid: 'target-41' })],
      groupMasterKeys: [],
      sigintInboxItemIds: [40, 41, 42],
      sinceTs: null,
      tillTs: null,
    });
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });
    const target = document.createElement('article');
    const scrollToMessage = vi.fn(() => target);
    const highlightLinkedMessage = vi.fn(() => true);
    Object.assign(state.columnRefsRef.current, {
      'feed-1': { scrollToMessage, highlightLinkedMessage },
    });

    expect(state.setFeedInitialTarget).toHaveBeenCalledWith('feed-1', {
      beforeIdNoninclusive: 41,
      messageIds: [41],
      signal: expect.any(AbortSignal),
    });
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: true }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: false }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));

    expect(scrollToMessage).toHaveBeenCalledOnce();
    expect(highlightLinkedMessage).toHaveBeenCalledExactlyOnceWith(41);
    expect(notifyMock).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  it('reports one landing error when the loaded feed has no target card', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=target-41');
    fetchInboxItemContextMock.mockResolvedValueOnce({
      message: [41, minimalInboxMessage({ messageUid: 'target-41' })],
      groupMasterKeys: [],
      sigintInboxItemIds: [41],
      sinceTs: null,
      tillTs: null,
    });
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: true }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: false }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));

    expect(notifyMock).toHaveBeenCalledExactlyOnceWith({
      message: 'Повідомлення за посиланням відсутнє у стрічці.',
      severity: 'error',
    });
    await act(async () => root.unmount());
  });

  it('reports the focused feed reload error once', async () => {
    window.history.replaceState({}, '', '/rer-duty-neo?m=target-41');
    fetchInboxItemContextMock.mockResolvedValueOnce({
      message: [41, minimalInboxMessage({ messageUid: 'target-41' })],
      groupMasterKeys: [],
      sigintInboxItemIds: [41],
      sinceTs: null,
      tillTs: null,
    });
    const { root, state } = await renderPage((feeds) => {
      feeds.messageFeeds = [feeds.messageFeeds[0]];
    });
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: true }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));
    state.error = 'raw network error';
    state.errorNotificationVersion = 1;
    state.messageFeeds = [{ ...state.messageFeeds[0], loading: false }];
    await act(async () => root.render(<RerDutyNeoPage authUserName="tester" />));

    expect(notifyMock).toHaveBeenCalledExactlyOnceWith({
      message: 'Не вдалося відкрити повідомлення за посиланням. Спробуйте ще раз.',
      severity: 'error',
    });
    await act(async () => root.unmount());
  });
});
