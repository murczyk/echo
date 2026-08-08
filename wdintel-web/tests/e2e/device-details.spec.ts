import { expect, test, type Page, type Route } from '@playwright/test';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const POSIX_ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const WINDOWS_ROOT_ID = '018f0000-0000-7000-8000-000000000002';
const DOCUMENTS_ID = '018f0000-0000-7000-8000-000000000003';
const USERS_ID = '018f0000-0000-7000-8000-000000000004';
const NOW = '2026-07-24T08:00:00Z';
const JOURNAL_FILE_ID = '018f0000-0000-7000-8000-000000000005';
const ANALYTICS_TAG_ID = '018f0000-0000-7000-8000-000000000006';

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
    has_content: kind === 'file',
    mime_type: kind === 'file' ? 'text/plain' : null,
    extension: kind === 'file' ? name.split('.').at(-1) : null,
    file_metadata_created_at: null,
    file_metadata_modified_at: NOW,
    created_at: NOW,
    updated_at: NOW,
    tags: [],
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
    rer_duty_test_replay_interval_sec: 1,
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
    goi_association_message_uid_worker_enabled: false,
    report_chunking_hours: 24,
    limit_big_reports: false,
    enable_audio_transcription: false,
    show_classic_duty: false,
    show_classic_analysis: false,
    hide_orbit_data: false,
  };
}

type ApiTracker = {
  analyticsSummaryRequestCount: number;
  analyticsTagsRequestCount: number;
  journalRequestCount: number;
  rootsRequestCount: number;
  subtreeCountRequestCount: number;
  submittedCreateName: string | undefined;
  releaseSubtreeCounts: () => void;
};

