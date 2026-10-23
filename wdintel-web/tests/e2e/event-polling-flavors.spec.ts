import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const status of [200, 503]) {
  test(`#3866 generic polls stay two seconds apart and run full checks every ten seconds after ${status} @regression`, async ({
    page,
  }) => {
    await page.clock.install();
    await page.clock.pauseAt(new Date());
    await installAnalysisNeoApiMocks(page);
    const requests: Array<{ flavor: string; startedAt: number }> = [];
    await page.route('**/api/event-stream/long-poll', async (route) => {
      requests.push({
        flavor: route.request().postDataJSON().flavor,
        startedAt: await page.evaluate(() => Date.now()),
      });
      await route.fulfill({
        status: requests.length === 1 ? status : 200,
        json: {
          events: [],
          last_event_id: null,
          deployment_maintenance:
            requests.length >= 2 ? { id: 'deploy-3866', remaining_ms: 120000 } : null,
        },
      });
    });
    await page.goto('/rer-callsigns-neo');
    await page.clock.runFor(100);
    await expect.poll(() => requests.length).toBe(1);
    await page.clock.runFor(1800);
    expect(requests).toHaveLength(1);
    for (let count = 2; count <= 6; count += 1) {
      await page.clock.runFor(count === 2 ? 300 : 2100);
      await expect.poll(() => requests.length).toBe(count);
    }
    expect(requests.map(({ flavor }) => flavor)).toEqual([
      'generic-full',
      'generic',
      'generic',
      'generic',
      'generic',
      'generic-full',
    ]);
    requests.slice(1).forEach((request, index) => {
      expect(request.startedAt - requests[index].startedAt).toBeGreaterThanOrEqual(2000);
    });
    expect(requests[5].startedAt - requests[0].startedAt).toBeGreaterThanOrEqual(10000);
    await expect(
      page.getByText('відбувається оновлення системи...', { exact: true }),
    ).toBeVisible();
  });
}

test('#3866 navigation changes poll flavors without concurrent or stale requests @regression', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await installAnalysisNeoApiMocks(page);
  const requests: Array<{ flavor: string; request: Request }> = [];
  const cancelled = new Set<Request>();
  page.on('requestfailed', (request) => cancelled.add(request));
  await page.route('**/api/event-stream/long-poll', (route) => {
    requests.push({ flavor: route.request().postDataJSON().flavor, request: route.request() });
  });
  await page.goto('/rer-callsigns-neo');
  await page.clock.runFor(100);
  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0].flavor).toBe('generic-full');

  for (const [path, flavor] of [
    ['/rer-analysis-neo', 'analysis-neo'],
    ['/rer-duty-neo', 'rer'],
    ['/rer-callsigns-neo', 'generic'],
  ]) {
    const previous = requests.at(-1)!.request;
    const previousCount = requests.length;
    await page.evaluate((destination) => {
      window.history.pushState(null, '', destination);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, path);
    await expect.poll(() => cancelled.has(previous)).toBe(true);
    await page.clock.runFor(2100);
    await expect.poll(() => requests.length).toBe(previousCount + 1);
    expect(requests.at(-1)!.flavor).toBe(flavor);
  }
});
