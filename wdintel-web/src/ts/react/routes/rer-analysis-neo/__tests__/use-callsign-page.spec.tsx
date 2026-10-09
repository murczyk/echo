/** @vitest-environment happy-dom */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({ fetchAnalysisCallsignPage: vi.fn() }));

vi.mock('../../../services/api/analysis', () => api);

import type { AnalysisStatsReq } from '../../../../../Bindings';
import { useCallsignPage } from '../use-callsign-page';

const req: AnalysisStatsReq = {
  sinceDateInclusiveMs: 1,
  tillDateNoninclusiveMs: 2,
  selectedGroups: null,
  selectedSenders: null,
  selectedFreqs: null,
  selectedPosts: null,
  selectedCallsigns: null,
  selectedUnits: null,
  selectedUnitIds: null,
  selectedLocations: null,
  selectedDeviceNames: null,
  selectedAors: null,
  orWithExtendedForm: null,
  orBookmarked: null,
  orImportant: null,
  orWithCoords: null,
  orWithoutCoords: null,
  search: null,
  selectedTags: null,
  deniedTags: null,
  tagPresence: null,
  selectedNetworks: null,
  withoutNetwork: null,
  metadataCc: null,
  metadataSender: null,
  metadataReceiver: null,
  metadataHash: null,
  onlyWithMetadata: null,
  withoutMetadata: null,
  includePelengLocations: null,
  unitsExactMatchOnly: null,
  filterTagsOption: null,
  withoutModelTags: null,
  reportTagsOnlyThisUnit: null,
  messageTimeBasis: null,
};

type Result = ReturnType<typeof useCallsignPage>;
let root: Root | null = null;
let latest: Result | null = null;
let onError = vi.fn();

function Harness({
  active = true,
  callsigns = null,
  search = null,
}: {
  active?: boolean;
  callsigns?: string[] | null;
  search?: string | null;
}) {
  latest = useCallsignPage({
    active,
    analysisReq: { ...req, search, selectedCallsigns: callsigns },
    onError,
  });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  api.fetchAnalysisCallsignPage.mockReset();
  api.fetchAnalysisCallsignPage.mockResolvedValue({
    entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
    hasMore: true,
    nextCursor: 'next',
  });
  onError = vi.fn();
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  vi.useRealTimers();
});

