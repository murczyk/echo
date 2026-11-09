import { expect, test } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

test('@regression #3974 saves report limits, preserves the RER toggle, and restarts only on confirmation', async ({
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
  await page.route('**/api/system-settings/current', (route) =>
    route.fulfill({
      json: {
        ...systemSettingsCurrentResponse(),
        rer_report_enabled: active?.rer_report_enabled ?? false,
      },
    }),
  );
  await page.route('**/api/admin/system-settings/rer-report-enabled', async (route) => {
    active = {
      ...active,
      id: 1,
      created_at: 0,
      updated_at: 0,
      deleted: false,
      rer_report_enabled: route.request().postDataJSON().enabled,
    };
    await route.fulfill({ json: active });
  });
  await page.route('**/api/logins', (route) => route.fulfill({ json: { users: [] } }));
  await page.route('**/api/admin/rer-report/access-list', (route) =>
    route.fulfill({ json: { login_ids: [] } }),
  );
  await page.route('**/api/admin/rer-report/metadata', (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  let restarts = 0;
  await page.route('**/api/admin/restart-report-worker', async (route) => {
    restarts += 1;
    await route.fulfill(
      restarts === 1 ? { status: 500, body: 'Service unavailable' } : { json: true },
    );
  });
  await page.goto('/admin/system-settings-neo#main');
  await expect(page.getByLabel('Одночасних звітів загалом')).toBeHidden();
  await page.getByRole('tab', { name: 'Звіти', exact: true }).click();
  await expect(page).toHaveURL(/#reports$/);
  const global = page.getByLabel('Одночасних звітів загалом');
  const perKind = page.getByLabel('Одночасних звітів кожного типу (крім еталонки)');
  const etalonka = page.getByLabel('Одночасних звітів еталонки');
  await expect(global).toHaveValue('4');
  await expect(perKind).toHaveValue('1');
  await expect(etalonka).toHaveValue('2');
  const rerToggle = page.getByRole('checkbox', { name: 'enable rer report' });
  await rerToggle.check();
  await expect(rerToggle).toBeEnabled();
  await global.fill('8');
  await perKind.fill('2');
  await etalonka.fill('3');
  await page.getByRole('button', { name: /^зберегти$/i }).click();
  await expect
    .poll(() => saves.at(-1))
    .toMatchObject({
      report_global_concurrency: 8,
      report_kind_concurrency: 2,
      report_etalonka_concurrency: 3,
      rer_report_enabled: true,
    });
  await page.reload();
  await expect(global).toHaveValue('8');
  await expect(perKind).toHaveValue('2');
  await expect(etalonka).toHaveValue('3');
  await expect(rerToggle).toBeChecked();
  await page.getByRole('button', { name: 'Перезапустити обробник звітів', exact: true }).click();
  expect(restarts).toBe(0);
  const dialog = page.getByRole('dialog', { name: 'Перезапустити обробник звітів?' });
  await dialog.getByRole('button', { name: 'Перезапустити', exact: true }).click();
  await expect(page.getByText(/Не вдалося перезапустити обробник звітів/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(dialog).toBeHidden();
  await page.getByRole('alert').getByRole('button').click();
  await page.getByRole('button', { name: 'Перезапустити обробник звітів', exact: true }).click();
  await dialog.getByRole('button', { name: 'Перезапустити', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Обробник звітів перезапущено.')).toBeVisible();
  expect(restarts).toBe(2);
});
