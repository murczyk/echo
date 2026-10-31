import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const login = {
  id: 'd2e7f61e-1e15-447d-8e5f-1e4880f1b2b4',
  login: 'local-login',
  roles: ['Rer'],
  createdAt: 0,
  deleted: false,
  sigintZoneId: 1,
  sigintZoneName: 'Зона',
  organismId: 2,
  organismName: 'Організм',
  organismEnabled: true,
  deltaLogin: 'delta-login',
  lastActiveAt: null,
  deactivationReason: null,
  signalProfileId: null,
  description: null,
  passwordAuthEnabled: false,
  hasPassword: false,
  totpEnabled: false,
};
const inactiveLogin = {
  ...login,
  deleted: true,
  deactivationReason: 'Inactive',
  lastActiveAt: 1_700_000_000_000,
  organismEnabled: false,
};

const overflowingLogins = Array.from({ length: 60 }, (_, index) => ({
  ...login,
  id: `overflow-login-${index}`,
  login: `overflow-login-${index}`,
  deltaLogin: `overflow-delta-${index}`,
}));

async function installAdminUsersApiMocks(
  page: import('@playwright/test').Page,
  users = [inactiveLogin],
) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/users/messenger-profiles', (route) =>
    route.fulfill({ json: { data: {} } }),
  );
  await page.route('**/api/logins', (route) => route.fulfill({ json: { users } }));
  await page.route('**/api/sigint/zones/list', (route) =>
    route.fulfill({ json: [[1, { id: 1, name: 'Зона' }]] }),
  );
  await page.route('**/api/organisms', (route) =>
    route.fulfill({
      json: [
        { id: 2, name: 'Організм', enabled: true },
        { id: 3, name: 'Інший організм', enabled: true },
      ],
    }),
  );
}

