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
} from '../../../../Bindings';
import { minimalInboxMessage } from './inbox-message-mocks';
import { buildInboxReq, emptyFilter, type MessageFeedState } from './utils';
import { useRerDutyMessageActions } from './useRerDutyMessageActions';

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
  loadFeedNewerMessages: vi.fn(() => Promise.resolve()),
  loadFeedInitialMessages: vi.fn(() => Promise.resolve()),
  showArrowResult: vi.fn(),
  setWatchModeByFeedId: vi.fn(),
  setLoadingNewerFeedIds: vi.fn(),
}));

vi.mock('../../services/api/inbox', () => ({
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

vi.mock('../../../copy-to-clipboard', () => ({
  copyTextToClipboard: hoisted.copyTextToClipboard,
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisCallsignInfos: vi.fn(() => Promise.resolve([])),
}));

vi.mock('../../services/api/user-settings', () => ({
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
    minimalInboxMessage({ timestamp: 100 + index }),
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
    showArrowResult: hoisted.showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId: hoisted.setWatchModeByFeedId,
    setLoadingNewerFeedIds: hoisted.setLoadingNewerFeedIds,
    requestValidatedInboxCount: hoisted.requestValidatedInboxCount,
    authUserName: props.authUserName ?? null,
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
    hoisted.deleteMessage.mockResolvedValue(undefined);
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
    hoisted.inboxMessageTagsModelError.mockResolvedValue(undefined);
    hoisted.requestValidatedInboxCount.mockResolvedValue({
      feedId: 'mf-0',
      quantity: 0,
      cursorId: 10,
      hasItems: true,
    });
    hoisted.loadFeedNewerMessages.mockResolvedValue(undefined);
    hoisted.loadFeedInitialMessages.mockResolvedValue(undefined);
    hoisted.showArrowResult.mockReset();
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
          initialFeeds={[buildFeed({ items: [[10, minimalInboxMessage({ timestamp: null })]] })]}
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
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).not.toHaveBeenCalled();
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledTimes(1);
    expect(hoisted.loadFeedNewerMessages).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({ scrollToEndAfterLoad: true }),
    );
  });

  it('scrolls to the existing bottom once for a valid zero-count arrow result', async () => {
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
          initialFeeds={[buildFeed({ items: [[10, minimalInboxMessage({ timestamp: null })]] })]}
        />,
      );
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(columnRefsRef.current['mf-0']?.scrollToEnd).toHaveBeenCalledTimes(1);
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).toHaveBeenCalledWith('auto');
    expect(hoisted.showArrowResult).toHaveBeenCalledWith('mf-0', 'Немає нових повідомлень');
    expect(hoisted.loadFeedNewerMessages).not.toHaveBeenCalled();
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
          initialFeeds={[buildFeed({ items: [[10, minimalInboxMessage({ timestamp: null })]] })]}
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
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).toHaveBeenCalledTimes(1);
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
          initialFeeds={[buildFeed({ items: [[10, minimalInboxMessage({ timestamp: null })]] })]}
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
    expect(columnRefsRef.current['mf-0']?.scrollToEnd).toHaveBeenCalledTimes(1);
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
                  minimalInboxMessage({ timestamp: 100 + index }),
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
                  minimalInboxMessage({ timestamp: 100 + index }),
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
                minimalInboxMessage({ timestamp: 100 + index }),
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
                minimalInboxMessage({ timestamp: 100 + index }),
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

  it('decrements unreadCount only when deleting an unread message', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [
                [1, minimalInboxMessage({ timestamp: 100 })],
                [2, minimalInboxMessage({ timestamp: 101 })],
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
                items: [[1, minimalInboxMessage({ timestamp: 100 })]],
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

  it('derives a friendly comment preview from the opened duty message', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(
        <TestHarness
          apiRef={apiRef}
          initialFeeds={[
            buildFeed({
              items: [
                [
                  7,
                  minimalInboxMessage({
                    groupMasterKey: 'group-1',
                    sender: 'sender-1',
                    text: 'hello',
                    freq: '100.000',
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
      apiRef.current!.setCommentMessageId(7);
      apiRef.current!.setCommentFeedId('mf-0');
    });

    expect(apiRef.current!.commentMessagePreview).toEqual({
      text: 'hello',
      freq: '100.000',
      groupMasterKey: 'group-1',
      groupName: 'Група 1',
      sender: 'sender-1',
      senderName: 'BBC SPORT',
    });
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
      expect.objectContaining({ tagId: 3, login: 'tester', model: null }),
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
});