async function installMocks(page: Page): Promise<ApiTracker> {
  let releaseSubtreeCounts = () => undefined;
  const subtreeCountsReady = new Promise<void>((resolve) => {
    releaseSubtreeCounts = resolve;
  });
  const tracker: ApiTracker = {
    analyticsSummaryRequestCount: 0,
    analyticsTagsRequestCount: 0,
    journalRequestCount: 0,
    rootsRequestCount: 0,
    subtreeCountRequestCount: 0,
    submittedCreateName: undefined,
    releaseSubtreeCounts,
  };
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
        id: 'device-tester-id',
        name: 'device-tester',
        roles: ['Cyber', 'DeviceSource'],
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
    if (pathname === '/api/device/list') {
      await fulfillJson(route, {
        list: [],
        total: 0,
        has_more: false,
        status_counts: { active: 0, archived: 0 },
      });
      return;
    }
    if (pathname === '/api/device/unit-stats') {
      await fulfillJson(route, { units: [] });
      return;
    }
    if (pathname === '/api/device/aors') {
      await fulfillJson(route, []);
      return;
    }
    if (pathname === '/api/device/units') {
      await fulfillJson(route, { units: [] });
      return;
    }
    if (pathname === '/api/device/create') {
      const payload: unknown = route.request().postDataJSON();
      if (payload === null || typeof payload !== 'object' || !('name' in payload)) {
        throw new Error('Device create request is missing name');
      }
      if (typeof payload.name !== 'string') {
        throw new Error('Device create request name is not a string');
      }
      tracker.submittedCreateName = payload.name;
      await fulfillJson(route, {
        id: DEVICE_ID,
        name: tracker.submittedCreateName,
        aors: [],
        unit: null,
        external_url: null,
        custom_fields: {},
        created_by: 'device-tester',
        archived: false,
        created_at: NOW,
        updated_at: NOW,
        archived_at: null,
      });
      return;
    }
    if (pathname === '/api/device/detail') {
      await fulfillJson(route, {
        id: DEVICE_ID,
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
    if (pathname === '/api/device/analytics/tags') {
      tracker.analyticsTagsRequestCount += 1;
      await fulfillJson(route, {
        tags: [{ id: ANALYTICS_TAG_ID, name: 'Документи' }],
      });
      return;
    }
    if (pathname === '/api/device/analytics/summary') {
      tracker.analyticsSummaryRequestCount += 1;
      await fulfillJson(route, {
        items: [
          {
            tag: { id: ANALYTICS_TAG_ID, name: 'Документи' },
            file_count: 1,
            latest_file_entry_created_at: NOW,
          },
        ],
      });
      return;
    }
    if (pathname === '/api/device/files/roots') {
      tracker.rootsRequestCount += 1;
      await fulfillJson(route, {
        roots: [root(POSIX_ROOT_ID, '/', 'posix'), root(WINDOWS_ROOT_ID, 'C:\\', 'windows')],
      });
      return;
    }
    if (pathname === '/api/device/files/subtree-counts') {
      tracker.subtreeCountRequestCount += 1;
      const request = route.request().postDataJSON() as {
        directory_entry_ids: string[];
      };
      const countsByEntryId: Record<string, number> = {
        [POSIX_ROOT_ID]: 2,
        [WINDOWS_ROOT_ID]: 0,
        [DOCUMENTS_ID]: 1,
        [USERS_ID]: 0,
      };
      await subtreeCountsReady;
      await fulfillJson(route, {
        counts: request.directory_entry_ids.map((entryId) => ({
          entry_id: entryId,
          file_count: countsByEntryId[entryId],
        })),
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
    if (pathname === '/api/device/files/journal') {
      tracker.journalRequestCount += 1;
      await fulfillJson(route, {
        entries: [
          {
            file_id: JOURNAL_FILE_ID,
            name: 'journal.log',
            absolute_path: '/var/log/journal.log',
            has_content: true,
            synchronized_at: '2026-07-28T08:15:30Z',
            tags: [],
          },
        ],
        total_count: 1,
        next_cursor: null,
      });
      return;
    }

    await fulfillJson(route, {});
  });
  return tracker;
}

test('@smoke device details uses tabs, a synchronization journal, a collapsible network-width sidebar, and an all-roots file tree', async ({
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
  const tracker = await installMocks(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/devices/${DEVICE_ID}`, { waitUntil: 'domcontentloaded' });

  await expect(page.getByRole('tab', { name: 'Аналітичні відомості' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('tab', { name: 'Файли' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Журнал' })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Аналітика файлів' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Аналітика файлів' })).toBeVisible();
  await expect(page.getByText('Документи', { exact: true })).toBeVisible();
  await expect.poll(() => tracker.analyticsTagsRequestCount).toBe(1);
  await expect.poll(() => tracker.analyticsSummaryRequestCount).toBe(1);
  expect(tracker.journalRequestCount).toBe(0);
  expect(tracker.rootsRequestCount).toBe(0);
  const metadataPanel = page.getByTestId('device-details-left-panel');
  await expect(metadataPanel).toBeVisible();
  await expect(metadataPanel).toContainText('Назва');
  await expect(metadataPanel).toContainText('Device Alpha');
  await expect(metadataPanel).not.toContainText('Джерельна мітка');
  const metadataBox = await metadataPanel.boundingBox();
  expect(metadataBox?.width).toBeGreaterThanOrEqual(360);
  expect(metadataBox?.width).toBeLessThanOrEqual(420);

  await page.getByRole('tab', { name: 'Журнал' }).click();
  const journalTable = page.getByRole('table', {
    name: 'Журнал синхронізації файлів',
  });
  await expect(journalTable).toBeVisible();
  await expect(metadataPanel).toBeVisible();
  await expect(journalTable.getByRole('columnheader')).toHaveText([
    'Назва файлу',
    'Шлях до файлу',
    'Теги',
    'Контент',
    'Дата й час синхронізації',
  ]);
  const journalRow = journalTable.getByRole('row').filter({ hasText: 'journal.log' });
  await expect(journalRow).toContainText('/var/log/journal.log');
  await expect(journalRow.getByRole('img', { name: 'Контент файлу наявний' })).toBeVisible();
  await expect.poll(() => tracker.journalRequestCount).toBe(1);
  await expect(page.getByRole('status', { name: 'Показано 1 з 1 файлів' })).toBeVisible();

  await page.getByRole('tab', { name: 'Аналітичні відомості' }).click();
  await page.getByRole('tab', { name: 'Журнал' }).click();
  await expect(journalTable).toBeVisible();
  await expect.poll(() => tracker.journalRequestCount).toBe(2);
  expect(tracker.rootsRequestCount).toBe(0);

  await page.getByRole('tab', { name: 'Файли' }).click();
  const fileTree = page.getByTestId('device-files-tree-panel');
  await expect(fileTree).toBeVisible();
  await expect.poll(() => tracker.rootsRequestCount).toBe(1);
  await expect(page.getByLabel('Вибрати каталог / як область пошуку')).toBeVisible();
  await expect(page.getByLabel('Вибрати каталог C:\\ як область пошуку')).toBeVisible();
  await expect(page.getByText('root.log', { exact: true })).toBeVisible();
  const rootFileRow = fileTree.getByRole('listitem').filter({ hasText: /^root\.log$/ });
  await expect(rootFileRow.getByText('.log', { exact: true })).toHaveCount(0);
  await expect(rootFileRow).not.toContainText('text/plain');
  await expect(page.getByLabel('Вибрати каталог Users як область пошуку')).toBeVisible();
  await expect(page.getByLabel('Завантаження кількості файлів')).toBeVisible();
  await expect.poll(() => tracker.subtreeCountRequestCount).toBe(1);
  await expect(
    page.getByLabel(
      'Вибрати каталог / як область пошуку; Файлів у каталозі та вкладених каталогах: 2',
      { exact: true },
    ),
  ).toHaveCount(0);
  tracker.releaseSubtreeCounts();
  await expect(page.getByLabel('Завантаження кількості файлів')).toBeHidden();
  await expect(
    page.getByLabel(
      'Вибрати каталог / як область пошуку; Файлів у каталозі та вкладених каталогах: 2',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel(
      'Вибрати каталог C:\\ як область пошуку; Файлів у каталозі та вкладених каталогах: 0',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    page.getByLabel(
      'Вибрати каталог Users як область пошуку; Файлів у каталозі та вкладених каталогах: 0',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(page.getByLabel('Назва містить')).toBeVisible();
  await expect(page.getByLabel('MIME-типи')).toBeVisible();
  await expect(page.getByLabel('Розширення')).toBeVisible();

  const rootLabelBox = await page.getByLabel('Вибрати каталог / як область пошуку').boundingBox();
  const documentsLabel = page.getByLabel('Вибрати каталог documents як область пошуку');
  const documentsLabelBox = await documentsLabel.boundingBox();
  expect(documentsLabelBox?.x).toBeGreaterThan(rootLabelBox?.x ?? 0);

  await page.getByLabel('Розгорнути каталог documents').click();
  await expect(page.getByText('report.txt', { exact: true })).toBeVisible();
  await expect(
    page.getByLabel(
      'Вибрати каталог documents як область пошуку; Файлів у каталозі та вкладених каталогах: 1',
      { exact: true },
    ),
  ).toBeVisible();

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
  await page.getByRole('tab', { name: 'Журнал' }).click();
  await expect(journalTable).toBeVisible();
  await expect(metadataPanel).toBeVisible();
  expect(browserFailures).toEqual([]);
});

test('@smoke device creation requires and submits a name for DeviceSource', async ({ page }) => {
  const browserFailures: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') browserFailures.push(`console: ${message.text()}`);
  });
  page.on('pageerror', (error) => browserFailures.push(`pageerror: ${error.message}`));
  page.on('response', (response) => {
    if (response.status() >= 400) {
      browserFailures.push(`response: ${response.status()} ${response.url()}`);
    }
  });

  const tracker = await installMocks(page);

  await page.goto('/devices', { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Створити пристрій' }).click();

  const nameInput = page.getByRole('textbox', { name: 'Назва', exact: true });
  await expect(nameInput).toBeVisible();
  await expect(nameInput).toHaveAttribute('required', '');
  await nameInput.fill('  Device Bravo  ');
  await expect(nameInput).toHaveAttribute('aria-invalid', 'false');
  await page.getByRole('button', { name: 'Створити', exact: true }).click();

  await expect.poll(() => tracker.submittedCreateName).toBe('Device Bravo');
  await expect(page.getByRole('textbox', { name: 'Назва', exact: true })).toBeHidden();
  expect(browserFailures).toEqual([]);
});
