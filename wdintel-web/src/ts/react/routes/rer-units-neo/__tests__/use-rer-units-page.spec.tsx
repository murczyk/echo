/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ListUnitsReq, Unit } from '../../../../../Bindings';

const api = vi.hoisted(() => ({
  createUnit: vi.fn(),
  getUnitsPage: vi.fn(),
  getUnitIdsWithVisibleAttachments: vi.fn(),
  mergeDuplicateUnit: vi.fn(),
  clearPendingUnitMerge: vi.fn(),
  loadPendingUnitMerge: vi.fn((): unknown => null),
  waitForBgtaskCompletion: vi.fn(),
}));

vi.mock('../../../services/api/units', () => ({
  createUnit: api.createUnit,
  createUnitWithAutoNetwork: vi.fn(),
  deleteUnit: vi.fn(),
  getUnitsPage: api.getUnitsPage,
  getUnitDetails: vi.fn(),
  getUnitIdsWithVisibleAttachments: api.getUnitIdsWithVisibleAttachments,
  mergeDuplicateUnit: api.mergeDuplicateUnit,
  unlinkOrbitUnit: vi.fn(),
  updateUnit: vi.fn(),
  uploadUnitsKmz: vi.fn(),
}));

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: vi.fn(),
}));

vi.mock('../../../services/api/bgtask', () => ({
  BgtaskFailedError: class extends Error {},
  clearPendingUnitMerge: api.clearPendingUnitMerge,
  fetchBgtaskStatusAndLogs: vi.fn(),
  getBgtaskProgressFromPercent: vi.fn(),
  loadPendingUnitMerge: api.loadPendingUnitMerge,
  savePendingUnitMerge: vi.fn(),
  waitForBgtaskCompletion: api.waitForBgtaskCompletion,
}));

import { BgtaskFailedError } from '../../../services/api/bgtask';
import { useRerUnitsPage } from '../use-rer-units-page';

type Page = ReturnType<typeof useRerUnitsPage>;

const activeUnit = { id: 1, name: 'Active', active: true } as Unit;
const inactiveUnit = { id: 2, name: 'Inactive', active: false } as Unit;
let root: Root | null = null;
let latestPage: Page | null = null;

function Harness({ req }: { req: ListUnitsReq }) {
  latestPage = useRerUnitsPage([], req);
  return null;
}

async function flushEffects() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  act(() => root?.unmount());
  root = null;
  latestPage = null;
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

// @test-scope safeguard: prevents a unit-page request from replacing the visible page with mismatched backend data
describe('useRerUnitsPage loading', () => {
  it('loads and replaces bounded backend pages', async () => {
    const activeReq = { limit: 20, offset: 0, filterActive: true } as ListUnitsReq;
    const inactiveReq = {
      limit: 20,
      offset: 20,
      filterActive: false,
      filterText: 'Inactive',
    } as ListUnitsReq;
    api.getUnitsPage.mockImplementation((req: ListUnitsReq) =>
      Promise.resolve(
        req.filterActive
          ? {
              units: [activeUnit],
              totalCount: 1,
              statusCounts: { active: 1, inactive: 50_000 },
              showLoadMore: false,
            }
          : {
              units: [inactiveUnit],
              totalCount: 1,
              statusCounts: { active: 0, inactive: 1 },
              showLoadMore: false,
            },
      ),
    );
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req: activeReq })));
    await flushEffects();

    expect(api.getUnitsPage).toHaveBeenNthCalledWith(
      1,
      activeReq,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([1]);
    expect(latestPage?.totalCount).toBe(1);
    expect(latestPage?.statusCounts).toEqual({ active: 1, inactive: 50_000 });
    expect(api.getUnitIdsWithVisibleAttachments).toHaveBeenNthCalledWith(
      1,
      [1],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );

    await act(async () => root?.render(createElement(Harness, { req: inactiveReq })));
    await flushEffects();

    expect(api.getUnitsPage).toHaveBeenNthCalledWith(
      2,
      inactiveReq,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([2]);
    expect(latestPage?.totalCount).toBe(1);
    expect(latestPage?.statusCounts).toEqual({ active: 0, inactive: 1 });
    expect(api.getUnitIdsWithVisibleAttachments).toHaveBeenNthCalledWith(
      2,
      [2],
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });
});

