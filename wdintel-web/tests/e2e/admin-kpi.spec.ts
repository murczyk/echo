import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { Login } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;

function account(id: string, patch: Partial<Login> = {}): Login {
  return {
    id,
    login: id,
    roles: ['Rer'],
    createdAt: NOW - 120 * DAY,
    deleted: false,
    sigintZoneId: 10,
    sigintZoneName: 'Напрямок А',
    organismId: 1,
    organismName: 'Організм А',
    organismEnabled: true,
    deltaLogin: null,
    lastActiveAt: NOW - DAY,
    deactivationReason: null,
    signalProfileId: null,
    description: null,
    passwordAuthEnabled: false,
    hasPassword: false,
    totpEnabled: false,
    ...patch,
  };
}

function fixtureAccounts() {
  const active = account('active', { roles: ['Rer', 'Rer', 'Full'] });
  return [
    active,
    account('exact-30', {
      deleted: true,
      deactivationReason: 'Inactive',
      lastActiveAt: NOW - 30 * DAY,
    }),
    account('exact-90', {
      deleted: true,
      deactivationReason: 'Inactive',
      lastActiveAt: NOW - 90 * DAY,
      organismId: 2,
      organismName: 'Організм Б',
    }),
    account('admin-old', {
      deleted: true,
      deactivationReason: 'Admin',
      lastActiveAt: NOW - 91 * DAY,
      organismId: 2,
      organismName: 'Організм Б',
      organismEnabled: false,
    }),
    account('disabled-organism', {
      organismEnabled: false,
      organismId: 3,
      organismName: 'Організм В',
      lastActiveAt: NOW - 5 * DAY,
    }),
    account('no-timestamp', {
      deleted: true,
      lastActiveAt: null,
      organismId: null,
      organismName: null,
      sigintZoneId: null,
      sigintZoneName: null,
      roles: [],
    }),
    account('future', { lastActiveAt: NOW + DAY, roles: ['Api'] }),
    account('invalid', { deleted: true, lastActiveAt: -1, roles: [] }),
    account('active-old', { lastActiveAt: NOW - 91 * DAY }),
    active,
  ];
}

async function setup(page: Page, users = fixtureAccounts()) {
  await page.clock.setFixedTime(NOW);
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin'] });
  await page.route('**/api/logins', (route) => route.fulfill({ json: { users } }));
  await page.route('**/api/admin/report-history/list', (route) =>
    route.fulfill({
      json: { rows: [{ id: 1, status: 'done' }], total: 731, has_more: true, next_offset: 1 },
    }),
  );
}

function metric(page: Page, title: string) {
  return page.getByRole('region', { name: title, exact: true }).locator('[aria-label="Кількість"]');
}

async function openValues(page: Page, title: string) {
  const section = page.getByRole('region', { name: title, exact: true });
  await section.locator('summary').click();
  return section.getByRole('table');
}

