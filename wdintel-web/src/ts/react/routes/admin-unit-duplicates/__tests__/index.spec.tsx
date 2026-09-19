/** @vitest-environment happy-dom */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Unit, UnitDuplicate } from '../../../../../Bindings';

const mocks = vi.hoisted(() => ({
  getUnitDuplicates: vi.fn(),
  mergeDuplicateUnit: vi.fn(),
  searchUnitsStrictThenRelaxed: vi.fn(),
}));
const taskMocks = vi.hoisted(() => ({
  clearPendingUnitMerge: vi.fn(),
  loadPendingUnitMerge: vi.fn(),
  waitForBgtaskCompletion: vi.fn(),
}));

vi.mock('../../../services/api/units', () => ({ ...mocks, DEFAULT_LIST_UNITS_REQ: {} }));
vi.mock('../../../services/api/bgtask', () => ({
  BgtaskFailedError: class extends Error {},
  clearPendingUnitMerge: taskMocks.clearPendingUnitMerge,
  loadPendingUnitMerge: taskMocks.loadPendingUnitMerge,
  savePendingUnitMerge: vi.fn(),
  waitForBgtaskCompletion: taskMocks.waitForBgtaskCompletion,
}));

import { AdminUnitDuplicatesPage } from '../index';
describe('AdminUnitDuplicatesPage', () => {
  beforeEach(() => {
    const storage = new Map<string, string>();
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
        clear: () => storage.clear(),
      },
    });
    mocks.getUnitDuplicates.mockReset().mockResolvedValue([]);
    mocks.mergeDuplicateUnit.mockReset();
    mocks.searchUnitsStrictThenRelaxed.mockReset().mockResolvedValue([]);
    taskMocks.clearPendingUnitMerge.mockReset();
    taskMocks.loadPendingUnitMerge.mockReset().mockReturnValue(null);
    taskMocks.waitForBgtaskCompletion.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('keeps polling a pending merge after a temporary status failure', async () => {
    taskMocks.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: { id: 1, name: 'Original' } as Unit,
      duplicate: { id: 2, name: 'Duplicate' } as Unit,
    });
    let completeTask: (() => void) | undefined;
    taskMocks.waitForBgtaskCompletion.mockImplementation((_taskId, onProgress, options) => {
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
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitDuplicatesPage authUserRoles={[]} />));
    expect(document.body.textContent).toContain('Temporary failure');
    expect(taskMocks.clearPendingUnitMerge).not.toHaveBeenCalled();

    await act(async () => completeTask?.());
    expect(taskMocks.clearPendingUnitMerge).toHaveBeenCalledWith(42);
    await act(async () => root.unmount());
  });

  it('keeps the terminal merge refresh over a stale mount load', async () => {
    let resolveInitial: ((units: UnitDuplicate[]) => void) | undefined;
    mocks.getUnitDuplicates
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveInitial = resolve;
          }),
      )
      .mockResolvedValueOnce([]);
    taskMocks.loadPendingUnitMerge.mockReturnValueOnce({
      taskId: 42,
      original: { id: 1, name: 'Original' } as Unit,
      duplicate: { id: 2, name: 'Duplicate' } as Unit,
    });
    taskMocks.waitForBgtaskCompletion.mockResolvedValueOnce(undefined);
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => root.render(<AdminUnitDuplicatesPage authUserRoles={[]} />));
    expect(mocks.getUnitDuplicates).toHaveBeenCalledTimes(2);

    await act(async () =>
      resolveInitial?.([
        {
          sigintUnit: {
            id: 2,
            name: 'Stale duplicate',
            other: '',
            teamOrCrew: '',
            section: '',
            squad: '',
            platoon: '',
            company: '',
            battalion: '',
            regiment: '',
            brigade: '',
            division: '',
            corps: '',
            army: '',
            militaryDistrict: '',
            armyRegion: '',
          } as Unit,
          orbitUnitId: 'stale',
          orbitUnitFullName: 'Stale Orbit unit',
        },
      ]),
    );
    expect(container.textContent).not.toContain('Stale duplicate');
    await act(async () => root.unmount());
  });
});
