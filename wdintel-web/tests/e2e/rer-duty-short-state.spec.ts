import { expect, test } from '@playwright/test';

import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

test.describe('@smoke', () => {
  test('blocked Duty session returns to login and stops background requests', async ({ page }) => {
    await installRerDutyShortStateMocks(page);
    let blocked = false;
    let countRequests = 0;
    let backgroundRequests = 0;
    let loginNavigations = 0;
    let releaseLongPoll!: () => void;
    const longPollResponse = new Promise<void>((resolve) => {
      releaseLongPoll = resolve;
    });
    page.on('request', (request) => {
      if (request.resourceType() === 'document' && new URL(request.url()).pathname === '/login') {
        loginNavigations += 1;
      }
    });
    await page.route(
      (url) => url.pathname.startsWith('/api/'),
      async (route) => {
        const pathname = new URL(route.request().url()).pathname;
        if (pathname === '/api/rer-importer/get-inbox-count') countRequests += 1;
        if (
          [
            '/api/rer-importer/get-inbox-count',
            '/api/event-stream/long-poll',
            '/api/user/keep-alive',
          ].includes(pathname)
        )
          backgroundRequests += 1;
        if (pathname === '/api/event-stream/long-poll' && !blocked) await longPollResponse;
        if (pathname === '/api/user/logout') {
          await route.fulfill({ status: 302, headers: { Location: '/login' } });
          return;
        }
        if (blocked) {
          await route.fulfill({ status: 401, body: 'Unauthenticated' });
        } else {
          await route.fallback();
        }
      },
    );

    await page.goto('/rer-duty-neo');
    await expect.poll(() => countRequests).toBeGreaterThan(0);
    blocked = true;
    releaseLongPoll();
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    await expect(page.locator('form')).toBeVisible();
    const requestsAfterLogout = backgroundRequests;
    await page.clock.install();
    await page.clock.runFor(5000);

    expect(backgroundRequests).toBe(requestsAfterLogout);
    expect(loginNavigations).toBe(1);
  });

  test('rer-duty-neo hydrates filters from short state id', async ({ page }) => {
    const shortStateId = 'short-1';
    const fixture = await installRerDutyShortStateMocks(page, { shortStateId });

    await page.goto(`/rer-duty-neo?state-short=${shortStateId}`);

    await expect
      .poll(() => fixture.getLastInboxRequest())
      .toEqual(expect.objectContaining({ selected_groups: ['group-1'] }));
  });

  test('rer-duty-neo falls back when short state id is missing', async ({ page }) => {
    const fixture = await installRerDutyShortStateMocks(page, { shortStateId: 'short-1' });

    await page.goto('/rer-duty-neo?state-short=missing');
    await expect
      .poll(() => fixture.getLastInboxRequest())
      .toEqual(expect.objectContaining({ selected_groups: null }));
  });
});
