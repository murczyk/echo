import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function install(page: Page, role = 'OrganismAdmin') {
  await installAnalysisNeoApiMocks(page, { userRoles: [role] });
  const organism = {
    id: 2,
    parent_id: null,
    name: 'Свій організм',
    roles: ['Basic', 'Rer', 'OrganismAdmin'],
    enabled: true,
    created_at: 0,
    aor_ids: [11],
    logins_count: 1,
  };
  const member = {
    id: '019a0fd8-a021-7f19-ab9b-a9d432052648',
    login: 'member-one',
    organism_id: 2,
    roles: ['Rer'],
    created_at: 0,
    last_active_at: null,
    organism_enabled: true,
    description: null,
    signal_profile_id: null,
    sigint_zone_id: null,
    delta_login: null,
    deleted: false,
    password_auth_enabled: true,
    has_password: true,
    totp_enabled: false,
  };
  let labels: Array<{ id: number; organism_id: number; name: string; color: string }> = [];
  let assignments: Array<{ login_id: string; label_id: number }> = [];
  let excludedLoginIds: string[] = [];
  const assigned: unknown[] = [];
  const exclusions: unknown[] = [];
  const protectedMember = {
    ...member,
    id: '019a0fd8-a021-7f19-ab9b-a9d432052649',
    login: 'service-user',
    roles: ['No2FA'],
  };
  await page.route('**/api/organisms', (route) => route.fulfill({ json: [organism] }));
  await page.route('**/api/organism/all-groups', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/organism/group-list', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/organism/available-groups-batch', (route) =>
    route.fulfill({ json: {} }),
  );
  await page.route('**/api/organism/compute-available-groups', (route) =>
    route.fulfill({ json: [] }),
  );
  await page.route('**/api/sigint/aor', (route) => route.fulfill({ json: [] }));
  let users = [member, protectedMember];
  const createdUsers: unknown[] = [];
  const updatedUsers: unknown[] = [];
  await page.route('**/api/login/create', (route) => {
    const req = route.request().postDataJSON();
    createdUsers.push(req);
    const created = {
      ...member,
      ...req,
      id: '019a0fd8-a021-7f19-ab9b-a9d432052650',
      sigint_zone_id: 1,
    };
    users = [...users, created];
    return route.fulfill({ json: created });
  });
  await page.route('**/api/login/update', (route) => {
    const req = route.request().postDataJSON();
    updatedUsers.push(req);
    const updated = { ...users.find((user) => user.id === req.id), ...req };
    users = users.map((user) => (user.id === req.id ? updated : user));
    return route.fulfill({ json: updated });
  });
  await page.route('**/api/logins', (route) => route.fulfill({ json: { users } }));
  await page.route('**/api/organism/user-labels', (route) =>
    route.fulfill({ json: { labels, assignments, excluded_login_ids: excludedLoginIds } }),
  );
  await page.route('**/api/organism/message-stats-exclusion', (route) => {
    const req = route.request().postDataJSON();
    expect(req.organism_id).toBe(2);
    exclusions.push(req);
    excludedLoginIds = excludedLoginIds.filter((id) => id !== req.login_id);
    if (req.excluded) excludedLoginIds.push(req.login_id);
    return route.fulfill({ json: null });
  });
  await page.route('**/api/organism/user-labels/upsert', (route) => {
    const req = route.request().postDataJSON();
    expect(req.organism_id).toBe(2);
    const label = { ...req, id: req.id ?? 42 };
    labels = [...labels.filter((item) => item.id !== label.id), label];
    return route.fulfill({ json: label });
  });
  await page.route('**/api/organism/user-labels/assign', (route) => {
    const req = route.request().postDataJSON();
    assigned.push(req);
    assignments = req.label_id === null ? [] : [{ login_id: req.login_id, label_id: req.label_id }];
    return route.fulfill({ json: null });
  });
  await page.route('**/api/organism/user-labels/delete', (route) => {
    const req = route.request().postDataJSON();
    labels = labels.filter((item) => item.id !== req.label_id);
    assignments = [];
    return route.fulfill({ json: null });
  });
  return { assigned, exclusions, createdUsers, updatedUsers };
}

