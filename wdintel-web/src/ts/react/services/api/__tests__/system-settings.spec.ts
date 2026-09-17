import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock('../client', () => ({ postJson: mocks.postJson }));

import { getRerDutyTestReplayStatus, listSystemSettings } from '../system-settings';

const rawSettings = {
  id: 1,
  rer_analysis_units_exact_match_only_default: true,
  rer_duty_test_enabled: false,
  rer_duty_insert_historical_interceptions: false,
  rer_duty_test_since_ms: 0,
  rer_duty_test_limit: 1,
  rer_duty_poll_interval_sec: 1,
  created_at: 1,
  updated_at: 1,
  deleted: false,
  short_url_enabled: false,
};

describe('system settings audio transcription mapping', () => {
  beforeEach(() => mocks.postJson.mockReset());

  // @test-scope parser: defaults missing optional backend flags from a system-settings response
  it('defaults an absent backend flag to false', async () => {
    mocks.postJson.mockResolvedValue({ items: [rawSettings] });
    const settings = await listSystemSettings();
    expect(settings[0].enableAudioTranscription).toBe(false);
    expect(settings[0].showPelengDistanceToBattleline).toBe(false);
    expect(settings[0].disableBotTags).toBe(false);
  });

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
