import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock('../client', () => ({ postJson: mocks.postJson }));

import { cleanupOrbitOtherUnits } from '../system-settings';

describe('system settings response normalization', () => {
  beforeEach(() => mocks.postJson.mockReset());
  it('maps Orbit cleanup roadblocks and override requests', async () => {
    mocks.postJson.mockResolvedValue({
      deleted_count: 2,
      active_units: [{ id: 7, name: 'Active unit' }],
    });

    await expect(cleanupOrbitOtherUnits(true)).resolves.toEqual({
      deletedCount: 2,
      activeUnits: [{ id: 7, name: 'Active unit' }],
    });
    expect(mocks.postJson).toHaveBeenCalledWith(
      '/api/admin/system-settings/orbit/cleanup-other-units',
      { ignore_active: true },
    );
  });
});
