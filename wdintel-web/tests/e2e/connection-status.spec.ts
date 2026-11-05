import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const width of [1440, 390]) {
  test(`@regression #4019 Analysis shared lookup errors use the bottom snackbar at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page);
    await page.route('**/api/sigint/units/hierarchy', (route) =>
      route.fulfill({ json: { revision: 'shared-error', groups: [], units: [] } }),
    );
    await page.route('**/api/sigint/units', (route) =>
      route.request().resourceType() === 'xhr'
        ? route.fulfill({ status: 408, body: '' })
        : route.fallback(),
    );
    await page.goto('/rer-analysis-neo?filterPanelOpen=false');

    const snackbar = page.locator('.MuiSnackbar-root');
    const error = snackbar.getByRole('alert');
    await expect(error).toContainText('Помилка оновлення підрозділів');
    await expect(error).toContainText('408');
    await expect(error).toHaveCSS('opacity', '1');
    await expect(page.locator('.toasts .toast')).toHaveCount(0);
    const position = await snackbar.boundingBox();
    expect(position!.y).toBeGreaterThan(450);
    expect(position!.x).toBeGreaterThanOrEqual(0);
    expect(position!.x + position!.width).toBeLessThanOrEqual(width);
    await error.getByRole('button', { name: 'Закрити сповіщення' }).click();
    await expect(snackbar).toHaveCount(0);
  });
}

test('@regression #4019 shared lookup errors keep the existing toast outside Analysis Neo', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/sigint/units', (route) => route.fulfill({ status: 408, body: '' }));
  await page.goto('/rer-analysis');
  const error = page.locator('.toasts .toast').filter({ hasText: 'Помилка оновлення підрозділів' });
  await expect(error).toBeVisible();
  await expect(error).toContainText('408');
  await expect(page.locator('.MuiSnackbar-root')).toHaveCount(0);
});

for (const { width, theme } of [
  { width: 1440, theme: 'light' },
  { width: 390, theme: 'dark' },
]) {
  test(`background connections recover without stale banners at ${width}px ${theme} @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript((themeMode) => {
      localStorage.setItem('echo-theme-mode', themeMode);
    }, theme);
    await page.clock.install();
    await installAnalysisNeoApiMocks(page);
    await page.route('**/api/user', (route) =>
      route.fulfill({
        json: {
          id: 'operator',
          name: 'operator',
          roles: ['Rer'],
          sigint_zone_id: null,
          organism_id: null,
          delta_login: null,
          goi_configured_for_organism: false,
          goi_full_access_for_organism: false,
          goi_host: null,
          goi_integrations: [],
          last_release_seen: null,
          rer_report_eligible: false,
        },
      }),
    );
    const failures = { events: false, keepAlive: false };
    let failedKeepAlives = 0;
    let successfulKeepAlives = 0;
    let successfulPolls = 0;
    await page.route('**/api/user/keep-alive', async (route) => {
      if (failures.keepAlive) {
        failedKeepAlives += 1;
        await route.abort('internetdisconnected');
      } else {
        successfulKeepAlives += 1;
        await route.fulfill({ json: {} });
      }
    });
    await page.route('**/api/event-stream/long-poll', async (route) => {
      if (failures.events) {
        await route.fulfill({ status: 503, body: 'Unavailable' });
      } else {
        successfulPolls += 1;
        await route.fulfill({ json: { events: [], last_event_id: null } });
      }
    });
    await page.goto('/rer-analysis-neo?filterPanelOpen=false');
    await expect(page.locator('app-navbar header')).toBeVisible();
    await expect.poll(() => successfulPolls).toBeGreaterThan(0);
    const indicator = page.getByRole('status', { name: 'Відновлення з’єднання…' });
    const sessionBanner = page.getByText('Помилка підтримання сесії', { exact: true });
    const pollingBanner = page.getByText('Помилка отримання оновлень', { exact: true });
    await expect(indicator).toHaveCount(0);

    failures.events = true;
    await page.clock.fastForward(2100);
    await expect(indicator).toBeVisible();
    await indicator.focus();
    await page.clock.runFor(1000);
    await expect(page.getByRole('tooltip')).toHaveText('Відновлення з’єднання…');
    await expect(indicator.locator('svg')).toHaveCSS('width', '16px');
    await expect(indicator.locator('svg')).toHaveCSS('height', '16px');
    await indicator.blur();

    failures.keepAlive = true;
    await page.clock.fastForward(30000);
    await expect.poll(() => failedKeepAlives).toBeGreaterThan(0);
    await expect(indicator).toBeVisible();

    const pollsBeforeRecovery = successfulPolls;
    failures.events = false;
    await page.clock.fastForward(30000);
    await expect.poll(() => successfulPolls).toBeGreaterThan(pollsBeforeRecovery);
    await expect(indicator).toBeVisible();

    failures.keepAlive = false;
    await page.clock.fastForward(30000);
    await expect.poll(() => successfulKeepAlives).toBeGreaterThan(0);
    await expect(indicator).toHaveCount(0);
    await expect(sessionBanner).toHaveCount(0);
    await expect(pollingBanner).toHaveCount(0);

    const failuresBeforeRetry = failedKeepAlives;
    failures.keepAlive = true;
    await page.clock.fastForward(30000);
    await expect.poll(() => failedKeepAlives).toBeGreaterThan(failuresBeforeRetry);
    await expect(indicator).toBeVisible();
    await page.locator('a.app-navbar-logo').click();
    await expect(page).toHaveURL((url) => url.pathname === '/');
    await expect(indicator).toBeVisible();

    failures.keepAlive = false;
    await page.clock.fastForward(30000);
    await expect(indicator).toHaveCount(0);
    await expect(sessionBanner).toHaveCount(0);
    await expect(pollingBanner).toHaveCount(0);
  });
}

