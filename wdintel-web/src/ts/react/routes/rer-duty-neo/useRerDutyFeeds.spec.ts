/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getPendingDutyCallsignLookups } from './useRerDutyFeeds';
import { useRerDutyFeeds } from './useRerDutyFeeds';

const hoisted = vi.hoisted(() => ({
  fetchAnalysisCallsignInfos: vi.fn(),
  fetchMessagesByIds: vi.fn(),
  fetchUserSettings: vi.fn(),
  USER_SETTINGS_UPDATED_EVENT: 'user-settings-updated',
  currentSystemSettings: vi.fn(),
  attachDutyNotificationAudioPrimingListeners: vi.fn(),
  loadFeedInitialMessages: vi.fn(),
  mergeResolvedCallsigns: vi.fn(),
  setFeedErrorMock: vi.fn(),
  applyFilterMock: vi.fn(),
  onInboxChangedMessageIds: vi.fn(),
  setMessageFeeds: null as null | React.Dispatch<
    React.SetStateAction<
      Array<{
        id: string;
        items: Array<[number, { textMarked?: Array<{ CNCallsignC?: { text?: string } }> }]>;
        filter: Record<string, unknown>;
      }>
    >
  >,
  feedLoadGenerations: {} as Record<string, number>,
  messageFeeds: [] as Array<{
    id: string;
    items: Array<[number, { textMarked?: Array<{ CNCallsignC?: { text?: string } }> }]>;
    filter: Record<string, unknown>;
  }>,
  initialCallsignInfoMap: {} as Record<string, { callsign: string; res: unknown[] }>,
  initialInboxCallsignInfoMap: {} as Record<string, { callsign: string; res: unknown[] }>,
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisCallsignInfos: hoisted.fetchAnalysisCallsignInfos,
}));

vi.mock('../../services/api/user-settings', () => ({
  fetchUserSettings: hoisted.fetchUserSettings,
  USER_SETTINGS_UPDATED_EVENT: hoisted.USER_SETTINGS_UPDATED_EVENT,
  saveUserSettings: vi.fn(),
}));

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: hoisted.currentSystemSettings,
}));

vi.mock('./notifications', () => ({
  attachDutyNotificationAudioPrimingListeners: hoisted.attachDutyNotificationAudioPrimingListeners,
}));

vi.mock('./useRerDutyFilterOptions', () => ({
  useRerDutyFilterOptions: () => ({
    freqs: [],
    setProfiles: vi.fn(),
    setGroupInfos: vi.fn(),
    profiles: {},
    tagsMap: {},
    tagsOrder: [],
    savedFilters: [],
    setSavedFilters: vi.fn(),
    selectedSavedIdByFeedId: {},
    setSelectedSavedIdByFeedId: vi.fn(),
    saveFilterNameByFeedId: {},
    setSaveFilterNameByFeedId: vi.fn(),
    pruneSavedFilterUiState: vi.fn(),
    reloadFreqsLoading: false,
    reloadLatestFrequencies: vi.fn(),
    groupsList: [],
    groupInfos: {},
    postsList: [],
    featureStrictNetworks: false,
  }),
}));

vi.mock('./useRerDutyMessageActions', () => ({
  useRerDutyMessageActions: () => ({
    handleSaveFilter: vi.fn(),
    handleApplySavedFilter: vi.fn(),
    handleUpdateSelectedSavedFilter: vi.fn(),
    handleRenameSelectedSavedFilter: vi.fn(),
    handleDeleteSelectedSavedFilter: vi.fn(),
    handleDeleteSavedFilter: vi.fn(),
    handleMessageBookmark: vi.fn(),
    handleMessageImportant: vi.fn(),
    handleMessageCopy: vi.fn(),
    handleDeleteConfirm: vi.fn(),
    setDeleteConfirmId: vi.fn(),
    setDeleteConfirmFeedId: vi.fn(),
    openCommentDialog: vi.fn(),
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
    senderOptions: [],
    tagIdsList: [],
    copiedFeedbackId: null,
  }),
}));

vi.mock('../shared/useInboxChangedMessageIds', () => ({
  useInboxChangedMessageIds: ({
    onMessageIds,
  }: {
    onMessageIds: (messageIds: number[]) => void | Promise<void>;
  }) => {
    hoisted.onInboxChangedMessageIds = onMessageIds;
  },
}));