describe('useCallsignPage', () => {
  it('does not reload after response state or unrelated parent renders', async () => {
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(1);

    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(1000));
    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(1);
  });

  it('keeps a loaded page when only the selected callsign facet changes', async () => {
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    await act(async () => root?.render(createElement(Harness, { callsigns: ['alpha'] })));
    await act(async () => vi.advanceTimersByTimeAsync(1000));

    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(1);
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['ALPHA']);
  });

  it('keeps the displayed next page instead of reloading page one', async () => {
    api.fetchAnalysisCallsignPage
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: true,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      });
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => latest?.loadNextPage());

    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(2);
    expect(api.fetchAnalysisCallsignPage.mock.calls[1][0].cursor).toBe('next');
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);
  });

  it('rejects an old response after the scope changes and deactivation', async () => {
    let resolveFirst!: (value: { entries: []; hasMore: boolean; nextCursor: null }) => void;
    api.fetchAnalysisCallsignPage.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)),
    );
    api.fetchAnalysisCallsignPage.mockResolvedValueOnce({
      entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
      hasMore: false,
      nextCursor: null,
    });
    await act(async () => root?.render(createElement(Harness, { search: 'old' })));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => root?.render(createElement(Harness, { search: 'new' })));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);

    await act(async () => root?.render(createElement(Harness, { active: false, search: 'new' })));
    await act(async () => resolveFirst({ entries: [], hasMore: false, nextCursor: null }));
    expect(latest?.entries).toEqual([]);
  });

  it('does not notify for an aborted callsign request', async () => {
    let rejectRequest!: (reason: unknown) => void;
    api.fetchAnalysisCallsignPage.mockImplementationOnce(
      () => new Promise((_, reject) => (rejectRequest = reject)),
    );
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => root?.render(createElement(Harness, { active: false })));
    await act(async () => rejectRequest(new DOMException('Aborted', 'AbortError')));

    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the displayed page and permits retry after a next-page failure', async () => {
    api.fetchAnalysisCallsignPage
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: true,
        nextCursor: 'next',
      })
      .mockRejectedValueOnce(new Error('next page failed'))
      .mockResolvedValueOnce({
        entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      });
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    await act(async () => latest?.loadNextPage());
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['ALPHA']);
    expect(latest?.error).toBeInstanceOf(Error);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'next page failed' }));

    await act(async () => latest?.retry());
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);
    expect(latest?.error).toBeNull();
  });

  it('keeps a later-page snapshot correctly indexed until a failed scope refresh succeeds', async () => {
    let rejectRefresh!: (reason: Error) => void;
    let resolveRetry!: (value: {
      entries: Array<{ value: string; label: string; values: string[]; count: number }>;
      hasMore: boolean;
      nextCursor: null;
    }) => void;
    api.fetchAnalysisCallsignPage
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: true,
        nextCursor: 'next',
      })
      .mockResolvedValueOnce({
        entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      })
      .mockImplementationOnce(() => new Promise((_, reject) => (rejectRefresh = reject)))
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)));
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => latest?.loadNextPage());

    act(() => latest?.setQuery('charlie'));
    expect(latest?.entries).toEqual([]);
    expect(latest?.snapshotEntries.map((entry) => entry.label)).toEqual(['BRAVO']);
    expect(latest?.snapshotPageIndex).toBe(1);
    expect(latest?.pageIndex).toBe(0);

    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () => rejectRefresh(new Error('refresh failed')));
    expect(latest?.pending).toBe(false);
    expect(latest?.stale).toBe(true);
    expect(latest?.snapshotPageIndex).toBe(1);
    expect(latest?.canRetry).toBe(true);

    void latest?.retry();
    await act(async () =>
      resolveRetry({
        entries: [{ value: 'charlie', label: 'CHARLIE', values: ['charlie'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      }),
    );
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['CHARLIE']);
    expect(latest?.pageIndex).toBe(0);
    expect(latest?.snapshotEntries).toEqual([]);
  });

  it('invalidates a prior scope during debounce, failure, retry, and a late response', async () => {
    let resolveSearch!: (value: {
      entries: Array<{ value: string; label: string; values: string[]; count: number }>;
      hasMore: boolean;
      nextCursor: null;
    }) => void;
    let rejectSearch!: (reason: Error) => void;
    let resolveRetry!: (value: {
      entries: Array<{ value: string; label: string; values: string[]; count: number }>;
      hasMore: boolean;
      nextCursor: null;
    }) => void;
    api.fetchAnalysisCallsignPage
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveSearch = resolve;
            rejectSearch = reject;
          }),
      )
      .mockImplementationOnce(() => new Promise((resolve) => (resolveRetry = resolve)));
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    act(() => latest?.setQuery('bravo'));
    expect(latest?.entries).toEqual([]);
    expect(latest?.snapshotEntries.map((entry) => entry.label)).toEqual(['ALPHA']);
    expect(latest?.stale).toBe(true);
    expect(latest?.pending).toBe(true);
    await act(async () => vi.advanceTimersByTimeAsync(250));
    expect(latest?.loading).toBe(true);
    expect(latest?.entries).toEqual([]);
    expect(latest?.snapshotEntries.map((entry) => entry.label)).toEqual(['ALPHA']);

    await act(async () => rejectSearch(new Error('search failed')));
    expect(latest?.entries).toEqual([]);
    expect(latest?.snapshotEntries.map((entry) => entry.label)).toEqual(['ALPHA']);
    expect(latest?.canRetry).toBe(true);

    void latest?.retry();
    await act(async () =>
      resolveSearch({
        entries: [{ value: 'old', label: 'OLD', values: ['old'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      }),
    );
    expect(latest?.entries).toEqual([]);
    expect(latest?.snapshotEntries.map((entry) => entry.label)).toEqual(['ALPHA']);

    await act(async () =>
      resolveRetry({
        entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      }),
    );
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);
  });

  it('retries an initial page failure without changing its scope', async () => {
    api.fetchAnalysisCallsignPage
      .mockRejectedValueOnce(new Error('initial page failed'))
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      });
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));

    expect(latest?.canRetry).toBe(true);
    await act(async () => latest?.retry());
    expect(api.fetchAnalysisCallsignPage).toHaveBeenCalledTimes(2);
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['ALPHA']);
    expect(latest?.error).toBeNull();
  });

  it('bounds backward cursor history while retaining first-page access', async () => {
    api.fetchAnalysisCallsignPage.mockImplementation(({ cursor }: { cursor: string | null }) => {
      const index = cursor == null ? 0 : Number(cursor.slice(1));
      return Promise.resolve({
        entries: [{ value: `callsign-${index}`, label: `CALLSIGN-${index}`, values: [], count: 1 }],
        hasMore: index < 24,
        nextCursor: index < 24 ? `p${index + 1}` : null,
      });
    });
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    for (let index = 0; index < 24; index += 1) {
      await act(async () => latest?.loadNextPage());
    }

    expect(latest?.pageIndex).toBe(24);
    for (let index = 24; index > 6; index -= 1) {
      await act(async () => latest?.loadPreviousPage());
    }
    expect(latest?.pageIndex).toBe(6);
    expect(latest?.hasPrevious).toBe(false);

    await act(async () => latest?.loadNextPage());
    expect(latest?.pageIndex).toBe(7);

    await act(async () => latest?.loadFirstPage());
    expect(latest?.pageIndex).toBe(0);
  });

  it('rejects a next-page response after the search scope changes', async () => {
    let resolveNext!: (value: {
      entries: Array<{ value: string; label: string; values: string[]; count: number }>;
      hasMore: boolean;
      nextCursor: null;
    }) => void;
    api.fetchAnalysisCallsignPage
      .mockResolvedValueOnce({
        entries: [{ value: 'alpha', label: 'ALPHA', values: ['alpha'], count: 1 }],
        hasMore: true,
        nextCursor: 'next',
      })
      .mockImplementationOnce(() => new Promise((resolve) => (resolveNext = resolve)))
      .mockResolvedValueOnce({
        entries: [{ value: 'charlie', label: 'CHARLIE', values: ['charlie'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      });
    await act(async () => root?.render(createElement(Harness)));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    void latest?.loadNextPage();
    await act(async () => root?.render(createElement(Harness, { search: 'charlie' })));
    await act(async () => vi.advanceTimersByTimeAsync(250));
    await act(async () =>
      resolveNext({
        entries: [{ value: 'bravo', label: 'BRAVO', values: ['bravo'], count: 1 }],
        hasMore: false,
        nextCursor: null,
      }),
    );

    expect(latest?.entries.map((entry) => entry.label)).toEqual(['CHARLIE']);
    expect(latest?.pageIndex).toBe(0);
  });
});
