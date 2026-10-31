/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { useRef, useState, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  InboxMessage,
  InboxMessageTag,
  InboxMessagesReq,
  SavedFilterDuty,
  SignalGroupEntry,
} from '../../../../../Bindings';
import { minimalInboxMessage } from '../inbox-message-mocks';
import {
  buildInboxReq,
  emptyFilter,
  feedIndicatorUnreadCount,
  feedHasUnloadedEvictedNewerTail,
  feedHasUnloadedHistoricalNewer,
  feedHasUnrenderedHistoricalNewer,
  historicalReadMessageIds,
  type MessageFeedState,
} from '../utils';
import { useRerDutyMessageActions } from '../useRerDutyMessageActions';
import { PowerSnackbarProvider } from '../../../components/PowerSnackbar';
import { mergeUpdatedDutyFeedMessages } from '../../shared/message-card/message-card-message-updates';

const hoisted = vi.hoisted(() => ({
  deleteMessage: vi.fn(),
  fetchInboxCount: vi.fn(),
  bookmarkAdd: vi.fn(),
  bookmarkRemove: vi.fn(),
  commentSave: vi.fn(),
  importantAdd: vi.fn(),
  importantRemove: vi.fn(),
  inboxMessageTagsAdd: vi.fn(),
  inboxMessageTagsModelError: vi.fn(),
  inboxMessageTagsRm: vi.fn(),
  savedFilterDelete: vi.fn(),
  savedFilterRename: vi.fn(),
  savedFilterUpsert: vi.fn(),
  copyTextToClipboard: vi.fn(),
  requestValidatedInboxCount: vi.fn(),
  catchUpFeedUnreadToTail: vi.fn(),
  loadFeedNewerMessages: vi.fn(() => Promise.resolve({ ok: true, addedCount: 0 })),
  loadFeedInitialMessages: vi.fn(() => Promise.resolve()),
  flushPendingNewerMessages: vi.fn(),
  showArrowResult: vi.fn(),
  setWatchModeByFeedId: vi.fn(),
  setLoadingNewerFeedIds: vi.fn(),
  beginFollowTail: vi.fn(() => 17),
  beginExplicitNavigation: vi.fn((feedId: string) => ({ feedId, generation: 17 })),
  isExplicitNavigationCurrent: vi.fn(() => true),
  registerExplicitLanding: vi.fn(() => true),
  registerExplicitLoading: vi.fn(() => true),
  cancelExplicitNavigation: vi.fn(() => true),
  registerExplicitScheduledWork: vi.fn(() => true),
  clearExplicitScheduledWork: vi.fn(),
  getExplicitScrollNavigation: vi.fn(() => ({ onUnavailable: vi.fn() })),
  addPalitraHighlightBlacklistEntry: vi.fn(),
  requestImportantMessage: vi.fn(),
}));

vi.mock('../../../services/api/inbox', () => ({
  bookmarkAdd: hoisted.bookmarkAdd,
  bookmarkRemove: hoisted.bookmarkRemove,
  commentSave: hoisted.commentSave,
  deleteMessage: hoisted.deleteMessage,
  fetchInboxCount: hoisted.fetchInboxCount,
  importantAdd: hoisted.importantAdd,
  importantRemove: hoisted.importantRemove,
  inboxMessageTagsAdd: hoisted.inboxMessageTagsAdd,
  inboxMessageTagsModelError: hoisted.inboxMessageTagsModelError,
  inboxMessageTagsRm: hoisted.inboxMessageTagsRm,
  savedFilterDelete: hoisted.savedFilterDelete,
  savedFilterRename: hoisted.savedFilterRename,
  savedFilterUpsert: hoisted.savedFilterUpsert,
}));

vi.mock('../../../services/api/palitra', () => ({
  addPalitraHighlightBlacklistEntry: hoisted.addPalitraHighlightBlacklistEntry,
}));

vi.mock('../../../components/app-navbar/ImportantMessageDialog', () => ({
  IMPORTANT_MESSAGE_UPDATED_EVENT: 'echo-important-message-updated',
  requestImportantMessage: hoisted.requestImportantMessage,
}));

vi.mock('../../../../copy-to-clipboard', () => ({
  copyTextToClipboard: hoisted.copyTextToClipboard,
}));

vi.mock('../../../services/api/analysis', () => ({
  fetchAnalysisCallsignInfos: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../../services/api/user-settings', () => ({
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  fetchUserSettings: vi.fn(() => Promise.resolve({ disableAutoScroll: false })),
}));

type BuildReqOpts = Omit<
  Parameters<typeof buildInboxReq>[0],
  | 'filter'
  | 'expandedFreqsSelected'
  | 'expandedFreqsDenied'
  | 'highlightSignals'
  | 'reportTagsOnlyThisUnit'
>;

type HarnessApi = ReturnType<typeof useRerDutyMessageActions> & {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  savedFilters: SavedFilterDuty[];
  setSavedFilters: Dispatch<SetStateAction<SavedFilterDuty[]>>;
  selectedSavedIdByFeedId: Record<string, number | null>;
  setSelectedSavedIdByFeedId: Dispatch<SetStateAction<Record<string, number | null>>>;
  saveFilterNameByFeedId: Record<string, string>;
  setSaveFilterNameByFeedId: Dispatch<SetStateAction<Record<string, string>>>;
  commentMessagePreview: {
    text?: string | null;
    freq?: string | null;
    groupMasterKey?: string | null;
    groupName?: string | null;
    sender?: string | null;
    senderName?: string | null;
  } | null;
  botTagAction: ReturnType<typeof useRerDutyMessageActions>['botTagAction'];
  onCancelBotTagAction: ReturnType<typeof useRerDutyMessageActions>['onCancelBotTagAction'];
  onMarkBotTagWrong: ReturnType<typeof useRerDutyMessageActions>['onMarkBotTagWrong'];
};

function buildReqForFeed(_feed: MessageFeedState, opts: BuildReqOpts): InboxMessagesReq {
  return {
    sinceIdNoninclusive: opts.sinceIdNoninclusive ?? null,
    sinceDateInclusiveMs: opts.sinceDateInclusiveMs ?? null,
    nolimit: opts.nolimit ?? null,
  } as InboxMessagesReq;
}

