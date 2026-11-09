import { expect, test } from '@playwright/test';

import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { emptyUnitsListResponse, systemSettingsCurrentResponse } from './fixture-responses';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

test('#3940 РЕР mode saves and reloads the inverse hide_networks value @regression', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  let active: Record<string, unknown> = { id: 1, deleted: false, hide_networks: true };
  await page.route('**/api/admin/system-settings/list', (route) =>
    route.fulfill({ json: { items: [active] } }),
  );
  await page.route('**/api/admin/system-settings/create', async (route) => {
    active = { ...route.request().postDataJSON(), id: 1, deleted: false };
    await route.fulfill({ json: active });
  });
  await page.goto('/admin/system-settings-neo#main');
  const toggle = page.getByRole('checkbox', { name: 'Режим РЕР' });
  await expect(toggle).not.toBeChecked();
  await toggle.locator('xpath=ancestor::label').locator('svg').hover();
  await expect(page.getByRole('tooltip')).toContainText(
    'показати радіомережі. групи за замовчуванням закриті, фільтри за замовчуванням відкриті. оптимізований дизайн картки перехопення під роботу РЕР',
  );
  await toggle.check();
  await page.getByRole('button', { name: /зберегти/i }).click();
  await expect.poll(() => active.hide_networks).toBe(false);
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await page.getByRole('button', { name: /зберегти/i }).click();
  await expect.poll(() => active.hide_networks).toBe(true);
  await page.reload();
  await expect(toggle).not.toBeChecked();
});

for (const host of ['analysis', 'duty'] as const) {
  test(`#3940 РЕР mode moves metadata into the card header (${host}) @regression`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1512, height: 1080 });
    const response = createLoadedInboxResponse();
    const unit = 'Тестовий підрозділ із довгою назвою для перевірки перенесення тексту';
    Object.assign(response.inbox_items[0][1], {
      unit: 'Stored unit label',
      unit_display: unit,
      location: 'Тестова локація',
      groupMasterKey: 'Тестова група',
      sender: 'Тестовий відправник',
      networkIds: [7, 8],
    });
    const options = {
      inboxResponse: response,
      signalGroups: ['Тестова група'],
      networkInfoResponse: [
        { id: 7, name: 'Альфа', unit_ids: [], location: null },
        { id: 8, name: 'Браво', unit_ids: [], location: null },
      ],
    };
    if (host === 'analysis') await installAnalysisNeoApiMocks(page, options);
    else await installRerDutyShortStateMocks(page, options);
    await page.route('**/api/sigint/units', (route) =>
      route.fulfill({ json: emptyUnitsListResponse() }),
    );
    let hideNetworks = false;
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({ json: systemSettingsCurrentResponse({ hideNetworks }) }),
    );
    const path = host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo';
    await page.goto(path);
    const card = page.locator('.message-card-root').first();
    const header = card.locator('[data-message-card-header-left="true"]');
    const details = card.locator('.message-card-details-region');
    await expect(header.locator('[data-message-card-network-item="true"]')).toHaveCount(2);
    await expect(header).toContainText('Альфа');
    await expect(header).toContainText('Браво');
    for (const text of ['Тестова група', 'Тестовий відправник', 'Тестова локація']) {
      await expect(header).toContainText(text);
      await expect(details).not.toContainText(text);
    }
    await expect(header).not.toContainText(unit);
    await expect(details.getByTitle(unit, { exact: true })).toBeVisible();
    await expect(details).toContainText('123.4');
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-bs-theme', theme),
        theme,
      );
      for (const width of [1512, 768, 390]) {
        await page.setViewportSize({ width, height: 1080 });
        if (host === 'analysis' && width <= 768) await page.keyboard.press('Escape');
        await expect(header).toBeVisible();
        await expect(details.getByTitle(unit, { exact: true })).toBeVisible();
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await card.screenshot({ path: testInfo.outputPath(`${host}-${theme}-${width}.png`) });
      }
    }
    Object.assign(response.inbox_items[0][1], { networkIds: [] });
    await page.goto(path);
    await expect(header).toContainText('Тестова локація');
    await expect(header).not.toContainText(unit);
    await expect(details.getByTitle(unit, { exact: true })).toBeVisible();
    await expect(header.locator('[data-message-card-network-item="true"]')).toHaveCount(0);
    Object.assign(response.inbox_items[0][1], { networkIds: [7, 8] });
    hideNetworks = true;
    await page.goto(path);
    await expect(header.locator('[data-message-card-header-unit-row="true"]')).toContainText(unit);
    await expect(details).not.toContainText(unit);
    await expect(details).toContainText('Тестова група');
    await expect(details).toContainText('Тестовий відправник');
    await expect(details).toContainText('Тестова локація');
    await expect(card.locator('[data-message-card-network-item="true"]')).toHaveCount(0);
  });
}
