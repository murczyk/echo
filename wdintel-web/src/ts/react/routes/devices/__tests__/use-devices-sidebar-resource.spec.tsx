/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useDevicesSidebarResource } from '.././use-devices-sidebar-resource';

const devicesApiMock = vi.hoisted(() => ({
  getDeviceUnitStats: vi.fn(),
  listDeviceUnits: vi.fn(),
}));
vi.mock('../../../services/api/devices', () => devicesApiMock);

let container: HTMLDivElement | null = null;
let root: Root | null = null;
let latest: ReturnType<typeof useDevicesSidebarResource> | null = null;

function Harness({ canReadUnitCatalog = true }: { canReadUnitCatalog?: boolean }) {
  latest = useDevicesSidebarResource(true, canReadUnitCatalog);
  return null;
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  devicesApiMock.listDeviceUnits.mockResolvedValue([]);
  devicesApiMock.getDeviceUnitStats.mockResolvedValue([]);
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  latest = null;
  vi.clearAllMocks();
});
describe('useDevicesSidebarResource', () => {
  it('keeps a unit-statistics failure in its own retryable resource', async () => {
    devicesApiMock.getDeviceUnitStats
      .mockRejectedValueOnce(new Error('stats unavailable'))
      .mockResolvedValueOnce([{ unit: { id: 7, name: 'Unit' }, count: 3 }]);

    await act(async () => {
      root?.render(<Harness />);
    });
    await flush();

    expect(latest?.loaded).toBe(false);
    expect(latest?.error).toContain('stats unavailable');

    await act(async () => {
      await latest?.reload();
    });

    expect(latest?.loaded).toBe(true);
    expect(latest?.error).toBeNull();
    expect(latest?.unitStats).toEqual([{ unit: { id: 7, name: 'Unit' }, count: 3 }]);
  });

  it('does not load the full unit catalog without analytical write access', async () => {
    const unitStats = [{ unit: { id: 7, name: 'Visible unit' }, count: 3 }];
    devicesApiMock.getDeviceUnitStats.mockResolvedValue(unitStats);

    await act(async () => {
      root?.render(<Harness canReadUnitCatalog={false} />);
    });
    await flush();

    expect(devicesApiMock.listDeviceUnits).not.toHaveBeenCalled();
    expect(devicesApiMock.getDeviceUnitStats).toHaveBeenCalledTimes(1);
    expect(latest?.units).toEqual([]);
    expect(latest?.unitStats).toEqual(unitStats);
  });
});