function buildFeed(overrides: Partial<MessageFeedState> = {}): MessageFeedState {
  const items: [number, InboxMessage][] = Array.from({ length: 20 }, (_, index) => [
    index + 1,
    minimalInboxMessage({ createdAtOrder: 100 + index }),
  ]);
  return {
    id: 'mf-0',
    filter: emptyFilter(),
    items,
    loading: false,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 70000,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
    ...overrides,
  };
}

function buildTag(tagId: number, overrides: Partial<InboxMessageTag> = {}): InboxMessageTag {
  return {
    id: tagId,
    tagId,
    confidence: 1,
    login: null,
    model: null,
    organismId: null,
    ...overrides,
  };
}

function buildMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return minimalInboxMessage({
    text: 'message',
    tags: [3, 4],
    inboxTags: [buildTag(3, { login: 'tester', organismId: 1 })],
    ...overrides,
  });
}

function TestHarness(props: {
  apiRef: MutableRefObject<HarnessApi | null>;
  initialFeeds?: MessageFeedState[];
  initialSavedFilters?: SavedFilterDuty[];
  authUserName?: string | null;
  errorRef?: MutableRefObject<ReturnType<typeof vi.fn> | null>;
  currentUserOrganismId?: number | null;
  columnRefsRef?: MutableRefObject<
    Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
  >;
}) {
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(
    props.initialFeeds ?? [buildFeed()],
  );
  const [savedFilters, setSavedFilters] = useState<SavedFilterDuty[]>(
    props.initialSavedFilters ?? [],
  );
  const [selectedSavedIdByFeedId, setSelectedSavedIdByFeedId] = useState<
    Record<string, number | null>
  >({});
  const [saveFilterNameByFeedId, setSaveFilterNameByFeedId] = useState<Record<string, string>>({});
  const fallbackColumnRefsRef = useRef<
    Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
  >({});
  const columnRefsRef = props.columnRefsRef ?? fallbackColumnRefsRef;
  const actions = useRerDutyMessageActions({
    messageFeeds,
    setMessageFeeds,
    setError: vi.fn(),
    applyFilter: vi.fn(),
    loadFeedInitialMessages: hoisted.loadFeedInitialMessages,
    loadFeedNewerMessages: hoisted.loadFeedNewerMessages,
    flushPendingNewerMessages: hoisted.flushPendingNewerMessages,
    showArrowResult: hoisted.showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId: hoisted.setWatchModeByFeedId,
    setLoadingNewerFeedIds: hoisted.setLoadingNewerFeedIds,
    requestValidatedInboxCount: hoisted.requestValidatedInboxCount,
    catchUpFeedUnreadToTail: hoisted.catchUpFeedUnreadToTail,
    authUserName: props.authUserName ?? null,
    currentUserOrganismId: props.currentUserOrganismId ?? null,
    profiles: {
      'sender-1': { givenName: 'BBC', familyName: 'SPORT' },
    },
    tagsMap: {},
    tagsOrder: [],
    groupInfos: {
      'group-1': { masterKey: 'group-1', name: 'Група 1' } as SignalGroupEntry,
    },
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    dutyDisableAutoScroll: false,
    beginFollowTail: hoisted.beginFollowTail,
    beginExplicitNavigation: hoisted.beginExplicitNavigation,
    isExplicitNavigationCurrent: hoisted.isExplicitNavigationCurrent,
    registerExplicitLanding: hoisted.registerExplicitLanding,
    registerExplicitLoading: hoisted.registerExplicitLoading,
    cancelExplicitNavigation: hoisted.cancelExplicitNavigation,
    registerExplicitScheduledWork: hoisted.registerExplicitScheduledWork,
    clearExplicitScheduledWork: hoisted.clearExplicitScheduledWork,
    getExplicitScrollNavigation: hoisted.getExplicitScrollNavigation,
  });
  props.apiRef.current = {
    ...actions,
    messageFeeds,
    setMessageFeeds,
    savedFilters,
    setSavedFilters,
    selectedSavedIdByFeedId,
    setSelectedSavedIdByFeedId,
    saveFilterNameByFeedId,
    setSaveFilterNameByFeedId,
    commentMessagePreview: actions.commentMessagePreview,
    botTagAction: actions.botTagAction,
    onCancelBotTagAction: actions.onCancelBotTagAction,
    onMarkBotTagWrong: actions.onMarkBotTagWrong,
  };
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
describe('useRerDutyMessageActions', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hoisted.importantAdd.mockResolvedValue(true);
    hoisted.importantRemove.mockResolvedValue(false);
    hoisted.deleteMessage.mockResolvedValue(undefined);
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    hoisted.inboxMessageTagsModelError.mockResolvedValue(undefined);
    hoisted.requestValidatedInboxCount.mockResolvedValue({
      feedId: 'mf-0',
      quantity: 0,
      cursorId: 10,
      hasItems: true,
    });
    hoisted.loadFeedNewerMessages.mockResolvedValue({ ok: true, addedCount: 0 });
    hoisted.loadFeedInitialMessages.mockResolvedValue(undefined);
    hoisted.showArrowResult.mockReset();
    hoisted.beginFollowTail.mockReset();
    hoisted.beginFollowTail.mockReturnValue(17);
    hoisted.beginExplicitNavigation.mockReset();
    hoisted.beginExplicitNavigation.mockImplementation((feedId) => ({ feedId, generation: 17 }));
    hoisted.isExplicitNavigationCurrent.mockReset().mockReturnValue(true);
    hoisted.registerExplicitLanding.mockReset().mockReturnValue(true);
    hoisted.registerExplicitLoading.mockReset().mockReturnValue(true);
    hoisted.cancelExplicitNavigation.mockReset().mockReturnValue(true);
    hoisted.registerExplicitScheduledWork.mockReset().mockReturnValue(true);
    hoisted.clearExplicitScheduledWork.mockReset();
    hoisted.getExplicitScrollNavigation.mockReset().mockReturnValue({ onUnavailable: vi.fn() });
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
    vi.useRealTimers();
  });

  it.each([
    ['text-7', 'Повідомлення скопійовано.'],
    ['text-network-7', 'Повідомлення скопійовано.'],
    ['text-network-note-7', 'Повідомлення скопійовано.'],
    ['link-7', 'Посилання на повідомлення скопійовано.'],
    ['freq-7', 'Скопійовано в буфер обміну.'],
    ['etalon-7', 'Скопійовано в буфер обміну.'],
    ['location-7', 'Скопійовано в буфер обміну.'],
  ])('shows a success snackbar only after copying %s completes', async (feedbackId, message) => {
    let finishCopy!: () => void;
    hoisted.copyTextToClipboard.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishCopy = resolve;
      }),
    );
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <PowerSnackbarProvider>
          <TestHarness apiRef={apiRef} />
        </PowerSnackbarProvider>,
      );
    });

    await act(async () => {
      apiRef.current?.handleMessageCopy('Copied message value', feedbackId);
      await flushMicrotasks();
    });
    expect(document.body.querySelector('[role="status"]')).toBeNull();

    await act(async () => {
      finishCopy();
      await flushMicrotasks();
    });

    expect(document.body.querySelector('[role="status"]')?.textContent).toContain(message);
  });

  it('#3646 removes AI origin without clearing another user importance', async () => {
    hoisted.importantRemove.mockResolvedValueOnce(true);
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [[1, buildMessage({ important: true, aiImportant: true })]],
            }),
          ]}
        />,
      );
    });

    await act(async () => {
      await apiRef.current!.handleMessageImportant('mf-0', 1, true);
    });

    expect(hoisted.importantRemove).toHaveBeenCalledWith({ messageId: 1 });
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].important).toBe(true);
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].aiImportant).toBe(false);
  });

  it('#3610 opens the shared notification dialog for a new Duty importance mark', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [[1, buildMessage({ important: false, groupMasterKey: 'group-a' })]],
            }),
          ]}
        />,
      );
    });

    await act(async () => {
      await apiRef.current!.handleMessageImportant('mf-0', 1, false);
    });

    expect(hoisted.requestImportantMessage).toHaveBeenCalledWith({
      messageId: 1,
      groupMasterKey: 'group-a',
    });
    expect(hoisted.importantAdd).not.toHaveBeenCalled();
  });

  it('uses the last message id cursor when loading newer mail from the arrow button', async () => {
    hoisted.requestValidatedInboxCount.mockResolvedValueOnce({
      feedId: 'mf-0',
      quantity: 3,
      cursorId: 10,
      hasItems: true,
    });
    const columnRefsRef: MutableRefObject<
      Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
    > = {
      current: {
        'mf-0': { scrollToEnd: vi.fn() },
      },
    };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(hoisted.requestValidatedInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.requestValidatedInboxCount).toHaveBeenCalledWith('mf-0');
    expect(hoisted.fetchInboxCount).not.toHaveBeenCalled();
    expect(hoisted.registerExplicitLanding).toHaveBeenCalledTimes(1);
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({ scrollToEndAfterLoad: true }),
    );
    expect(hoisted.catchUpFeedUnreadToTail).not.toHaveBeenCalled();
  });

  it('does not clear unread state when arrow newer load fails', async () => {
    hoisted.requestValidatedInboxCount.mockResolvedValueOnce({
      feedId: 'mf-0',
      quantity: 3,
      cursorId: 10,
      hasItems: true,
    });
    hoisted.loadFeedNewerMessages.mockResolvedValueOnce({ ok: false, addedCount: 0 });
    const columnRefsRef: MutableRefObject<
      Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
    > = {
      current: {
        'mf-0': { scrollToEnd: vi.fn() },
      },
    };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(hoisted.catchUpFeedUnreadToTail).not.toHaveBeenCalled();
    expect(hoisted.showArrowResult).toHaveBeenCalledWith(
      'mf-0',
      'Не вдалося перевірити нові повідомлення',
    );
  });

  // https://github.com/echoua/echo/issues/3546
  it('updates event metadata in every loaded feed without changing creation order or unread state', async () => {
    const original = buildMessage({ text: 'before', timestamp: 20, createdAt: 40 });
    const updated = buildMessage({ text: 'after', timestamp: 30, createdAt: 40 });
    const firstFeed = buildFeed({
      id: 'mf-1',
      items: [
        [8, buildMessage({ timestamp: 20, createdAt: 20 })],
        [42, original],
        [3, buildMessage({ timestamp: 20, createdAt: 20 })],
      ],
    });
    const secondFeed = buildFeed({ id: 'mf-2', items: [[42, original]] });
    const untouchedFeed = buildFeed({ id: 'mf-3', items: [[9, buildMessage({ timestamp: 5 })]] });
    const untouchedItems = untouchedFeed.items;
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };

    await act(async () => {
      root.render(
        <TestHarness apiRef={apiRef} initialFeeds={[firstFeed, secondFeed, untouchedFeed]} />,
      );
    });

    await act(async () => {
      apiRef.current!.handleEditedMessage(42, updated);
    });

    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([3, 8, 42]);
    expect(apiRef.current!.messageFeeds[1].items.map(([id]) => id)).toEqual([42]);
    expect(apiRef.current!.messageFeeds[2].items).toBe(untouchedItems);
    expect(apiRef.current!.messageFeeds.map((feed) => feed.unreadCount)).toEqual([
      70000, 70000, 70000,
    ]);

    await act(async () => {
      apiRef.current!.handleEditedMessage(
        42,
        buildMessage({ text: 'earlier', timestamp: 10, createdAt: 40 }),
      );
    });

    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([3, 8, 42]);
  });

  it('waits for a confirmed landing while arrow count validation is pending', async () => {
    const count = deferred<{
      feedId: string;
      quantity: number;
      cursorId: number | null;
      hasItems: boolean;
    }>();
    hoisted.requestValidatedInboxCount.mockImplementationOnce(() => count.promise);
    const scrollToEnd = vi.fn();
    const columnRefsRef = { current: { 'mf-0': { scrollToEnd } } };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
            }),
          ]}
        />,
      );
      await flushMicrotasks();
    });

    const click = apiRef.current!.handleArrowClick('mf-0');
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.beginExplicitNavigation).toHaveBeenCalledWith('mf-0');
    expect(hoisted.loadFeedNewerMessages).not.toHaveBeenCalled();

    await act(async () => {
      count.resolve({ feedId: 'mf-0', quantity: 1, cursorId: 10, hasItems: true });
      await click;
    });
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({ scrollToEndAfterLoad: true, followGeneration: 17 }),
    );
    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('registers a confirmed landing for a valid zero-count arrow result', async () => {
    hoisted.requestValidatedInboxCount.mockResolvedValueOnce({
      feedId: 'mf-0',
      quantity: 0,
      cursorId: 10,
      hasItems: true,
    });
    const columnRefsRef: MutableRefObject<
      Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
    > = {
      current: {
        'mf-0': { scrollToEnd: vi.fn() },
      },
    };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(columnRefsRef.current['mf-0']?.scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.registerExplicitLanding).toHaveBeenCalledTimes(1);
    expect(hoisted.showArrowResult).not.toHaveBeenCalled();
    expect(hoisted.catchUpFeedUnreadToTail).not.toHaveBeenCalled();
    expect(hoisted.loadFeedNewerMessages).not.toHaveBeenCalled();
  });

  it('#3496 loads an evicted newer tail directly even when unread count is zero', async () => {
    hoisted.loadFeedNewerMessages.mockResolvedValueOnce({
      ok: true,
      addedCount: 40,
      target: { id: 80, timestamp: 180 },
    });
    const scrollToEnd = vi.fn();
    const columnRefsRef = { current: { 'mf-0': { scrollToEnd } } };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[40, minimalInboxMessage({ createdAtOrder: 140 })]],
              evictedNewerTailId: 80,
              readIds: new Set([40]),
              unreadCount: 0,
            }),
          ]}
        />,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
      await vi.advanceTimersByTimeAsync(20);
    });

    expect(hoisted.requestValidatedInboxCount).toHaveBeenCalledWith('mf-0');
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({
        nolimit: true,
        scrollToEndAfterLoad: true,
        explicitNavigation: true,
      }),
    );
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });

  it('shows a busy result when the shared count request resolves stale for the arrow button', async () => {
    hoisted.requestValidatedInboxCount.mockResolvedValueOnce(null);

    const columnRefsRef: MutableRefObject<
      Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
    > = {
      current: {
        'mf-0': { scrollToEnd: vi.fn() },
      },
    };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
              evictedNewerTailId: 20,
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(hoisted.requestValidatedInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxCount).not.toHaveBeenCalled();
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.showArrowResult).toHaveBeenCalledWith(
      'mf-0',
      'Оновлення триває, спробуйте ще раз',
    );
    expect(hoisted.loadFeedNewerMessages).not.toHaveBeenCalled();
  });

  it('shows the existing failure chip when the shared count request fails for the arrow button', async () => {
    hoisted.requestValidatedInboxCount.mockRejectedValueOnce(new Error('count failed'));

    const columnRefsRef: MutableRefObject<
      Record<string, { scrollToEnd: (behavior?: ScrollBehavior) => void } | null>
    > = {
      current: {
        'mf-0': { scrollToEnd: vi.fn() },
      },
    };
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          columnRefsRef={columnRefsRef}
          initialFeeds={[
            buildFeed({
              items: [[10, minimalInboxMessage({ createdAt: null, createdAtOrder: null })]],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(hoisted.requestValidatedInboxCount).toHaveBeenCalledTimes(1);
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.showArrowResult).toHaveBeenCalledWith(
      'mf-0',
      'Не вдалося перевірити нові повідомлення',
    );
    expect(hoisted.loadFeedNewerMessages).not.toHaveBeenCalled();
  });

  it('keeps unreadCount unchanged when the trimmed window is already read at bottom', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                items: Array.from({ length: 40 }, (_, index) => [
                  index + 1,
                  minimalInboxMessage({ createdAtOrder: 100 + index }),
                ]),
                readIds: new Set<number>(Array.from({ length: 40 }, (_, index) => index + 1)),
                unreadCount: 5,
              }
            : feed,
        ),
      );
    });
    const feedBefore = apiRef.current!.messageFeeds[0];

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(40, { atBottom: true });
    });
    expect(apiRef.current!.messageFeeds[0]).toBe(feedBefore);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);
    expect(apiRef.current!.messageFeeds[0].readIds.has(40)).toBe(true);
  });

  it('decrements unreadCount by newly visible ids from the loaded unread tail', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                items: Array.from({ length: 65 }, (_, index) => [
                  index + 1,
                  minimalInboxMessage({ createdAtOrder: 100 + index }),
                ]),
                readIds: new Set<number>(Array.from({ length: 60 }, (_, index) => index + 1)),
                unreadCount: 7,
              }
            : feed,
        ),
      );
    });

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(65, { atBottom: true });
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(2);
    expect(
      [61, 62, 63, 64, 65].every((id) => apiRef.current!.messageFeeds[0].readIds.has(id)),
    ).toBe(true);
  });

  it('clears unreadCount when the loaded unread tail accounts for all unread messages', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: Array.from({ length: 65 }, (_, index) => [
                index + 1,
                minimalInboxMessage({ createdAtOrder: 100 + index }),
              ]),
              readIds: new Set<number>(Array.from({ length: 60 }, (_, index) => index + 1)),
              unreadCount: 5,
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(65, { atBottom: true });
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
    expect(
      [61, 62, 63, 64, 65].every((id) => apiRef.current!.messageFeeds[0].readIds.has(id)),
    ).toBe(true);
  });

  it('does not mutate state on repeated bottom visibility reports for already read ids', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: Array.from({ length: 65 }, (_, index) => [
                index + 1,
                minimalInboxMessage({ createdAtOrder: 100 + index }),
              ]),
              readIds: new Set<number>(Array.from({ length: 65 }, (_, index) => index + 1)),
              unreadCount: 5,
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    const feedBefore = apiRef.current!.messageFeeds[0];
    const stateBefore = apiRef.current!.messageFeeds;

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(65, { atBottom: true });
    });

    expect(apiRef.current!.messageFeeds).toBe(stateBefore);
    expect(apiRef.current!.messageFeeds[0]).toBe(feedBefore);
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);
  });

  it('clears scrolled-past windowed unread when reporting atBottom', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: Array.from({ length: 40 }, (_, index) => [
                index + 21,
                minimalInboxMessage({ createdAtOrder: (index + 21) * 100 }),
              ]),
              readIds: new Set<number>(Array.from({ length: 40 }, (_, index) => index + 21)),
              windowedUnreadItems: new Map(
                Array.from({ length: 20 }, (_, index) => [index + 1, (index + 1) * 100]),
              ),
              unreadCount: 23,
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(60, { atBottom: true });
    });

    const feed = apiRef.current!.messageFeeds[0];
    expect(feed.windowedUnreadItems.size).toBe(0);
    expect(feed.unreadCount).toBe(3);
  });

  it('acknowledges an overlapping bottom unread identity only once', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [[1, minimalInboxMessage({ createdAtOrder: 100 })]],
              readIds: new Set<number>(),
              windowedUnreadItems: new Map([
                [1, 100],
                [2, 200],
              ]),
              unresolvedUnreadIds: new Set([99]),
              unreadCount: 3,
            }),
          ]}
        />,
      );
      await flushMicrotasks();
    });

    await act(async () => apiRef.current!.handleVisibleMessageIds('mf-0')(1, { atBottom: true }));
    let feed = apiRef.current!.messageFeeds[0];
    expect(feed.readIds).toContain(1);
    expect(feed.windowedUnreadItems).toEqual(new Map([[2, 200]]));
    expect(feed.unresolvedUnreadIds).toEqual(new Set([99]));
    expect(feed.unreadCount).toBe(2);

    await act(async () => apiRef.current!.handleVisibleMessageIds('mf-0')(1, { atBottom: true }));
    feed = apiRef.current!.messageFeeds[0];
    expect(feed.windowedUnreadItems).toEqual(new Map([[2, 200]]));
    expect(feed.unresolvedUnreadIds).toEqual(new Set([99]));
    expect(feed.unreadCount).toBe(2);
  });

  it('decrements unreadCount only when deleting an unread message', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [
                [1, minimalInboxMessage({ createdAtOrder: 100 })],
                [2, minimalInboxMessage({ createdAtOrder: 101 })],
              ],
              unreadCount: 5,
              readIds: new Set<number>([2]),
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setDeleteConfirmId(1);
      apiRef.current!.setDeleteConfirmFeedId('mf-0');
    });
    await act(async () => {
      await apiRef.current!.handleDeleteConfirm();
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(4);

    await act(async () => {
      apiRef.current!.setMessageFeeds((prev) =>
        prev.map((feed) =>
          feed.id === 'mf-0'
            ? {
                ...feed,
                items: [[1, minimalInboxMessage({ createdAtOrder: 100 })]],
                unreadCount: 5,
                readIds: new Set<number>([1]),
              }
            : feed,
        ),
      );
    });

    await act(async () => {
      apiRef.current!.setDeleteConfirmId(1);
      apiRef.current!.setDeleteConfirmFeedId('mf-0');
    });
    await act(async () => {
      await apiRef.current!.handleDeleteConfirm();
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(5);
  });

  for (const eventFirst of [true, false]) {
    for (const wasRead of [true, false]) {
      it(`#3894 preserves remaining unread after deleting a ${wasRead ? 'read' : 'unread'} message with ${eventFirst ? 'event' : 'response'} first`, async () => {
        const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
        const request = deferred<void>();
        hoisted.deleteMessage.mockReturnValueOnce(request.promise);
        const unrelatedFeed = buildFeed({ id: 'unrelated', items: [[9, buildMessage()]] });
        await act(async () => {
          root.render(
            <TestHarness
              apiRef={apiRef}
              initialFeeds={[
                buildFeed({
                  items: [
                    [1, buildMessage()],
                    [2, buildMessage()],
                  ],
                  readIds: new Set(wasRead ? [1, 2] : [2]),
                  unreadCount: wasRead ? 1 : 2,
                  evictedNewerTailId: 3,
                }),
                buildFeed({
                  id: 'other-loaded',
                  items: [[1, buildMessage()]],
                  pendingNewerItems: [[1, buildMessage()]],
                  readIds: new Set(wasRead ? [] : [1]),
                  unreadCount: wasRead ? 2 : 1,
                }),
                buildFeed({
                  id: 'pending-only',
                  items: [[2, buildMessage()]],
                  pendingNewerItems: [[1, buildMessage()]],
                  unreadCount: 2,
                }),
                buildFeed({
                  id: 'windowed-only',
                  items: [],
                  windowedUnreadItems: new Map([
                    [1, 100],
                    [9, 900],
                  ]),
                  unreadCount: 3,
                  unresolvedUnreadCount: 1,
                }),
                buildFeed({
                  id: 'unresolved-only',
                  items: [],
                  unresolvedUnreadIds: new Set([1, 9]),
                  unreadCount: 3,
                  unresolvedUnreadCount: 1,
                }),
                buildFeed({
                  id: 'overlapping',
                  items: [[1, buildMessage()]],
                  pendingNewerItems: [[1, buildMessage()]],
                  windowedUnreadItems: new Map([[1, 100]]),
                  unresolvedUnreadIds: new Set([1]),
                  readIds: new Set(wasRead ? [1] : []),
                  unreadCount: wasRead ? 1 : 2,
                }),
                unrelatedFeed,
              ]}
            />,
          );
        });
        await act(async () => {
          apiRef.current!.setDeleteConfirmId(1);
          apiRef.current!.setDeleteConfirmFeedId('mf-0');
        });
        let confirmation!: Promise<void>;
        await act(async () => {
          confirmation = apiRef.current!.handleDeleteConfirm();
        });
        expect(apiRef.current!.messageFeeds[1].items.map(([id]) => id)).toEqual([1]);
        const receiveEvent = (feedId = 'mf-0') =>
          act(async () => {
            apiRef.current!.setMessageFeeds((feeds) =>
              mergeUpdatedDutyFeedMessages(feeds, feedId, [1], []),
            );
          });

        if (eventFirst) {
          await receiveEvent();
          await receiveEvent('windowed-only');
          expect(apiRef.current!.messageFeeds[1].items.map(([id]) => id)).toEqual([1]);
        }
        await act(async () => {
          request.resolve();
          await confirmation;
        });
        const otherLoaded = apiRef.current!.messageFeeds[1];
        expect(otherLoaded.items).toEqual([]);
        expect(otherLoaded.pendingNewerItems).toEqual([]);
        expect(otherLoaded.readIds).toEqual(new Set());
        expect(otherLoaded.unreadCount).toBe(1);
        const pendingOnly = apiRef.current!.messageFeeds[2];
        expect(pendingOnly.items.map(([id]) => id)).toEqual([2]);
        expect(pendingOnly.pendingNewerItems).toEqual([]);
        expect(pendingOnly.unreadCount).toBe(1);
        const windowedOnly = apiRef.current!.messageFeeds[3];
        expect(windowedOnly.windowedUnreadItems).toEqual(new Map([[9, 900]]));
        expect(windowedOnly.unreadCount).toBe(2);
        expect(windowedOnly.unresolvedUnreadCount).toBe(1);
        expect(feedIndicatorUnreadCount(windowedOnly)).toBe(2);
        const unresolvedOnly = apiRef.current!.messageFeeds[4];
        expect(unresolvedOnly.unresolvedUnreadIds).toEqual(new Set([9]));
        expect(unresolvedOnly.unreadCount).toBe(2);
        expect(unresolvedOnly.unresolvedUnreadCount).toBe(1);
        expect(feedIndicatorUnreadCount(unresolvedOnly)).toBe(2);
        const overlapping = apiRef.current!.messageFeeds[5];
        expect(overlapping.items).toEqual([]);
        expect(overlapping.pendingNewerItems).toEqual([]);
        expect(overlapping.windowedUnreadItems).toEqual(new Map());
        expect(overlapping.unresolvedUnreadIds).toEqual(new Set());
        expect(overlapping.unreadCount).toBe(1);
        expect(apiRef.current!.messageFeeds[6]).toBe(unrelatedFeed);
        const feedsAfterResponse = apiRef.current!.messageFeeds;
        for (const { id } of feedsAfterResponse) await receiveEvent(id);
        expect(apiRef.current!.messageFeeds).toBe(feedsAfterResponse);

        const feed = apiRef.current!.messageFeeds[0];
        expect(feed.items.map(([id]) => id)).toEqual([2]);
        expect(feed.readIds).toEqual(new Set([2]));
        expect(feed.unreadCount).toBe(1);
        expect(feedIndicatorUnreadCount(feed)).toBe(1);
      });
    }
  }

  it('#3894 preserves all feeds when deletion fails', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    const initialFeeds = [
      buildFeed({ items: [[1, buildMessage()]] }),
      buildFeed({ id: 'pending-only', items: [], pendingNewerItems: [[1, buildMessage()]] }),
      buildFeed({
        id: 'off-window',
        items: [],
        windowedUnreadItems: new Map([[1, 100]]),
        unresolvedUnreadIds: new Set([1]),
      }),
    ];
    hoisted.deleteMessage.mockRejectedValueOnce(new Error('Deletion failed'));
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} initialFeeds={initialFeeds} />);
    });
    await act(async () => {
      apiRef.current!.setDeleteConfirmId(1);
      apiRef.current!.setDeleteConfirmFeedId('mf-0');
    });
    await act(async () => {
      await apiRef.current!.handleDeleteConfirm();
    });
    expect(apiRef.current!.messageFeeds).toBe(initialFeeds);
  });

  for (const buffered of [false, true]) {
    it(`#3894 reconciles a deleted ${buffered ? 'buffered' : 'loaded'} historical tail without losing another feed's history`, () => {
      const older: [number, InboxMessage] = [20, buildMessage({ createdAtOrder: 200 })];
      const boundary: [number, InboxMessage] = [10, buildMessage({ createdAtOrder: 300 })];
      const historicalReadThrough = { id: 10, timestamp: 300 };
      const offWindow = buildFeed({
        id: 'historical-window',
        items: [[1, buildMessage({ createdAtOrder: 100 })]],
        historicalReadThrough,
        evictedNewerTailId: 10,
      });
      const feeds = mergeUpdatedDutyFeedMessages(
        [
          buildFeed({
            items: buffered ? [older] : [older, boundary],
            pendingNewerItems: buffered ? [boundary] : [],
            historicalReadThrough,
            evictedNewerTailId: 10,
          }),
          offWindow,
        ],
        null,
        [10],
        [],
      );
      expect(feeds[0].historicalReadThrough).toEqual({ id: 20, timestamp: 200 });
      expect(feeds[0].evictedNewerTailId).toBeNull();
      expect(feedHasUnloadedHistoricalNewer(feeds[0])).toBe(false);
      expect(feedHasUnrenderedHistoricalNewer(feeds[0])).toBe(false);
      expect(feedHasUnloadedEvictedNewerTail(feeds[0])).toBe(false);
      expect(feeds[1]).toBe(offWindow);
      expect(feedHasUnloadedHistoricalNewer(feeds[1])).toBe(true);
      expect(feedHasUnloadedEvictedNewerTail(feeds[1])).toBe(true);
      expect(
        historicalReadMessageIds(feeds[1], [[5, buildMessage({ createdAtOrder: 250 })]]),
      ).toEqual([5]);
    });
  }

  it('#3894 clears historical markers when the only loaded message is deleted', () => {
    const feeds = mergeUpdatedDutyFeedMessages(
      [
        buildFeed({
          items: [[1, buildMessage({ createdAtOrder: 100 })]],
          historicalReadThrough: { id: 1, timestamp: 100 },
          evictedNewerTailId: 1,
        }),
      ],
      null,
      [1],
      [],
    );
    expect(feeds[0].historicalReadThrough).toBeNull();
    expect(feeds[0].evictedNewerTailId).toBeNull();
    expect(feedHasUnloadedHistoricalNewer(feeds[0])).toBe(false);
    expect(feedHasUnloadedEvictedNewerTail(feeds[0])).toBe(false);
  });

  it('#3894 keeps post-link arrivals unread after deleting the historical boundary', () => {
    const live: [number, InboxMessage] = [3, buildMessage({ createdAtOrder: 300 })];
    const feeds = mergeUpdatedDutyFeedMessages(
      [
        buildFeed({
          items: [
            [1, buildMessage({ createdAtOrder: 100 })],
            [2, buildMessage({ createdAtOrder: 200 })],
            live,
          ],
          historicalReadThrough: { id: 2, timestamp: 200 },
          evictedNewerTailId: 2,
          readIds: new Set([1, 2]),
          unreadCount: 1,
        }),
      ],
      null,
      [2],
      [],
    );
    expect(feeds[0].historicalReadThrough).toEqual({ id: 1, timestamp: 100 });
    expect(historicalReadMessageIds(feeds[0], [live])).toEqual([]);
    expect(feeds[0].readIds).toEqual(new Set([1]));
    expect(feeds[0].unreadCount).toBe(1);
  });

  it('#3894 preserves off-window unread identities when messages are updated, not deleted', () => {
    const feeds = [
      buildFeed({
        items: [],
        windowedUnreadItems: new Map([[1, 100]]),
        unresolvedUnreadIds: new Set([1]),
        unreadCount: 1,
      }),
    ];
    expect(mergeUpdatedDutyFeedMessages(feeds, 'mf-0', [1], [[1, buildMessage()]])).toBe(feeds);
  });

  it('keeps saved-filter updates scoped to the feed that selected them', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    const firstFeed = buildFeed({
      id: 'mf-0',
      filter: { ...emptyFilter(), groupsSelected: ['group-a'] },
    });
    const secondFeed = buildFeed({
      id: 'mf-1',
      filter: { ...emptyFilter(), groupsSelected: ['group-b'] },
    });
    hoisted.savedFilterUpsert.mockResolvedValue([
      { id: 1, name: 'Filter A', req: firstFeed.filter },
    ]);

    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[firstFeed, secondFeed]}
          initialSavedFilters={[{ id: 1, name: 'Filter A', req: firstFeed.filter }]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-0': 1 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({
        ...prev,
        'mf-0': 'Filter A',
        'mf-1': '',
      }));
    });

    await act(async () => {
      await apiRef.current!.handleUpdateSelectedSavedFilter('mf-1');
    });
    expect(hoisted.savedFilterUpsert).not.toHaveBeenCalled();

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-1': 1 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({ ...prev, 'mf-1': 'Filter A' }));
    });

    await act(async () => {
      await apiRef.current!.handleUpdateSelectedSavedFilter('mf-1');
    });

    expect(hoisted.savedFilterUpsert).toHaveBeenCalledTimes(1);
    expect(hoisted.savedFilterUpsert).toHaveBeenCalledWith({
      name: 'Filter A',
      req: secondFeed.filter,
    });
  });

  it('updates draft names for every feed that shares a renamed saved filter', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    const firstFeed = buildFeed({
      id: 'mf-0',
      filter: { ...emptyFilter(), groupsSelected: ['group-a'] },
    });
    const secondFeed = buildFeed({
      id: 'mf-1',
      filter: { ...emptyFilter(), groupsSelected: ['group-b'] },
    });
    hoisted.savedFilterRename.mockResolvedValue(undefined);
    hoisted.savedFilterUpsert.mockResolvedValue([
      { id: 1, name: 'Renamed filter', req: firstFeed.filter },
    ]);

    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[firstFeed, secondFeed]}
          initialSavedFilters={[{ id: 1, name: 'Filter A', req: firstFeed.filter }]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-0': 1, 'mf-1': 1 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({
        ...prev,
        'mf-0': 'Filter A',
        'mf-1': 'Filter A',
      }));
    });

    await act(async () => {
      const result = await apiRef.current!.handleRenameSelectedSavedFilter(
        'mf-0',
        'Renamed filter',
      );
      expect(result).toBe(true);
    });

    expect(apiRef.current!.saveFilterNameByFeedId['mf-0']).toBe('Renamed filter');
    expect(apiRef.current!.saveFilterNameByFeedId['mf-1']).toBe('Renamed filter');
  });

  it('does not overwrite a feed that changed selection while rename was in flight', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    const firstFeed = buildFeed({
      id: 'mf-0',
      filter: { ...emptyFilter(), groupsSelected: ['group-a'] },
    });
    const secondFeed = buildFeed({
      id: 'mf-1',
      filter: { ...emptyFilter(), groupsSelected: ['group-b'] },
    });
    const renameDeferred = deferred<void>();
    hoisted.savedFilterRename.mockReturnValue(renameDeferred.promise);

    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[firstFeed, secondFeed]}
          initialSavedFilters={[
            { id: 1, name: 'Filter A', req: firstFeed.filter },
            { id: 2, name: 'Filter B', req: secondFeed.filter },
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-0': 1, 'mf-1': 1 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({
        ...prev,
        'mf-0': 'Filter A',
        'mf-1': 'Filter A',
      }));
    });

    await act(async () => {
      void apiRef.current!.handleRenameSelectedSavedFilter('mf-0', 'Renamed filter');
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-1': 2 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({ ...prev, 'mf-1': 'Filter B' }));
    });

    await act(async () => {
      renameDeferred.resolve();
      await flushMicrotasks();
    });

    expect(apiRef.current!.saveFilterNameByFeedId['mf-0']).toBe('Renamed filter');
    expect(apiRef.current!.saveFilterNameByFeedId['mf-1']).toBe('Filter B');
  });

  it('does not clear a feed that changed selection while delete was in flight', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    const firstFeed = buildFeed({
      id: 'mf-0',
      filter: { ...emptyFilter(), groupsSelected: ['group-a'] },
    });
    const secondFeed = buildFeed({
      id: 'mf-1',
      filter: { ...emptyFilter(), groupsSelected: ['group-b'] },
    });
    const deleteDeferred = deferred<void>();
    hoisted.savedFilterDelete.mockReturnValue(deleteDeferred.promise);

    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[firstFeed, secondFeed]}
          initialSavedFilters={[
            { id: 1, name: 'Filter A', req: firstFeed.filter },
            { id: 2, name: 'Filter B', req: secondFeed.filter },
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-0': 1, 'mf-1': 1 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({
        ...prev,
        'mf-0': 'Filter A',
        'mf-1': 'Filter A',
      }));
    });

    await act(async () => {
      void apiRef.current!.handleDeleteSelectedSavedFilter('mf-0');
    });

    await act(async () => {
      apiRef.current!.setSelectedSavedIdByFeedId((prev) => ({ ...prev, 'mf-1': 2 }));
      apiRef.current!.setSaveFilterNameByFeedId((prev) => ({ ...prev, 'mf-1': 'Filter B' }));
    });

    await act(async () => {
      deleteDeferred.resolve();
      await flushMicrotasks();
    });

    expect(apiRef.current!.saveFilterNameByFeedId['mf-0']).toBe('');
    expect(apiRef.current!.saveFilterNameByFeedId['mf-1']).toBe('Filter B');
  });

  it('keeps bot rows when toggling the human tag and clears only bot rows on model error', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };

    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          authUserName="tester"
          currentUserOrganismId={7}
          initialFeeds={[
            buildFeed({
              items: [
                [
                  1,
                  buildMessage({
                    inboxTags: [buildTag(3, { model: 'bot', confidence: 0.92 })],
                  }),
                ],
              ],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleToggleTag('mf-0', 1, 3);
    });

    expect(hoisted.inboxMessageTagsAdd).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.botTagAction).toBeNull();
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, login: 'tester', model: null, organismId: 7 }),
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].tags).toEqual([3, 4]);

    await act(async () => {
      await apiRef.current!.handleToggleTag('mf-0', 1, 3);
    });

    expect(hoisted.inboxMessageTagsRm).toHaveBeenCalledWith({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.botTagAction).toEqual({ messageId: 1, tagId: 3 });
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].inboxTags).toEqual([
      expect.objectContaining({ tagId: 3, model: 'bot' }),
    ]);
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].tags).toEqual([3, 4]);

    await act(async () => {
      await apiRef.current!.onMarkBotTagWrong(1, 3);
    });

    expect(hoisted.inboxMessageTagsModelError).toHaveBeenCalledWith({
      messageId: 1,
      tagId: 3,
    });
    expect(apiRef.current!.botTagAction).toBeNull();
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].inboxTags).toEqual([]);
    expect(apiRef.current!.messageFeeds[0].items[0]?.[1].tags).toEqual([4]);
  });

  it('removes a blacklisted source from matching messages in every loaded feed', async () => {
    hoisted.addPalitraHighlightBlacklistEntry.mockResolvedValueOnce(undefined);
    const sharedPoint = { etalon: 'Альфа', text: 'Альфа', palitraIds: [7, 12] };
    const first = buildMessage({ pointTokens: [sharedPoint] });
    const second = buildMessage({ pointTokens: [sharedPoint] });
    const unrelated = buildMessage({ pointTokens: [{ ...sharedPoint, palitraIds: [12] }] });
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({ id: 'mf-0', items: [[1, first]] }),
            buildFeed({
              id: 'mf-1',
              items: [
                [2, second],
                [3, unrelated],
              ],
            }),
          ]}
        />,
      );
    });
    await act(async () => {
      await apiRef.current!.onAddPointHighlightBlacklist({
        messageId: 1,
        etalon: ' Альфа ',
        palitraId: 7,
      });
    });
    expect(apiRef.current!.messageFeeds[0].items[0][1].pointTokens).toEqual([
      { etalon: 'Альфа', text: 'Альфа', palitraIds: [12] },
    ]);
    expect(apiRef.current!.messageFeeds[1].items[0][1].pointTokens).toEqual([
      { etalon: 'Альфа', text: 'Альфа', palitraIds: [12] },
    ]);
    expect(apiRef.current!.messageFeeds[1].items[1][1]).toBe(unrelated);
  });

  it('updates importance in every matching feed without replacing unaffected references', async () => {
    const firstTarget = buildMessage({ important: false });
    const secondTarget = buildMessage({ important: false });
    const unchanged = buildMessage({ important: false });
    const unrelated = buildMessage({ important: false });
    const feeds = [
      buildFeed({
        id: 'mf-0',
        items: [
          [1, firstTarget],
          [2, unchanged],
        ],
      }),
      buildFeed({ id: 'mf-1', items: [[1, secondTarget]] }),
      buildFeed({ id: 'mf-2', items: [[3, unrelated]] }),
    ];
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} initialFeeds={feeds} />);
    });
    const stateBefore = apiRef.current!.messageFeeds;

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-important-message-updated', {
          detail: { messageId: 1, important: true },
        }),
      );
    });

    const stateAfter = apiRef.current!.messageFeeds;
    expect(stateAfter[0].items[0][1].important).toBe(true);
    expect(stateAfter[1].items[0][1].important).toBe(true);
    expect(stateAfter[0].items[1]).toBe(stateBefore[0].items[1]);
    expect(stateAfter[0].items[1][1]).toBe(unchanged);
    expect(stateAfter[2]).toBe(stateBefore[2]);
    expect(stateAfter[2].items).toBe(stateBefore[2].items);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-important-message-updated', {
          detail: { messageId: 1, important: true },
        }),
      );
    });
    expect(apiRef.current!.messageFeeds).toBe(stateAfter);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent('echo-important-message-updated', {
          detail: { messageId: 99, important: true },
        }),
      );
    });
    expect(apiRef.current!.messageFeeds).toBe(stateAfter);
  });
});
