import { expect, test, type Page, type Route } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const NETWORK_ID = 42;

const network = {
  id: NETWORK_ID,
  name: 'Callsigns network',
  location: '',
  freqs: [],
  unit_ids: [],
  aor_ids: [],
  post_ids: [],
  descriptions: [],
  created_at: Date.now(),
  radio_station: null,
  purpose: null,
  operation_mode: null,
  operation_type: null,
  operation_period: null,
  last_activity_at: null,
  last_updated_at: Date.now(),
  last_updated_by: null,
  active_from: null,
  active_to: null,
  deleted: false,
  do_not_archive: false,
  unit_mask: [],
  status: 'NetworkActive',
};

function networkCallsign(id: number, callsign: string, messageCount = 0) {
  return {
    id,
    network_id: NETWORK_ID,
    callsign,
    known_callsign_id: null,
    position: null,
    comment: null,
    full_name: null,
    unit_id: null,
    unit_name: null,
    source_id: null,
    radio_freq: null,
    created_at: Date.now(),
    active: true,
    developing: false,
    message_count: messageCount,
    last_datetime: messageCount > 0 ? Date.now() : null,
    freqs: null,
    unit_developing: false,
    main_radio_station: false,
    command_control: false,
  };
}

async function installCallsignsMocks(page: Page) {
  const statsRequests: Route[] = [];
  const listBodies: Array<{ include_activity_info: boolean | null; period: string | null }> = [];

  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  await page.route('**/api/sigint/network-info-one', (route) => route.fulfill({ json: network }));
  await page.route('**/api/sigint/sources', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/sigint/network-callsigns-list', (route) =>
    route.fulfill({ json: { callsigns: [] } }),
  );
  await page.route('**/api/sigint/network-callsigns/list', (route) => {
    const body = route.request().postDataJSON();
    listBodies.push(body);
    if (body.include_activity_info === false) {
      return route.fulfill({
        json: {
          network_callsigns: [networkCallsign(1, 'СОКІЛ-1'), networkCallsign(2, 'БАРС-2')],
        },
      });
    }
    statsRequests.push(route);
    return undefined;
  });

  return { statsRequests, listBodies };
}

test('@regression #4047 shows the all-time callsign list before stats, then filters with stats', async ({
  page,
}) => {
  const { statsRequests, listBodies } = await installCallsignsMocks(page);

  await page.goto(`/rer-networks-neo/${NETWORK_ID}?tab=callsigns`);

  const activeRow = page.getByRole('row', { name: /СОКІЛ-1/ });
  const silentRow = page.getByRole('row', { name: /БАРС-2/ });
  await expect(activeRow).toBeVisible();
  await expect(silentRow).toBeVisible();

  await expect.poll(() => statsRequests.length).toBe(1);
  expect(listBodies).toContainEqual(
    expect.objectContaining({ include_activity_info: false, period: null }),
  );
  expect(listBodies).toContainEqual(
    expect.objectContaining({ include_activity_info: true, period: 'Last21Days' }),
  );

  await statsRequests[0].fulfill({
    json: { network_callsigns: [networkCallsign(1, 'СОКІЛ-1', 5)] },
  });

  await expect(page.getByRole('columnheader', { name: /К-сть \(21 д\)/ })).toBeVisible();
  await expect(activeRow).toContainText('5');
  await expect(silentRow).toBeVisible();

  await page.getByRole('button', { name: 'Налаштування позивних' }).first().click();
  await page.getByLabel('Період позивних').click();
  await page.getByRole('option', { name: '21 день' }).click();
  await page.keyboard.press('Escape');

  await expect(silentRow).toHaveCount(0);
  await expect(activeRow).toBeVisible();
  expect(statsRequests).toHaveLength(1);
});

test('@regression #4047 keeps the callsign list when stats fail and retries them', async ({
  page,
}) => {
  const { statsRequests } = await installCallsignsMocks(page);

  await page.goto(`/rer-networks-neo/${NETWORK_ID}?tab=callsigns`);

  await expect(page.getByRole('row', { name: /СОКІЛ-1/ })).toBeVisible();
  await expect.poll(() => statsRequests.length).toBe(1);
  await statsRequests[0].fulfill({ status: 500, json: { error: 'stats failed' } });

  await expect(page.getByText(/Не вдалося завантажити статистику позивних/)).toBeVisible();
  await expect(page.getByRole('row', { name: /СОКІЛ-1/ })).toBeVisible();

  await page.getByRole('button', { name: 'Спробувати ще раз' }).click();
  await expect.poll(() => statsRequests.length).toBe(2);
  await statsRequests[1].fulfill({
    json: { network_callsigns: [networkCallsign(1, 'СОКІЛ-1', 5)] },
  });

  await expect(page.getByText(/Не вдалося завантажити статистику позивних/)).toHaveCount(0);
  await expect(page.getByRole('row', { name: /СОКІЛ-1/ })).toContainText('5');
});
