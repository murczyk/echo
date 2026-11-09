import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

// Regression: https://github.com/echoua/echo/issues/3064
for (const width of [1280, 390]) {
  test(`#3064 personal AI position display opt-in persists at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page);
    await page.route('**/api/sigint/zones/list', (route) => route.fulfill({ json: [] }));
    let globallyEnabled = false;
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({
        json: {
          ...systemSettingsCurrentResponse(),
          ai_position_highlights_enabled: globallyEnabled,
        },
      }),
    );
    let settings: Record<string, unknown> = {
      tagsLayout: 'compact',
      messageTextPreviewLines: 'twenty',
      aiPositionHighlightsEnabled: false,
    };
    const saves: Record<string, unknown>[] = [];
    await page.route('**/api/user/settings', async (route) => {
      if (route.request().method() === 'PUT') {
        settings = route.request().postDataJSON();
        saves.push(settings);
      }
      await route.fulfill({ json: settings });
    });
    await page.goto('/settings-neo?section=duty');
    const toggle = page.getByRole('checkbox', { name: /Показувати ШІ-позиції/ });
    await expect(toggle).not.toBeChecked();
    await expect(toggle).toBeEnabled();
    await toggle.check();
    await expect.poll(() => saves.at(-1)?.aiPositionHighlightsEnabled).toBe(true);
    await page.reload();
    await expect(toggle).toBeChecked();
    await page.goto('/settings-neo?section=analysis');
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await expect.poll(() => saves.at(-1)?.aiPositionHighlightsEnabled).toBe(false);
    globallyEnabled = true;
    await page.reload();
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeDisabled();
  });
}

// Regression: https://github.com/echoua/echo/issues/3064
test('#3064 admin AI position display flag saves independently of processing @regression', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  let active: Record<string, unknown> | null = null;
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/admin/system-settings/list', (route) =>
    route.fulfill({ json: { items: active ? [active] : [] } }),
  );
  await page.route('**/api/admin/system-settings/create', async (route) => {
    const values = route.request().postDataJSON();
    saves.push(values);
    active = { ...values, id: 1, created_at: 0, updated_at: 0, deleted: false };
    await route.fulfill({ json: active });
  });
  await page.goto('/admin/system-settings-neo');
  const toggle = page.getByRole('checkbox', { name: /Показувати ШІ-позиції всім користувачам/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  const save = page.getByRole('button', { name: /зберегти/i });
  await save.click();
  await expect.poll(() => saves.at(-1)?.ai_position_highlights_enabled).toBe(true);
  await page.reload();
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await save.click();
  await expect.poll(() => saves.at(-1)?.ai_position_highlights_enabled).toBe(false);
});

for (const width of [1280, 390]) {
  test(`admin Main settings use aligned selectable switch rows in bordered groups at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    let active: Record<string, unknown> | null = null;
    await page.route('**/api/admin/system-settings/list', (route) =>
      route.fulfill({ json: { items: active ? [active] : [] } }),
    );
    await page.route('**/api/admin/system-settings/create', async (route) => {
      const values = route.request().postDataJSON();
      active = { ...values, id: 1, created_at: 0, updated_at: 0, deleted: false };
      await route.fulfill({ json: active });
    });
    await page.goto('/admin/system-settings-neo#main');

    const titles = [
      'Інтерфейс і значення за замовчуванням',
      'Безпека',
      'Обробка повідомлень',
      'Можливості системи',
      'Службова обробка',
    ];
    for (const title of titles) {
      const heading = page.getByRole('heading', { name: title });
      await expect(heading).toBeVisible();
      await expect(heading.locator('xpath=../..')).toHaveCSS('border-top-width', '1px');
    }

    const exactMatch = page.getByRole('checkbox', {
      name: 'Прапорець «точний збіг за еталонкою» на Аналізі увімкнений',
    });
    const hideNetworks = page.getByRole('checkbox', { name: 'Режим РЕР' });
    await expect(exactMatch).toBeChecked();
    await exactMatch.uncheck();
    await expect(exactMatch).not.toBeChecked();
    const exactMatchRow = exactMatch.locator('xpath=ancestor::label');
    const hideNetworksRow = hideNetworks.locator('xpath=ancestor::label');
    await expect(exactMatchRow).toHaveCSS('margin-left', '0px');
    await expect(hideNetworksRow).toHaveCSS('margin-left', '0px');
    await expect(exactMatchRow).toHaveCSS('align-items', 'center');
    await expect(hideNetworksRow).toHaveCSS('align-items', 'center');
    await expect(exactMatchRow.locator('p')).toHaveCSS('font-weight', '400');
    await expect(hideNetworksRow.locator('svg').locator('..')).toHaveCSS('align-items', 'center');
    await page.getByRole('button', { name: /зберегти/i }).click();
    await page.reload();
    await expect(exactMatch).not.toBeChecked();
  });
}
