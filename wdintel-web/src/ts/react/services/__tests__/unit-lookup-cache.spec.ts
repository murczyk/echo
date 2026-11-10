/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit } from '../../../../Bindings';
import { getUnitsByIds } from '../api/units';
import { invalidateUnitCatalog, reconcileUnitCatalog } from '../unit-catalog-events';
import { createUnitLookupCache } from '../unit-lookup-cache';

vi.mock('../api/units', () => ({ getUnitsByIds: vi.fn() }));

const unit = (id: number, name = `Unit ${id}`) => ({ id, name }) as Unit;

describe('Analysis unit lookup regression #3571', () => {
  beforeEach(() => {
    invalidateUnitCatalog();
    vi.mocked(getUnitsByIds).mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches only newly referenced IDs, including sharing in-flight and absent IDs', async () => {
    const lookup = createUnitLookupCache();
    let resolve!: (units: Unit[]) => void;
    vi.mocked(getUnitsByIds).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const first = lookup([1, 2, 1]);
    const concurrent = lookup([2]);
    resolve([unit(1)]);
    await expect(first).resolves.toEqual([unit(1)]);
    await expect(concurrent).resolves.toEqual([]);
    await expect(lookup([1, 2])).resolves.toEqual([unit(1)]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(1);
    vi.mocked(getUnitsByIds).mockResolvedValueOnce([unit(3)]);
    await expect(lookup([1, 2, 3])).resolves.toEqual([unit(1), unit(3)]);
    expect(getUnitsByIds).toHaveBeenLastCalledWith(
      [3],
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('refreshes after invalidation and prevents an older request restoring stale units', async () => {
    const lookup = createUnitLookupCache();
    let resolve!: (units: Unit[]) => void;
    vi.mocked(getUnitsByIds).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const stale = lookup([1]);
    const rejected = expect(stale).rejects.toMatchObject({ name: 'AbortError' });
    invalidateUnitCatalog();
    vi.mocked(getUnitsByIds).mockResolvedValueOnce([unit(1, 'Renamed')]);
    await expect(lookup([1])).resolves.toEqual([unit(1, 'Renamed')]);
    resolve([unit(1, 'Stale')]);
    await rejected;
    await expect(lookup([1])).resolves.toEqual([unit(1, 'Renamed')]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(2);
  });

  it('does not cache failed requests', async () => {
    const lookup = createUnitLookupCache();
    vi.mocked(getUnitsByIds)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValueOnce([unit(1)]);
    await expect(lookup([1])).rejects.toThrow('Unavailable');
    await expect(lookup([1])).resolves.toEqual([unit(1)]);
  });

  it('reports shared lookup timeouts without cancelling callers and allows retries', async () => {
    vi.useFakeTimers();
    const lookup = createUnitLookupCache();
    const controller = new AbortController();
    vi.mocked(getUnitsByIds).mockImplementationOnce(
      (_ids, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );
    const timeoutMessage = 'Перевищено час очікування завантаження підрозділів.';
    await Promise.all([
      expect(lookup([1], { signal: controller.signal })).rejects.toThrow(timeoutMessage),
      expect(lookup([1])).rejects.toThrow(timeoutMessage),
      vi.advanceTimersByTimeAsync(30_000),
    ]);
    expect(controller.signal.aborted).toBe(false);
    vi.mocked(getUnitsByIds).mockResolvedValueOnce([unit(1)]);
    await expect(lookup([1])).resolves.toEqual([unit(1)]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(2);
  });

  it('reconciles missed notifications and quiet-table windows without refetching every poll', async () => {
    const lookup = createUnitLookupCache();
    vi.mocked(getUnitsByIds).mockResolvedValue([unit(1)]);
    reconcileUnitCatalog('window-1:original', false);
    await lookup([1]);
    reconcileUnitCatalog('window-1:original', false);
    await lookup([1]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(1);
    vi.mocked(getUnitsByIds).mockResolvedValue([unit(1, 'Missed edit')]);
    reconcileUnitCatalog('window-1:edited', false);
    await expect(lookup([1])).resolves.toEqual([unit(1, 'Missed edit')]);
    reconcileUnitCatalog('window-1:edited', true);
    await lookup([1]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(2);
    vi.mocked(getUnitsByIds).mockResolvedValue([unit(1, 'Direct SQL edit')]);
    reconcileUnitCatalog('window-2:edited', false);
    await expect(lookup([1])).resolves.toEqual([unit(1, 'Direct SQL edit')]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(3);
  });

  it('cancels a caller without aborting another caller sharing the same batch', async () => {
    const lookup = createUnitLookupCache();
    const controller = new AbortController();
    let resolve!: (units: Unit[]) => void;
    vi.mocked(getUnitsByIds).mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const cancelled = lookup([1], { signal: controller.signal });
    const rejected = expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
    const shared = lookup([1]);
    controller.abort();
    await rejected;
    resolve([unit(1)]);
    await expect(shared).resolves.toEqual([unit(1)]);
    expect(getUnitsByIds).toHaveBeenCalledTimes(1);
  });
});
