/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  effectiveDutyPollIntervalSec,
  getPendingDutyCallsignLookups,
  mergeAvailableFrequencies,
  mergeKnownGroupKeys,
} from './useRerDutyFeeds';
import { useRerDutyFeeds } from './useRerDutyFeeds';

const hoisted = vi.hoisted(() => ({
  fetchOrganismKeywordSets: vi.fn(),
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
  pollNow: vi.fn(),
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
vi.mock('../../services/api/organism-keyword-sets', () => ({
  fetchOrganismKeywordSets: hoisted.fetchOrganismKeywordSets,
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
    handleToggleTag: vi.fn(),
    botTagAction: null,
    onCancelBotTagAction: vi.fn(),
    onMarkBotTagWrong: vi.fn(),
    handleArrowClick: vi.fn(),
    handleVisibleMessageIds: vi.fn(),
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
    const [error, setErrorState] = React.useState<string | null>(null);
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
      setError: React.useCallback((message: string) => {
        hoisted.setFeedErrorMock(message);
        setErrorState(message);
      }, []),
      setWatchModeByFeedId: vi.fn(),
      setMessageFeeds: (next) => {
        setMessageFeeds(next);
      },
      nearBottomByFeedIdRef: { current: {} },
      atBottomByFeedIdRef: { current: {} },
      columnRefsRef: { current: {} },
      error,
      createMessageFeed: vi.fn(),
      removeMessageFeed: vi.fn(),
      loadFeedInitialMessages: hoisted.loadFeedInitialMessages,
      reloadFeeds: vi.fn(),
      reloadEditedFeeds: vi.fn(),
      reloadFeedsPreservingUnread: vi.fn(),
      loadFeedOlderMessages: vi.fn(),
      applyFilter: hoisted.applyFilterMock,
      toggleGroup: vi.fn(),
      selectAllGroups: vi.fn(),
      loadFeedNewerMessages: vi.fn(),
      flushPendingNewerMessages: vi.fn(),
      pollNow: hoisted.pollNow,
      getFeedLoadGeneration: (feedId: string) => hoisted.feedLoadGenerations[feedId] ?? 0,
      buildReqForFeed: vi.fn(
        (
          feed: {
            id: string;
            filter: Record<string, unknown>;
            highlightSignalsEnabled?: boolean;
          },
          opts: { loadLatest?: boolean },
        ) => ({
          feedId: feed.id,
          filter: feed.filter,
          loadLatest: opts?.loadLatest ?? null,
          highlightSignals: feed.highlightSignalsEnabled ?? false,
          reportTagsOnlyThisUnit: null,
        }),
      ),
      showArrowResult: vi.fn(),
      setLoadingNewerFeedIds: vi.fn(),
      catchUpFeedUnreadToTail: vi.fn(),
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

function TestHarness({
  deviceAccess,
}: {
  deviceAccess?: import('./useRerDutyPageSettings').DeviceAccess;
}) {
  latest = useRerDutyFeeds(null, null, deviceAccess);
  return null;
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
}

describe('mergeKnownGroupKeys', () => {
  it('keeps the safety poll aligned with the backend count cache', () => {
    expect(effectiveDutyPollIntervalSec(1)).toBe(5);
    expect(effectiveDutyPollIntervalSec(10)).toBe(10);
  });

  it('keeps a group selected in one column available to other Duty columns', () => {
    const availableGroupKeys = mergeKnownGroupKeys(
      [],
      [],
      [],
      [
        {
          items: [],
          filter: { groupsSelected: ['historic-group'], groupsDenied: [] },
        },
        {
          items: [],
          filter: { groupsSelected: [], groupsDenied: [] },
        },
      ],
    );

    expect(availableGroupKeys).toEqual(['historic-group']);
  });

  it('keeps groups from a replaced message window and persisted filters', () => {
    const initialFeeds = [
      {
        items: [
          [1, { groupMasterKey: 'A' }],
          [2, { groupMasterKey: 'B' }],
          [3, { groupMasterKey: 'C' }],
        ] as [number, { groupMasterKey: string }][],
        filter: { groupsSelected: [], groupsDenied: [] },
      },
    ];
    const replacedFeeds = [
      {
        items: [[1, { groupMasterKey: 'A' }]] as [number, { groupMasterKey: string }][],
        filter: { groupsSelected: ['saved-group'], groupsDenied: [] },
      },
    ];

    const known = mergeKnownGroupKeys([], [], [], initialFeeds);
    expect(mergeKnownGroupKeys(known, [], [], replacedFeeds)).toEqual([
      'A',
      'B',
      'C',
      'saved-group',
    ]);
  });

  it('retains groups present only in saved filters', () => {
    expect(
      mergeKnownGroupKeys(
        [],
        [],
        [],
        [],
        [{ groupsSelected: ['saved-selected'], groupsDenied: ['saved-denied'] }],
      ),
    ).toEqual(['saved-selected', 'saved-denied']);
  });
});

describe('mergeAvailableFrequencies', () => {
  it.each(['freqsSelected', 'freqsDenied'] as const)(
    'keeps a restored active frequency available for other Duty columns from %s',
    (activeField) => {
      const filter = {
        freqsSelected: [],
        freqsDenied: [],
        [activeField]: ['153.6250'],
      };

      expect(mergeAvailableFrequencies([], [{ items: [], filter }])).toContain('153.6250');
    },
  );
});

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
    hoisted.pollNow.mockReset();
    hoisted.pollNow.mockResolvedValue(undefined);
    hoisted.fetchUserSettings.mockResolvedValue({ disableAutoScroll: false });
    hoisted.fetchOrganismKeywordSets.mockResolvedValue([]);
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

  it('exposes device-access lookup failures through its public error result', async () => {
    await act(async () => {
      root.render(
        React.createElement(TestHarness, {
          deviceAccess: { status: 'error', message: 'access lookup failed' },
        }),
      );
      await flushMicrotasks();
    });
    expect(latest?.error).toBe('access lookup failed');
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

  it('enriches network-only callsign results without scheduling a retry', async () => {
    hoisted.fetchAnalysisCallsignInfos.mockReset().mockResolvedValueOnce([
      {
        callsign: 'ВЕТЕР',
        res: [],
        networkHints: [{ id: 1, networkId: 10, position: 'командир', formation: '4 мср' }],
      },
    ]);
    hoisted.messageFeeds = [
      {
        id: 'mf-0',
        items: [[1, { textMarked: [{ CNCallsignC: { text: 'ВЕТЕР' } }] }]],
        filter: {},
      },
    ];

    await act(async () => {
      root.render(React.createElement(TestHarness));
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
    expect(hoisted.mergeResolvedCallsigns).toHaveBeenCalledWith([
      expect.objectContaining({
        callsign: 'ВЕТЕР',
        res: [],
        networkHints: [{ id: 1, networkId: 10, position: 'командир', formation: '4 мср' }],
      }),
    ]);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
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
      expect(hoisted.pollNow).toHaveBeenCalledOnce();
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
          reportTagsOnlyThisUnit: null,
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