// @test-scope safeguard: prevents stale post-mutation refreshes from reopening or overwriting the current unit session
describe('useRerUnitsPage mutations', () => {
  it('keeps the terminal merge refresh over a stale mount load', async () => {
    const req = { limit: 20, offset: 0 } as ListUnitsReq;
    let resolveInitial: ((response: unknown) => void) | undefined;
    api.getUnitsPage
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce({
        units: [activeUnit],
        totalCount: 1,
        statusCounts: { active: 1, inactive: 0 },
        showLoadMore: false,
      });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([activeUnit.id]);
    api.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: activeUnit,
      duplicate: inactiveUnit,
    });
    api.waitForBgtaskCompletion.mockResolvedValueOnce(undefined);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    await flushEffects();
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([activeUnit.id]);

    await act(async () => {
      resolveInitial?.({
        units: [activeUnit, inactiveUnit],
        totalCount: 2,
        statusCounts: { active: 1, inactive: 1 },
        showLoadMore: false,
      });
    });
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([activeUnit.id]);
    expect(latestPage?.attachmentUnitIds).toEqual(new Set([activeUnit.id]));
    expect(api.getUnitIdsWithVisibleAttachments).toHaveBeenCalledTimes(1);
  });

  it('refreshes units and attachments after a staged merge fails', async () => {
    const req = { limit: 20, offset: 0 } as ListUnitsReq;
    api.getUnitsPage
      .mockResolvedValueOnce({
        units: [activeUnit, inactiveUnit],
        totalCount: 2,
        statusCounts: { active: 1, inactive: 1 },
        showLoadMore: false,
      })
      .mockResolvedValueOnce({
        units: [activeUnit],
        totalCount: 1,
        statusCounts: { active: 1, inactive: 0 },
        showLoadMore: false,
      });
    api.getUnitIdsWithVisibleAttachments
      .mockResolvedValueOnce([inactiveUnit.id])
      .mockResolvedValueOnce([activeUnit.id]);
    api.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: activeUnit,
      duplicate: inactiveUnit,
    });
    api.waitForBgtaskCompletion.mockRejectedValueOnce(new BgtaskFailedError('Merge failed'));

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    await flushEffects();

    expect(api.clearPendingUnitMerge).toHaveBeenCalledWith(42);
    expect(api.getUnitsPage).toHaveBeenCalledTimes(2);
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([activeUnit.id]);
    expect(latestPage?.attachmentUnitIds).toEqual(new Set([activeUnit.id]));
    expect(latestPage?.dialogError).toContain('Merge failed');
  });

  it('keeps a pending merge active while status polling retries', async () => {
    const req = { limit: 20, offset: 0 } as ListUnitsReq;
    api.getUnitsPage.mockResolvedValue({
      units: [activeUnit, inactiveUnit],
      totalCount: 2,
      statusCounts: { active: 1, inactive: 1 },
      showLoadMore: false,
    });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);
    api.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: activeUnit,
      duplicate: inactiveUnit,
    });
    let completeTask: (() => void) | undefined;
    api.waitForBgtaskCompletion.mockImplementation((_taskId, onProgress, options) => {
      options.onStatusError(new Error('Temporary failure'));
      return new Promise<void>((resolve) => {
        completeTask = () => {
          onProgress(100, 'Done');
          resolve();
        };
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    expect(latestPage?.submitting).toBe(true);
    expect(latestPage?.dialogError).toContain('Temporary failure');
    expect(api.clearPendingUnitMerge).not.toHaveBeenCalled();

    await act(async () => completeTask?.());
    await flushEffects();
    expect(api.clearPendingUnitMerge).toHaveBeenCalledWith(42);
    expect(latestPage?.dialogError).toBeNull();
  });

  it('resumes a pending merge after navigation and stops polling on unmount', async () => {
    const req = { limit: 20, offset: 0 } as ListUnitsReq;
    api.getUnitsPage.mockResolvedValue({
      units: [activeUnit, inactiveUnit],
      totalCount: 2,
      statusCounts: { active: 1, inactive: 1 },
      showLoadMore: false,
    });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);
    api.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: activeUnit,
      duplicate: inactiveUnit,
    });
    let finishTask: (() => void) | undefined;
    api.waitForBgtaskCompletion.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finishTask = resolve;
        }),
    );

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    expect(latestPage?.mergeTarget?.id).toBe(activeUnit.id);
    expect(latestPage?.submitting).toBe(true);
    expect(api.mergeDuplicateUnit).not.toHaveBeenCalled();
    const signal = api.waitForBgtaskCompletion.mock.calls[0][2].signal as AbortSignal;

    await act(async () => root?.unmount());
    root = null;
    expect(signal.aborted).toBe(true);
    finishTask?.();
  });

  it('keeps merge progress monotonic while waiting for the background task', async () => {
    const req = { limit: 20, offset: 0 } as ListUnitsReq;
    api.getUnitsPage.mockResolvedValue({
      units: [activeUnit, inactiveUnit],
      totalCount: 2,
      statusCounts: { active: 1, inactive: 1 },
      showLoadMore: false,
    });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);
    api.mergeDuplicateUnit.mockResolvedValue(42);
    let finishTask: (() => void) | undefined;
    api.waitForBgtaskCompletion.mockImplementation(async (_taskId, onProgress) => {
      onProgress(50, 'Сигнали');
      onProgress(20, 'Повторна перевірка');
      await new Promise<void>((resolve) => {
        finishTask = resolve;
      });
    });

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    await flushEffects();
    act(() => latestPage?.openMergeDialog(activeUnit));

    let merge: Promise<void> | undefined;
    await act(async () => {
      merge = latestPage?.confirmMerge(inactiveUnit);
      await flushEffects();
    });
    expect(api.mergeDuplicateUnit).toHaveBeenCalledWith({
      originalId: activeUnit.id,
      cloneToDeleteId: inactiveUnit.id,
    });
    expect(latestPage?.mergeProgress).toBe(50);
    expect(latestPage?.submitting).toBe(true);
    expect(api.getUnitsPage).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishTask?.();
      await merge;
    });
    expect(latestPage?.mergeTarget).toBe(null);
    expect(latestPage?.submitting).toBe(false);
    expect(api.getUnitsPage).toHaveBeenCalledTimes(2);
  });

  it('closes the create dialog before a slow post-create refresh completes', async () => {
    const req = { limit: 20, offset: 0, filterActive: true } as ListUnitsReq;
    const createdUnit = { id: 515, name: '6 зва', active: true } as Unit;
    api.getUnitsPage
      .mockResolvedValueOnce({
        units: [],
        totalCount: 0,
        statusCounts: { active: 0, inactive: 0 },
        showLoadMore: false,
      })
      .mockImplementationOnce(() => new Promise(() => {}));
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);
    api.createUnit.mockResolvedValue(createdUnit);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req })));
    await flushEffects();

    act(() => latestPage?.openCreateDialog());
    expect(latestPage?.createOpen).toBe(true);

    await act(async () => {
      await latestPage?.submitUnit({
        unit: {
          company: '',
          battalion: '',
          regiment: '',
          division: '',
          army: '6 зва',
          militaryDistrict: '',
          armyRegion: '',
          active: true,
          isDeduplicateCandidate: null,
          comment: '',
          orbitNote: null,
          presentInOrbit: null,
          duplicateUnitIds: [],
        },
        autoNetwork: undefined,
      });
    });

    expect(latestPage?.createOpen).toBe(false);
    expect(latestPage?.submitting).toBe(false);
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([515]);
    expect(api.getUnitsPage).toHaveBeenCalledTimes(2);
  });

  it('does not replace a newer page with a stale post-create refresh', async () => {
    const initialReq = { limit: 20, offset: 0, filterActive: true } as ListUnitsReq;
    const nextReq = { limit: 20, offset: 20, filterActive: false } as ListUnitsReq;
    const createdUnit = { id: 515, name: '6 зва', active: true } as Unit;
    let resolveStaleRefresh: ((response: unknown) => void) | undefined;
    api.getUnitsPage
      .mockResolvedValueOnce({
        units: [],
        totalCount: 0,
        statusCounts: { active: 0, inactive: 0 },
        showLoadMore: false,
      })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveStaleRefresh = resolve;
          }),
      )
      .mockResolvedValueOnce({
        units: [inactiveUnit],
        totalCount: 1,
        statusCounts: { active: 0, inactive: 1 },
        showLoadMore: false,
      });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);
    api.createUnit.mockResolvedValue(createdUnit);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness, { req: initialReq })));
    await flushEffects();

    await act(async () => {
      await latestPage?.submitUnit({
        unit: {
          company: '',
          battalion: '',
          regiment: '',
          division: '',
          army: '6 зва',
          militaryDistrict: '',
          armyRegion: '',
          active: true,
          isDeduplicateCandidate: null,
          comment: '',
          orbitNote: null,
          presentInOrbit: null,
          duplicateUnitIds: [],
        },
        autoNetwork: undefined,
      });
    });

    await act(async () => root?.render(createElement(Harness, { req: nextReq })));
    await flushEffects();

    await act(async () => {
      resolveStaleRefresh?.({
        units: [activeUnit],
        totalCount: 50_000,
        statusCounts: { active: 50_000, inactive: 0 },
        showLoadMore: true,
      });
    });
    await flushEffects();

    expect(latestPage?.units.map((unit) => unit.id)).toEqual([2]);
    expect(latestPage?.totalCount).toBe(1);
    expect(latestPage?.statusCounts).toEqual({ active: 0, inactive: 1 });
  });
});
