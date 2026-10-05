import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

test('@regression #3660 admin can save media cache limits and disable caching', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/system-settings/current', async (route) => {
    await route.fulfill({
      json: { ...systemSettingsCurrentResponse(), exclude_orbit_other_units: true },
    });
  });
  let active: Record<string, unknown> | null = null;
  const saves: Record<string, unknown>[] = [];
  await page.route('**/api/admin/system-settings/list', async (route) => {
    await route.fulfill({ json: { items: active ? [active] : [] } });
  });
  await page.route('**/api/admin/system-settings/create', async (route) => {
    const values = route.request().postDataJSON();
    saves.push(values);
    active = { ...values, id: 1, created_at: 0, updated_at: 0, deleted: false };
    await route.fulfill({ json: active });
  });
  await page.goto('/admin/system-settings-neo#cache');
  const toggle = page.getByRole('checkbox', { name: 'Увімкнути локальний кеш медіа' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await page.getByLabel('Зберігання медіа (години)').fill('48');
  await page.getByLabel('Максимальний розмір кешу (ГіБ)').fill('64');
  await page.getByLabel('Резерв вільного місця (ГіБ)').fill('12');
  const save = page.getByRole('button', { name: /зберегти/i });
  await save.click();
  await expect(save).toBeDisabled();
  expect(saves[0]).toMatchObject({
    messenger_media_cache_enabled: true,
    messenger_media_cache_retention_hours: 48,
    messenger_media_cache_max_size_gib: 64,
    messenger_media_cache_min_free_gib: 12,
  });
  await page.reload();
  await expect(toggle).toBeChecked();
  await expect(page.getByLabel('Зберігання медіа (години)')).toHaveValue('48');
  await page.getByLabel('Зберігання медіа (години)').fill('23');
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Кеш медіа' })).toContainText(
    'від 24 до 8760 годин',
  );
  expect(saves).toHaveLength(1);
  await page.getByLabel('Зберігання медіа (години)').fill('48');
  await toggle.uncheck();
  await save.click();
  await expect(save).toBeDisabled();
  expect(saves[1]).toMatchObject({ messenger_media_cache_enabled: false });
});
