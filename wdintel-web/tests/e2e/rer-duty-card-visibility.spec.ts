import { expect, test } from '@playwright/test';

import { createLoadedInboxResponse } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

test('#4219 Duty card hides the header, frequency and unit chosen in settings @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installRerDutyShortStateMocks(page, {
    inboxResponse: createLoadedInboxResponse(),
    userRoles: ['Rer'],
  });
  await page.route('**/api/sigint/zones/list', (route) => route.fulfill({ json: [] }));
  let settings: Record<string, unknown> = {
    tagsLayout: 'compact',
    disableAutoScroll: false,
    dutyHideCardHeader: true,
    dutyHideCardFrequency: true,
    dutyHideCardUnit: true,
  };
  await page.route('**/api/user/settings', async (route) => {
    if (route.request().method() === 'PUT') settings = route.request().postDataJSON();
    await route.fulfill({ json: settings });
  });

  await page.goto('/rer-duty-neo');
  const card = page.locator('.message-card-root').first();
  await expect(card).toContainText('Analysis summary fixture message');
  await expect(card.locator('[data-message-card-header-left="true"]')).toHaveCount(0);
  await expect(card).not.toContainText('123.4');
  await expect(card).not.toContainText('Analysis Unit');
  await expect(
    card.getByRole('button', { name: 'Створити розвіддонесення', exact: true }),
  ).toBeVisible();

  await page.goto('/settings-neo?section=duty');
  const header = page.getByRole('checkbox', { name: /^Заголовок/ });
  const frequency = page.getByRole('checkbox', { name: 'Частота', exact: true });
  const unit = page.getByRole('checkbox', { name: 'Підрозділ', exact: true });
  await expect(header).not.toBeChecked();
  await expect(unit).not.toBeChecked();
  await frequency.check();
  await expect.poll(() => settings.dutyHideCardFrequency).toBe(false);
  expect(settings).toMatchObject({ dutyHideCardHeader: true, dutyHideCardUnit: true });
  await header.check();
  await expect.poll(() => settings.dutyHideCardHeader).toBe(false);

  await page.goto('/rer-duty-neo');
  await expect(card).toContainText('123.4');
  await expect(card.locator('[data-message-card-header-left="true"]')).toHaveCount(1);
  await expect(card).not.toContainText('Analysis Unit');

  await page.goto('/settings-neo?section=analysis');
  await expect(page.getByRole('checkbox', { name: 'Частота', exact: true })).toHaveCount(0);
});
