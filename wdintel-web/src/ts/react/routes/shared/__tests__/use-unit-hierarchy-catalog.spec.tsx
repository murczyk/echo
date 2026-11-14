/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnitHierarchyRsp } from '../../../../../Bindings';
import { getUnitHierarchy } from '../../../services/api/units';
import { invalidateUnitCatalog } from '../../../services/unit-catalog-events';
import { buildAnalysisReq, emptyQueryState } from '../../rer-analysis-neo/helpers';
import { aggregateUnitParentOptions } from '../unit-children-filter';
import {
  loadUnitHierarchyForSelections,
  useUnitHierarchyCatalog,
} from '../use-unit-children-filter';

vi.mock('../../../services/api/units', () => ({ getUnitHierarchy: vi.fn() }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function response(revision: string): UnitHierarchyRsp {
  return {
    revision,
    groups: [],
    units: [{ id: 1, name: revision, groupIndex: null }],
    selections: [],
  };
}

type Catalog = ReturnType<typeof useUnitHierarchyCatalog>;

describe('scoped hierarchy regression #3571', () => {
  let root: Root;
  let container: HTMLDivElement;
  let catalogs: Map<string, Catalog>;
  const onError = vi.fn();

  function Harness({
    id,
    unitIds = [1],
    selectionValues = [],
  }: {
    id: string;
    unitIds?: number[];
    selectionValues?: string[];
  }) {
    catalogs.set(id, useUnitHierarchyCatalog(true, onError, { unitIds, selectionValues }));
    return null;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    invalidateUnitCatalog();
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

  it('does not reload unchanged catalogs on focus, recovery, visibility or timers', async () => {
    vi.mocked(getUnitHierarchy).mockResolvedValue(response('old'));
    await act(async () => root.render(createElement(Harness, { id: 'first' })));
    const original = catalogs.get('first')?.hierarchy;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(getUnitHierarchy).toHaveBeenCalledTimes(1);
    expect(catalogs.get('first')?.hierarchy).toBe(original);
  });

  it('shares matching scopes, reuses completed scopes and fetches newly needed paths', async () => {
    vi.mocked(getUnitHierarchy).mockResolvedValue(response('catalog'));
    await act(async () =>
      root.render([
        createElement(Harness, { id: 'first', key: 'first' }),
        createElement(Harness, { id: 'second', key: 'second' }),
      ]),
    );
    expect(getUnitHierarchy).toHaveBeenCalledTimes(1);
    expect(catalogs.get('first')?.tree).toBe(catalogs.get('second')?.tree);
    await act(async () => root.render(createElement(Harness, { id: 'other', unitIds: [2] })));
    expect(getUnitHierarchy).toHaveBeenLastCalledWith(null, { unitIds: [2], selectionValues: [] });
    await act(async () => root.render(createElement(Harness, { id: 'returned' })));
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
  });

  it('invalidates in-flight snapshots on actual unit changes', async () => {
    const original = deferred<UnitHierarchyRsp>();
    vi.mocked(getUnitHierarchy)
      .mockReturnValueOnce(original.promise)
      .mockResolvedValueOnce(response('new'));
    await act(async () => root.render(createElement(Harness, { id: 'first' })));
    await act(async () => invalidateUnitCatalog());
    await act(async () => original.resolve(response('old')));
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    expect(catalogs.get('first')?.tree?.[0].label).toBe('new');
    expect(onError).not.toHaveBeenCalled();
  });

  it('reports failures once and retries only after explicit invalidation', async () => {
    vi.mocked(getUnitHierarchy)
      .mockRejectedValueOnce(new Error('Unavailable'))
      .mockResolvedValue(response('recovered'));
    await act(async () => root.render(createElement(Harness, { id: 'first' })));
    await act(async () => vi.advanceTimersByTimeAsync(120_000));
    expect(getUnitHierarchy).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await act(async () => invalidateUnitCatalog());
    expect(catalogs.get('first')?.tree?.[0].label).toBe('recovered');
  });

  it('retains the displayed branch while a reload resolves changed descendants', async () => {
    const refreshed = deferred<UnitHierarchyRsp>();
    vi.mocked(getUnitHierarchy)
      .mockResolvedValueOnce(response('original'))
      .mockReturnValueOnce(refreshed.promise);
    const props = { id: 'selected', unitIds: [], selectionValues: ['unit-id:1'] };
    await act(async () => root.render(createElement(Harness, props)));
    const original = catalogs.get('selected')?.hierarchy;
    let reload!: ReturnType<typeof loadUnitHierarchyForSelections>;
    await act(async () => {
      invalidateUnitCatalog();
      reload = loadUnitHierarchyForSelections(['unit-id:1']);
    });
    expect(catalogs.get('selected')?.loading).toBe(true);
    expect(catalogs.get('selected')?.hierarchy).toBe(original);
    await act(async () =>
      refreshed.resolve({
        ...response('moved'),
        selections: [{ value: 'unit-id:1', label: 'Parent', unitIds: [1, 3], exactUnitIds: [1] }],
      }),
    );
    expect((await reload).children.get('unit-id:1')).toEqual(['unit-id:1', 'unit-id:3']);
    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    expect(catalogs.get('selected')?.loading).toBe(false);
  });

  it('#4202 keeps hierarchy identity on catalog reconciliation that changes nothing', async () => {
    // The server's catalog revision changes every five minutes even when no
    // unit changed. A new hierarchy object made every open Analysis tab reload
    // its unit statistics at the same moment.
    vi.mocked(getUnitHierarchy).mockResolvedValueOnce(response('stable')).mockResolvedValue(null);
    await act(async () =>
      root.render([
        createElement(Harness, { id: 'empty', key: 'empty', unitIds: [] }),
        createElement(Harness, { id: 'scoped', key: 'scoped' }),
      ]),
    );
    const empty = catalogs.get('empty')?.hierarchy;
    const scoped = catalogs.get('scoped')?.hierarchy;
    expect(empty).toBeTruthy();
    expect(scoped).toBeTruthy();

    await act(async () => invalidateUnitCatalog({ refreshMessages: false }));

    expect(getUnitHierarchy).toHaveBeenCalledTimes(2);
    expect(getUnitHierarchy).toHaveBeenLastCalledWith('stable', {
      unitIds: [1],
      selectionValues: [],
    });
    expect(catalogs.get('scoped')?.hierarchy).toBe(scoped);
    expect(catalogs.get('empty')?.hierarchy).toBe(empty);
    expect(catalogs.get('empty')?.loading).toBe(false);
  });

  it('skips empty scopes and uses server-resolved descendants outside downloaded paths', async () => {
    await act(async () => root.render(createElement(Harness, { id: 'first', unitIds: [] })));
    expect(getUnitHierarchy).not.toHaveBeenCalled();
    vi.mocked(getUnitHierarchy).mockResolvedValue({
      ...response('scoped'),
      selections: [{ value: 'unit-id:1', label: 'Parent', unitIds: [1, 2, 3], exactUnitIds: [1] }],
    });
    await act(async () =>
      root.render(
        createElement(Harness, { id: 'selected', unitIds: [], selectionValues: ['unit-id:1'] }),
      ),
    );
    const req = buildAnalysisReq({
      ...emptyQueryState(),
      fromDateTimeStr: '2026-11-01T00:00',
      toDateTimeStr: '2026-11-02T00:00',
      unitsSelected: ['unit-id:1'],
      unitHierarchy: catalogs.get('selected')?.hierarchy,
    });
    expect(req?.selectedUnitIds).toEqual([1, 2, 3]);
    expect(catalogs.get('selected')?.tree).toHaveLength(1);
  });

  it.each([
    ['unit-parent:group:2:22 А', [30, 31]],
    ['unit-id:31', [30, 31]],
    ['unit-parent:group:2:22 А', [30]],
  ] as const)(
    '#3527 reconciles restored parent %s without duplicating local facet counts',
    async (selection, directIds) => {
      vi.mocked(getUnitHierarchy).mockResolvedValue({
        revision: 'normalized',
        groups: [{ id: 'group:2:22 А', label: '22 А', level: 2, parentIndex: null }],
        units: directIds.map((id) => ({ id, name: '22 А', groupIndex: 0 })),
        selections: [
          {
            value: selection,
            label: '22 А',
            unitIds: [...directIds, 32],
            exactUnitIds: selection.startsWith('unit-parent:') ? [...directIds] : [31],
          },
        ],
      });
      const hierarchy = await loadUnitHierarchyForSelections([selection]);
      const options = aggregateUnitParentOptions(
        [
          ...directIds.map((id) => ({ value: `unit-id:${id}`, label: '22 А', count: id - 28 })),
          { value: 'unit-id:32', label: 'Child', count: 5 },
        ],
        hierarchy,
      );

      expect(options.filter((option) => option.label === '22 А')).toEqual([
        { value: 'unit-id:30', label: '22 А', count: directIds.length === 1 ? 7 : 10 },
      ]);
      for (const value of [selection, 'unit-id:30']) {
        expect(
          buildAnalysisReq({
            ...emptyQueryState(),
            fromDateTimeStr: '2026-11-01T00:00',
            toDateTimeStr: '2026-11-02T00:00',
            unitsSelected: [value],
            unitHierarchy: hierarchy,
          })?.selectedUnitIds,
        ).toEqual([...directIds, 32]);
      }
    },
  );
});