test('@regression #3873 excludes users from message statistics, including protected accounts', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/admin/organisms-neo/edit?id=2');
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  const checkbox = page.getByRole('checkbox', {
    name: 'Виключити зі статистики повідомлень: service-user',
    exact: true,
  });
  await expect(checkbox).not.toBeChecked();
  await checkbox.click();
  await expect(checkbox).toBeChecked();
  await page.reload();
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  await expect(checkbox).toBeChecked();
  await checkbox.click();
  await expect(checkbox).not.toBeChecked();
  await expect
    .poll(() => fixture.exclusions)
    .toEqual(
      [true, false].map((excluded) => ({
        organism_id: 2,
        login_id: '019a0fd8-a021-7f19-ab9b-a9d432052649',
        excluded,
      })),
    );
});

test('@regression #3873 reports a statistics exclusion save failure without changing the setting', async ({
  page,
}) => {
  await install(page);
  await page.route('**/api/organism/message-stats-exclusion', (route) =>
    route.fulfill({ status: 500, body: 'Не вдалося виключити користувача' }),
  );
  await page.goto('/admin/organisms-neo/edit?id=2');
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  const checkbox = page.getByRole('checkbox', {
    name: 'Виключити зі статистики повідомлень: member-one',
    exact: true,
  });
  await checkbox.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося виключити користувача' }).first(),
  ).toBeVisible();
  await expect(checkbox).not.toBeChecked();
  await expect(checkbox).toBeEnabled();
});

