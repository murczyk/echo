import { expect, test, type Page, type Route } from '@playwright/test';

import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { systemSettingsCurrentResponse } from './fixture-responses';
import { installRouteLoadComparisonMocks } from './page-loading-comparison.fixtures';

function dutyMessage(id: number, text = `Duty message ${id}`) {
  return transformCamelToSnake<Record<string, unknown>>(
    minimalInboxMessage({
      messageUuid: null,
      text: `${text} ${'message content '.repeat(25)}`,
      timestamp: 1_790_000_000_000 + id * 1000,
      createdAt: 1_790_000_000_000 + id * 1000,
      coordsWithLocality: [],
      hasDateInHeader: false,
      messageComments: [],
      unitIds: [],
      networkName: null,
      deviceName: null,
    }),
  );
}

function inboxResponse(ids: number[]) {
  return {
    inbox_items: ids.map((id) => [id, dutyMessage(id)]),
    poll_cursor_id: null,
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

async function installDutyPollingMocks(page: Page, intervalSec = 5) {
  await installRouteLoadComparisonMocks(page, 'duty');
  const pendingPolls: Route[] = [];
  const countStarts: number[] = [];
  const newerStarts: number[] = [];
  const hydratedIds: number[][] = [];
  let pollStarts = 0;
  await page.route('**/api/system-settings/current', (route) =>
    route.fulfill({
      json: { ...systemSettingsCurrentResponse(), rer_duty_poll_interval_sec: intervalSec },
    }),
  );
  await page.route('**/api/rer-importer/get-inbox', async (route) => {
    const request = route.request().postDataJSON();
    if (request.since_id_noninclusive != null) {
      newerStarts.push(await page.evaluate(() => Date.now()));
    }
    await route.fulfill({
      json: inboxResponse(
        request.since_id_noninclusive != null || request.before_id_noninclusive != null
          ? []
          : Array.from({ length: 40 }, (_, index) => index + 1),
      ),
    });
  });
  await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
    countStarts.push(await page.evaluate(() => Date.now()));
    await route.fulfill({ json: { quantity: 0, first_element_ts: null } });
  });
  await page.route('**/api/rer-importer/messages-by-id', async (route) => {
    const ids: number[] = route.request().postDataJSON().message_ids;
    hydratedIds.push(ids);
    await route.fulfill({
      json: { messages: ids.map((id) => [id, dutyMessage(id, 'Updated Duty message')]) },
    });
  });
  await page.route('**/api/rer-importer/signal-profile-batch', (route) =>
    route.fulfill({ json: { data: {} } }),
  );
  await page.route('**/api/datasources/list', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/event-stream/long-poll', (route) => {
    pollStarts += 1;
    pendingPolls.push(route);
  });
  return { pendingPolls, countStarts, newerStarts, hydratedIds, pollStarts: () => pollStarts };
}

async function navigateWithinApp(page: Page, path: string) {
  await page.evaluate((destination) => {
    window.history.pushState(null, '', destination);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, path);
}

// Regression: https://github.com/echoua/echo/issues/3780
test.describe('@regression Classic Duty polling', () => {
  test.setTimeout(75_000);
  test('uses one Shared poll across Classic and Neo navigation and refreshes loaded messages', async ({
    page,
  }) => {
    const fixture = await installDutyPollingMocks(page);
    await page.goto('/rer-duty');
    await expect(page.getByText('Duty message 40', { exact: false }).first()).toBeVisible();
    await expect.poll(fixture.pollStarts).toBe(1);
    expect(fixture.pollStarts()).toBe(1);

    await fixture.pendingPolls.shift()!.fulfill({
      json: {
        events: [40, 40, 999].map((messageId, index) => ({
          id: `duty-event-${index}`,
          event_type: { ETInboxChanged: messageId },
          created_at: 1_790_000_000_000,
          origin: null,
          intelligence_report: false,
        })),
        last_event_id: 'duty-event-2',
      },
    });
    await expect(page.getByText('Updated Duty message', { exact: false }).first()).toBeVisible();
    expect(fixture.hydratedIds).toEqual([[40]]);
    await expect.poll(fixture.pollStarts).toBe(2);

    await navigateWithinApp(page, '/rer-duty-neo');
    await expect(page.locator('rer-duty-neo')).toBeVisible();
    await navigateWithinApp(page, '/rer-duty');
    await expect(page.locator('.waterfall').first()).toBeVisible();
    expect(fixture.pollStarts()).toBe(2);
  });

  for (const status of [200, 503]) {
    test(`retries a blocked count after its ${status} response without waiting for another tick`, async ({
      page,
    }) => {
      await page.clock.install();
      await page.clock.pauseAt(new Date());
      await installDutyPollingMocks(page);
      const countStarts: number[] = [];
      let pendingCount: Route | undefined;
      await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
        countStarts.push(await page.evaluate(() => Date.now()));
        if (countStarts.length === 1) {
          pendingCount = route;
        } else {
          await route.fulfill({ json: { quantity: 0, first_element_ts: null } });
        }
      });
      await page.goto('/rer-duty');
      await page.clock.runFor(500);
      await expect(page.getByText('Duty message 40', { exact: false }).first()).toBeVisible();
      await page.clock.runFor(5000);
      await expect.poll(() => countStarts.length).toBe(1);
      await page.clock.runFor(6000);
      expect(countStarts).toHaveLength(1);

      await pendingCount!.fulfill({ status, json: { quantity: 0, first_element_ts: null } });
      await page.clock.runFor(50);
      await expect.poll(() => countStarts.length).toBe(2);
      expect(countStarts[1] - countStarts[0]).toBeGreaterThanOrEqual(5000);
      expect(countStarts[1] - countStarts[0]).toBeLessThan(10_000);
      await page.clock.runFor(4000);
      expect(countStarts).toHaveLength(2);
    });
  }

  for (const intervalSec of [5, 12]) {
    test(`repeated scroll-to-latest reloads preserve the ${intervalSec}-second automatic pace`, async ({
      page,
    }) => {
      const fixture = await installDutyPollingMocks(page, intervalSec);
      await page.goto('/rer-duty');
      await expect(page.getByText('Duty message 40', { exact: false }).first()).toBeVisible();
      await expect
        .poll(() => fixture.newerStarts.length, { timeout: intervalSec * 1000 + 5000 })
        .toBeGreaterThan(0);

      const scroller = page.locator('#waterfall-wf-0');
      for (let reload = 0; reload < 4; reload++) {
        await expect
          .poll(() =>
            scroller.evaluate(
              (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
            ),
          )
          .toBeLessThanOrEqual(1);
        await scroller.evaluate((element) => {
          element.style.scrollBehavior = 'auto';
        });
        await scroller.hover();
        await page.mouse.wheel(0, -1200);
        await expect(scroller.locator('.bi-arrow-down-circle')).toBeVisible();
        await scroller.locator('.bi-arrow-down-circle').click();
        await expect(page.getByText('Duty message 40', { exact: false }).first()).toBeVisible();
      }
      await expect
        .poll(() => fixture.newerStarts.length, { timeout: intervalSec * 5000 })
        .toBeGreaterThan(2);
      for (const starts of [fixture.countStarts, fixture.newerStarts]) {
        for (let index = 1; index < starts.length; index++) {
          expect(starts[index] - starts[index - 1]).toBeGreaterThanOrEqual(intervalSec * 1000 - 50);
        }
      }
    });
  }
});