vi.mock('../../services/api/inbox-messages', () => ({
  fetchMessagesByIds: hoisted.fetchMessagesByIds,
}));

vi.mock('./useRerDutyFeedState', () => ({
  useRerDutyFeedState: () => {
    const [messageFeeds, setMessageFeeds] = React.useState(hoisted.messageFeeds);
    const [callsignInfoMap, setCallsignInfoMap] = React.useState<
      Record<string, { callsign: string; res: unknown[] }>
    >(hoisted.initialCallsignInfoMap);
    const [inboxCallsignInfoMap, setInboxCallsignInfoMap] = React.useState<
      Record<string, { callsign: string; res: unknown[] }>
    >(hoisted.initialInboxCallsignInfoMap);
    hoisted.loadFeedInitialMessages.mockImplementation((feedId: string) => {
      setMessageFeeds((current) =>
        current.map((feed) =>
          feed.id === feedId
            ? {
                ...feed,
                items: [[2, { text: 'reloaded', unit: 'reloaded-unit' } as never]],
                readIds: new Set<number>(),
                unreadCount: 0,
                referenceTimeMs: 0,
                loading: false,
                loadingOlder: false,
                hasReachedStart: false,
              }
            : feed,
        ),
      );
      return Promise.resolve();
    });
    hoisted.setMessageFeeds = setMessageFeeds;

    return {
      messageFeeds,
      inboxCallsignInfoMap,
      callsignInfoMap,
      mergeResolvedCallsigns: (items: Array<{ callsign: string; res: unknown[] }>) => {
        hoisted.mergeResolvedCallsigns(items);
        setCallsignInfoMap((current) => {
          const next = { ...current };
          items.forEach((item) => {
            next[item.callsign.toLowerCase()] = item;
          });
          return next;
        });
        setInboxCallsignInfoMap((current) => current);
      },
      setError: hoisted.setFeedErrorMock,
      setWatchModeByFeedId: vi.fn(),
      setMessageFeeds: (next) => {
        setMessageFeeds(next);
      },
      nearBottomByFeedIdRef: { current: {} },
      atBottomByFeedIdRef: { current: {} },
      columnRefsRef: { current: {} },
      error: null,
      createMessageFeed: vi.fn(),
      removeMessageFeed: vi.fn(),
      loadFeedInitialMessages: hoisted.loadFeedInitialMessages,
      reloadFeeds: vi.fn(),
      reloadEditedFeeds: vi.fn(),
      loadFeedOlderMessages: vi.fn(),
      applyFilter: hoisted.applyFilterMock,
      toggleGroup: vi.fn(),
      selectAllGroups: vi.fn(),
      loadFeedNewerMessages: vi.fn(),
      getFeedLoadGeneration: (feedId: string) => hoisted.feedLoadGenerations[feedId] ?? 0,
      buildReqForFeed: vi.fn(
        (
          feed: {
            id: string;
            filter: Record<string, unknown>;
            highlightSignalsEnabled?: boolean;
            onlyMyUnitTagsEnabled?: boolean;
          },
          opts: { loadLatest?: boolean },
        ) => ({
          feedId: feed.id,
          filter: feed.filter,
          loadLatest: opts?.loadLatest ?? null,
          highlightSignals: feed.highlightSignalsEnabled ?? false,
          reportTagsOnlyThisUnit: feed.onlyMyUnitTagsEnabled ? true : null,
        }),
      ),
      showArrowResult: vi.fn(),
      setLoadingNewerFeedIds: vi.fn(),
      watchModeByFeedId: {},
      loadingNewerFeedIds: new Set(),
      arrowResultByFeedId: {},
      networkDisplayMap: {},
      networkMap: {},
      unitsMap: {},
    };
  },
}));

let latest: ReturnType<typeof useRerDutyFeeds> | null = null;