for (const width of [390, 1280]) {
  test(`#3826 KPI preserves scopes and 30/90-day boundaries at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await setup(page);
    const reportRequest = page.waitForRequest('**/api/admin/report-history/list');
    if (width === 1280) {
      await page.goto('/');
      await page.getByRole('button', { name: 'Адмін', exact: true }).click();
      await page.getByRole('menuitem', { name: 'База знань', exact: true }).hover();
      await page.getByRole('menuitem', { name: 'KPI', exact: true }).click();
    } else {
      await page.goto('/admin/kpi');
    }
    await expect(metric(page, 'Облікові записи')).toHaveText('9');
    await expect(metric(page, 'Активні облікові записи')).toHaveText('3');
    await expect(metric(page, 'Деактивовані / заблоковані')).toHaveText('6');
    await expect(metric(page, 'Потребують перевірки: понад 90 днів')).toHaveText('2');
    await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('731');
    expect((await reportRequest).postDataJSON()).toEqual({
      offset: 0,
      limit: 1,
      global_filter: '',
      column_filters: [{ id: 'status', value: 'done' }],
      sorting: [],
    });

    const statuses = await openValues(page, 'Статуси облікових записів');
    await expect(
      statuses.getByRole('row', { name: 'Деактивовано адміністратором 1', exact: true }),
    ).toBeVisible();
    await expect(
      statuses.getByRole('row', { name: 'Організм деактивовано 1', exact: true }),
    ).toBeVisible();
    const recency = await openValues(page, 'Давність останнього запису активності');
    await expect(
      recency.getByRole('row', { name: 'Від 30 до 90 днів включно 2', exact: true }),
    ).toBeVisible();
    await expect(recency.getByRole('row', { name: 'Понад 90 днів 1', exact: true })).toBeVisible();
    await expect(
      recency.getByRole('row', { name: 'Немає запису активності 1', exact: true }),
    ).toBeVisible();
    await expect(
      recency.getByRole('row', { name: 'Некоректна дата 1', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('checkbox', { name: 'Включити активні облікові записи до давності' })
      .check();
    await expect(recency.getByRole('row', { name: 'Понад 90 днів 2', exact: true })).toBeVisible();
    await expect(
      recency.getByRole('row', { name: 'Некоректна дата 2', exact: true }),
    ).toBeVisible();
    const roles = await openValues(page, 'Розподіл за ролями');
    await expect(roles.getByRole('row', { name: 'Rer 6', exact: true })).toBeVisible();
    await expect(roles.getByRole('row', { name: 'Не вказано 2', exact: true })).toBeVisible();
    const review = page.getByRole('region', { name: 'Облікові записи для перевірки' });
    await expect(review.getByRole('link', { name: 'exact-90', exact: true })).toHaveCount(0);
    await expect(review.getByRole('link', { name: 'admin-old', exact: true })).toHaveAttribute(
      'href',
      '/admin/users-neo/admin-old',
    );

    await page.getByRole('combobox', { name: 'Роль', exact: true }).click();
    await page.getByRole('option', { name: 'Rer', exact: true }).click();
    await page.getByRole('combobox', { name: 'Організм', exact: true }).click();
    await page.getByRole('option', { name: 'Організм А (ID 1)', exact: true }).click();
    await expect(metric(page, 'Облікові записи')).toHaveText('3');
    await expect(metric(page, 'Активні облікові записи')).toHaveText('2');
    await expect(review.getByRole('link', { name: 'admin-old', exact: true })).toHaveCount(0);
    await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('731');
    const chart = page
      .getByRole('region', { name: 'Статуси облікових записів', exact: true })
      .locator('div[aria-hidden="true"] svg');
    await expect(chart).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await expect(chart).toBeVisible();
    await page.getByRole('link', { name: 'Переглянути всі звіти' }).scrollIntoViewIfNeeded();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

test('#3826 KPI isolates failures, retains stale snapshots, and retries @regression', async ({
  page,
}) => {
  await setup(page);
  let accountsFail = true;
  let reportsFail = false;
  let users = [account('active')];
  await page.route('**/api/logins', (route) =>
    route.fulfill(
      accountsFail ? { status: 500, body: 'Accounts unavailable' } : { json: { users } },
    ),
  );
  await page.route('**/api/admin/report-history/list', (route) =>
    route.fulfill(
      reportsFail
        ? { status: 500, body: 'Reports unavailable' }
        : { json: { rows: [], total: 23, has_more: false, next_offset: 0 } },
    ),
  );
  await page.goto('/admin/kpi');
  await expect(page.getByRole('button', { name: 'Повторити: облікові записи' })).toBeVisible();
  await expect(metric(page, 'Облікові записи')).toHaveCount(0);
  await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('23');
  await expect(page.locator('.MuiSnackbar-root')).toContainText(
    'Не вдалося завантажити облікові записи',
  );
  accountsFail = false;
  await page.getByRole('button', { name: 'Повторити: облікові записи' }).click();
  await expect(metric(page, 'Облікові записи')).toHaveText('1');
  reportsFail = true;
  users = [account('active'), account('new-account')];
  await page.getByRole('button', { name: 'Оновити KPI' }).click();
  await expect(page.getByRole('button', { name: 'Повторити: звіти' })).toBeVisible();
  await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('23');
  await expect(page.getByRole('region', { name: 'Звіти: вся система', exact: true })).toContainText(
    'Показано попередні дані.',
  );
  await expect(metric(page, 'Облікові записи')).toHaveText('2');
  reportsFail = false;
  await page.getByRole('button', { name: 'Повторити: звіти' }).click();
  await expect(page.getByRole('button', { name: 'Повторити: звіти' })).toHaveCount(0);
});

test('#3826 KPI distinguishes an empty account base from a failed request @regression', async ({
  page,
}) => {
  await setup(page, []);
  await page.goto('/admin/kpi');
  await expect(metric(page, 'Облікові записи')).toHaveText('0');
  await expect(
    page.getByText('Облікових записів у вибраному розрізі немає.', { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Повторити: облікові записи' })).toHaveCount(0);
});

for (const roles of [['Rer'], ['Full'], ['Cyber'], []]) {
  test(`#3826 blocks direct KPI access for ${roles.join(',') || 'no roles'} @regression`, async ({
    page,
  }) => {
    await setup(page);
    await installAnalysisNeoApiMocks(page, { userRoles: roles });
    let protectedRequests = 0;
    await page.route(/\/api\/(logins|admin\/report-history\/list)$/, (route) => {
      protectedRequests += 1;
      return route.fulfill({ json: {} });
    });
    await page.goto('/admin/kpi');
    await expect(page).toHaveURL(/\/$/);
    await expect(page.locator('admin-kpi')).toHaveCount(0);
    expect(protectedRequests).toBe(0);
  });
}

test('#3826 waits for Admin identity before mounting KPI or loading protected data @regression', async ({
  page,
}) => {
  await setup(page);
  let releaseUser!: () => void;
  const userReady = new Promise<void>((resolve) => {
    releaseUser = resolve;
  });
  let protectedRequests = 0;
  await page.route('**/api/user', async (route) => {
    await userReady;
    await route.fallback();
  });
  await page.route('**/api/logins', (route) => {
    protectedRequests += 1;
    return route.fulfill({ json: { users: [] } });
  });
  await page.goto('/admin/kpi');
  await expect(page.getByText('KPI доступні лише адміністраторам.', { exact: true })).toBeVisible();
  await expect(page.locator('admin-kpi')).toHaveCount(0);
  expect(protectedRequests).toBe(0);
  releaseUser();
  await expect(metric(page, 'Облікові записи')).toHaveText('0');
});

test('#3826 preserves login redirect on authentication failure @regression', async ({ page }) => {
  await setup(page);
  await page.route('**/api/user', (route) => route.fulfill({ status: 401 }));
  await page.goto('/admin/kpi');
  await expect(page).toHaveURL(/\/login\?redirect=%2Fadmin%2Fkpi/);
  await expect(page.locator('admin-kpi')).toHaveCount(0);
});
