/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ListUnitsReq, Unit } from '../../../../Bindings';

const api = vi.hoisted(() => ({
  getUnitsPage: vi.fn(),
  getUnitIdsWithVisibleAttachments: vi.fn(),
}));

vi.mock('../../services/api/units', () => ({
  createUnit: vi.fn(),
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

vi.mock('../../services/api/system-settings', () => ({
  currentSystemSettings: vi.fn(),
}));

vi.mock('../../services/api/bgtask', () => ({
  fetchBgtaskStatusAndLogs: vi.fn(),
  getBgtaskProgressFromPercent: vi.fn(),
}));

import { useRerUnitsPage } from './use-rer-units-page';

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
