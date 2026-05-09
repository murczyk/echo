import { expect, test } from '@playwright/test';

import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

test.describe('@smoke', () => {
  test('rer-duty-neo hydrates filters from short state id', async ({ page }) => {
    const shortStateId = 'short-1';
    const fixture = await installRerDutyShortStateMocks(page, { shortStateId });

    await page.goto(`/rer-duty-neo?state-short=${shortStateId}`);

    await expect.poll(() => fixture.getLastInboxRequest()).toEqual(
      expect.objectContaining({ selected_groups: ['group-1'] }),
    );
  });

  test('rer-duty-neo falls back when short state id is missing', async ({ page }) => {
    const fixture = await installRerDutyShortStateMocks(page, { shortStateId: 'short-1' });

    await page.goto('/rer-duty-neo?state-short=missing');
    await expect.poll(() => fixture.getLastInboxRequest()).toEqual(
      expect.objectContaining({ selected_groups: null }),
    );
  });
});
