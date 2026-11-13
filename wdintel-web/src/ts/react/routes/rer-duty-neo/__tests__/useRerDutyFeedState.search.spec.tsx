/**
 * @vitest-environment happy-dom
 */
import React, { act } from 'react';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createDutyFeedStateFixture,
  DutyFeedStateHarness,
  getDutyApiMocks,
  inboxRsp,
  rangeRsp,
  settleReactCommits,
  type DutyFeedStateApiRef,
} from '../useRerDutyFeedState.test-utils';
import { emptyFilter } from '../utils';
import { minimalInboxMessage } from '../inbox-message-mocks';

const fixture = createDutyFeedStateFixture();
const requests = getDutyApiMocks();
const period = 14 * 24 * 60 * 60 * 1000;
const since = 1_800_000_000_000;

describe('#3571 Duty search history', () => {
  let root: Root;
  let apiRef: DutyFeedStateApiRef;

  beforeEach(() => {
    ({ root } = fixture.setup());
    apiRef = { current: null };
    const filter = {
      ...emptyFilter(),
      search: 'needle',
      searchMode: 'Substring',
      groupsSelected: ['group-a'],
      sendersSelected: ['sender-a'],
      freqsDenied: ['100'],
    };
    window.history.replaceState(
      {},
      '',
      `/rer-duty-neo?state=${encodeURIComponent(JSON.stringify({ messageFeeds: [['mf-0', filter]] }))}`,
    );
  });

  afterEach(fixture.cleanup);

  async function mount(enabled = true) {
    await act(async () => {
      root.render(<DutyFeedStateHarness apiRef={apiRef} enableDutySearch={enabled} />);
      await settleReactCommits();
    });
  }

  it('#3571 reloads an unloaded historical target without retaining the adaptive cutoff', async () => {
    const now = since + period;
    const targetTime = now - 40 * 24 * 60 * 60 * 1000;
    window.history.replaceState(
      {},
      '',
      `/rer-duty-neo?state=${encodeURIComponent(
        JSON.stringify({
          messageFeeds: [
            [
              'mf-0',
              { ...emptyFilter(), groupsSelected: ['group-a'], deniedSenders: ['sender-b'] },
            ],
          ],
        }),
      )}`,
    );
    const rows: Parameters<typeof inboxRsp>[0] = [
      [4, minimalInboxMessage({ text: 'before context', createdAt: targetTime - 1000 })],
      [5, minimalInboxMessage({ text: 'needle target', createdAt: targetTime })],
      [6, minimalInboxMessage({ text: 'after context', createdAt: targetTime + 1000 })],
      [90, minimalInboxMessage({ text: 'recent latest', createdAt: now - 1000 })],
    ];
    requests.fetchInboxMessages.mockImplementation(async (request) => {
      const adaptive =
        request.loadLatest === true &&
        request.beforeIdNoninclusive == null &&
        request.sinceIdNoninclusive == null &&
        request.sinceDateInclusiveMs == null;
      const lowerBound = adaptive ? since : request.sinceDateInclusiveMs;
      return {
        ...inboxRsp(
          rows.filter(
            ([id, message]) =>
              (lowerBound == null || message.createdAt >= lowerBound) &&
              (request.beforeIdNoninclusive == null || id < request.beforeIdNoninclusive) &&
              (request.sinceIdNoninclusive == null || id > request.sinceIdNoninclusive),
          ),
        ),
        historySinceMs: adaptive ? since : null,
        historyPeriodMs: adaptive ? period : null,
      };
    });
    requests.fetchMessagesByIdsWithMetadata.mockImplementation(async (ids, request) =>
      inboxRsp(
        rows.filter(
          ([id, message]) =>
            ids.includes(id) &&
            (request.sinceDateInclusiveMs == null ||
              message.createdAt >= request.sinceDateInclusiveMs),
        ),
      ),
    );
    await mount();
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([90]);
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since);
    requests.fetchInboxMessages.mockClear();
    await act(async () => {
      apiRef.current!.setFeedInitialTarget('mf-0', { beforeIdNoninclusive: 5, messageIds: [5] });
      apiRef.current!.applyFilter('mf-0', apiRef.current!.messageFeeds[0].filter, true, {
        preserveUnread: true,
      });
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([4, 5, 6, 90]);
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBeNull();
    expect(apiRef.current!.messageFeeds[0].historyPeriodMs).toBeNull();
    for (const [request] of requests.fetchInboxMessages.mock.calls)
      expect(request).toMatchObject({
        sinceDateInclusiveMs: null,
        selectedGroups: ['group-a'],
        deniedSenders: ['sender-b'],
        search: null,
      });
    expect(requests.fetchMessagesByIdsWithMetadata).toHaveBeenLastCalledWith(
      [5],
      expect.objectContaining({
        sinceDateInclusiveMs: null,
        selectedGroups: ['group-a'],
        deniedSenders: ['sender-b'],
        search: null,
      }),
      expect.anything(),
    );
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
      await settleReactCommits();
    });
    expect(requests.fetchInboxMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        beforeIdNoninclusive: 4,
        sinceDateInclusiveMs: null,
      }),
      expect.anything(),
    );
    await act(async () => {
      await apiRef.current!.loadFeedInitialMessages('mf-0', { loadLatest: true });
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([90]);
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since);
  });

  it('advances empty periods, retains filters, and retries the same period after failure', async () => {
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...inboxRsp([]),
      historySinceMs: since,
      historyPeriodMs: period,
    });
    await mount();
    expect(apiRef.current!.messageFeeds[0].hasReachedStart).toBe(true);
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0', true);
      await settleReactCommits();
    });
    expect(requests.fetchInboxMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        search: 'needle',
        searchMode: 'Substring',
        selectedGroups: ['group-a'],
        selectedSenders: ['sender-a'],
        deniedFreqs: ['100'],
        sortBy: 'IMSCreatedAt',
        sinceDateInclusiveMs: since - period,
        tillDateInclusiveMs: since,
        loadLatest: true,
      }),
      expect.anything(),
    );
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since - period);
    requests.fetchInboxMessages.mockRejectedValueOnce(new Error('Search unavailable'));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0', true);
      await settleReactCommits();
    });
    expect(apiRef.current!.error).toBe('Search unavailable');
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since - period);
    const createdAtOrder = (since - period) * 1000 - 1;
    const boundaryMessage: Parameters<typeof inboxRsp>[0][number] = [
      7,
      minimalInboxMessage({ createdAtOrder }),
    ];
    requests.fetchInboxMessages.mockImplementationOnce((request) =>
      inboxRsp(
        createdAtOrder >= request.sinceDateInclusiveMs * 1000 &&
          createdAtOrder <= request.tillDateInclusiveMs * 1000
          ? [boundaryMessage]
          : [],
      ),
    );
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0', true);
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([7]);
    expect(requests.fetchInboxMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({
        sinceDateInclusiveMs: since - 2 * period,
        tillDateInclusiveMs: since - period,
      }),
      expect.anything(),
    );
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since - 2 * period);
  });

  it('bounds ordinary older pages and discards an older-period response after filters change', async () => {
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...rangeRsp(21, 40),
      historySinceMs: since,
      historyPeriodMs: period,
    });
    await mount();
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
      await settleReactCommits();
    });
    expect(requests.fetchInboxMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ beforeIdNoninclusive: 21, sinceDateInclusiveMs: since }),
      expect.anything(),
    );
    const pending = fixture.deferred<ReturnType<typeof inboxRsp>>('older search period');
    requests.fetchInboxMessages.mockReturnValueOnce(pending.promise);
    const loading = apiRef.current!.loadFeedOlderMessages('mf-0', true);
    await act(async () => settleReactCommits());
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...rangeRsp(80, 81),
      historySinceMs: since + 1000,
      historyPeriodMs: period,
    });
    await act(async () => {
      apiRef.current!.applyFilter('mf-0', {
        ...apiRef.current!.messageFeeds[0].filter,
        search: 'changed',
      });
      await settleReactCommits();
    });
    expect(requests.fetchInboxMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ search: 'changed', sinceDateInclusiveMs: null }),
      expect.anything(),
    );
    await act(async () => {
      pending.resolve(rangeRsp(1, 20));
      await loading;
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual([80, 81]);
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since + 1000);
  });

  it('ignores search restored from a link when disabled', async () => {
    await mount(false);
    expect(requests.fetchInboxMessages).toHaveBeenCalledWith(
      expect.objectContaining({ search: null, searchMode: null }),
      expect.anything(),
    );
  });

  it('allows retrying history after reconciliation removes the oldest result', async () => {
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...rangeRsp(21, 40),
      historySinceMs: since,
      historyPeriodMs: period,
    });
    await mount();
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
      await settleReactCommits();
    });
    const pending = fixture.deferred<ReturnType<typeof inboxRsp>>('reconciled history');
    requests.fetchInboxMessages.mockReturnValueOnce(pending.promise);
    const loading = apiRef.current!.loadFeedOlderMessages('mf-0', true);
    await act(async () => settleReactCommits());
    await act(async () => {
      apiRef.current!.setMessageFeeds((feeds) =>
        feeds.map((feed) => ({ ...feed, items: feed.items.slice(1) })),
      );
    });
    await act(async () => {
      pending.resolve(rangeRsp(1, 20));
      await loading;
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual(
      Array.from({ length: 19 }, (_, index) => index + 22),
    );
    expect(apiRef.current!.messageFeeds[0].loadingOlder).toBe(false);
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since);
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0', true);
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].historySinceMs).toBe(since - period);
  });

  it('clears history loading when a live reload supersedes an empty-period search', async () => {
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...inboxRsp([]),
      historySinceMs: since,
      historyPeriodMs: period,
    });
    await mount();
    const pending = fixture.deferred<ReturnType<typeof inboxRsp>>('superseded history');
    requests.fetchInboxMessages.mockReturnValueOnce(pending.promise);
    const loading = apiRef.current!.loadFeedOlderMessages('mf-0', true);
    await act(async () => settleReactCommits());
    requests.fetchInboxMessages.mockResolvedValueOnce(rangeRsp(21, 40));
    await act(async () => {
      apiRef.current!.reloadFeeds();
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].loadingOlder).toBe(false);
    await act(async () => {
      pending.resolve(rangeRsp(1, 20));
      await loading;
      await settleReactCommits();
    });
    expect(apiRef.current!.messageFeeds[0].items.map(([id]) => id)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 21),
    );
  });

  it('discards a count from the previous history boundary', async () => {
    requests.fetchInboxMessages.mockResolvedValueOnce({
      ...rangeRsp(21, 40),
      historySinceMs: since,
      historyPeriodMs: period,
    });
    await mount();
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0');
      await settleReactCommits();
    });
    const pending = fixture.deferred<{ quantity: number; firstElementTs: null }>('bounded count');
    requests.fetchInboxCount.mockReturnValueOnce(pending.promise);
    const count = apiRef.current!.requestValidatedInboxCount('mf-0');
    requests.fetchInboxMessages.mockResolvedValueOnce(inboxRsp([]));
    await act(async () => {
      await apiRef.current!.loadFeedOlderMessages('mf-0', true);
      await settleReactCommits();
    });
    let result: unknown;
    await act(async () => {
      pending.resolve({ quantity: 99, firstElementTs: null });
      result = await count;
      await settleReactCommits();
    });
    expect(result).toBeNull();
  });
});
