import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getJson: vi.fn(),
}));

vi.mock('../client', () => ({
  getJson: (...args: unknown[]) => mocks.getJson(...args),
}));

import { fetchUserSettings } from '../user-settings';

describe('user-settings api', () => {
  beforeEach(() => {
    mocks.getJson.mockReset();
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
    });
  });
});
