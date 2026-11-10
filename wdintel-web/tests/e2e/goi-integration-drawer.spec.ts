import { expect, test, type Locator, type Page } from '@playwright/test';
import type { GoiAdminIntegration } from '../../src/ts/react/services/api/goi-admin';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const integration: GoiAdminIntegration = {
  id: 3,
  ownerOrganismId: 1,
  ownerOrganismName: 'Власник',
  createdAtMs: 0,
  integrationType: 'full',
  serverLabel: 'goi-original',
  sshHost: 'original.test',
  sshUser: 'goi',
  sshPort: 22,
  path: '/fixture/palettes',
  apiHost: 'api.original.test',
  apiPort: 8088,
  apiLogin: 'goi',
  apiPassword: 'original-secret',
  disableGoiToEchoPalitraSync: true,
  pauseWorker: false,
  maintainerLoginId: '',
  accessOrganismIds: [],
  accessLogins: [],
};
const drawer = (page: Page) => page.locator('[aria-labelledby="goi-integration-drawer-title"]');

async function openPage(page: Page, item = integration) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  await page.route('**/api/admin/goi/integrations', (route) =>
    route.fulfill({ json: { items: [item] } }),
  );
  await page.route('**/api/organisms', (route) =>
    route.fulfill({
      json: [
        { id: 1, name: 'Власник' },
        { id: 2, name: 'Доступна організація' },
      ],
    }),
  );
  await page.route('**/api/logins', (route) =>
    route.fulfill({
      json: {
        users: [
          { id: 'maintainer-id', login: 'maintainer' },
          { id: 'reader-id', login: 'reader' },
        ],
      },
    }),
  );
  await page.goto('/admin/goi-integrations-neo');
  await expect(page.getByRole('row', { name: /goi-original/ })).toBeVisible();
}
async function edit(page: Page) {
  await page
    .getByRole('row', { name: /goi-original/ })
    .getByRole('button', { name: 'Редагувати', exact: true })
    .click();
  await expect(drawer(page)).toBeVisible();
}
async function choose(page: Page, form: Locator, label: string, option: string) {
  await form.getByRole('combobox', { name: new RegExp(`^${label}`) }).click();
  await page.getByRole('option', { name: option, exact: true }).click();
}

