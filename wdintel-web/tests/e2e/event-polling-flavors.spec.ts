import { expect, test } from '@playwright/test';
import type { Request } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { emptyNetworksListResponse, emptyUnitsListResponse } from './fixture-responses';

test('#3866 shared lookups reconcile every minute and expose refresh failures @regression', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date('2026-10-23T12:00:00Z'));
  await installAnalysisNeoApiMocks(page);
  const requests = { units: 0, networks: 0 };
  let unavailable = false;
  for (const [endpoint, key, response] of [
    ['units', 'units', emptyUnitsListResponse()],
    ['network-list', 'networks', emptyNetworksListResponse()],
  ] as const) {
    await page.route(`**/api/sigint/${endpoint}`, async (route) => {
      requests[key] += 1;
      await route.fulfill({ status: unavailable ? 503 : 200, json: response });
    });
  }
  await page.goto('/');
  await page.clock.runFor(100);
  await expect.poll(() => requests).toEqual({ units: 1, networks: 1 });
  await page.clock.fastForward(58000);
  expect(requests).toEqual({ units: 1, networks: 1 });
  unavailable = true;
  await page.clock.runFor(2100);
  await expect.poll(() => requests).toEqual({ units: 2, networks: 2 });
  await expect(page.getByText('Помилка оновлення підрозділів', { exact: true })).toBeVisible();
  unavailable = false;
  await page.clock.fastForward(60000);
  await expect.poll(() => requests).toEqual({ units: 3, networks: 3 });
});

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
    const fullCheckCount = status === 503 ? 7 : 6;
    for (let count = 2; count <= fullCheckCount; count += 1) {
      await page.clock.runFor(count === 2 ? 300 : 2100);
      await expect.poll(() => requests.length).toBe(count);
    }
    expect(requests.map(({ flavor }) => flavor)).toEqual(
      status === 503
        ? [
            'generic-full',
            'generic-full',
            'generic',
            'generic',
            'generic',
            'generic',
            'generic-full',
          ]
        : ['generic-full', 'generic', 'generic', 'generic', 'generic', 'generic-full'],
    );
    requests.slice(1).forEach((request, index) => {
      expect(request.startedAt - requests[index].startedAt).toBeGreaterThanOrEqual(2000);
    });
    expect(
      requests.at(-1)!.startedAt - requests[status === 503 ? 1 : 0].startedAt,
    ).toBeGreaterThanOrEqual(10000);
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
    ['/rer-callsigns-neo', 'generic-full'],
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

test('#3866 failed full checks remain visible across navigation until authenticated recovery @regression', async ({
  page,
}) => {
  await page.clock.install();
  await page.clock.pauseAt(new Date());
  await installAnalysisNeoApiMocks(page);
  const requests: string[] = [];
  let recover = false;
  await page.route('**/api/event-stream/long-poll', async (route) => {
    const flavor = route.request().postDataJSON().flavor;
    requests.push(flavor);
    await route.fulfill({
      status: recover || flavor === 'generic' ? 200 : 503,
      json: { events: [], last_event_id: null },
    });
  });
  await page.goto('/rer-analysis-neo');
  await page.clock.runFor(100);
  const indicator = page.getByRole('status', { name: 'Відновлення з’єднання…' });
  await expect(indicator).toBeVisible();
  await page.locator('a.app-navbar-logo').click();
  await expect(page).toHaveURL((url) => url.pathname === '/');
  await expect(indicator).toBeVisible();
  await page.clock.runFor(2100);
  await expect.poll(() => requests.length).toBe(2);
  expect(requests).toEqual(['analysis-neo', 'generic-full']);
  await expect(indicator).toBeVisible();
  recover = true;
  await page.clock.runFor(4100);
  await expect.poll(() => requests.length).toBe(3);
  expect(requests.at(-1)).toBe('generic-full');
  await expect(indicator).toHaveCount(0);
});
