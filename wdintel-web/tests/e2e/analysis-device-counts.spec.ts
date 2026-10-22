import { expect, test } from '@playwright/test';
import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

test('@regression #3783 device options show message counts and refresh with other filters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installAnalysisNeoApiMocks(page, {
    userRoles: ['Rer', 'Cyber'],
    inboxResponse: createLoadedInboxResponse(),
  });
  await page.route('**/api/system-settings/current', (route) =>
    route.fulfill({
      json: { ...systemSettingsCurrentResponse(), devices_section_enabled: true },
    }),
  );
  const requests: Array<Record<string, unknown>> = [];
  await page.route('**/api/rer/analysis/stats/device-names', (route) => {
    const req = route.request().postDataJSON();
    requests.push(req);
    return route.fulfill({
      json: [
        { name: 'Device Alpha', count: req.search ? 3 : 17 },
        { name: 'Device Beta', count: req.search ? 1 : 8 },
      ],
    });
  });
  const inboxRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/rer-importer/get-inbox', async (route) => {
    inboxRequests.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.goto('/rer-analysis-neo?deviceNames=Device%20Alpha');
  const devices = page.locator('[data-section-id="Пристрої"]');
  await devices.getByRole('button', { name: /Пристрої/ }).click();
  const picker = devices.getByRole('combobox', { name: 'Назва пристрою' });
  await picker.click();
  await expect(page.getByRole('option', { name: /Device Alpha/ })).toHaveText('Device Alpha17');
  await expect(page.getByRole('option', { name: /Device Beta/ })).toHaveText('Device Beta8');
  expect(requests.at(-1)?.selected_device_names).toBeNull();
  await page.getByRole('option', { name: /Device Beta/ }).click();
  await picker.press('Escape');
  await expect
    .poll(() => inboxRequests.at(-1)?.selected_device_names)
    .toEqual(['Device Alpha', 'Device Beta']);
  await page.getByPlaceholder('Пошук', { exact: true }).fill('signal');
  await expect.poll(() => requests.at(-1)?.search).toBe('signal');
  await picker.click();
  await expect(page.getByRole('option', { name: /Device Alpha/ })).toHaveText('Device Alpha3');
  await expect(page.getByRole('option', { name: /Device Beta/ })).toHaveText('Device Beta1');
});

test('@regression #3783 disabled devices send no device count requests and clear stored filters', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installAnalysisNeoApiMocks(page, {
    userRoles: ['Rer', 'Cyber'],
    inboxResponse: createLoadedInboxResponse(),
  });
  const deviceRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/rer/analysis/stats/device-names'))
      deviceRequests.push(request.url());
  });
  const inboxRequests: Array<Record<string, unknown>> = [];
  await page.route('**/api/rer-importer/get-inbox', async (route) => {
    inboxRequests.push(route.request().postDataJSON());
    await route.fallback();
  });
  await page.goto('/rer-analysis-neo?deviceNames=Device%20Alpha');
  await expect(page.locator('[data-message-id="101"]')).toBeVisible();
  await expect(page.locator('[data-section-id="Пристрої"]')).toHaveCount(0);
  await expect.poll(() => new URL(page.url()).searchParams.get('deviceNames')).toBeNull();
  expect(inboxRequests.length).toBeGreaterThan(0);
  expect(inboxRequests.every((req) => req.selected_device_names == null)).toBe(true);
  expect(deviceRequests).toEqual([]);
});