function TestHarness() {
  latest = useRerDutyFeeds(null);
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('getPendingDutyCallsignLookups', () => {
  it('skips callsigns that already resolved as not found', () => {
    const pending = getPendingDutyCallsignLookups({
      messageFeeds: [
        {
          items: [
            [
              1,
              {
                textMarked: [
                  { CNCallsignC: { text: 'БОРОДА' } },
                  { CNCallsignC: { text: 'ДЕМОН' } },
                ],
              },
            ],
          ],
        },
      ] as never,
      enrichedCallsigns: new Set<string>(),
      inboxCallsignInfoMap: { борода: { res: [] } },
      loadingCallsigns: new Set<string>(),
      emptyResultRetryAfterMs: new Map<string, number>([['борода', 10_000]]),
      nowMs: 9_000,
    });

    expect(pending).toEqual(['демон']);
  });

  it('skips callsigns that are already cached or currently loading', () => {
    const pending = getPendingDutyCallsignLookups({
      messageFeeds: [
        {
          items: [
            [
              1,
              {
                textMarked: [
                  { CNCallsignC: { text: 'БОРОДА' } },
                  { CNCallsignC: { text: 'ДЕМОН' } },
                  { CNCallsignC: { text: 'БАЙКАЛ' } },
                ],
              },
            ],
          ],
        },
      ] as never,
      enrichedCallsigns: new Set<string>(['демон']),
      inboxCallsignInfoMap: { демон: { res: [{}] } },
      loadingCallsigns: new Set<string>(['байкал']),
      emptyResultRetryAfterMs: new Map<string, number>(),
      nowMs: 9_000,
    });

    expect(pending).toEqual(['борода']);
  });

  it('retries empty cached callsigns again after the backoff expires', () => {
    const pending = getPendingDutyCallsignLookups({
      messageFeeds: [
        {
          items: [[1, { textMarked: [{ CNCallsignC: { text: 'БОРОДА' } }] }]],
        },
      ] as never,
      enrichedCallsigns: new Set<string>(),
      inboxCallsignInfoMap: { борода: { res: [] } },
      loadingCallsigns: new Set<string>(),
      emptyResultRetryAfterMs: new Map<string, number>([['борода', 10_000]]),
      nowMs: 10_001,
    });

    expect(pending).toEqual(['борода']);
  });
});

describe('useRerDutyFeeds', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    latest = null;
    hoisted.onInboxChangedMessageIds = vi.fn();
    hoisted.loadFeedInitialMessages.mockReset();
    hoisted.feedLoadGenerations = {};
    hoisted.initialCallsignInfoMap = {};
    hoisted.initialInboxCallsignInfoMap = {};
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [
          [
            1,
            {
              textMarked: [{ CNCallsignC: { text: 'БОРОДА' } }],
            },
          ],
        ],
        filter: {},
      },
    ];
    hoisted.fetchMessagesByIds.mockReset();
    hoisted.fetchAnalysisCallsignInfos.mockReset();
    hoisted.applyFilterMock.mockReset();
    hoisted.fetchUserSettings.mockResolvedValue({ disableAutoScroll: false });
    hoisted.currentSystemSettings.mockResolvedValue({
      rerDutyTestEnabled: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
    });
    hoisted.fetchAnalysisCallsignInfos
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [] }])
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [{ id: 1 }] }]);
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
    latest = null;
    vi.useRealTimers();
  });

  it('retries empty-result callsigns after the backoff expires even without unrelated rerenders', async () => {
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(1, ['борода']);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(2, ['борода']);
  });

  it('adds a frequency to the selected feed filter without duplicating it', async () => {
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [
          [
            1,
            {
              textMarked: [{ CNCallsignC: { text: 'БОРОДА' } }],
            },
          ],
        ],
        filter: {
          freqsSelected: ['153.6250'],
          freqsDenied: ['153.6250', '200.0000'],
        },
      },
    ];
    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(latest).not.toBeNull();
    expect(typeof latest?.addFrequencyToFilter).toBe('function');

    await act(async () => {
      latest!.addFrequencyToFilter('mf-0', '153.6250');
    });

    expect(hoisted.applyFilterMock).toHaveBeenCalledWith(
      'mf-0',
      expect.objectContaining({
        freqsSelected: ['153.6250'],
        freqsDenied: ['200.0000'],
      }),
    );
  });

  it('retries failed callsign lookups after the backoff expires even when inbox rows already exist', async () => {
    hoisted.initialCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.initialInboxCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.fetchAnalysisCallsignInfos
      .mockReset()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [{ id: 1 }] }]);

    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(1, ['борода']);
    expect(hoisted.setFeedErrorMock).toHaveBeenCalledWith(
      'Не вдалося завантажити довідку позивних',
    );

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(2, ['борода']);
  });

  it('still runs enrichment when inbox cache already contains a partial callsign row set', async () => {
    hoisted.initialCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.initialInboxCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.fetchAnalysisCallsignInfos
      .mockReset()
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [{ id: 2 }] }]);

    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(1, ['борода']);
  });

  it('retries empty enrichment results even when inbox rows already exist', async () => {
    hoisted.initialCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.initialInboxCallsignInfoMap = {
      борода: { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.fetchAnalysisCallsignInfos
      .mockReset()
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [] }])
      .mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [] }]);

    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(2, ['борода']);
  });
});

