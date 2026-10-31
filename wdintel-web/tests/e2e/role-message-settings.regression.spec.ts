import { expect, test } from '@playwright/test';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { openCreateReportDrawer } from './image-editor-drawer.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

test.use({ viewport: { width: 1600, height: 1000 } });

for (const flow of ['message', 'report'] as const) {
  test(`@regression #3935 ${flow} enforced required fields and restricted inline unit creation`, async ({
    page,
  }) => {
    const submissions: Record<string, unknown>[] = [];
    let settingsRequests = 0;
    const installRules = async () => {
      await page.route('**/api/1.1/submit-direct/settings', async (route) => {
        settingsRequests += 1;
        await route.fulfill({
          json: {
            unitRequired: true,
            deviceRequired: flow === 'message',
            allowUnitCreation: false,
          },
        });
      });
    };
    if (flow === 'message') {
      await installRerDutyShortStateMocks(page, {
        signalGroups: ['editor-e2e-group'],
        userRoles: ['Admin', 'Rer'],
      });
      await installRules();
      await page.route('**/api/system-settings/current', (route) =>
        route.fulfill({
          json: { ...systemSettingsCurrentResponse(), devices_section_enabled: true },
        }),
      );
      await page.goto('/rer-duty-neo');
      expect(settingsRequests).toBe(0);
      await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    } else {
      await openCreateReportDrawer(page, installRules);
    }
    await expect.poll(() => settingsRequests).toBe(1);
    await page.route('**/api/sigint/unit/search', (route) =>
      route.fulfill({
        json: {
          units:
            route.request().postDataJSON().search === 'Немає такого підрозділу'
              ? []
              : [{ id: 3935, name: 'Підрозділ 3935', active: true }],
        },
      }),
    );
    await page.route('**/api/sigint/device-name/create', (route) =>
      route.fulfill({ json: { device: { id: 3935, name: 'Пристрій 3935' } } }),
    );
    await page.route('**/api/1.1/submit-direct', (route) => {
      submissions.push(route.request().postDataJSON());
      return route.fulfill({ json: { signal_message_id: 3935 } });
    });
    const body = page.getByRole('textbox', {
      name: flow === 'message' ? 'Текст повідомлення' : 'Текст розвіддонесення',
    });
    await body.fill('Повідомлення 3935');
    const group = page.getByRole('combobox', {
      name: flow === 'message' ? 'Група' : 'Відправити в групу',
      exact: true,
    });
    await group.click();
    await page
      .getByRole('option')
      .filter({ hasText: flow === 'message' ? 'editor-e2e-group' : 'Не відправляти' })
      .first()
      .click();
    const submit = page.getByRole('button', { name: 'Створити', exact: true });
    await expect(submit).toBeDisabled();
    const unit = page.getByRole('combobox', { name: 'Підрозділ', exact: true });
    const emptySearch = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/sigint/unit/search') &&
        response.request().postDataJSON()?.search === 'Немає такого підрозділу',
    );
    await unit.fill('Немає такого підрозділу');
    await emptySearch;
    await unit.press('ArrowDown');
    await expect(page.getByRole('option', { name: /Додати Підрозділ/ })).toHaveCount(0);
    await unit.fill('Підрозділ 3935');
    await page.getByRole('option', { name: 'Підрозділ 3935', exact: true }).click();
    if (flow === 'message') {
      await expect(submit).toBeDisabled();
      await page.getByRole('combobox', { name: 'Назва пристрою' }).fill('Пристрій 3935');
    }
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => submissions.length).toBe(1);
    expect(submissions[0]).toMatchObject({ unit_id: 3935 });
  });
}

test('@regression #3935 creation settings failures blocked saving and could be retried', async ({
  page,
}) => {
  await installRerDutyShortStateMocks(page, { signalGroups: ['editor-e2e-group'] });
  let failing = true;
  let requests = 0;
  await page.route('**/api/1.1/submit-direct/settings', (route) => {
    requests += 1;
    return failing
      ? route.fulfill({ status: 500, body: 'Rules unavailable' })
      : route.fulfill({
          json: { unitRequired: false, deviceRequired: false, allowUnitCreation: true },
        });
  });
  await page.goto('/rer-duty-neo');
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  const editor = page.locator('[data-manage-message-presentation]');
  await expect(editor.getByText(/Не вдалося завантажити налаштування ролей/)).toBeVisible();
  await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('Повідомлення 3935');
  await page.getByRole('combobox', { name: 'Група', exact: true }).click();
  await page.getByRole('option').filter({ hasText: 'editor-e2e-group' }).first().click();
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
  failing = false;
  await editor.getByRole('button', { name: 'Повторити', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Створити', exact: true })).toBeEnabled();
  expect(requests).toBe(2);
});
