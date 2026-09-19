import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock('../client', () => ({ postJson: mocks.postJson }));

import { getRerDutyTestReplayStatus } from '../system-settings';

describe('system settings response normalization', () => {
  beforeEach(() => mocks.postJson.mockReset());

  // @test-scope parser: normalizes replay-status fields from a backend response
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
});
