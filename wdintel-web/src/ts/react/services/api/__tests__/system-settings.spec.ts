import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock('../client', () => ({ postJson: mocks.postJson }));

import { cleanupOrbitOtherUnits, getRerDutyTestReplayStatus } from '../system-settings';

describe('system settings response normalization', () => {
  beforeEach(() => mocks.postJson.mockReset());
  it('maps replay status', async () => {
    mocks.postJson.mockResolvedValue({
      status: 'running',
      source_count: 5,
      next_source_position: 2,
      generated_count: 7,
      next_emit_at_ms: 123,
    });

    await expect(getRerDutyTestReplayStatus()).resolves.toEqual({
      status: 'running',
      sourceCount: 5,
      nextSourcePosition: 2,
      generatedCount: 7,
      nextEmitAtMs: 123,
    });
  });

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
