import { expect, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const frequency = {
  id: 11,
  network_id: 42,
  freq: '145.5000',
  deleted: false,
  active_from: Date.UTC(2026, 0, 1),
  active_to: null,
  created_at: 0,
  modulation: 'NFM',
  encryption_id: null,
  encryption_keys: [],
};
const description = {
  id: 7,
  network_id: 42,
  network_frequency_id: null,
  descr_type: 'Confirmation',
  topic: 'Початкова тема',
  description: 'Початкові матеріали',
  login: 'analysis-tester',
  created_at: 0,
};
const network = {
  id: 42,
  name: 'Мережа для регресії',
  location: 'Початковий район',
  freqs: [frequency],
  unit_ids: [1],
  aor_ids: [1],
  post_ids: [],
  descriptions: [description],
  created_at: 0,
  radio_station: null,
  purpose: null,
  operation_mode: null,
  operation_type: null,
  operation_period: null,
  last_activity_at: null,
  last_updated_at: 0,
  last_updated_by: null,
  active_from: null,
  active_to: null,
  deleted: false,
  do_not_archive: false,
  unit_mask: [],
  status: 'NetworkActive',
};

export async function installNetworkDrawerMocks(page: Page, tab: string) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  for (const endpoint of ['aor', 'posts', 'encryptions-list']) {
    await page.route(`**/api/sigint/${endpoint}`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/api/sigint/sources', (route) => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/sigint/network-info-one', (route) => route.fulfill({ json: network }));
  await page.route('**/api/sigint/network-callsigns-list', (route) =>
    route.fulfill({ json: { callsigns: [] } }),
  );
  await page.route('**/api/sigint/network-callsigns/list', (route) =>
    route.fulfill({ json: { network_callsigns: [] } }),
  );
  await page.route('**/api/sigint/network-freqs-list', (route) =>
    route.fulfill({ json: { freqs: [] } }),
  );
  await page.route('**/api/sigint/network-freq-callsigns-batch', (route) =>
    route.fulfill({ json: { results: [] } }),
  );
  await page.route('**/api/sigint/keys', (route) => route.fulfill({ json: { keys: [] } }));
  const writes: Array<{ operation: string; payload: Record<string, any> }> = [];
  let failNext = false;
  for (const operation of [
    'update-network',
    'network/update-posts',
    'network/update-units',
    'network/add-descriptions',
    'network/update-description',
    'network/v2/add-freq',
  ]) {
    await page.route(`**/api/sigint/${operation}`, async (route) => {
      writes.push({ operation, payload: route.request().postDataJSON() });
      if (failNext) {
        failNext = false;
        await route.fulfill({ status: 500, json: { error: 'Тестова помилка збереження' } });
        return;
      }
      await route.fulfill({
        json: operation === 'network/v2/add-freq' ? { network, freq: null } : network,
      });
    });
  }
  await page.goto(`/rer-networks-neo/42?tab=${tab}`);
  await expect(page.getByRole('button', { name: 'Дії з мережею', exact: true })).toBeVisible();
  return {
    writes,
    failNextSave: () => {
      failNext = true;
    },
  };
}

export function networkDrawer(page: Page, kind: 'edit' | 'description' | 'freq-create') {
  return page.locator(`[aria-labelledby="network-${kind}-drawer-title"]`);
}

export async function openNetworkEdit(page: Page) {
  await page.getByRole('button', { name: 'Дії з мережею', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  const form = networkDrawer(page, 'edit');
  await expect(form).toBeVisible();
  return form;
}

export async function openNetworkAdd(page: Page, kind: 'description' | 'freq-create') {
  await page.getByRole('button', { name: 'Додати', exact: true }).click();
  const form = networkDrawer(page, kind);
  await expect(form).toBeVisible();
  return form;
}
