import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}));

vi.mock('./client', () => ({
  getJson: (...args: unknown[]) => mocks.getJson(...args),
  putJson: (...args: unknown[]) => mocks.putJson(...args),
}));

import { fetchUserSettings, saveUserSettings } from './user-settings';

describe('user-settings api', () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
    mocks.putJson.mockReset();
  });

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
      messageTextPreviewLines: 20,
    });
  });

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

  it.each([
    [20, 'twenty'],
    [40, 'forty'],
    [null, 'off'],
  ] as const)('serializes message preview value %s', async (value, wireValue) => {
    mocks.putJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      messageTextPreviewLines: wireValue,
    });

    await saveUserSettings({
      tagsLayout: 'compact',
      messageTextPreviewLines: value,
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: false,
    });

    expect(mocks.putJson).toHaveBeenCalledWith(
      '/api/user/settings',
      expect.objectContaining({ messageTextPreviewLines: wireValue }),
      { signal: undefined },
    );
  });

  it('serializes duty settings when saving', async () => {
    mocks.putJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: true,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: false,
      messageTextPreviewLines: 'twenty',
    });

    await saveUserSettings({
      tagsLayout: 'full',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: true,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: false,
    });

    expect(mocks.putJson).toHaveBeenCalledWith(
      '/api/user/settings',
      {
        tagsLayout: 'full',
        disableAutoScroll: true,
        analysisMapInSidebar: false,
        dutyAudioTranscriptionCollapsed: true,
        analysisAudioTranscriptionCollapsed: false,
        showAnalysisCallsignAddForm: false,
        showClassicDuty: false,
        showClassicAnalysis: false,
        dutyCollapseMediaPreviews: false,
        messageTextPreviewLines: 'twenty',
      },
      { signal: undefined },
    );
  });

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
    });

    await expect(fetchUserSettings()).resolves.toMatchObject({
      messageTextPreviewLines: expected,
    });
  });

  it('serializes an enabled media-preview preference', async () => {
    mocks.putJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      dutyCollapseMediaPreviews: true,
    });

    await saveUserSettings({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: false,
      dutyAudioTranscriptionCollapsed: false,
      analysisAudioTranscriptionCollapsed: false,
      showAnalysisCallsignAddForm: false,
      showClassicDuty: false,
      showClassicAnalysis: false,
      dutyCollapseMediaPreviews: true,
    });

    expect(mocks.putJson).toHaveBeenCalledWith(
      '/api/user/settings',
      expect.objectContaining({ dutyCollapseMediaPreviews: true }),
      { signal: undefined },
    );
  });
});
