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
  fetchUserSettings: vi.fn(),
  currentSystemSettings: vi.fn(),
  attachDutyNotificationAudioPrimingListeners: vi.fn(),
  mergeResolvedCallsigns: vi.fn(),
  initialCallsignInfoMap: {} as Record<string, { callsign: string; res: unknown[] }>,
  initialInboxCallsignInfoMap: {} as Record<string, { callsign: string; res: unknown[] }>,
}));

vi.mock('../../services/api/analysis', () => ({
  fetchAnalysisCallsignInfos: hoisted.fetchAnalysisCallsignInfos,
}));

vi.mock('../../services/api/user-settings', () => ({
  fetchUserSettings: hoisted.fetchUserSettings,
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
    savedFilters: [],
    setSavedFilters: vi.fn(),
    selectedSavedId: null,
    setSelectedSavedId: vi.fn(),
    saveFilterName: '',
    setSaveFilterName: vi.fn(),
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

vi.mock('./useRerDutyFeedState', () => ({
  useRerDutyFeedState: () => {
    const [callsignInfoMap, setCallsignInfoMap] = React.useState<Record<string, { callsign: string; res: unknown[] }>>(
      hoisted.initialCallsignInfoMap,
    );
    const [inboxCallsignInfoMap, setInboxCallsignInfoMap] = React.useState<Record<string, { callsign: string; res: unknown[] }>>(
      hoisted.initialInboxCallsignInfoMap,
    );

    return {
      messageFeeds: [
        {
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
      ],
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
      setError: vi.fn(),
      setWatchModeByFeedId: vi.fn(),
      setMessageFeeds: vi.fn(),
      nearBottomByFeedIdRef: { current: {} },
      atBottomByFeedIdRef: { current: {} },
      columnRefsRef: { current: {} },
      error: null,
      createMessageFeed: vi.fn(),
      removeMessageFeed: vi.fn(),
      loadFeedInitialMessages: vi.fn(),
      loadFeedOlderMessages: vi.fn(),
      applyFilter: vi.fn(),
      toggleGroup: vi.fn(),
      selectAllGroups: vi.fn(),
      loadFeedNewerMessages: vi.fn(),
      buildReqForFeed: vi.fn(),
      showArrowResult: vi.fn(),
      setLoadingNewerFeedId: vi.fn(),
      watchModeByFeedId: {},
      loadingNewerFeedId: null,
      arrowResultByFeedId: {},
      networkDisplayMap: {},
      networkMap: {},
      unitsMap: {},
    };
  },
}));

function TestHarness() {
  useRerDutyFeeds(null);
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
      inboxCallsignInfoMap: { 'борода': { res: [] } },
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
      inboxCallsignInfoMap: { 'демон': { res: [{}] } },
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
      inboxCallsignInfoMap: { 'борода': { res: [] } },
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
    hoisted.initialCallsignInfoMap = {};
    hoisted.initialInboxCallsignInfoMap = {};
    hoisted.fetchAnalysisCallsignInfos.mockReset();
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

  it('retries failed callsign lookups after the backoff expires even without unrelated rerenders', async () => {
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

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(2);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(2, ['борода']);
  });

  it('still runs enrichment when inbox cache already contains a partial callsign row set', async () => {
    hoisted.initialCallsignInfoMap = {
      'борода': { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.initialInboxCallsignInfoMap = {
      'борода': { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.fetchAnalysisCallsignInfos.mockReset().mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [{ id: 2 }] }]);

    await act(async () => {
      root.render(React.createElement(TestHarness));
    });
    await act(async () => {
      await flushMicrotasks();
    });

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenNthCalledWith(1, ['борода']);
  });

  it('stops retrying when inbox rows are already usable and enrichment returns empty', async () => {
    hoisted.initialCallsignInfoMap = {
      'борода': { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.initialInboxCallsignInfoMap = {
      'борода': { callsign: 'БОРОДА', res: [{ id: 1 }] },
    };
    hoisted.fetchAnalysisCallsignInfos.mockReset().mockResolvedValueOnce([{ callsign: 'БОРОДА', res: [] }]);

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

    expect(hoisted.fetchAnalysisCallsignInfos).toHaveBeenCalledTimes(1);
  });
});
