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

  it('defaults table row numbers to enabled when the backend omits the field', async () => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });

    await expect(fetchUserSettings()).resolves.toEqual({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      analysisMapInSidebar: true,
    });
  });

  it('serializes duty settings when saving', async () => {
    mocks.putJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
    });

    await saveUserSettings({
      tagsLayout: 'full',
      disableAutoScroll: true,
      analysisMapInSidebar: false,
    });

    expect(mocks.putJson).toHaveBeenCalledWith(
      '/api/user/settings',
      {
        tagsLayout: 'full',
        disableAutoScroll: true,
        analysisMapInSidebar: false,
      },
      { signal: undefined },
    );
  });
});
