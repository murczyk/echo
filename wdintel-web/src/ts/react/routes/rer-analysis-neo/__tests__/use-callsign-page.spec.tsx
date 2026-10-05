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

function Harness({ active = true, search = null }: { active?: boolean; search?: string | null }) {
  latest = useCallsignPage({ active, analysisReq: { ...req, search }, onError: vi.fn() });
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
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);
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

    await act(async () => latest?.loadNextPage());
    expect(latest?.entries.map((entry) => entry.label)).toEqual(['BRAVO']);
    expect(latest?.error).toBeNull();
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