test('@regression #3873 organism administrator manages labels and assigns only one per user', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/admin/organisms-neo');
  await expect(page.getByText('Свій організм', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Створити організм', exact: true })).toHaveCount(0);
  await page.goto('/admin/organisms-neo/edit?id=2');
  await expect(page.getByRole('combobox', { name: 'Батьківський організм' })).toBeDisabled();
  for (const name of ['Смуги', 'Ролі', 'Обмежити групами']) {
    await expect(page.getByRole('combobox', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByText('Доступні групи для організму', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Обмежити перелік груп' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Лейбли користувачів' }).click();
  await page.getByRole('button', { name: 'Створити лейбл' }).click();
  await page.getByRole('textbox', { name: 'Назва лейбла' }).fill('Аналітика');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByText('Аналітика', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  await page.getByRole('combobox', { name: 'Лейбл: member-one' }).click();
  await page.getByRole('option', { name: 'Аналітика', exact: true }).click();
  await expect
    .poll(() => fixture.assigned)
    .toEqual([{ organism_id: 2, login_id: '019a0fd8-a021-7f19-ab9b-a9d432052648', label_id: 42 }]);
  await expect(page.getByRole('combobox', { name: 'Лейбл: member-one' })).toContainText(
    'Аналітика',
  );
  await page.getByRole('button', { name: 'Додати користувача' }).click();
  await page.getByRole('dialog').getByRole('combobox', { name: /^Ролі/ }).click();
  await expect(page.getByRole('option', { name: 'Admin', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await page.getByRole('tab', { name: 'Лейбли користувачів' }).click();
  await page.getByRole('button', { name: 'Видалити', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Без лейбла');
  await dialog.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(page.getByText('Лейблів ще немає.')).toBeVisible();
});

test('@regression #3873 keeps organism management usable on a narrow screen', async ({ page }) => {
  await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/admin/organisms-neo/edit?id=2');
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Лейбл: member-one' })).toBeVisible();
  await expect(
    page.getByRole('checkbox', {
      name: 'Виключити зі статистики повідомлень: member-one',
      exact: true,
    }),
  ).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
});

for (const role of ['Admin', 'OrganismAdmin']) {
  test(`@regression #3873 keeps remote GOI worker operations restricted for ${role}`, async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { userRoles: [role] });
    await page.route('**/api/organisms', (route) =>
      route.fulfill({ json: [{ id: 2, name: 'Свій організм', enabled: true }] }),
    );
    await page.route('**/api/logins', (route) => route.fulfill({ json: { users: [] } }));
    await page.route('**/api/admin/goi/integrations', (route) =>
      route.fulfill({
        json: {
          items: [
            {
              id: 7,
              owner_organism_id: 2,
              owner_organism_name: 'Свій організм',
              created_at_ms: 0,
              integration_type: 'full',
              server_label: 'Local GOI',
              ssh_host: '127.0.0.1',
              ssh_user: 'test',
              ssh_port: 22,
              path: '/tmp',
              api_host: '127.0.0.1',
              api_port: 8088,
              api_login: 'test',
              api_password: 'test',
              disable_goi_to_echo_palitra_sync: true,
              pause_worker: true,
              maintainer_login_id: null,
              access_organism_ids: [2],
              access_logins: [],
            },
          ],
        },
      }),
    );
    await page.goto('/admin/goi-integrations-neo');
    await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Редагувати інтеграцію ГОІ', exact: true }),
    ).toBeVisible();
    const editor = page;
    await expect(editor.getByRole('button', { name: 'Зберегти', exact: true })).toBeVisible();
    for (const name of ["Перевірити з'єднання", 'Налаштувати воркер']) {
      const action = editor.getByRole('button', { name, exact: true });
      if (role === 'Admin') await expect(action).toBeVisible();
      else await expect(action).toHaveCount(0);
    }
  });
}

test('@regression #3873 reuses user forms within organism administrator permissions', async ({
  page,
}) => {
  const fixture = await install(page);
  const forbiddenReads: string[] = [];
  page.on('request', (request) => {
    if (
      /api\/(sigint\/(zones\/list|aor)|organism\/(all-groups|group-list|compute-available-groups)|users\/messenger-profiles)$/.test(
        new URL(request.url()).pathname.replace(/^\//, ''),
      )
    )
      forbiddenReads.push(request.url());
  });
  await page.goto('/admin/organisms-neo/edit?id=2');
  await page.getByRole('tab', { name: 'Користувачі', exact: true }).click();
  await expect(page.getByRole('link', { name: 'member-one', exact: true })).toHaveCount(0);
  await expect(
    page
      .getByRole('row')
      .filter({ hasText: 'service-user' })
      .getByRole('button', { name: 'Редагувати', exact: true }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Додати користувача', exact: true }).click();
  const dialog = page.getByRole('dialog');
  for (const name of ['Організм', 'Зона'])
    await expect(dialog.getByRole('combobox', { name, exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('textbox', { name: 'Delta логін', exact: true })).toHaveCount(0);
  await dialog.getByRole('textbox', { name: 'Логін', exact: true }).fill('new-member');
  await dialog.getByLabel(/^Пароль/).fill('test-password');
  await dialog.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.createdUsers).toEqual([
    expect.objectContaining({
      login: 'new-member',
      organism_id: 2,
      roles: ['Basic'],
      password: 'test-password',
      password_auth_enabled: true,
      sigint_zone_id: null,
      delta_login: null,
    }),
  ]);
  const row = page.getByRole('row').filter({ hasText: 'new-member' });
  const editAction = row.getByRole('button', { name: 'Редагувати', exact: true });
  const loginButton = row.getByRole('button', { name: 'new-member', exact: true });
  for (const trigger of [editAction, loginButton]) {
    await trigger.click();
    await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(trigger).toBeFocused();
  }
  await editAction.click();
  await dialog.getByRole('textbox', { name: 'Нотатка', exact: true }).fill('Оновлено');
  await dialog.getByRole('checkbox', { name: 'Активний', exact: true }).uncheck();
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(fixture.updatedUsers).toEqual([
    expect.objectContaining({
      organism_id: 2,
      deleted: true,
      description: 'Оновлено',
      sigint_zone_id: 1,
    }),
  ]);
  expect(fixture.updatedUsers[0]).not.toHaveProperty('delta_login');
  expect(forbiddenReads).toEqual([]);
  await page.getByRole('textbox', { name: 'Пошук', exact: true }).fill('service-user');
  await expect(page.getByRole('row').filter({ hasText: 'new-member' })).toHaveCount(0);
});

for (const role of ['Admin', 'OrganismAdmin']) {
  test(`@regression #3873 organism settings respect ${role} and preserve hidden configuration`, async ({
    page,
  }) => {
    await install(page, role);
    const updates: unknown[] = [];
    await page.route('**/api/organism/update', (route) => {
      const req = route.request().postDataJSON();
      updates.push(req);
      return route.fulfill({ json: { ...req, created_at: 0, logins_count: 2 } });
    });
    await page.goto('/admin/organisms-neo/edit?id=2');
    for (const name of ['Смуги', 'Ролі']) {
      const field = page.getByRole('combobox', { name: new RegExp(`^${name}`) });
      if (role === 'Admin') await expect(field).toBeEnabled();
      else await expect(field).toHaveCount(0);
    }
    const groups = page.getByRole('checkbox', { name: 'Обмежити перелік груп' });
    if (role === 'Admin') await expect(groups).toBeEnabled();
    else await expect(groups).toHaveCount(0);
    await page.getByRole('textbox', { name: 'Назва', exact: false }).fill('Нова назва');
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect
      .poll(() => updates)
      .toEqual([
        expect.objectContaining({
          id: 2,
          name: 'Нова назва',
          roles: ['Basic', 'Rer', 'OrganismAdmin'],
          aor_ids: [11],
          parent_id: null,
        }),
      ]);
  });
}