describe('useRerDutyFeeds inbox refreshes', () => {
  beforeEach(() => {
    hoisted.fetchMessagesByIds.mockClear();
  });

  it('skips fetching when no visible ids overlap', async () => {
    const localContainer = document.createElement('div');
    const localRoot = createRoot(localContainer);
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [[1, { textMarked: [], tags: [1], inboxTags: [] }]],
        filter: {},
      },
    ] as never;

    document.body.appendChild(localContainer);
    try {
      await act(async () => {
        localRoot.render(React.createElement(TestHarness));
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await act(async () => {
        await hoisted.onInboxChangedMessageIds([9]);
      });

      expect(hoisted.fetchMessagesByIds).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        localRoot.unmount();
      });
      localContainer.remove();
    }
  });

  it('refreshes visible message copies with feed request context', async () => {
    const localContainer = document.createElement('div');
    const localRoot = createRoot(localContainer);
    const currentMessage = {
      text: 'current',
      textMarked: [{ CNTextC: { text: 'marked' } }],
      keywordTokens: [{ text: 'keyword' }],
      pointTokens: [{ text: 'point', etalon: 'point-old' }],
      tags: [1],
      inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    } as never;
    const currentOtherMessage = {
      text: 'other',
      textMarked: [{ CNTextC: { text: 'other marked' } }],
      keywordTokens: [{ text: 'other keyword' }],
      pointTokens: [{ text: 'other point', etalon: 'other-point' }],
      tags: [1],
      inboxTags: [{ id: 1, tagId: 1, confidence: 1, login: null, model: null, organismId: null }],
    } as never;
    const updatedMessage = {
      text: 'updated',
      textMarked: [{ CNTextC: { text: 'new marked' } }],
      keywordTokens: [{ text: 'new keyword' }],
      pointTokens: [{ text: 'new point', etalon: 'point-new' }],
      tags: [2],
      inboxTags: [{ id: 2, tagId: 2, confidence: 1, login: null, model: null, organismId: null }],
    } as never;
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [
          [1, currentOtherMessage],
          [2, currentMessage],
        ],
        filter: {},
        highlightSignalsEnabled: true,
        onlyMyUnitTagsEnabled: true,
        unreadCount: 4,
        readIds: new Set<number>([1]),
      },
      {
        id: 'mf-1',
        items: [[2, currentMessage]],
        filter: {},
        unreadCount: 1,
        readIds: new Set<number>(),
      },
    ] as never;
    hoisted.fetchMessagesByIds.mockResolvedValue([[2, updatedMessage]]);

    document.body.appendChild(localContainer);
    try {
      await act(async () => {
        localRoot.render(React.createElement(TestHarness));
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await act(async () => {
        await hoisted.onInboxChangedMessageIds([2]);
      });

      expect(hoisted.fetchMessagesByIds).toHaveBeenCalledWith(
        [2],
        expect.objectContaining({
          feedId: 'mf-0',
          loadLatest: true,
          highlightSignals: true,
          reportTagsOnlyThisUnit: true,
        }),
      );
      expect(latest?.messageFeeds[0].items[1]?.[1].text).toBe('updated');
      expect(latest?.messageFeeds[0].items[1]?.[1].tags).toEqual([2]);
      expect(latest?.messageFeeds[0].items[1]?.[1].inboxTags).toEqual([
        { id: 2, tagId: 2, confidence: 1, login: null, model: null, organismId: null },
      ]);
      expect(latest?.messageFeeds[0].items[1]?.[1].keywordTokens).toBe(
        updatedMessage.keywordTokens,
      );
      expect(latest?.messageFeeds[0].items[1]?.[1].textMarked).toBe(updatedMessage.textMarked);
      expect(latest?.messageFeeds[0].items[1]?.[1].pointTokens).toBe(updatedMessage.pointTokens);
      expect(latest?.messageFeeds[1].items[0]?.[1].text).toBe('updated');
      expect(latest?.messageFeeds[1].items[0]?.[1].tags).toEqual([2]);
      expect(hoisted.loadFeedInitialMessages).not.toHaveBeenCalled();
      expect(latest?.messageFeeds[0].unreadCount).toBe(4);
      expect(latest?.messageFeeds[0].readIds).toBe(hoisted.messageFeeds[0].readIds);
    } finally {
      await act(async () => {
        localRoot.unmount();
      });
      localContainer.remove();
    }
  });

  it('skips a stale refresh response when the feed request signature changed', async () => {
    const localContainer = document.createElement('div');
    const localRoot = createRoot(localContainer);
    let resolveFetch!: (value: never) => void;
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [[2, { text: 'current', tags: [1], inboxTags: [] }]],
        filter: {
          highlightKeywordSetId: null,
        },
      },
    ] as never;
    hoisted.fetchMessagesByIds.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    document.body.appendChild(localContainer);
    try {
      await act(async () => {
        localRoot.render(React.createElement(TestHarness));
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const refreshPromise = act(async () => {
        await hoisted.onInboxChangedMessageIds([2]);
      });

      await act(async () => {
        hoisted.setMessageFeeds?.((current) =>
          current.map((feed) =>
            feed.id === 'mf-0'
              ? {
                  ...feed,
                  filter: { ...feed.filter, highlightKeywordSetId: 7 },
                }
              : feed,
          ),
        );
      });

      await act(async () => {
        resolveFetch([] as never);
        await flushMicrotasks();
      });
      await refreshPromise;

      expect(latest?.messageFeeds[0].filter).toMatchObject({ highlightKeywordSetId: 7 });
      expect(latest?.messageFeeds[0].items[0]?.[1].text).toBe('current');
    } finally {
      await act(async () => {
        localRoot.unmount();
      });
      localContainer.remove();
    }
  });

  it('skips a stale refresh response when the feed load generation changed', async () => {
    const localContainer = document.createElement('div');
    const localRoot = createRoot(localContainer);
    let resolveFetch!: (value: never) => void;
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [[2, { text: 'current', tags: [1], inboxTags: [] }]],
        filter: {},
      },
    ] as never;
    hoisted.feedLoadGenerations = { 'mf-0': 1 };
    hoisted.fetchMessagesByIds.mockImplementationOnce(
      () =>
        new Promise<never>((resolve) => {
          resolveFetch = resolve;
        }),
    );

    document.body.appendChild(localContainer);
    try {
      await act(async () => {
        localRoot.render(React.createElement(TestHarness));
      });
      await act(async () => {
        await flushMicrotasks();
      });

      const refreshPromise = act(async () => {
        await hoisted.onInboxChangedMessageIds([2]);
      });

      hoisted.feedLoadGenerations = { 'mf-0': 2 };

      await act(async () => {
        resolveFetch([[2, { text: 'stale', tags: [2], inboxTags: [] }]] as never);
        await flushMicrotasks();
      });
      await refreshPromise;

      expect(latest?.messageFeeds[0].items[0]?.[1].text).toBe('current');
    } finally {
      await act(async () => {
        localRoot.unmount();
      });
      localContainer.remove();
    }
  });

  it('surfaces fetch failures and leaves feed state unchanged', async () => {
    const localContainer = document.createElement('div');
    const localRoot = createRoot(localContainer);
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [[1, { text: 'current', tags: [1], inboxTags: [] }]],
        filter: {},
      },
    ] as never;
    hoisted.fetchMessagesByIds.mockRejectedValueOnce(new Error('boom'));

    document.body.appendChild(localContainer);
    try {
      await act(async () => {
        localRoot.render(React.createElement(TestHarness));
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await act(async () => {
        await hoisted.onInboxChangedMessageIds([1]);
      });

      expect(hoisted.setFeedErrorMock).toHaveBeenCalledWith('boom');
      expect(latest?.messageFeeds[0].items[0]?.[1].text).toBe('current');
    } finally {
      await act(async () => {
        localRoot.unmount();
      });
      localContainer.remove();
    }
  });
});
