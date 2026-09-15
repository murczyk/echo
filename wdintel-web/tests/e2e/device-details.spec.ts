import { readFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import { expect, test, type Page, type Route } from '@playwright/test';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const POSIX_ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const WINDOWS_ROOT_ID = '018f0000-0000-7000-8000-000000000002';
const DOCUMENTS_ID = '018f0000-0000-7000-8000-000000000003';
const USERS_ID = '018f0000-0000-7000-8000-000000000004';
const NOW = '2026-07-24T08:00:00Z';
const JOURNAL_FILE_ID = '018f0000-0000-7000-8000-000000000005';
const ANALYTICS_TAG_ID = '018f0000-0000-7000-8000-000000000006';
const SEARCH_FILE_ONE_ID = '018f0000-0000-7000-8000-000000000012';
const SEARCH_FILE_TWO_ID = '018f0000-0000-7000-8000-000000000013';

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
    show_peleng_distance_to_battleline: false,
    hide_orbit_data: false,
    disable_bot_tags: false,
  };
}

type ApiTracker = {
  analyticsSummaryRequestCount: number;
  analyticsTagsRequestCount: number;
  journalRequestCount: number;
  rootsRequestCount: number;
  subtreeCountRequestCount: number;
  searchRequests: Array<Record<string, unknown>>;
  deviceArchived: boolean;
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
    searchRequests: [],
    deviceArchived: false,
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
        archived: tracker.deviceArchived,
        created_at: NOW,
        updated_at: NOW,
        archived_at: tracker.deviceArchived ? NOW : null,
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
        total_file_count: 2,
        analyzed_file_count: 1,
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
      const request = route.request().postDataJSON() as Record<string, unknown>;
      tracker.searchRequests.push(request);
      const nameQuery = request.name_query;
      const cursor = request.cursor;
      const entries =
        nameQuery === 'duplicate'
          ? cursor === null
            ? [
                entry({
                  entryId: SEARCH_FILE_ONE_ID,
                  parentEntryId: POSIX_ROOT_ID,
                  kind: 'file',
                  name: 'duplicate.log',
                  pathSyntax: 'posix',
                  absolutePath: '/shared/duplicate.log',
                }),
              ]
            : cursor === 'search-page-2'
              ? [
                  entry({
                    entryId: SEARCH_FILE_TWO_ID,
                    parentEntryId: POSIX_ROOT_ID,
                    kind: 'file',
                    name: 'duplicate.log',
                    pathSyntax: 'posix',
                    absolutePath: '/shared/duplicate.log',
                  }),
                ]
              : []
          : nameQuery === null && request.scope_entry_id === POSIX_ROOT_ID
            ? [
                entry({
                  entryId: DOCUMENTS_ID,
                  parentEntryId: POSIX_ROOT_ID,
                  kind: 'directory',
                  name: 'documents',
                }),
              ]
            : [];
      await fulfillJson(route, {
        entries,
        next_cursor: nameQuery === 'duplicate' && cursor === null ? 'search-page-2' : null,
      });
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

// @test-scope safeguard: prevents device operators from losing access to synchronized evidence and filesystem roots during detail navigation
test('@smoke device details uses tabs, an IDE-style Files sidebar, and a synchronization journal', async ({
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
  const analyticsProgress = page.getByTestId('device-analytics-progress');
  await expect(analyticsProgress).toContainText('Усього файлів');
  await expect(analyticsProgress).toContainText('2');
  await expect(analyticsProgress).toContainText('Проаналізовано файлів');
  await expect(analyticsProgress).toContainText('1');
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
  const filesSidebar = page.getByTestId('device-files-sidebar');
  const fileTree = filesSidebar.getByTestId('device-files-tree');
  const contentPane = page.getByTestId('device-file-content-pane');
  await expect(filesSidebar).toBeVisible();
  await expect(fileTree).toBeVisible();
  await expect(contentPane).toBeVisible();
  await expect(contentPane.getByRole('heading', { name: 'Вміст файлу' })).toBeVisible();
  await expect(contentPane).toContainText('Виберіть файл у дереві або результатах пошуку.');
  await expect(contentPane.getByRole('button')).toHaveCount(0);
  await expect(contentPane.getByRole('textbox')).toHaveCount(0);
  await expect.poll(() => tracker.rootsRequestCount).toBe(1);

  const explorerModeButton = filesSidebar.getByRole('button', {
    name: 'Показати файлове дерево',
  });
  const searchModeButton = filesSidebar.getByRole('button', { name: 'Показати пошук файлів' });
  await expect(explorerModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(explorerModeButton).toHaveAttribute('aria-controls', 'device-files-explorer-panel');
  await expect(searchModeButton).toHaveAttribute('aria-pressed', 'false');
  await expect(searchModeButton).toHaveAttribute('aria-controls', 'device-files-search-panel');
  await expect(filesSidebar.getByLabel('Назва містить')).toBeHidden();

  await expect(filesSidebar.getByLabel('Вибрати каталог / як область пошуку')).toBeVisible();
  await expect(filesSidebar.getByLabel('Вибрати каталог C:\\ як область пошуку')).toBeVisible();
  await expect(fileTree.getByText('root.log', { exact: true })).toBeVisible();
  const rootFileRow = fileTree.getByRole('listitem').filter({ hasText: /^root\.log$/ });
  await expect(rootFileRow.getByText('.log', { exact: true })).toHaveCount(0);
  await expect(rootFileRow).not.toContainText('text/plain');
  await expect(filesSidebar.getByLabel('Вибрати каталог Users як область пошуку')).toBeVisible();
  await expect(filesSidebar.getByLabel('Завантаження кількості файлів')).toBeVisible();
  await expect.poll(() => tracker.subtreeCountRequestCount).toBe(1);
  await expect(
    filesSidebar.getByLabel(
      'Вибрати каталог / як область пошуку; Файлів у каталозі та вкладених каталогах: 2',
      { exact: true },
    ),
  ).toHaveCount(0);
  tracker.releaseSubtreeCounts();
  await expect(filesSidebar.getByLabel('Завантаження кількості файлів')).toBeHidden();
  await expect(
    filesSidebar.getByLabel(
      'Вибрати каталог / як область пошуку; Файлів у каталозі та вкладених каталогах: 2',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    filesSidebar.getByLabel(
      'Вибрати каталог C:\\ як область пошуку; Файлів у каталозі та вкладених каталогах: 0',
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    filesSidebar.getByLabel(
      'Вибрати каталог Users як область пошуку; Файлів у каталозі та вкладених каталогах: 0',
      { exact: true },
    ),
  ).toBeVisible();

  const rootLabelBox = await filesSidebar
    .getByLabel('Вибрати каталог / як область пошуку')
    .boundingBox();
  const documentsLabel = filesSidebar.getByLabel('Вибрати каталог documents як область пошуку');
  const documentsLabelBox = await documentsLabel.boundingBox();
  expect(documentsLabelBox?.x).toBeGreaterThan(rootLabelBox?.x ?? 0);
  await documentsLabel.click();

  await searchModeButton.click();
  await expect(explorerModeButton).toHaveAttribute('aria-pressed', 'false');
  await expect(searchModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(fileTree).toBeHidden();
  const resetToRootButton = filesSidebar.getByRole('button', { name: 'Шукати від кореня /' });
  await expect(resetToRootButton).toBeVisible();
  await resetToRootButton.click();
  await expect(resetToRootButton).toBeHidden();

  const advancedFiltersButton = filesSidebar.locator(
    'button[aria-controls="device-file-search-advanced-filters"]',
  );
  await advancedFiltersButton.focus();
  await page.keyboard.press('Enter');
  await expect(advancedFiltersButton).toHaveAttribute('aria-expanded', 'true');
  await expect(filesSidebar.getByLabel('MIME-типи')).toBeVisible();
  await expect(filesSidebar.getByLabel('Розширення')).toBeVisible();
  await filesSidebar.getByLabel('MIME-типи').fill('text/plain');
  await filesSidebar.getByLabel('Розширення').fill('log');
  await filesSidebar.getByRole('checkbox', { name: 'Файли' }).check();
  const nameInput = filesSidebar.getByLabel('Назва містить');
  await nameInput.fill('duplicate');
  await filesSidebar.getByRole('button', { name: 'Знайти', exact: true }).click();

  await expect.poll(() => tracker.searchRequests.length).toBe(1);
  expect(tracker.searchRequests[0]).toEqual({
    device_id: DEVICE_ID,
    scope_entry_id: POSIX_ROOT_ID,
    name_query: 'duplicate',
    kinds: ['file'],
    mime_types: ['text/plain'],
    extensions: ['log'],
    file_metadata_modified_from: null,
    file_metadata_modified_to: null,
    limit: 100,
    cursor: null,
    tag_ids: null,
    tag_match: null,
    untagged: null,
  });
  await expect(filesSidebar.getByText('duplicate.log', { exact: true })).toHaveCount(1);
  await expect(filesSidebar.getByText('/shared/duplicate.log', { exact: true })).toHaveCount(1);
  await filesSidebar.getByRole('button', { name: 'Завантажити ще' }).click();
  await expect.poll(() => tracker.searchRequests.length).toBe(2);
  expect(tracker.searchRequests[1]).toMatchObject({ cursor: 'search-page-2' });
  await expect(filesSidebar.getByText('duplicate.log', { exact: true })).toHaveCount(2);
  await expect(filesSidebar.getByText('/shared/duplicate.log', { exact: true })).toHaveCount(2);

  const mainPanel = page.getByTestId('device-details-tab-panel');
  const mainBeforeCollapse = await mainPanel.boundingBox();
  await page.getByRole('button', { name: 'Згорнути ліву панель' }).click();
  await expect(filesSidebar).toBeHidden();
  await expect(page.getByRole('complementary', { name: 'Файли' })).toHaveCount(0);
  const hiddenSearchButtonFocused = await filesSidebar
    .locator('button[aria-label="Показати пошук файлів"]')
    .evaluate((button) => {
      (button as HTMLButtonElement).focus();
      return document.activeElement === button;
    });
  expect(hiddenSearchButtonFocused).toBe(false);
  const mainAfterCollapse = await mainPanel.boundingBox();
  expect(mainAfterCollapse?.width).toBeGreaterThan(mainBeforeCollapse?.width ?? 0);

  await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
  await expect(filesSidebar).toBeVisible();
  await expect(searchModeButton).toHaveAttribute('aria-pressed', 'true');
  await expect(nameInput).toHaveValue('duplicate');
  await expect(advancedFiltersButton).toHaveAttribute('aria-expanded', 'true');
  await expect(filesSidebar.getByText('duplicate.log', { exact: true })).toHaveCount(2);

  await page.setViewportSize({ width: 900, height: 900 });
  const tabletSidebarBox = await filesSidebar.boundingBox();
  const tabletMainBox = await mainPanel.boundingBox();
  expect(tabletMainBox?.y).toBeGreaterThanOrEqual(
    (tabletSidebarBox?.y ?? 0) + (tabletSidebarBox?.height ?? 0),
  );

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('button', { name: 'Згорнути ліву панель' })).toBeHidden();
  await expect(filesSidebar).toBeVisible();
  expect(await filesSidebar.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
    true,
  );

  await filesSidebar.getByRole('button', { name: 'Очистити' }).click();
  await expect(nameInput).toHaveValue('');
  await filesSidebar.getByRole('button', { name: 'Знайти', exact: true }).click();
  const directoryResult = filesSidebar.getByRole('button', { name: 'documents', exact: true });
  await expect(directoryResult).toBeVisible();
  await directoryResult.click();
  await expect(filesSidebar.getByText('duplicate.log', { exact: true })).toHaveCount(0);
  await expect(resetToRootButton).toBeVisible();
  await expect(filesSidebar).toContainText('Налаштуйте область і фільтри та виконайте пошук.');
  await resetToRootButton.click();
  await nameInput.fill('empty');
  await nameInput.press('Enter');
  await expect(filesSidebar).toContainText('За заданими фільтрами нічого не знайдено.');
  await filesSidebar.getByRole('button', { name: 'Сховати результати' }).click();
  await expect(filesSidebar).toContainText('Налаштуйте область і фільтри та виконайте пошук.');

  await page.getByRole('tab', { name: 'Журнал' }).click();
  await expect(journalTable).toBeVisible();
  await expect(metadataPanel).toBeVisible();

  tracker.deviceArchived = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('tab', { name: 'Файли' })).toBeVisible();
  await page.getByRole('tab', { name: 'Файли' }).click();
  const archivedFilesSidebar = page.getByTestId('device-files-sidebar');
  await expect(archivedFilesSidebar.getByText('root.log', { exact: true })).toBeVisible();
  expect(browserFailures).toEqual([]);
});

// @test-scope safeguard: prevents creation of an unusable DeviceSource record without its required name
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

// @test-scope regression: https://github.com/echoua/echo/pull/3500
test('@smoke device files previews read only, explains unavailable states and downloads original bytes', async ({
  page,
  baseURL,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  const tracker = await installMocks(page);
  tracker.releaseSubtreeCounts();
  await page.setViewportSize({ width: 1440, height: 1024 });
  await page.addInitScript(() => {
    if (window === window.top) localStorage.setItem('echo-theme-mode', 'dark');
  });
  const samples = [
    { name: 'звіт.TXT', bytes: Buffer.from('Український текст\n<script>read only</script>') },
    {
      name: 'report.pdf',
      bytes: await readFile(new URL('./fixtures/device-file-content.pdf', import.meta.url)),
    },
    {
      name: 'report.docx',
      bytes: await readFile(new URL('./fixtures/device-file-content.docx', import.meta.url)),
    },
    { name: 'archive.zip', bytes: Buffer.from('UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==', 'base64') },
  ];
  const files = samples.map((sample, index) => ({
    ...entry({
      entryId: `018f0000-0000-7000-8000-00000000002${index}`,
      parentEntryId: POSIX_ROOT_ID,
      kind: 'file',
      name: sample.name,
      absolutePath: `C:\\Users\\analyst\\Documents\\${sample.name}`,
    }),
    file_id: `018f0000-0000-7000-8000-00000000002${index}`,
    revision: 1,
  }));
  const missingFile = {
    ...entry({
      entryId: '018f0000-0000-7000-8000-000000000030',
      parentEntryId: POSIX_ROOT_ID,
      kind: 'file',
      name: 'Журнал.txt',
      absolutePath: 'C:\\Users\\analyst\\Documents\\Журнал.txt',
    }),
    revision: 2,
    has_content: false,
  };
  const contentRequests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.endsWith('/content')) contentRequests.push(request.url());
  });
  let downloadCount = 0;
  page.on('download', () => downloadCount++);
  let downloadResponse: 'ok' | 'error' | 'interrupted' | 'pending' = 'ok';
  let finishDownload: (() => void) | null = null;
  // Real HTTP exercises interrupted and incomplete download response bodies.
  const server = createServer((request, response) => {
    const pathname = new URL(request.url!, 'http://localhost').pathname;
    if (pathname.endsWith('/revisions/1/content')) {
      const sample = samples[files.findIndex((file) => file.file_id === pathname.split('/')[5])];
      if (!sample) {
        response.writeHead(404).end();
        return;
      }
      if (request.method === 'GET' && downloadResponse === 'error') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ message: 'Не вдалося розшифрувати файл' }));
        return;
      }
      response.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': `attachment; filename="${Buffer.from(sample.name).toString('latin1')}"; filename*=UTF-8''${encodeURIComponent(sample.name)}`,
        'content-length': String(sample.bytes.length),
        'cache-control': 'private, no-store',
      });
      if (request.method === 'GET' && downloadResponse === 'interrupted') {
        response.write(sample.bytes.subarray(0, 1), () => response.destroy());
        return;
      }
      if (request.method === 'GET' && downloadResponse === 'pending') {
        response.write(sample.bytes.subarray(0, 1));
        finishDownload = () => response.end(sample.bytes.subarray(1));
        return;
      }
      response.end(request.method === 'HEAD' ? undefined : sample.bytes);
      return;
    }
    const proxy = proxyRequest(
      new URL(request.url!, baseURL),
      { method: request.method, headers: request.headers },
      (upstream) => {
        response.writeHead(upstream.statusCode!, upstream.headers);
        upstream.pipe(response);
      },
    );
    proxy.on('error', () => response.writeHead(502).end());
    request.pipe(proxy);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  try {
    await page.route('**/api/device/files/browse', (route) =>
      fulfillJson(route, {
        breadcrumbs: [],
        entries:
          route.request().postDataJSON().parent_entry_id === POSIX_ROOT_ID
            ? [...files, missingFile]
            : [],
        next_cursor: null,
      }),
    );
    await page.route('**/api/device/files/*/*/revisions/1/content', (route) => route.continue());
    await page.goto(`http://127.0.0.1:${address.port}/devices/${DEVICE_ID}`, {
      waitUntil: 'domcontentloaded',
    });
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    const pane = page.getByTestId('device-file-content-pane');
    const tree = page.getByTestId('device-files-tree');
    await expect(page.getByTestId('device-files-sidebar')).toHaveCSS('width', '320px');
    for (const sample of samples) {
      await tree.getByRole('button', { name: sample.name, exact: true }).click();
      await expect(
        pane.getByRole('heading', { name: `C:\\Users\\analyst\\Documents\\${sample.name}` }),
      ).toBeVisible();
      await expect(pane.locator('header')).toHaveCSS('height', '48px');
      await expect(pane.locator('header h2')).toHaveCSS('font-size', '14px');
      await expect(pane.locator('header')).toContainText('Ревізія 1 · Поточна');
      if (sample.name.endsWith('TXT')) {
        await expect(pane.locator('pre')).toHaveText(sample.bytes.toString());
        await expect(pane.locator('script')).toHaveCount(0);
      } else if (sample.name.endsWith('pdf')) {
        await expect(pane.locator('.react-pdf__Page__canvas')).toBeVisible();
        await expect(pane).toContainText('Device PDF content');
      } else if (sample.name.endsWith('docx')) {
        await expect(
          pane
            .frameLocator('iframe[title="DOCX preview"]')
            .getByText('Device DOCX content — тільки читання'),
        ).toBeVisible();
        await expect(pane.locator('iframe')).toHaveAttribute('sandbox', '');
      } else {
        await expect(
          pane.getByRole('heading', { name: 'Перегляд формату ZIP не підтримується' }),
        ).toBeVisible();
        await expect(pane.getByRole('button', { name: 'Скачати файл' })).toBeEnabled();
        await expect(pane.locator('pre, canvas, iframe')).toHaveCount(0);
      }
      await expect(pane.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0);
      await page.screenshot({
        path: test.info().outputPath(`${sample.name}.png`),
        animations: 'disabled',
      });
      const downloaded = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл' }).click();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(sample.name);
      expect(await readFile((await download.path())!)).toEqual(sample.bytes);
    }
    await test.step('PR #3500: observes GET failures and waits for the complete download body', async () => {
      const downloadButton = pane.getByRole('button', { name: 'Скачати файл' });
      const archive = samples[3];
      const archiveUrl = `/api/device/files/${DEVICE_ID}/${files[3].file_id}/revisions/1/content`;
      await tree.getByRole('button', { name: missingFile.name, exact: true }).click();
      await tree.getByRole('button', { name: archive.name, exact: true }).click();
      for (const failure of ['error', 'interrupted'] as const) {
        downloadResponse = failure;
        expect((await page.request.head(new URL(archiveUrl, page.url()).href)).status()).toBe(200);
        await downloadButton.click();
        const alert = page.getByRole('alert').filter({ hasText: 'Помилка скачування файлу' });
        await expect(alert).toBeVisible();
        if (failure === 'error') await expect(alert).toContainText('Не вдалося розшифрувати файл');
        else await expect(alert).toContainText('Перевірте мережу та спробуйте ще раз.');
        await expect(downloadButton).toBeEnabled();
        expect(downloadCount).toBe(samples.length);
        await tree.getByRole('button', { name: missingFile.name, exact: true }).click();
        await tree.getByRole('button', { name: archive.name, exact: true }).click();
      }
      downloadResponse = 'pending';
      const downloaded = page.waitForEvent('download');
      await downloadButton.click();
      await expect.poll(() => finishDownload !== null).toBe(true);
      await expect(downloadButton).toBeDisabled();
      expect(downloadCount).toBe(samples.length);
      finishDownload!();
      const download = await downloaded;
      expect(download.suggestedFilename()).toBe(archive.name);
      expect(await readFile((await download.path())!)).toEqual(archive.bytes);
      await expect(downloadButton).toBeEnabled();
      downloadResponse = 'ok';
    });
    const requestsBeforeMissing = contentRequests.length;
    const missingButton = tree.getByRole('button', { name: missingFile.name, exact: true });
    await expect(missingButton).toHaveCSS('opacity', '0.55');
    await missingButton.click();
    await expect(missingButton).toHaveAttribute('aria-pressed', 'true');
    await expect(pane.getByRole('heading', { name: 'Контент файлу відсутній' })).toBeVisible();
    await expect(pane.locator('header')).toContainText(missingFile.absolute_path!);
    await expect(pane.locator('header')).toContainText('Ревізія 2 · Поточна');
    await expect(pane.getByRole('button', { name: 'Скачати файл' })).toBeDisabled();
    await expect(pane.locator('pre, canvas, iframe')).toHaveCount(0);
    expect(contentRequests).toHaveLength(requestsBeforeMissing);
    await page.screenshot({
      path: test.info().outputPath('missing-content.png'),
      animations: 'disabled',
    });
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'light'));
    await page.screenshot({
      path: test.info().outputPath('missing-content-light.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 390, height: 844 });
    const headerBounds = await pane.locator('header').boundingBox();
    const downloadBounds = await pane.getByRole('button', { name: 'Скачати файл' }).boundingBox();
    expect(downloadBounds!.x + downloadBounds!.width).toBeLessThanOrEqual(
      headerBounds!.x + headerBounds!.width,
    );
    await page.screenshot({
      path: test.info().outputPath('missing-content-mobile.png'),
      animations: 'disabled',
    });
    await page.setViewportSize({ width: 1440, height: 1024 });
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    files[0].revision = 2;
    files[0].has_content = false;
    await page.getByRole('button', { name: 'Оновити файлові дані' }).click();
    await expect(pane.getByRole('heading', { name: 'Вміст файлу' })).toBeVisible();
    await tree.getByRole('button', { name: samples[0].name, exact: true }).click();
    await expect(pane.locator('header')).toContainText('Ревізія 2 · Поточна');
    await expect(pane.getByRole('heading', { name: 'Контент файлу відсутній' })).toBeVisible();
    await expect(pane.locator('pre')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Скачати файл' })).toBeDisabled();
    await page.route(
      `**/api/device/files/${DEVICE_ID}/${files[1].file_id}/revisions/1/content`,
      (route) => route.fulfill({ status: 404 }),
    );
    await tree.getByRole('button', { name: samples[1].name, exact: true }).click();
    await expect(pane.getByRole('alert')).toContainText('Помилка завантаження вмісту файлу');
    await expect(pane.locator('pre, canvas')).toHaveCount(0);
    await expect(
      page.getByRole('alert').filter({ hasText: 'Помилка завантаження вмісту файлу' }),
    ).toHaveCount(2);
    expect(pageErrors).toEqual([]);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
