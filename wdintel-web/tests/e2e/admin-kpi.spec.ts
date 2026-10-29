import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

import type { Login } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const NOW = Date.UTC(2026, 9, 22, 12);
const DAY = 86_400_000;
const SIX_HOURS = DAY / 4;

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
  await page.route('**/api/kpi/*', async (route) => {
    const period = route.request().postDataJSON();
    const duration = { samples: 0, excluded: 0, medianSeconds: null, p90Seconds: null };
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    const responses = {
      reports: {
        period,
        total: 0,
        done: 0,
        failed: 0,
        byKind: [],
        byAuthor: [],
        byDay: [],
        generation: duration,
      },
      activity: {
        period,
        available: false,
        reason: 'Greptime не налаштовано.',
        observedFrom: null,
        observedUntil: null,
        accounts: null,
        byDay: [],
        byPage: [],
        queueEnqueued: 0,
        queueDropped: 0,
        unmappedAccountGroups: 0,
      },
      requests: {
        period,
        available: false,
        reason: 'Greptime не налаштовано.',
        total: null,
        serverErrors: null,
        clientErrors: null,
        byStatus: [],
      },
      notifications: { period, total: 0, byStatus: [], transport: duration },
    };
    await route.fulfill({ json: responses[endpoint as keyof typeof responses] });
  });
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
      const adminMenu = page.locator('#navbar-dropdown-menu-admin');
      await expect(
        adminMenu.locator(':scope > li > [role="menuitem"]').filter({ hasText: /^KPI$/ }),
      ).toHaveCount(0);
      const knowledgeBase = adminMenu
        .getByRole('menuitem', { name: 'База знань', exact: true })
        .locator('..');
      await knowledgeBase.hover();
      await expect(knowledgeBase.getByRole('menuitem').last()).toHaveText('KPI');
      await knowledgeBase.getByRole('menuitem', { name: 'KPI', exact: true }).click();
    } else {
      await page.goto('/admin/kpi');
    }
    await expect(metric(page, 'Облікові записи')).toHaveText('9');
    await expect(metric(page, 'Активні облікові записи')).toHaveText('3');
    await expect(metric(page, 'Деактивовані / заблоковані')).toHaveText('6');
    await expect(metric(page, 'Потребують перевірки: понад 90 днів')).toHaveText('2');
    await page.getByRole('tab', { name: 'Активність', exact: true }).click();
    await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('731');
    await page.getByRole('tab', { name: 'База користувачів', exact: true }).click();
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
    const chart = page
      .getByRole('region', { name: 'Статуси облікових записів', exact: true })
      .locator('div[aria-hidden="true"] svg');
    await expect(chart).toBeVisible();
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await expect(chart).toBeVisible();
    await page.getByRole('tab', { name: 'Активність', exact: true }).click();
    await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('731');
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
  await page.getByRole('tab', { name: 'Активність', exact: true }).click();
  await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('23');
  await expect(page.locator('.MuiSnackbar-root')).toContainText(
    'Не вдалося завантажити облікові записи',
  );
  accountsFail = false;
  await page.getByRole('tab', { name: 'База користувачів', exact: true }).click();
  await page.getByRole('button', { name: 'Повторити: облікові записи' }).click();
  await expect(metric(page, 'Облікові записи')).toHaveText('1');
  reportsFail = true;
  users = [account('active'), account('new-account')];
  await page.getByRole('button', { name: 'Оновити KPI' }).click();
  await page.getByRole('tab', { name: 'Активність', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Повторити: звіти' })).toBeVisible();
  await expect(metric(page, 'Успішні звіти в доступній історії')).toHaveText('23');
  await expect(page.getByRole('region', { name: 'Звіти: вся система', exact: true })).toContainText(
    'Показано попередні дані.',
  );
  await page.getByRole('tab', { name: 'База користувачів', exact: true }).click();
  await expect(metric(page, 'Облікові записи')).toHaveText('2');
  await page.getByRole('tab', { name: 'Активність', exact: true }).click();
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
    await page.route(/\/api\/(logins|admin\/report-history\/list|kpi\/[^/]+)$/, (route) => {
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

test('#3826 historical tabs use bounded periods and isolate unavailable sources @regression', async ({
  page,
}) => {
  await setup(page);
  const requests: { endpoint: string; since: number; until: number }[] = [];
  let failRequests = true;
  await page.route('**/api/kpi/requests', async (route) => {
    const period = route.request().postDataJSON();
    requests.push({ endpoint: 'requests', ...period });
    if (failRequests && period.since === NOW - 30 * DAY + SIX_HOURS) {
      return route.fulfill({ status: 500, body: 'History unavailable' });
    }
    if (period.until === NOW) {
      return route.fulfill({
        json: {
          period,
          available: false,
          reason: 'Немає записаних відповідей; покриття історії невідоме.',
          total: 0,
          serverErrors: 0,
          clientErrors: 0,
          byStatus: [],
        },
      });
    }
    return route.fulfill({
      json: {
        period,
        available: true,
        reason: null,
        total: 40,
        serverErrors: 2,
        clientErrors: 3,
        byStatus: [
          { id: '200', label: '200', count: 35 },
          { id: '404', label: '404', count: 3 },
          { id: '500', label: '500', count: 2 },
        ],
      },
    });
  });
  await page.goto('/admin/kpi?tab=quality');
  await expect(page.getByRole('tab')).toHaveText([
    'База користувачів',
    'Активність',
    'Чого затримуються (швидкість)',
    'Технічна якість',
  ]);
  await expect(page.getByRole('tab', { name: 'Технічна якість', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(
    page.getByRole('button', { name: 'Повторити: якість API', exact: true }),
  ).toBeVisible();
  await expect(metric(page, 'Сповіщення для відправлення')).toHaveText('0');
  await expect(metric(page, 'Час до відправлення в транспорт: медіана')).toHaveText('Недоступно');
  await expect(metric(page, 'Записані відповіді API')).toHaveCount(0);
  failRequests = false;
  requests.length = 0;
  await page.getByRole('button', { name: 'Повторити: якість API', exact: true }).click();
  await expect(metric(page, 'Записані відповіді API')).toHaveText('4760');
  await expect(metric(page, 'Помилки сервера API')).toHaveText('238');
  await expect(metric(page, 'Помилки клієнта API')).toHaveText('357');
  await expect(metric(page, 'Частка відповідей з помилкою')).toHaveText('12.50%');
  expect(requests).toEqual(
    Array.from({ length: 120 }, (_, index) => ({
      endpoint: 'requests',
      since: NOW - 30 * DAY + index * SIX_HOURS,
      until: NOW - 30 * DAY + (index + 1) * SIX_HOURS,
    })),
  );
  const statuses = await openValues(page, 'Відповіді API за HTTP-статусом');
  await expect(statuses.getByRole('row', { name: '200 4165', exact: true })).toBeVisible();
  await expect(statuses.getByRole('row', { name: '404 357', exact: true })).toBeVisible();
  await expect(statuses.getByRole('row', { name: '500 238', exact: true })).toBeVisible();
  await page.getByRole('combobox', { name: /^Період історії/ }).click();
  await page.getByRole('option', { name: 'Останні 7 днів', exact: true }).click();
  await expect(metric(page, 'Записані відповіді API')).toHaveText('1080');
  expect(requests.slice(120)).toEqual(
    Array.from({ length: 28 }, (_, index) => ({
      endpoint: 'requests',
      since: NOW - 7 * DAY + index * SIX_HOURS,
      until: NOW - 7 * DAY + (index + 1) * SIX_HOURS,
    })),
  );
  await page.getByRole('tab', { name: 'Активність', exact: true }).click();
  await expect(
    page.getByRole('region', { name: 'Спостереження сторінок', exact: true }),
  ).toContainText('Недоступно: Greptime не налаштовано.');
  await expect(metric(page, 'Облікові записи зі спостереженнями')).toHaveCount(0);
  await expect(page).toHaveURL(/tab=activity/);
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Технічна якість', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  for (const tab of await page.getByRole('tab').all()) {
    await tab.click();
    await expect(
      page.getByRole('region', { name: 'Показники, для яких бракує даних або визначень' }),
    ).toHaveCount(0);
  }
  await page.goto('/admin/kpi?tab=referrals');
  await expect(page.getByRole('tab', { name: 'База користувачів', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(metric(page, 'Облікові записи')).toHaveText('9');
});

test('#3826 API-quality batches cancel on period changes and retain complete snapshots @regression', async ({
  page,
}) => {
  await setup(page);
  let releaseOld!: () => void;
  let finishOld!: () => void;
  const oldReady = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  const oldFinished = new Promise<void>((resolve) => {
    finishOld = resolve;
  });
  const requests: { since: number; until: number }[] = [];
  let failRequests = false;
  await page.route('**/api/kpi/requests', async (route) => {
    const period = route.request().postDataJSON();
    requests.push(period);
    const old = period.since === NOW - 30 * DAY;
    if (old) await oldReady;
    if (failRequests && period.since === NOW - 6 * DAY + SIX_HOURS) {
      return route.fulfill({ status: 500, body: 'History unavailable' });
    }
    await route.fulfill({
      json: {
        period,
        available: true,
        reason: null,
        total: old ? 999 : 10,
        serverErrors: 1,
        clientErrors: 0,
        byStatus: [
          { id: '200', label: '200', count: old ? 998 : 9 },
          { id: '500', label: '500', count: 1 },
        ],
      },
    });
    if (old) finishOld();
  });
  await page.goto('/admin/kpi?tab=quality');
  await expect.poll(() => requests.length).toBe(1);
  await page.getByRole('combobox', { name: /^Період історії/ }).click();
  await page.getByRole('option', { name: 'Останні 7 днів', exact: true }).click();
  await expect(metric(page, 'Записані відповіді API')).toHaveText('280');
  releaseOld();
  await oldFinished;
  expect(requests).toHaveLength(29);
  await expect(metric(page, 'Записані відповіді API')).toHaveText('280');
  await expect(metric(page, 'Частка відповідей з помилкою')).toHaveText('10.00%');
  failRequests = true;
  await page.clock.setFixedTime(NOW + DAY);
  await page.getByRole('button', { name: 'Оновити KPI', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Повторити: якість API', exact: true }),
  ).toBeVisible();
  await expect(metric(page, 'Записані відповіді API')).toHaveText('280');
  const quality = page.getByRole('region', { name: 'Якість запитів API', exact: true });
  await expect(quality).toContainText('Показано попередні дані.');
  await expect(quality).toContainText(new Date(NOW).toISOString());
  failRequests = false;
  await page.getByRole('button', { name: 'Повторити: якість API', exact: true }).click();
  await expect(quality).toContainText(new Date(NOW + DAY).toISOString());
  await expect(metric(page, 'Записані відповіді API')).toHaveText('280');
  await expect(
    page.getByRole('button', { name: 'Повторити: якість API', exact: true }),
  ).toHaveCount(0);
});

test('#3826 API-quality totals reconcile across empty slices, boundaries, and exporter retries @regression', async ({
  page,
}) => {
  await setup(page);
  const since = NOW - 30 * DAY;
  const events = [
    { timestamp: since - 1000, id: 'before', status: '500' },
    { timestamp: since, id: 'first', status: '200' },
    { timestamp: since, id: 'first', status: '200' },
    { timestamp: since + SIX_HOURS - 1000, id: 'before-boundary', status: '404' },
    { timestamp: since + SIX_HOURS, id: 'boundary', status: '500' },
    { timestamp: since + SIX_HOURS, id: 'boundary', status: '500' },
    { timestamp: since + 2 * SIX_HOURS, id: 'later', status: '200' },
    { timestamp: NOW - 1000, id: 'last', status: '404' },
    { timestamp: NOW, id: 'after', status: '500' },
  ];
  let empty = false;
  let calls = 0;
  await page.route('**/api/kpi/requests', async (route) => {
    calls += 1;
    const period = route.request().postDataJSON();
    const statuses = new Map<string, Set<string>>();
    for (const event of empty ? [] : events) {
      if (event.timestamp < period.since || event.timestamp >= period.until) continue;
      const ids = statuses.get(event.status) ?? new Set<string>();
      ids.add(event.id);
      statuses.set(event.status, ids);
    }
    const byStatus = [...statuses].map(([id, ids]) => ({ id, label: id, count: ids.size }));
    await route.fulfill({
      json: {
        period,
        available: byStatus.length > 0,
        reason: byStatus.length ? null : 'Немає записаних відповідей; покриття історії невідоме.',
        total: byStatus.reduce((total, row) => total + row.count, 0),
        serverErrors: statuses.get('500')?.size ?? 0,
        clientErrors: statuses.get('404')?.size ?? 0,
        byStatus,
      },
    });
  });
  await page.goto('/admin/kpi?tab=quality');
  await expect(metric(page, 'Записані відповіді API')).toHaveText('5');
  await expect(metric(page, 'Помилки сервера API')).toHaveText('1');
  await expect(metric(page, 'Помилки клієнта API')).toHaveText('2');
  await expect(metric(page, 'Частка відповідей з помилкою')).toHaveText('60.00%');
  expect(calls).toBe(120);
  const statuses = await openValues(page, 'Відповіді API за HTTP-статусом');
  await expect(statuses.getByRole('row', { name: '200 2', exact: true })).toBeVisible();
  await expect(statuses.getByRole('row', { name: '404 2', exact: true })).toBeVisible();
  await expect(statuses.getByRole('row', { name: '500 1', exact: true })).toBeVisible();
  empty = true;
  await page.clock.setFixedTime(NOW + DAY);
  await page.getByRole('button', { name: 'Оновити KPI', exact: true }).click();
  const quality = page.getByRole('region', { name: 'Якість запитів API', exact: true });
  await expect(quality).toContainText('Недоступно: Немає записаних відповідей');
  await expect(metric(page, 'Записані відповіді API')).toHaveCount(0);
  expect(calls).toBe(240);
});

for (const unavailableSlice of [0, 1]) {
  test(`#3826 stops on an unavailable API-quality source at slice ${unavailableSlice} @regression`, async ({
    page,
  }) => {
    await setup(page);
    let calls = 0;
    await page.route('**/api/kpi/requests', (route) => {
      const period = route.request().postDataJSON();
      if (calls++ === unavailableSlice) return route.fallback();
      return route.fulfill({
        json: {
          period,
          available: true,
          reason: null,
          total: 10,
          serverErrors: 0,
          clientErrors: 0,
          byStatus: [{ id: '200', label: '200', count: 10 }],
        },
      });
    });
    await page.goto('/admin/kpi?tab=quality');
    const quality = page.getByRole('region', { name: 'Якість запитів API', exact: true });
    await expect(quality).toContainText('Недоступно: Greptime не налаштовано.');
    await expect(quality).toContainText(new Date(NOW - 30 * DAY).toISOString());
    await expect(quality).toContainText(new Date(NOW).toISOString());
    await expect(metric(page, 'Записані відповіді API')).toHaveCount(0);
    expect(calls).toBe(unavailableSlice + 1);
  });
}

for (const action of ['refresh', 'tab exit']) {
  test(`#3826 aborts the in-flight API-quality request on ${action} @regression`, async ({
    page,
  }) => {
    await setup(page);
    let release!: () => void;
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    await page.route('**/api/kpi/requests', async (route) => {
      if (calls++ === 0) await ready;
      await route.fallback();
    });
    await page.goto('/admin/kpi?tab=quality');
    await expect.poll(() => calls).toBe(1);
    const aborted = page.waitForEvent('requestfailed', {
      predicate: (request) => request.url().endsWith('/api/kpi/requests'),
    });
    try {
      if (action === 'refresh') {
        await page.clock.setFixedTime(NOW + DAY);
        await page.getByRole('button', { name: 'Оновити KPI', exact: true }).click();
      } else {
        await page.getByRole('tab', { name: 'База користувачів', exact: true }).click();
      }
      expect((await aborted).failure()?.errorText).toContain('ERR_ABORTED');
    } finally {
      release();
    }
    if (action === 'refresh') {
      await expect(
        page.getByRole('region', { name: 'Якість запитів API', exact: true }),
      ).toContainText('Недоступно: Greptime не налаштовано.');
    } else {
      await expect(metric(page, 'Облікові записи')).toHaveText('9');
    }
    await expect(
      page.getByRole('button', { name: 'Повторити: якість API', exact: true }),
    ).toHaveCount(0);
    expect(calls).toBe(action === 'refresh' ? 2 : 1);
  });
}

test('#3826 changed periods discard delayed history responses and retain failed snapshots @regression', async ({
  page,
}) => {
  await setup(page);
  let releaseOld!: () => void;
  const oldReady = new Promise<void>((resolve) => {
    releaseOld = resolve;
  });
  let failReports = false;
  let calls = 0;
  await page.route('**/api/kpi/reports', async (route) => {
    const period = route.request().postDataJSON();
    calls += 1;
    const first = calls === 1;
    if (first) await oldReady;
    if (failReports) return route.fulfill({ status: 500, body: 'Reports failed' });
    return route.fulfill({
      json: {
        period,
        total: first ? 999 : 7,
        done: first ? 999 : 5,
        failed: 2,
        byKind: [],
        byAuthor: [],
        byDay: [],
        generation: { samples: 1, excluded: 4, medianSeconds: 12, p90Seconds: 12 },
      },
    });
  });
  await page.goto('/admin/kpi?tab=speed');
  await expect.poll(() => calls).toBe(1);
  await page.getByRole('combobox', { name: /^Період історії/ }).click();
  await page.getByRole('option', { name: 'Останні 7 днів', exact: true }).click();
  await expect(metric(page, 'Запити генерації')).toHaveText('7');
  releaseOld();
  await expect(metric(page, 'Запити генерації')).toHaveText('7');
  failReports = true;
  await page.clock.setFixedTime(NOW + DAY);
  await page.getByRole('button', { name: 'Оновити KPI', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Повторити: історія звітів', exact: true }),
  ).toBeVisible();
  await expect(metric(page, 'Запити генерації')).toHaveText('7');
  await expect(
    page.getByRole('region', { name: 'Генерація звітів за період', exact: true }),
  ).toContainText('Показано попередні дані.');
  failReports = false;
  await page.getByRole('button', { name: 'Повторити: історія звітів', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Повторити: історія звітів', exact: true }),
  ).toHaveCount(0);
});