// Regression: https://github.com/echoua/echo/issues/3658
for (const failure of ['gateway', 'offline'] as const) {
  test(`analysis filters back off and recover after ${failure} failures @regression`, async ({
    page,
  }) => {
    test.setTimeout(60000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.clock.install();
    await page.addInitScript(() => {
      Math.random = () => 0;
    });
    await installAnalysisNeoApiMocks(page);
    await page.route('**/api/event-stream/long-poll', () => {});
    const attempts = { tags: 0, groups: 0, senders: 0 };
    let unavailable = false;
    for (const section of ['tags', 'groups', 'senders'] as const) {
      await page.route(`**/api/rer/analysis/stats/${section}`, async (route) => {
        attempts[section] += 1;
        if (!unavailable) {
          await route.fallback();
        } else if (failure === 'offline') {
          await route.abort('internetdisconnected');
        } else {
          await route.fulfill({ status: 502, body: 'Bad Gateway' });
        }
      });
    }
    await page.clock.pauseAt(new Date());
    await page.goto('/rer-analysis-neo');
    await expect(page.getByRole('combobox', { name: 'Пошук', exact: true })).toBeVisible();
    await page.clock.runFor(500);
    unavailable = true;
    attempts.tags = 0;
    attempts.groups = 0;
    attempts.senders = 0;
    await page.getByRole('combobox', { name: 'Пошук', exact: true }).fill('outage');
    await page.clock.runFor(300);
    await expect.poll(() => attempts).toEqual({ tags: 1, groups: 1, senders: 1 });
    await page.clock.runFor(1500);
    expect(attempts).toEqual({ tags: 1, groups: 1, senders: 1 });
    await page.clock.runFor(500);
    await expect.poll(() => attempts).toEqual({ tags: 2, groups: 2, senders: 2 });
    await page.clock.runFor(3500);
    expect(attempts).toEqual({ tags: 2, groups: 2, senders: 2 });
    await page.clock.runFor(500);
    await expect.poll(() => attempts).toEqual({ tags: 3, groups: 3, senders: 3 });
    unavailable = false;
    await page.clock.runFor(8100);
    await expect.poll(() => attempts).toEqual({ tags: 4, groups: 4, senders: 4 });
    await page.clock.runFor(1000);
    expect(attempts).toEqual({ tags: 4, groups: 4, senders: 4 });
    unavailable = true;
    await page.getByRole('combobox', { name: 'Пошук', exact: true }).fill('another outage');
    await page.clock.runFor(300);
    await expect.poll(() => attempts).toEqual({ tags: 5, groups: 5, senders: 5 });
    await page.goto('/login');
    await page.clock.fastForward(60000);
    expect(attempts).toEqual({ tags: 5, groups: 5, senders: 5 });
  });
}

// Regression: https://github.com/echoua/echo/issues/3658
test('unavailable analysis APIs at startup do not cause a request storm @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  let requests = 0;
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/**', async (route) => {
    if (
      !['fetch', 'xhr'].includes(route.request().resourceType()) ||
      new URL(route.request().url()).pathname === '/api/user'
    ) {
      await route.fallback();
      return;
    }
    requests += 1;
    await route.fulfill({ status: 502, body: 'Bad Gateway' });
  });
  await page.goto('/rer-analysis-neo');
  await expect(page.getByRole('heading', { name: 'Аналіз', exact: true })).toBeVisible();
  await page.clock.runFor(5000);
  expect(requests).toBeGreaterThan(0);
  expect(requests).toBeLessThan(50);
});
