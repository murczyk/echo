/**
 * @vitest-environment happy-dom
 */
import { createRoot, type Root } from 'react-dom/client';
import { useState, act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { InboxMessage, InboxMessagesReq } from '../../../../Bindings';
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
  inboxMessageTagsRm: vi.fn(),
  savedFilterDelete: vi.fn(),
  savedFilterRename: vi.fn(),
  savedFilterUpsert: vi.fn(),
  copyTextToClipboard: vi.fn(),
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
  'filter' | 'expandedFreqsSelected' | 'expandedFreqsDenied' | 'highlightSignals' | 'reportTagsOnlyThisUnit'
>;

type HarnessApi = ReturnType<typeof useRerDutyMessageActions> & {
  messageFeeds: MessageFeedState[];
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
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
    firstItemIndex: 0,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    unreadCount: 70000,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
    ...overrides,
  };
}

function TestHarness(props: {
  apiRef: MutableRefObject<HarnessApi | null>;
  initialFeeds?: MessageFeedState[];
}) {
  const [messageFeeds, setMessageFeeds] = useState<MessageFeedState[]>(props.initialFeeds ?? [buildFeed()]);
  const actions = useRerDutyMessageActions({
    messageFeeds,
    setMessageFeeds,
    setError: vi.fn(),
    applyFilter: vi.fn(),
    loadFeedInitialMessages: vi.fn(() => Promise.resolve()),
    loadFeedNewerMessages: vi.fn(() => Promise.resolve()),
    buildReqForFeed,
    columnRefsRef: { current: {} },
    showArrowResult: vi.fn(),
    setWatchModeByFeedId: vi.fn(),
    setLoadingNewerFeedId: vi.fn(),
    authUserName: null,
    profiles: {},
    tagsMap: {},
    savedFilters: [],
    setSavedFilters: vi.fn(),
    selectedSavedId: null,
    setSelectedSavedId: vi.fn(),
    saveFilterName: '',
    setSaveFilterName: vi.fn(),
    dutyDisableAutoScroll: false,
  });
  props.apiRef.current = { ...actions, messageFeeds, setMessageFeeds };
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('useRerDutyMessageActions', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    hoisted.deleteMessage.mockResolvedValue(undefined);
    hoisted.fetchInboxCount.mockResolvedValue({ quantity: 0, firstElementTs: null });
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
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} initialFeeds={[buildFeed({ items: [[10, minimalInboxMessage({ timestamp: null })]] })]} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      await apiRef.current!.handleArrowClick('mf-0');
    });

    expect(hoisted.fetchInboxCount).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchInboxCount.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        sinceIdNoninclusive: 10,
        sinceDateInclusiveMs: null,
        nolimit: true,
      }),
    );
  });

  it('decrements unreadCount by newly visible ids and clears it at bottom', async () => {
    const apiRef: MutableRefObject<HarnessApi | null> = { current: null };
    await act(async () => {
      root.render(<TestHarness apiRef={apiRef} />);
    });
    await act(async () => {
      await flushMicrotasks();
    });

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(
        Array.from({ length: 20 }, (_, index) => index + 1),
        { atBottom: false },
      );
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(69980);

    await act(async () => {
      apiRef.current!.handleVisibleMessageIds('mf-0')(
        Array.from({ length: 20 }, (_, index) => index + 1),
        { atBottom: true },
      );
    });
    expect(apiRef.current!.messageFeeds[0].unreadCount).toBe(0);
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
            ? { ...feed, items: [[1, minimalInboxMessage({ timestamp: 100 })]], unreadCount: 5, readIds: new Set<number>([1]) }
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
});
