/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitHierarchyRsp } from '../../../../../Bindings';
import { getUnitHierarchy } from '../../../services/api/units';
import { useUnitHierarchyCatalog } from '../use-unit-children-filter';

vi.mock('../../../services/api/units', () => ({ getUnitHierarchy: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(revision: string): UnitHierarchyRsp {
  return { revision, groups: [], units: [{ id: 1, name: revision, groupIndex: null }] };
}

type Catalog = ReturnType<typeof useUnitHierarchyCatalog>;

describe('hierarchy reconciliation regression #3527', () => {
  let root: Root;
  let container: HTMLDivElement;
  let catalogs: Map<string, Catalog>;
  const onError = vi.fn();

  function Harness({ id }: { id: string }) {
    catalogs.set(id, useUnitHierarchyCatalog(true, onError));
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getUnitHierarchy).mockReset();
    onError.mockReset();
    catalogs = new Map();
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('queues a fresh read when focus returns during an older request', async () => {
    const original = deferred<UnitHierarchyRsp>();
    vi.mocked(getUnitHierarchy)
      .mockReturnValueOnce(original.promise)
      .mockResolvedValueOnce(response('new'));
    await act(async () => root.render(createElement(Harness, { id: 'first' })));
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => original.resolve(response('old')));
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    expect(catalogs.get('first')?.tree?.[0].label).toBe('new');
  });

  it('shares matching requests while keeping different known revisions independent', async () => {
    vi.mocked(getUnitHierarchy).mockResolvedValueOnce(response('old'));
    await act(async () => root.render(createElement(Harness, { id: 'first', key: 'first' })));
    const fresh = deferred<UnitHierarchyRsp>();
    const unchanged = deferred<null>();
    vi.mocked(getUnitHierarchy).mockImplementation((revision) =>
      revision === 'old' ? unchanged.promise : fresh.promise,
    );
    await act(async () => {
      root.render([
        createElement(Harness, { id: 'first', key: 'first' }),
        createElement(Harness, { id: 'second', key: 'second' }),
        createElement(Harness, { id: 'third', key: 'third' }),
      ]);
    });
    await act(async () => window.dispatchEvent(new Event('focus')));
    await act(async () => {
      unchanged.resolve(null);
      fresh.resolve(response('new'));
    });
    expect(catalogs.get('first')?.tree?.[0].label).toBe('old');
    expect(catalogs.get('second')?.tree?.[0].label).toBe('new');
    expect(catalogs.get('third')?.tree).toBe(catalogs.get('second')?.tree);
  });

  it('reconciles active pages, preserves unchanged indexes, and resumes visible tabs', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
    vi.mocked(getUnitHierarchy).mockResolvedValueOnce(response('old')).mockResolvedValue(null);
    await act(async () => root.render(createElement(Harness, { id: 'first' })));
    const original = catalogs.get('first')?.hierarchy;
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(getUnitHierarchy).toHaveBeenLastCalledWith('old');
    expect(catalogs.get('first')?.hierarchy).toBe(original);
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('hidden');
    await act(async () => vi.advanceTimersByTimeAsync(60_000));
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    visibility.mockReturnValue('visible');
    vi.mocked(getUnitHierarchy).mockResolvedValueOnce(response('new'));
    await act(async () => document.dispatchEvent(new Event('visibilitychange')));
    expect(catalogs.get('first')?.tree?.[0].label).toBe('new');
    expect(onError).not.toHaveBeenCalled();
  });
});
