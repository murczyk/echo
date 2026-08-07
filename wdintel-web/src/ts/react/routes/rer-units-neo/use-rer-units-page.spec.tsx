/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Unit } from '../../../../Bindings';

const api = vi.hoisted(() => ({
  getAllUnitsList: vi.fn(),
  getUnitStatusCounts: vi.fn(),
  getUnitIdsWithVisibleAttachments: vi.fn(),
}));

vi.mock('../../services/api/units', () => ({
  createUnit: vi.fn(),
  createUnitWithAutoNetwork: vi.fn(),
  deleteUnit: vi.fn(),
  getAllUnitsList: api.getAllUnitsList,
  getUnitDetails: vi.fn(),
  getUnitIdsWithVisibleAttachments: api.getUnitIdsWithVisibleAttachments,
  getUnitStatusCounts: api.getUnitStatusCounts,
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

function Harness() {
  latestPage = useRerUnitsPage([]);
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
  it('loads active units first and inactive units on demand', async () => {
    api.getAllUnitsList.mockImplementation(({ includeInactive } = {}) =>
      Promise.resolve(includeInactive ? [activeUnit, inactiveUnit] : [activeUnit]),
    );
    api.getUnitStatusCounts.mockResolvedValue({ active: 1, inactive: 1 });
    api.getUnitIdsWithVisibleAttachments.mockResolvedValue([]);

    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(createElement(Harness)));
    await flushEffects();

    expect(api.getAllUnitsList).toHaveBeenNthCalledWith(1);
    expect(latestPage?.units.map((unit) => unit.id)).toEqual([1]);
    expect(latestPage?.statusCounts).toEqual({ active: 1, inactive: 1 });

    act(() => latestPage?.setStatusFilter('inactive'));
    await flushEffects();

    expect(api.getAllUnitsList).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ includeInactive: true, signal: expect.any(AbortSignal) }),
    );
    expect(latestPage?.visibleUnits.map((unit) => unit.id)).toEqual([2]);
  });
});
