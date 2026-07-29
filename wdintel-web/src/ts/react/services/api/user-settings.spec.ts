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
    });
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
      },
      { signal: undefined },
    );
  });
});
