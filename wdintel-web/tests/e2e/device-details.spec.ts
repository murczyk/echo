import { expect, test, type Page, type Route } from '@playwright/test';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const POSIX_ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const WINDOWS_ROOT_ID = '018f0000-0000-7000-8000-000000000002';
const DOCUMENTS_ID = '018f0000-0000-7000-8000-000000000003';
const USERS_ID = '018f0000-0000-7000-8000-000000000004';
const NOW = '2026-07-24T08:00:00Z';

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

function root(entryId: string, name: string, pathSyntax: 'posix' | 'windows') {
  return {
    entry_id: entryId,
    device_id: DEVICE_ID,
    parent_entry_id: null,
    kind: 'directory',
    name,
    path_syntax: pathSyntax,
    created_at: NOW,
    updated_at: NOW,
  };
}

function entry({
  entryId,
  parentEntryId,
  kind,
  name,
  pathSyntax = null,
  absolutePath = null,
}: {
  entryId: string;
  parentEntryId: string;
  kind: 'directory' | 'file';
  name: string;
  pathSyntax?: 'posix' | 'windows' | null;
  absolutePath?: string | null;
}) {
  return {
    entry_id: entryId,
    parent_entry_id: parentEntryId,
    kind,
    file_id: kind === 'file' ? `${entryId.slice(0, -1)}f` : null,
    name,
    path_components: [name],
    path_syntax: pathSyntax,
    absolute_path: absolutePath,
    mime_type: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? name.split('.').at(-1) : null,
    file_metadata_created_at: null,
    file_metadata_modified_at: NOW,
    created_at: NOW,
    updated_at: NOW,
  };
}

function systemSettings() {
  return {
    id: null,
    rer_analysis_units_exact_match_only_default: false,
    rer_duty_test_enabled: false,
    rer_duty_insert_historical_interceptions: false,
    rer_duty_test_since_ms: 0,
    rer_duty_test_limit: 1,
    rer_duty_poll_interval_sec: 1,
    short_url_enabled: false,
    support_non_rer_interceptions: false,
    default_neo_analysis: false,
    autofix_echoim_missing_messages: false,
    peleng_bounds_enabled: false,
    peleng_bounds_top_left_lat: null,
    peleng_bounds_top_left_lng: null,
    peleng_bounds_bottom_right_lat: null,
    peleng_bounds_bottom_right_lng: null,
    devices_section_enabled: true,
    sigint_comment_parsing_enabled: false,
    do_not_store_duplicate_echoim_failures: false,
  };
}

async function installMocks(page: Page) {
  await page.route('**/api-public/server-info', (route) =>
    fulfillJson(route, {
      mode: '',
      public_host: '',
      grafana_address: '',
      feature_delta: false,
      feature_analysis_map: false,
      feature_strict_networks: false,
      version: '',
    }),
  );
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.fallback();
      return;
    }
    if (pathname === '/api/user') {
      await fulfillJson(route, {
        name: 'device-tester',
        roles: ['Cyber', 'DeviceSource', 'DeviceAnalyst'],
        sigint_zone_id: null,
        organism_id: null,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
      });
      return;
    }
    if (pathname === '/api/system-settings/current') {
      await fulfillJson(route, systemSettings());
      return;
    }
    if (pathname === '/api/user/settings') {
      await fulfillJson(route, { tagsLayout: 'compact', disableAutoScroll: false });
      return;
    }
    if (pathname === '/api/device/detail') {
      await fulfillJson(route, {
        id: DEVICE_ID,
        source_label: 'Inventory Alpha',
        name: 'Device Alpha',
        aors: [{ id: 1, name: 'Північ' }],
        unit: { id: 7, name: 'Unit Seven' },
        external_url: 'https://example.test/device-alpha',
        custom_fields: { inventory_id: 'node-1' },
        created_by: 'operator',
        archived: false,
        created_at: NOW,
        updated_at: NOW,
        archived_at: null,
      });
      return;
    }
    if (pathname === '/api/device/files/roots') {
      await fulfillJson(route, {
        roots: [root(POSIX_ROOT_ID, '/', 'posix'), root(WINDOWS_ROOT_ID, 'C:\\', 'windows')],
      });
      return;
    }
    if (pathname === '/api/device/files/browse') {
      const request = route.request().postDataJSON() as { parent_entry_id: string };
      const entries =
        request.parent_entry_id === POSIX_ROOT_ID
          ? [
              entry({
                entryId: DOCUMENTS_ID,
                parentEntryId: POSIX_ROOT_ID,
                kind: 'directory',
                name: 'documents',
              }),
              entry({
                entryId: '018f0000-0000-7000-8000-000000000010',
                parentEntryId: POSIX_ROOT_ID,
                kind: 'file',
                name: 'root.log',
                pathSyntax: 'posix',
                absolutePath: '/root.log',
              }),
            ]
          : request.parent_entry_id === WINDOWS_ROOT_ID
            ? [
                entry({
                  entryId: USERS_ID,
                  parentEntryId: WINDOWS_ROOT_ID,
                  kind: 'directory',
                  name: 'Users',
                }),
              ]
            : request.parent_entry_id === DOCUMENTS_ID
              ? [
                  entry({
                    entryId: '018f0000-0000-7000-8000-000000000011',
                    parentEntryId: DOCUMENTS_ID,
                    kind: 'file',
                    name: 'report.txt',
                    pathSyntax: 'posix',
                    absolutePath: '/documents/report.txt',
                  }),
                ]
              : [];
      await fulfillJson(route, { breadcrumbs: [], entries, next_cursor: null });
      return;
    }
    if (pathname === '/api/device/files/search') {
      await fulfillJson(route, { entries: [], next_cursor: null });
      return;
    }

    await fulfillJson(route, {});
  });
}

