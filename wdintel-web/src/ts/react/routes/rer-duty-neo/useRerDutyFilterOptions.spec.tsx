/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  senders: vi.fn(),
  frequencies: vi.fn(),
  posts: vi.fn(),
  tags: vi.fn(),
  groups: vi.fn(),
  details: vi.fn(),
  saved: vi.fn(),
  server: vi.fn(),
}));

vi.mock('../../services/api/inbox', () => ({
  getLatestSenders: api.senders,
  getLatestFrequencies: api.frequencies,
  getPostsList: api.posts,
  getTagsForDisplay: api.tags,
  getUserSigintGroups: api.groups,
  getGroupInfosBatch: api.details,
  savedFiltersList: api.saved,
}));
vi.mock('../../services/api/server-info', () => ({ fetchServerInfo: api.server }));

import { useRerDutyFilterOptions } from './useRerDutyFilterOptions';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function groupInfo(masterKey: string, name = masterKey) {
  return {
    masterKey,
    name,
    ignoreOperativny: false,
    interseptionKind: 'rer' as const,
    disableNetworkAssignment: false,
    groupStats: { activityLastDay: 0, activityLastWeek: 0 },
    adminData: null,
    areasOfResponsibility: null,
  };
}

describe('useRerDutyFilterOptions', () => {
  let root: Root;
  let container: HTMLDivElement;
  let current: ReturnType<typeof useRerDutyFilterOptions> | null = null;

  beforeEach(() => {
    api.senders.mockResolvedValue({ data: {} });
    api.frequencies.mockResolvedValue([]);
    api.posts.mockResolvedValue([]);
    api.tags.mockResolvedValue({ tagsMap: {}, tagsOrder: [] });
    api.saved.mockResolvedValue([]);
    api.server.mockResolvedValue({ featureStrictNetworks: false });
    container = document.createElement('div');
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.clearAllMocks();
  });

  it('publishes keys before unrelated references and details resolve', async () => {
    const groups = deferred<string[]>();
    const details = deferred<ReturnType<typeof groupInfo>[]>();
    api.groups.mockReturnValue(groups.promise);
    api.details.mockReturnValue(details.promise);
    api.senders.mockReturnValue(new Promise(() => {}));

    mount();
    await act(async () => groups.resolve(['A', 'B']));
    expect(current?.groupsList).toEqual(['A', 'B']);
    expect(current?.groupInfos).toEqual({});
    expect(current?.groupCatalogLoading).toBe(true);

    await act(async () => details.resolve([groupInfo('A', 'Alpha'), groupInfo('B', 'Beta')]));
    expect(current?.groupsList).toEqual(['A', 'B']);
    expect(current?.groupInfos.A?.name).toBe('Alpha');
  });

  it('keeps keys and existing details when details fail', async () => {
    api.groups.mockResolvedValue(['A', 'B']);
    api.details.mockRejectedValue(new Error('details failed'));
    mount();
    await act(async () => {});
    expect(current?.groupsList).toEqual(['A', 'B']);
    expect(current?.groupCatalogError).toEqual({
      kind: 'details',
      message: 'Не вдалося завантажити назви деяких груп.',
    });
    expect(current?.groupCatalogLoading).toBe(false);
  });

  it('preserves the loaded catalog when a refresh fails', async () => {
    api.groups.mockResolvedValueOnce(['A']);
    api.details.mockResolvedValueOnce([groupInfo('A', 'Alpha')]);
    mount();
    await act(async () => {});

    api.groups.mockRejectedValueOnce(new Error('catalog failed'));
    act(() => current?.reloadGroupCatalog());
    await act(async () => {});

    expect(current?.groupsList).toEqual(['A']);
    expect(current?.groupCatalogError).toEqual({
      kind: 'catalog',
      message: 'Не вдалося завантажити повний список груп. Показано раніше доступні групи.',
    });
    expect(current?.groupCatalogLoading).toBe(false);
  });

  it('merges refreshed details without replacing existing details', async () => {
    api.groups.mockResolvedValueOnce(['A']).mockResolvedValueOnce(['B']);
    api.details.mockResolvedValueOnce([groupInfo('A', 'Alpha')]);
    mount();
    await act(async () => {});

    api.details.mockResolvedValueOnce([groupInfo('B', 'Beta')]);
    act(() => current?.reloadGroupCatalog());
    await act(async () => {});

    expect(current?.groupInfos.A?.name).toBe('Alpha');
    expect(current?.groupInfos.B?.name).toBe('Beta');
    expect(api.groups).toHaveBeenCalledTimes(2);
    expect(api.details).toHaveBeenCalledTimes(2);

    act(() => root.render(<HookProbe onValue={(value) => (current = value)} />));
    expect(api.groups).toHaveBeenCalledTimes(2);
    expect(api.details).toHaveBeenCalledTimes(2);
  });

  it('ignores stale retry responses', async () => {
    const first = deferred<string[]>();
    const second = deferred<string[]>();
    api.groups.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    api.details.mockResolvedValue([]);
    mount();
    await act(async () => {});
    act(() => current?.reloadGroupCatalog());
    await act(async () => second.resolve(['B']));
    await act(async () => first.resolve(['A']));
    expect(current?.groupsList).toEqual(['B']);
  });

  it('ignores stale detail responses from an obsolete retry', async () => {
    const firstDetails = deferred<ReturnType<typeof groupInfo>[]>();
    api.groups.mockResolvedValueOnce(['A']).mockResolvedValueOnce(['B']);
    api.details
      .mockReturnValueOnce(firstDetails.promise)
      .mockResolvedValueOnce([groupInfo('B', 'Beta')]);
    mount();
    await act(async () => {});
    act(() => current?.reloadGroupCatalog());
    await act(async () => {});
    await act(async () => firstDetails.resolve([groupInfo('A', 'Stale Alpha')]));

    expect(current?.groupInfos).toEqual({ B: groupInfo('B', 'Beta') });
  });

  it('does not update after unmount while catalog requests are pending', async () => {
    const groups = deferred<string[]>();
    const details = deferred<ReturnType<typeof groupInfo>[]>();
    api.groups.mockReturnValue(groups.promise);
    api.details.mockReturnValue(details.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    act(() => root.unmount());
    await act(async () => groups.resolve(['A']));
    await act(async () => details.resolve([groupInfo('A', 'Alpha')]));

    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('does not publish details resolved after unmount', async () => {
    const details = deferred<ReturnType<typeof groupInfo>[]>();
    api.groups.mockResolvedValue(['A']);
    api.details.mockReturnValue(details.promise);
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mount();
    await act(async () => {});

    expect(api.details).toHaveBeenCalledWith(['A']);
    expect(current?.groupsList).toEqual(['A']);
    expect(current?.groupInfos).toEqual({});

    act(() => root.unmount());
    await act(async () => details.resolve([groupInfo('A', 'Alpha')]));

    expect(current?.groupInfos).toEqual({});
    expect(consoleError).not.toHaveBeenCalled();
    consoleError.mockRestore();
  });

  it('keeps frequency-dependent loads blocked until a retry succeeds', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    api.frequencies.mockRejectedValueOnce(new Error('frequencies failed'));
    mount();
    await act(async () => {});

    expect(current?.freqsReady).toBe(false);

    api.frequencies.mockResolvedValueOnce(['155.5']);
    await act(async () => {
      await current?.reloadLatestFrequencies();
    });

    expect(current?.freqs).toEqual(['155.5']);
    expect(current?.freqsReady).toBe(true);
    warning.mockRestore();
  });

  function mount() {
    act(() => root.render(<HookProbe onValue={(value) => (current = value)} />));
  }
});

function HookProbe({
  onValue,
}: {
  onValue: (value: ReturnType<typeof useRerDutyFilterOptions>) => void;
}) {
  const value = useRerDutyFilterOptions();
  onValue(value);
  return null;
}
