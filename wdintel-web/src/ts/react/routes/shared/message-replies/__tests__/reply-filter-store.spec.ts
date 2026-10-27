import { describe, expect, it, vi } from 'vitest';
import { fetchMessagesByIdsMatchingFilters } from '../../../../services/api/analysis';
import { ReplyFilterStore } from '../reply-filter-store';

vi.mock('../../../../services/api/analysis', () => ({
  fetchMessagesByIdsMatchingFilters: vi.fn(),
}));

describe('#3612 reply filter checks', () => {
  it('settles every mounted card when the thread exceeds the resolved cache limit', async () => {
    vi.mocked(fetchMessagesByIdsMatchingFilters).mockReset().mockResolvedValue([]);
    const store = new ReplyFilterStore({ feed: {} }, vi.fn());
    const ids = Array.from({ length: 1025 }, (_, index) => index + 1);
    const listener = vi.fn();
    store.subscribe(listener, ids);
    const results = await Promise.all([store.check('feed', ids), store.check('feed', ids)]);
    expect(results.map((matches) => matches.size)).toEqual([1025, 1025]);
    store.invalidate([1]);
    expect(listener).toHaveBeenCalledOnce();
    store.dispose();
  }, 1000);

  it('checks a shared hundred-member thread once for forty mounted cards and refreshes changed IDs', async () => {
    const fetch = vi.mocked(fetchMessagesByIdsMatchingFilters).mockReset().mockResolvedValue([]);
    const store = new ReplyFilterStore({ feed: { search: 'visible' } }, vi.fn());
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    await Promise.all(Array.from({ length: 40 }, () => store.check('feed', ids)));
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toEqual(ids);
    const listener = vi.fn();
    store.subscribe(listener, ids);
    store.invalidate([500]);
    expect(listener).not.toHaveBeenCalled();
    store.invalidate([50]);
    await store.check('feed', ids);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls[1]![0]).toEqual([50]);
    store.dispose();
  });

  it('reports a failed check without treating messages as excluded, and permits retry', async () => {
    const error = new Error('filter lookup failed');
    const fetch = vi
      .mocked(fetchMessagesByIdsMatchingFilters)
      .mockReset()
      .mockRejectedValueOnce(error)
      .mockResolvedValue([]);
    const onError = vi.fn();
    const store = new ReplyFilterStore({ feed: {} }, onError);
    await expect(store.check('feed', [1])).rejects.toBe(error);
    expect(onError).toHaveBeenCalledWith(error);
    expect(await store.check('feed', [1])).toEqual(new Map([[1, false]]));
    expect(fetch).toHaveBeenCalledTimes(2);
    store.dispose();
  });
});
