import { expect, test, type Page } from '@playwright/test';
import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function installUnitMocks(page: Page) {
  const inbox = createLoadedInboxResponse();
  Object.assign(inbox.inbox_items[0][1], { unitIds: [1], unitDisplay: 'Parent' });
  await installAnalysisNeoApiMocks(page, { inboxResponse: inbox });
  const hierarchyRequests: unknown[] = [];
  const unitRequests: number[][] = [];
  const inboxRequests: { selected_unit_ids?: number[] }[] = [];
  let renamed = false;
  let emitChange = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/rer-importer/get-inbox') {
      inboxRequests.push(request.postDataJSON());
    }
  });
  await page.route('**/api/sigint/units/hierarchy', (route) => {
    const request = route.request().postDataJSON();
    hierarchyRequests.push(request);
    const revision = renamed ? 'renamed' : 'original';
    return route.fulfill({
      json:
        request.known_revision === revision
          ? null
          : {
              revision,
              groups: [],
              units: [{ id: 1, name: renamed ? 'Renamed parent' : 'Parent', group_index: null }],
              selections: [
                {
                  value: 'unit-id:1',
                  label: renamed ? 'Renamed parent' : 'Parent',
                  unit_ids: [1, 2, 3],
                  exact_unit_ids: [1],
                },
              ],
            },
    });
  });
  await page.route('**/api/sigint/units-by-id', (route) => {
    const { ids } = route.request().postDataJSON();
    unitRequests.push(ids);
    return route.fulfill({
      json: {
        units: ids.map((id: number) => ({ id, name: renamed ? 'Renamed parent' : 'Parent' })),
      },
    });
  });
  await page.route('**/api/event-stream/long-poll', (route) => {
    const events = emitChange
      ? [
          {
            id: 'unit-change',
            event_type: 'ETUnitChanged',
            created_at: Date.now(),
            origin: null,
            intelligence_report: false,
          },
        ]
      : [];
    emitChange = false;
    return route.fulfill({ json: { events, last_event_id: events.length ? 'unit-change' : null } });
  });
  return {
    hierarchyRequests,
    unitRequests,
    inboxRequests,
    rename: () => {
      renamed = true;
      emitChange = true;
    },
  };
}

test('@regression #3571 avoids catalog requests on focus, recovery and timers', async ({
  page,
}) => {
  const requests = await installUnitMocks(page);
  await page.goto('/rer-analysis-neo');
  await expect(page.locator('[data-message-id="101"]')).toBeVisible();
  await expect.poll(() => requests.unitRequests.length).toBe(1);
  await page.clock.install();
  await page.evaluate(() => {
    window.dispatchEvent(new Event('focus'));
    window.dispatchEvent(new Event('online'));
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(65_000);
  expect(requests.hierarchyRequests).toHaveLength(0);
  expect(requests.unitRequests).toEqual([[1]]);
});

test('@regression #3571 resolves parent selections without downloading descendants and refreshes actual changes', async ({
  page,
}) => {
  const requests = await installUnitMocks(page);
  await page.goto('/rer-analysis-neo?units=unit-id%3A1');
  await expect(page.locator('[data-message-id="101"]')).toBeVisible();
  await expect.poll(() => requests.unitRequests.length).toBe(1);
  expect(requests.hierarchyRequests).toEqual([
    { known_revision: null, unit_ids: [], selection_values: ['unit-id:1'] },
  ]);
  expect(requests.inboxRequests.length).toBeGreaterThan(0);
  expect(
    requests.inboxRequests.every(
      (request) => JSON.stringify(request.selected_unit_ids) === '[1,2,3]',
    ),
  ).toBe(true);
  requests.rename();
  await expect.poll(() => requests.unitRequests.length).toBe(2);
  await expect.poll(() => requests.hierarchyRequests.length).toBe(2);
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect.poll(() => requests.unitRequests.length).toBe(3);
  await expect.poll(() => requests.hierarchyRequests.length).toBe(3);
  expect(requests.unitRequests).toEqual([[1], [1], [1]]);
});
