import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const status of [200, 503]) {
  test(`#3858 units long-poll waits five seconds after a ${status} response @regression`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await installAnalysisNeoApiMocks(page, { userRoles: ['Rer'] });
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/event-stream/long-poll', async (route) => {
      requests.push(route.request().postDataJSON());
      await route.fulfill({
        status: requests.length === 1 ? status : 200,
        json: { events: [], last_event_id: 'units-event-cursor' },
      });
    });
    await page.goto('/rer-units-neo');
    await page.clock.runFor(100);
    await expect(page.locator('rer-units-neo')).toBeVisible();
    await expect.poll(() => requests.length).toBe(1);
    await page.clock.runFor(4500);
    expect(requests).toHaveLength(1);
    await page.clock.runFor(600);
    await expect.poll(() => requests.length).toBe(2);
    if (status === 200) expect(requests[1].last_event_id).toBe('units-event-cursor');
    await page.clock.runFor(4500);
    expect(requests).toHaveLength(2);
    await page.clock.runFor(600);
    await expect.poll(() => requests.length).toBe(3);
    expect(requests[2].last_event_id).toBe('units-event-cursor');
  });
}

test('#3866 other pages start long-polls at least two seconds apart @regression', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await installAnalysisNeoApiMocks(page);
  let requests = 0;
  await page.route('**/api/event-stream/long-poll', async (route) => {
    requests += 1;
    expect(route.request().postDataJSON().flavor).toBe('analysis-neo');
    await route.fulfill({ json: { events: [], last_event_id: null } });
  });
  await page.goto('/rer-analysis-neo');
  await page.clock.runFor(100);
  await expect.poll(() => requests).toBe(1);
  await page.clock.runFor(1800);
  expect(requests).toBe(1);
  await page.clock.runFor(300);
  await expect.poll(() => requests).toBeGreaterThan(1);
});
