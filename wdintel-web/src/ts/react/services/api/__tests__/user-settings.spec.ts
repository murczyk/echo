import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}));

vi.mock('../client', () => ({
  getJson: (...args: unknown[]) => mocks.getJson(...args),
  putJson: (...args: unknown[]) => mocks.putJson(...args),
}));

import { fetchUserSettings } from '../user-settings';

describe('user-settings api', () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
    mocks.putJson.mockReset();
  });

  // @test-scope parser: defaults optional fields omitted by older user-settings responses
  it('defaults optional settings when the backend omits them', async () => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });

    await expect(fetchUserSettings()).resolves.toEqual({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
      mediaSummaryEnabled: false,
      messageTextPreviewLines: 20,
      messageSortBy: 'interception',
    });
  });

  // @test-scope parser: normalizes nullable media-preview fields from user-settings responses
  it.each([
    ['null', null, true],
    ['explicit false', false, false],
    ['explicit true', true, true],
  ])('normalizes %s media-preview preferences', async (_, dutyCollapseMediaPreviews, expected) => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      dutyCollapseMediaPreviews,
    });

    await expect(fetchUserSettings()).resolves.toMatchObject({
      dutyCollapseMediaPreviews: expected,
    });
  });

  // @test-scope parser: normalizes nullable media-summary fields from user-settings responses
  it.each([
    ['null', null, false],
    ['explicit false', false, false],
    ['explicit true', true, true],
  ])('normalizes %s media-summary preferences', async (_, mediaSummaryEnabled, expected) => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      mediaSummaryEnabled,
    });

    await expect(fetchUserSettings()).resolves.toMatchObject({
      mediaSummaryEnabled: expected,
    });
  });

  // @test-scope parser: normalizes legacy message-preview values from user-settings responses
  it.each([
    ['twenty', 20],
    ['Twenty', 20],
    ['forty', 40],
    ['Forty', 40],
    ['off', null],
    ['Off', null],
    ['unknown', 20],
  ])('normalizes message preview value %s', async (wireValue, expected) => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      messageTextPreviewLines: wireValue,
      messageSortBy: 'interception',
    });

    await expect(fetchUserSettings()).resolves.toMatchObject({
      messageTextPreviewLines: expected,
      messageSortBy: 'interception',
    });
  });
});