test('@smoke device details uses tabs, a collapsible network-width sidebar, and an all-roots file tree', async ({
  page,
}) => {
  const browserFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserFailures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on('requestfailed', (request) => {
    const errorText = request.failure()?.errorText ?? '';
    if (!errorText.includes('ABORTED')) {
      browserFailures.push(`requestfailed: ${request.url()} ${errorText}`);
    }
  });
  page.on('response', (response) => {
    if (response.status() >= 400) {
      browserFailures.push(`response: ${response.status()} ${response.url()}`);
    }
  });
  await installMocks(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/devices/${DEVICE_ID}`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('tab', { name: 'Аналітичні відомості' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Файли' })).toBeVisible();
  const metadataPanel = page.getByTestId('device-details-left-panel');
  await expect(metadataPanel).toBeVisible();
  const metadataBox = await metadataPanel.boundingBox();
  expect(metadataBox?.width).toBeGreaterThanOrEqual(360);
  expect(metadataBox?.width).toBeLessThanOrEqual(420);

  await page.getByRole('tab', { name: 'Файли' }).click();
  const fileTree = page.getByTestId('device-files-tree-panel');
  await expect(fileTree).toBeVisible();
  await expect(page.getByLabel('Вибрати каталог / як область пошуку')).toBeVisible();
  await expect(page.getByLabel('Вибрати каталог C:\\ як область пошуку')).toBeVisible();
  await expect(page.getByText('root.log', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Вибрати каталог Users як область пошуку')).toBeVisible();
  await expect(page.getByLabel('Назва містить')).toBeVisible();
  await expect(page.getByLabel('MIME-типи')).toBeVisible();
  await expect(page.getByLabel('Розширення')).toBeVisible();

  const rootLabelBox = await page.getByLabel('Вибрати каталог / як область пошуку').boundingBox();
  const documentsLabel = page.getByLabel('Вибрати каталог documents як область пошуку');
  const documentsLabelBox = await documentsLabel.boundingBox();
  expect(documentsLabelBox?.x).toBeGreaterThan(rootLabelBox?.x ?? 0);

  await page.getByLabel('Розгорнути каталог documents').click();
  await expect(page.getByText('report.txt', { exact: true })).toBeVisible();

  const mainPanel = page.getByTestId('device-details-tab-panel');
  const mainBeforeCollapse = await mainPanel.boundingBox();
  await page.getByRole('button', { name: 'Згорнути ліву панель' }).click();
  await expect(fileTree).toBeHidden();
  await expect(page.getByRole('button', { name: 'Розгорнути ліву панель' })).toBeVisible();
  const mainAfterCollapse = await mainPanel.boundingBox();
  expect(mainAfterCollapse?.width).toBeGreaterThan(mainBeforeCollapse?.width ?? 0);

  await page.setViewportSize({ width: 768, height: 900 });
  await expect(page.getByRole('button', { name: 'Розгорнути ліву панель' })).toBeVisible();
  await expect(fileTree).toBeHidden();
  await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
  await expect(fileTree).toBeVisible();
  const tabletTreeBox = await fileTree.boundingBox();
  const tabletMainBox = await mainPanel.boundingBox();
  expect(tabletMainBox?.y).toBeGreaterThan(tabletTreeBox?.y ?? 0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Розгорнути ліву панель' })).toBeHidden();
  await expect(fileTree).toBeVisible();
  expect(browserFailures).toEqual([]);
});
