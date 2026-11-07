import { expect, test } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

for (const width of [375, 1200]) {
  // Regression: https://github.com/echoua/echo/issues/3598
  test(`@regression #3598 preserves loaded RER settings after metadata fails (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({
        json: { ...systemSettingsCurrentResponse(), rer_report_enabled: true },
      }),
    );
    await page.route('**/api/logins', (route) => route.fulfill({ json: { users: [] } }));
    await page.route('**/api/admin/rer-report/access-list', (route) =>
      route.fulfill({ json: { login_ids: [] } }),
    );
    let metadataFails = true;
    await page.route('**/api/admin/rer-report/metadata', (route) =>
      route.fulfill(
        metadataFails ? { status: 500, body: 'Metadata unavailable' } : { json: { items: [] } },
      ),
    );
    await page.route('**/api/admin/system-settings/list', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.goto('/admin/system-settings-neo?globalFilter=unit#reports');

    const toggle = page.getByRole('checkbox', { name: 'enable rer report' });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Додати новий' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Повторити завантаження' })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('globalFilter')).toBe('unit');

    metadataFails = false;
    await page.getByRole('button', { name: 'Повторити завантаження' }).click();
    await expect(page.getByRole('button', { name: 'Повторити завантаження' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Додати новий' })).toBeEnabled();
    await expect(toggle).toBeChecked();
    await page.getByRole('button', { name: 'Додати новий' }).click();
    await expect(page.getByRole('dialog', { name: 'Додати метадані РЕР' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}

for (const width of [375, 1200]) {
  test(`@regression #3940 saves one report name and rejects a different parent (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({ json: { ...systemSettingsCurrentResponse(), rer_report_enabled: true } }),
    );
    await page.route('**/api/logins', (route) => route.fulfill({ json: { users: [] } }));
    await page.route('**/api/admin/rer-report/access-list', (route) =>
      route.fulfill({ json: { login_ids: [] } }),
    );
    await page.route('**/api/admin/system-settings/list', (route) =>
      route.fulfill({ json: { items: [] } }),
    );
    await page.route('**/api/admin/rer-report/metadata', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 1,
              sigint_unit_id: 1,
              sigint_unit_name: 'Підрозділ А',
              report_parent_context: JSON.stringify(['', '', '1 А', '', '1 мсд']),
              sigint_unit_active: true,
              sigint_unit_deleted: false,
              report_name: 'Спільна назва',
              locations: [],
            },
          ],
        },
      }),
    );
    await page.route('**/api/sigint/units', (route) =>
      route.fulfill({
        json: {
          units: [
            { id: 2, name: 'Підрозділ Б', army: '1 А', division: '2 мсд' },
            { id: 4, name: 'Підрозділ Б', army: '1 А', division: '3 мсд' },
            { id: 3, name: 'Підрозділ без ієрархії', army: '1 А', regiment: '1 полк' },
            { id: 5, name: 'Та сама дивізія', army: '1 А', division: '1 мсд', brigade: '2 бр' },
            { id: 6, name: 'Лише бригада', army: '1 А', brigade: '1 бр' },
          ],
        },
      }),
    );
    const created: Record<string, unknown>[] = [];
    await page.route('**/api/admin/rer-report/metadata/create', (route) => {
      const request = route.request().postDataJSON() as Record<string, unknown>;
      created.push(request);
      return route.fulfill({
        json: {
          ...request,
          id: 2,
          sigint_unit_name: 'Підрозділ Б',
          report_parent_context: JSON.stringify(['', '', '1 А', '', '2 мсд']),
          sigint_unit_active: true,
          sigint_unit_deleted: false,
        },
      });
    });
    await page.goto(
      `/admin/system-settings-neo?sorting=${encodeURIComponent(JSON.stringify([{ id: 'labels', desc: false }]))}#reports`,
    );
    await page.getByRole('button', { name: 'Додати новий' }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('Підрозділ Б');
    await expect(page.getByRole('option', { name: 'Підрозділ Б (#4)', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Підрозділ Б (#2)', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Назва для звіту' })).toHaveValue(
      'Підрозділ Б',
    );
    await dialog.getByRole('textbox', { name: 'Назва для звіту' }).fill('Спільна назва');
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
    await expect(dialog.getByText(/іншою ієрархією/)).toBeVisible();
    expect(created).toHaveLength(0);
    await dialog.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('Та сама дивізія');
    await page.getByRole('option', { name: 'Та сама дивізія', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeEnabled();
    await dialog.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('Лише бригада');
    await page.getByRole('option', { name: 'Лише бригада', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
    await dialog
      .getByRole('combobox', { name: 'Підрозділ', exact: true })
      .fill('Підрозділ без ієрархії');
    await page.getByRole('option', { name: 'Підрозділ без ієрархії', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeEnabled();
    await dialog.getByRole('combobox', { name: 'Підрозділ', exact: true }).fill('Підрозділ Б');
    await page.getByRole('option', { name: 'Підрозділ Б (#2)', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
    await dialog.getByRole('textbox', { name: 'Назва для звіту' }).fill('Нова назва');
    await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(created).toEqual([{ sigint_unit_id: 2, locations: [], report_name: 'Нова назва' }]);
    await expect(page.getByText('Нова назва', { exact: true })).toBeVisible();
  });
}
