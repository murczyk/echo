import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ postJson: vi.fn() }));

vi.mock('./client', () => ({ postJson: mocks.postJson }));

import { createSystemSettings, listSystemSettings } from './system-settings';

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

  it('defaults an absent backend flag to false', async () => {
    mocks.postJson.mockResolvedValue({ items: [rawSettings] });
    const settings = await listSystemSettings();
    expect(settings[0].enableAudioTranscription).toBe(false);
  });

  it('writes the audio transcription flag in create requests', async () => {
    mocks.postJson.mockResolvedValue({
      ...rawSettings,
      enable_audio_transcription: true,
    });
    await createSystemSettings({
      rerAnalysisUnitsExactMatchOnlyDefault: true,
      rerDutyTestEnabled: false,
      rerDutyInsertHistoricalInterceptions: false,
      rerDutyTestSinceMs: 0,
      rerDutyTestLimit: 1,
      rerDutyPollIntervalSec: 1,
      rerDutyShortUrl: false,
      supportNonRerInterceptions: false,
      defaultNeoAnalysis: false,
      autofixEchoimMissingMessages: false,
      devicesSectionEnabled: false,
      sigintCommentParsingEnabled: false,
      doNotStoreDuplicateEchoimFailures: false,
      enableAudioTranscription: true,
      pelengBoundsEnabled: false,
      pelengBoundsTopLeftLat: null,
      pelengBoundsTopLeftLng: null,
      pelengBoundsBottomRightLat: null,
      pelengBoundsBottomRightLng: null,
      echoRestapiErrorDiscordWebhookUrl: null,
    });
    expect(mocks.postJson).toHaveBeenCalledWith(
      '/api/admin/system-settings/create',
      expect.objectContaining({ enable_audio_transcription: true }),
    );
  });
});
