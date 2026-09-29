import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

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
    await page.goto('/rer-analysis-neo');
    await expect(page.locator('app-navbar header')).toBeVisible();
    await expect.poll(() => successfulPolls).toBeGreaterThan(0);
    const indicator = page.getByRole('status', { name: 'Відновлення з’єднання…' });
    const sessionBanner = page.getByText('Помилка підтримання сесії', { exact: true });
    const pollingBanner = page.getByText('Помилка отримання оновлень', { exact: true });
    await expect(indicator).toHaveCount(0);

    failures.events = true;
    await page.clock.fastForward(1000);
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
    await expect(page).toHaveURL(/\/$/);
    await expect(indicator).toBeVisible();

    failures.keepAlive = false;
    await page.clock.fastForward(30000);
    await expect(indicator).toHaveCount(0);
    await expect(sessionBanner).toHaveCount(0);
    await expect(pollingBanner).toHaveCount(0);
  });
}
