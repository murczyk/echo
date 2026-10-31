import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
  putJson: vi.fn(),
}));

vi.mock('../client', () => ({
  getJson: (...args: unknown[]) => mocks.getJson(...args),
  putJson: (...args: unknown[]) => mocks.putJson(...args),
}));

import { fetchUserSettings, saveUserSettings } from '../user-settings';

describe('user-settings api', () => {
  it('#3927 preserves the quick action through load, save, and later settings edits', async () => {
    mocks.getJson.mockResolvedValueOnce({
      tagsLayout: 'compact',
      disableAutoScroll: false,
      messageCardQuickAction: 'copyText',
    });
    const settings = await fetchUserSettings();
    expect(settings.messageCardQuickAction).toBe('copyText');
    mocks.putJson.mockImplementationOnce(async (_path, body) => body);
    const saved = await saveUserSettings({ ...settings, tagsLayout: 'hidden' });
    expect(saved.messageCardQuickAction).toBe('copyText');
    expect(mocks.putJson).toHaveBeenCalledWith(
      '/api/user/settings',
      expect.objectContaining({ messageCardQuickAction: 'copyText', tagsLayout: 'hidden' }),
      { signal: undefined },
    );
  });

  it.each([undefined, null, 'unsupported'])(
    '#3927 falls back for legacy or unknown quick action %s',
    async (messageCardQuickAction) => {
      mocks.getJson.mockResolvedValueOnce({
        tagsLayout: 'compact',
        disableAutoScroll: false,
        messageCardQuickAction,
      });
      expect((await fetchUserSettings()).messageCardQuickAction).toBe('createReport');
    },
  );

  beforeEach(() => {
    mocks.getJson.mockReset();
    mocks.putJson.mockReset();
  });
  it.each([
    ['twenty', 20],
    ['Twenty', 20],
    ['forty', 40],
    ['Forty', 40],
    ['off', null],
    ['Off', null],
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
      largeMediaPreviews: false,
      largeMessageCardText: false,
    });
  });
});
