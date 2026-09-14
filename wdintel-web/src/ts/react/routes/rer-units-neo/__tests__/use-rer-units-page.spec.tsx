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
}));

vi.mock('../../../services/api/units', () => ({
  createUnit: api.createUnit,
  createUnitWithAutoNetwork: vi.fn(),
  deleteUnit: vi.fn(),
  getUnitsPage: api.getUnitsPage,
  getUnitDetails: vi.fn(),
  getUnitIdsWithVisibleAttachments: api.getUnitIdsWithVisibleAttachments,
  mergeDuplicateUnit: vi.fn(),
  unlinkOrbitUnit: vi.fn(),
  updateUnit: vi.fn(),
  uploadUnitsKmz: vi.fn(),
}));

vi.mock('../../../services/api/system-settings', () => ({
  currentSystemSettings: vi.fn(),
}));

vi.mock('../../../services/api/bgtask', () => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
  getBgtaskProgressFromPercent: vi.fn(),
}));

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