for (const width of [1280, 390]) {
  test(`Admin Users dialogs follow visual keyboard order at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    let createRequests = 0;
    await page.route('**/api/users/messenger-profiles', (route) =>
      route.fulfill({ json: { data: {} } }),
    );
    await page.route('**/api/logins', (route) =>
      route.fulfill({ json: { users: [inactiveLogin] } }),
    );
    await page.route('**/api/login/create', (route) => {
      createRequests += 1;
      if (createRequests === 1) {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify([['login', 'Логін зайнятий']]),
        });
      }
      return route.fulfill({ json: { ...login, id: 'created-login' } });
    });
    await page.route('**/api/sigint/zones/list', (route) =>
      route.fulfill({ json: [[1, { id: 1, name: 'Зона' }]] }),
    );
    await page.route('**/api/organisms', (route) =>
      route.fulfill({
        json: [
          { id: 2, name: 'Організм', enabled: true },
          { id: 3, name: 'Інший організм', enabled: true },
        ],
      }),
    );

    await page.goto('/admin/users-neo');
    const users = page.locator('users-neo');
    const status = users.locator('.admin-user-status');
    await expect(status).toContainText('Деактивовано через неактивність');
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await status.evaluate((element) => {
      const cell = element.parentElement;
      if (cell) cell.style.width = '120px';
    });
    expect(await status.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );
    await users.getByRole('button', { name: 'Додати користувача' }).click();
    const dialog = page.getByRole('dialog', { name: 'Додати користувача' });
    expect(
      await dialog.evaluate((element) => element instanceof HTMLFormElement && element.noValidate),
    ).toBe(true);
    await expect(dialog.getByRole('heading', { name: 'Вхід' })).toHaveCount(0);
    const localLogin = dialog.getByRole('textbox', { name: 'Логін', exact: true });
    const deltaLogin = dialog.getByRole('textbox', { name: 'Delta логін', exact: true });
    await expect(localLogin).toBeFocused();
    await expect(deltaLogin).toBeVisible();
    await page.keyboard.press('Tab');
    await expect(deltaLogin).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByLabel('Вхід за паролем')).toBeFocused();

    const localBox = await localLogin.boundingBox();
    const deltaBox = await deltaLogin.boundingBox();
    expect(localBox).not.toBeNull();
    expect(deltaBox).not.toBeNull();
    if (width >= 768) {
      expect(Math.abs(localBox!.y - deltaBox!.y)).toBeLessThan(2);
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(768);
    } else {
      expect(deltaBox!.y).toBeGreaterThan(localBox!.y);
      expect((await dialog.boundingBox())!.width).toBeLessThanOrEqual(width - 32);
    }
    const dialogContent = dialog.locator('.MuiDialogContent-root');
    expect(
      await dialogContent.evaluate((element) => element.scrollHeight <= element.clientHeight),
    ).toBe(true);

    await dialog.getByLabel('Вхід за паролем').check();
    const password = dialog.getByRole('textbox', { name: 'Пароль', exact: true });
    await expect(password).toBeVisible();
    await dialog.getByLabel('Вхід за паролем').uncheck();
    await expect(password).toBeHidden();
    await page.keyboard.press('Shift+Tab');
    await expect(deltaLogin).toBeFocused();

    await localLogin.fill('created-local-login');
    await deltaLogin.fill('created-delta-login');
    await dialog.evaluate((form) => {
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    });
    await expect.poll(() => createRequests).toBe(0);
    await expect(dialog.getByText('Виберіть організм')).toBeVisible();
    const createOrganism = dialog.getByRole('combobox', { name: 'Організм', exact: true });
    await createOrganism.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await localLogin.focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => createRequests).toBe(1);
    await expect(localLogin).toHaveAttribute('aria-invalid', 'true');
    expect(
      await localLogin.evaluate((element) =>
        element
          .getAttribute('aria-describedby')
          ?.split(' ')
          .map((id) => document.getElementById(id)?.textContent)
          .join(' '),
      ),
    ).toContain('Логін зайнятий');
    await localLogin.fill('created-local-login-retry');
    await page.keyboard.press('Enter');
    await expect.poll(() => createRequests).toBe(2);
    await expect(dialog).toBeHidden();

    await users.getByRole('button', { name: 'Редагувати' }).first().click();

    const editDialog = page.getByRole('dialog', { name: 'Редагувати користувача' });
    const editLocalLogin = editDialog.getByRole('textbox', { name: 'Логін', exact: true });
    const editDeltaLogin = editDialog.getByRole('textbox', { name: 'Delta логін', exact: true });
    await expect(editLocalLogin).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(editDeltaLogin).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(editDialog.getByLabel('Вхід за паролем')).toBeFocused();
    await expect(editDialog.getByRole('heading', { name: 'Вхід' })).toHaveCount(0);

    const organism = editDialog.getByRole('combobox', { name: 'Організм', exact: true });
    const roles = editDialog.getByRole('combobox', { name: /^Ролі/ });
    const zone = editDialog.getByRole('combobox', { name: 'Зона', exact: true });
    const organismBox = await organism.boundingBox();
    const rolesBox = await roles.boundingBox();
    const zoneBox = await zone.boundingBox();
    expect(organismBox).not.toBeNull();
    expect(rolesBox).not.toBeNull();
    expect(zoneBox).not.toBeNull();
    expect(rolesBox!.y).toBeGreaterThan(organismBox!.y);
    if (width >= 768) {
      expect(Math.abs(rolesBox!.y - zoneBox!.y)).toBeLessThan(12);
    } else {
      expect(zoneBox!.y).toBeGreaterThan(rolesBox!.y);
    }

    await organism.click();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(editDialog).toBeVisible();

    const notes = editDialog.getByRole('textbox', { name: 'Нотатка', exact: true });
    await notes.fill('first line');
    await notes.press('Enter');
    await expect(notes).toHaveValue('first line\n');

    const activeLabel = editDialog.getByText('Активний', { exact: true });
    const activeHelper = editDialog.getByText('Вимкнення блокує доступ після збереження.');
    expect((await activeHelper.boundingBox())!.y).toBeGreaterThan(
      (await activeLabel.boundingBox())!.y,
    );
  });
}

for (const width of [390, 1000, 1280]) {
  test(`Admin Users table keeps rows reachable at ${width}px @regression`, async ({ page }) => {
    await page.setViewportSize({ width, height: 480 });
    await installAdminUsersApiMocks(page, overflowingLogins);
    await page.goto('/admin/users-neo');

    const users = page.locator('users-neo');
    const tableContainer = users.locator('.MuiTableContainer-root');
    await expect(tableContainer).toBeVisible();
    expect(
      await tableContainer.evaluate((element) => element.scrollHeight > element.clientHeight),
    ).toBe(true);
    await tableContainer.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    await expect(users.getByText('overflow-login-59', { exact: true })).toBeVisible();

    expect(await users.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
      true,
    );

    if (width >= 1000) {
      const search = users.getByPlaceholder('Пошук');
      const tableActions = users.locator('#active-filters-button');
      const searchBox = await search.boundingBox();
      const actionsBox = await tableActions.boundingBox();
      expect(searchBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(Math.abs(searchBox!.y - actionsBox!.y)).toBeLessThan(4);
    }
  });
}

test('Admin Users search clearing updates URL, rows, and the active-filter badge @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installAdminUsersApiMocks(page, overflowingLogins);
  await page.goto(
    '/admin/users-neo?columnFilters=%5B%7B%22id%22%3A%22login%22%2C%22value%22%3A%22overflow-login-1%22%7D%5D',
  );

  const users = page.locator('users-neo');
  const search = users.getByPlaceholder('Пошук');
  await expect(users.getByText('overflow-login-1', { exact: true })).toBeVisible();
  await search.fill('overflow-login-10');
  await expect(page).toHaveURL(/globalFilter=overflow-login-10/);
  await expect(users.getByText('overflow-login-10', { exact: true })).toBeVisible();
  await search.press('Escape');

  await expect(page).not.toHaveURL(/globalFilter=/);
  await expect(users.getByText('overflow-login-1', { exact: true })).toBeVisible();
  await expect(
    users.locator('#active-filters-button').locator('..').locator('.MuiBadge-badge'),
  ).not.toHaveClass(/MuiBadge-invisible/);
});

test('Admin Users clear-search button hides the badge when no column filters remain @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installAdminUsersApiMocks(page, overflowingLogins);
  await page.goto('/admin/users-neo');

  const users = page.locator('users-neo');
  const search = users.getByPlaceholder('Пошук');
  const badge = users.locator('#active-filters-button').locator('..').locator('.MuiBadge-badge');
  await expect(users.locator('tbody tr')).toHaveCount(overflowingLogins.length);
  await expect(badge).toHaveClass(/MuiBadge-invisible/);

  await search.fill('overflow-login-10');
  await expect(page).toHaveURL(/globalFilter=overflow-login-10/);
  await expect(users.locator('tbody tr')).toHaveCount(1);
  await expect(badge).not.toHaveClass(/MuiBadge-invisible/);
  await users.getByRole('button', { name: 'clear-filter', exact: true }).click();

  await expect(search).toHaveValue('');
  await expect(page).not.toHaveURL(/globalFilter=/);
  await expect(users.locator('tbody tr')).toHaveCount(overflowingLogins.length);
  await expect(badge).toHaveClass(/MuiBadge-invisible/);
});

for (const width of [1280, 390]) {
  test(`@regression #3935 role cards supported add, edit and delete at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAdminUsersApiMocks(page);
    let settings = [
      { role: 'Rer', unitRequired: true, deviceRequired: false, allowUnitCreation: false },
    ];
    const saves: unknown[] = [];
    await page.route('**/api/admin/role-message-settings/*', async (route) => {
      const operation = new URL(route.request().url()).pathname.split('/').pop();
      if (operation === 'list')
        return route.fulfill({ json: { settings, roles: ['Admin', 'Rer', 'Cyber'] } });
      const request = route.request().postDataJSON();
      if (operation === 'delete') {
        settings = settings.filter(({ role }) => role !== request.role);
        return route.fulfill({ json: null });
      }
      saves.push(request);
      settings = [...settings.filter(({ role }) => role !== request.role), request];
      return route.fulfill({ json: request });
    });
    await page.goto('/admin/users-neo');
    const tabs = page.getByRole('tab');
    await expect(tabs.nth(0)).toHaveText('Всі користувачі');
    await expect(tabs.nth(1)).toHaveText('Налаштування ролей');
    await tabs.nth(1).click();
    await expect(page.getByRole('article', { name: 'Налаштування ролі Rer' })).toBeVisible();
    await page.getByRole('button', { name: 'Додати налаштування', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
    await dialog.getByRole('combobox', { name: 'Роль' }).click();
    await expect(page.getByRole('option', { name: 'Rer', exact: true })).toHaveCount(0);
    await page.getByRole('option', { name: 'Cyber', exact: true }).click();
    await dialog.getByRole('checkbox', { name: 'Обов’язковий підрозділ' }).check();
    await dialog.getByRole('checkbox', { name: 'Обов’язкова назва пристрою' }).check();
    await dialog.getByRole('button', { name: 'Зберегти' }).click();
    const card = page.getByRole('article', { name: 'Налаштування ролі Cyber' });
    await expect(card).toBeVisible();
    expect(saves[0]).toEqual({
      role: 'Cyber',
      unitRequired: true,
      deviceRequired: true,
      allowUnitCreation: true,
    });
    await card.getByRole('button', { name: 'Редагувати' }).click();
    await expect(dialog.getByRole('combobox', { name: 'Роль' })).toBeDisabled();
    await dialog.getByRole('checkbox', { name: 'Дозволено створювати підрозділи' }).uncheck();
    await dialog.getByRole('button', { name: 'Зберегти' }).click();
    await expect(dialog).toHaveCount(0);
    expect(saves[1]).toEqual({
      role: 'Cyber',
      unitRequired: true,
      deviceRequired: true,
      allowUnitCreation: false,
    });
    await card.getByRole('button', { name: 'Видалити' }).click();
    await dialog.getByRole('button', { name: 'Видалити' }).click();
    await expect(card).toHaveCount(0);
    await page.getByRole('button', { name: 'Додати налаштування', exact: true }).click();
    await dialog.getByRole('combobox', { name: 'Роль' }).click();
    await expect(page.getByRole('option', { name: 'Cyber', exact: true })).toBeVisible();
  });
}