// Regression: https://github.com/echoua/echo/issues/4108
// These browser flows protect drafts and API side effects when editing state is isolated.
test.describe('GOI integration editor #4108 @regression', () => {
  test('creates latest full draft with owner, maintainer and access after validation', async ({
    page,
  }) => {
    const saves: unknown[] = [];
    await openPage(page);
    await page.route('**/api/admin/goi/integration/upsert', async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({ json: { ...integration, id: 4, serverLabel: 'created-full' } });
    });
    await page.getByRole('button', { name: 'Додати інтеграцію', exact: true }).click();
    const form = drawer(page);
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form.getByText('Вкажіть організм-власник', { exact: true })).toBeVisible();
    expect(saves).toHaveLength(0);
    await choose(page, form, 'Організм-власник', 'Власник');
    const sync = form.getByRole('checkbox', {
      name: 'Вимкнути перенесення палітр з ГОІ в Echo',
      exact: true,
    });
    await expect(sync).toBeDisabled();
    await choose(page, form, 'Відповідальний логін', 'maintainer');
    await sync.uncheck();
    await form.getByRole('checkbox', { name: 'Призупинити воркер', exact: true }).check();
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('latest.test');
    await form.getByRole('textbox', { name: 'SSH user', exact: true }).fill('latest-user');
    await form.getByRole('spinbutton', { name: 'SSH порт', exact: true }).fill('2222');
    await form
      .getByRole('textbox', { name: 'Шлях до палітр', exact: true })
      .fill('/latest/palettes');
    await form.getByRole('textbox', { name: 'API host', exact: true }).fill('api.latest.test');
    await form.getByRole('spinbutton', { name: 'API порт', exact: true }).fill('9090');
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form.getByText('Вкажіть API логін', { exact: true })).toBeVisible();
    expect(saves).toHaveLength(0);
    await form.getByRole('textbox', { name: 'API логін', exact: true }).fill('latest-login');
    await form.getByLabel('API пароль', { exact: true }).fill('latest-password');
    await choose(page, form, 'Доступ для організмів', 'Доступна організація');
    await page.keyboard.press('Escape');
    await choose(page, form, 'Доступ для логінів', 'reader');
    await page.keyboard.press('Escape');
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(saves).toEqual([
      {
        id: null,
        owner_organism_id: 1,
        integration_type: 'full',
        ssh_host: 'latest.test',
        ssh_user: 'latest-user',
        ssh_port: 2222,
        path: '/latest/palettes',
        api_host: 'api.latest.test',
        api_port: 9090,
        api_login: 'latest-login',
        api_password: 'latest-password',
        disable_goi_to_echo_palitra_sync: false,
        pause_worker: true,
        maintainer_login_id: 'maintainer-id',
        access_organism_ids: [2],
        access_logins: ['reader-id'],
      },
    ]);
    await expect(page.getByRole('row', { name: /created-full/ })).toBeVisible();
  });

  test('switches full to simple and back, clears credentials and creates latest simple URL', async ({
    page,
  }) => {
    const saves: unknown[] = [];
    await openPage(page);
    await page.route('**/api/admin/goi/integration/upsert', async (route) => {
      saves.push(route.request().postDataJSON());
      await route.fulfill({
        json: { ...integration, id: 4, integrationType: 'simple', serverLabel: 'created-simple' },
      });
    });
    await page.getByRole('button', { name: 'Додати інтеграцію', exact: true }).click();
    const form = drawer(page);
    await choose(page, form, 'Організм-власник', 'Власник');
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('fallback.test');
    await form.getByRole('textbox', { name: 'SSH user', exact: true }).fill('discard-user');
    await form.getByLabel('API пароль', { exact: true }).fill('discard-secret');
    await choose(page, form, 'Тип інтеграції', 'Проста');
    await expect(form.getByRole('textbox', { name: 'GOI URL', exact: true })).toHaveValue(
      'fallback.test',
    );
    await expect(
      form.getByRole('button', { name: "Перевірити з'єднання", exact: true }),
    ).toHaveCount(0);
    await choose(page, form, 'Тип інтеграції', 'Повна');
    await expect(form.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue('');
    await expect(form.getByRole('textbox', { name: 'SSH user', exact: true })).toHaveValue('');
    await expect(form.getByLabel('API пароль', { exact: true })).toHaveValue('');
    await choose(page, form, 'Тип інтеграції', 'Проста');
    await form.getByRole('textbox', { name: 'GOI URL', exact: true }).fill('');
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(
      form.getByText('Для простої інтеграції вкажіть GOI URL або host', { exact: true }),
    ).toBeVisible();
    expect(saves).toHaveLength(0);
    await form
      .getByRole('textbox', { name: 'GOI URL', exact: true })
      .pressSequentially('https://latest.test/goi', { delay: 35 });
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(saves).toEqual([
      {
        id: null,
        owner_organism_id: 1,
        integration_type: 'simple',
        ssh_host: null,
        ssh_user: null,
        ssh_port: 22,
        path: '/etc/goi/data/palettes',
        api_host: 'https://latest.test/goi',
        api_port: 8088,
        api_login: null,
        api_password: null,
        disable_goi_to_echo_palitra_sync: true,
        pause_worker: false,
        maintainer_login_id: null,
        access_organism_ids: [],
        access_logins: [],
      },
    ]);
  });

  test('keeps declined dirty draft, resets accepted dismissal and retries failed save with latest edits', async ({
    page,
  }) => {
    const saves: Record<string, unknown>[] = [];
    await openPage(page);
    await page.route('**/api/admin/goi/integration/upsert', async (route) => {
      const body = route.request().postDataJSON();
      saves.push(body);
      await route.fulfill(
        saves.length === 1
          ? { status: 500, json: { error: 'fixture save failed' } }
          : { json: { ...integration, sshHost: body.ssh_host, serverLabel: 'saved-retry' } },
      );
    });
    await edit(page);
    const form = drawer(page);
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('discard.test');
    page.once('dialog', async (dialog) => {
      expect(dialog.message()).toBe('Є незбережені зміни. Закрити форму?');
      await dialog.dismiss();
    });
    await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue(
      'discard.test',
    );
    page.once('dialog', (dialog) => dialog.accept());
    await form.getByRole('button', { name: 'Закрити форму', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(saves).toHaveLength(0);
    await edit(page);
    await expect(form.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue(
      'original.test',
    );
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('first.test');
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(
      form.getByText('Помилка збереження: fixture save failed', { exact: true }),
    ).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue(
      'first.test',
    );
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('');
    await form
      .getByRole('textbox', { name: 'SSH host', exact: true })
      .pressSequentially('retry.test', { delay: 50 });
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(saves.map((body) => [body.id, body.ssh_host])).toEqual([
      [3, 'first.test'],
      [3, 'retry.test'],
    ]);
    await expect(page.getByRole('row', { name: /saved-retry/ })).toBeVisible();
  });

  test('edits simple integration and forces sync off when maintainer is removed', async ({
    page,
  }) => {
    let saved: unknown;
    await openPage(page, {
      ...integration,
      integrationType: 'simple',
      apiHost: 'https://original.test',
      maintainerLoginId: 'maintainer-id',
      disableGoiToEchoPalitraSync: false,
      accessOrganismIds: [2],
      accessLogins: ['reader-id'],
    });
    await page.route('**/api/admin/goi/integration/upsert', async (route) => {
      saved = route.request().postDataJSON();
      await route.fulfill({
        json: { ...integration, integrationType: 'simple', serverLabel: 'simple-edited' },
      });
    });
    await edit(page);
    const form = drawer(page);
    await expect(
      form.getByRole('combobox', { name: 'Відповідальний логін', exact: true }),
    ).toHaveValue('maintainer');
    await expect(form.getByRole('combobox', { name: /^Доступ для організмів/ })).toHaveText(
      'Доступна організація',
    );
    await expect(form.getByText('reader', { exact: true })).toBeVisible();
    await form.getByRole('combobox', { name: 'Відповідальний логін', exact: true }).fill('');
    await page.keyboard.press('Escape');
    await expect(
      form.getByRole('checkbox', { name: 'Вимкнути перенесення палітр з ГОІ в Echo', exact: true }),
    ).toBeDisabled();
    await form.getByRole('textbox', { name: 'GOI URL', exact: true }).fill('https://edited.test');
    await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(saved).toMatchObject({
      id: 3,
      integration_type: 'simple',
      api_host: 'https://edited.test',
      maintainer_login_id: null,
      disable_goi_to_echo_palitra_sync: true,
      access_organism_ids: [2],
      access_logins: ['reader-id'],
    });
  });

  test('checks latest SSH values, blocks busy dismissal and retries mocked error', async ({
    page,
  }) => {
    const checks: unknown[] = [];
    let finishCheck!: () => void;
    await openPage(page);
    await page.route('**/api/admin/goi/check-connection', async (route) => {
      checks.push(route.request().postDataJSON());
      if (checks.length === 1) {
        await new Promise<void>((resolve) => {
          finishCheck = resolve;
        });
        await route.fulfill({
          json: { ok: false, error: 'fixture connection failed', listedEntries: [] },
        });
      } else
        await route.fulfill({ json: { ok: true, error: null, listedEntries: ['palette.json'] } });
    });
    await edit(page);
    const form = drawer(page);
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill(' check.test ');
    await form.getByRole('textbox', { name: 'SSH user', exact: true }).fill(' check-user ');
    await form.getByRole('textbox', { name: 'Шлях до палітр', exact: true }).fill('');
    await form.getByRole('button', { name: "Перевірити з'єднання", exact: true }).click();
    await expect.poll(() => checks.length).toBe(1);
    await expect(form.getByRole('button', { name: 'Скасувати', exact: true })).toBeDisabled();
    await expect(form.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await expect(form).toBeVisible();
    finishCheck();
    await expect(form.getByText('fixture connection failed', { exact: true })).toBeVisible();
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill('');
    await form
      .getByRole('textbox', { name: 'SSH host', exact: true })
      .pressSequentially('retry-check.test', { delay: 35 });
    await form.getByRole('button', { name: "Перевірити з'єднання", exact: true }).click();
    await expect(
      form.getByText("З'єднання успішне. Файли: palette.json", { exact: true }),
    ).toBeVisible();
    expect(checks).toEqual([
      {
        ssh_host: 'check.test',
        ssh_user: 'check-user',
        ssh_port: 22,
        path: '/etc/goi/data/palettes',
      },
      {
        ssh_host: 'retry-check.test',
        ssh_user: 'check-user',
        ssh_port: 22,
        path: '/etc/goi/data/palettes',
      },
    ]);
  });

  test('refreshes clean baseline and table from mocked worker setup response', async ({ page }) => {
    let setup: unknown;
    let confirms = 0;
    page.on('dialog', async (dialog) => {
      confirms += 1;
      await dialog.dismiss();
    });
    await openPage(page);
    await page.route('**/api/admin/goi/integration/setup-worker', async (route) => {
      setup = route.request().postDataJSON();
      await route.fulfill({
        json: {
          ...integration,
          sshHost: 'configured.test',
          apiPassword: 'generated-secret',
          serverLabel: 'configured-worker',
        },
      });
    });
    await edit(page);
    const form = drawer(page);
    await form.getByRole('textbox', { name: 'SSH host', exact: true }).fill(' setup.test ');
    await form.getByRole('textbox', { name: 'API host', exact: true }).fill('');
    await form.getByRole('button', { name: 'Налаштувати воркер', exact: true }).click();
    await expect(form.getByRole('textbox', { name: 'SSH host', exact: true })).toHaveValue(
      'configured.test',
    );
    await expect(form.getByLabel('API пароль', { exact: true })).toHaveValue('generated-secret');
    expect(setup).toEqual({
      id: 3,
      ssh_host: 'setup.test',
      ssh_user: 'goi',
      ssh_port: 22,
      path: '/fixture/palettes',
      api_host: 'setup.test',
      api_port: 8088,
    });
    await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(form).not.toBeVisible();
    expect(confirms).toBe(0);
    await expect(page.getByRole('row', { name: /configured-worker/ })).toBeVisible();
    await page
      .getByRole('row', { name: /configured-worker/ })
      .getByRole('button', { name: 'Редагувати', exact: true })
      .click();
    await expect(drawer(page).getByLabel('API пароль', { exact: true })).toHaveValue(
      'generated-secret',
    );
  });
});
