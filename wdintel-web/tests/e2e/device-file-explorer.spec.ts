import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  emptyNetworksListResponse,
  emptyUnitsListResponse,
  systemSettingsCurrentResponse,
} from './fixture-responses';

const DEVICE_ID = '018f0000-0000-7000-8000-000000000000';
const ROOT_ID = '018f0000-0000-7000-8000-000000000001';
const FOLDER_ID = '018f0000-0000-7000-8000-000000000002';
const FILE_ID = '018f0000-0000-7000-8000-000000000003';
const PENDING_ID = '018f0000-0000-7000-8000-000000000004';
const NOW = '2026-11-03T09:00:00Z';
const FILE_TEXT = 'Перевірка перегляду файлу пристрою #3930';
const NEXT_FILE_TEXT = 'Наступний файл пристрою #3930';
const TAG = { id: '018f0000-0000-7000-8000-000000000005', name: 'Документи' };

test('@regression #3930 #4101 search viewed button waits for writes and recovers after failure', async ({
  page,
}) => {
  await installExplorerMocks(page);
  const requests: { release: () => void }[] = [];
  await page.route(/\/api\/device\/files\/(?:viewed|unviewed)$/, async (route) => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const index = requests.length;
    requests.push({ release });
    await hold;
    return route
      .fulfill(
        index === 1
          ? { status: 500, body: 'marker unavailable' }
          : { json: { is_favorite: false, is_viewed: index === 0 } },
      )
      .catch(() => {});
  });
  try {
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    await search.fill('report');
    await search.press('Enter');
    const row = page
      .getByRole('table', { name: 'Результати пошуку', exact: true })
      .locator(`[data-entry-id="${FILE_ID}"]`);
    for (const index of [0, 1, 2]) {
      const action = index === 0 ? 'Позначити як переглянуте' : 'Позначити як нове';
      const button = row.getByRole('button', { name: `${action}: report.txt`, exact: true });
      await expect(button).toBeEnabled();
      await button.click();
      await expect.poll(() => requests.length).toBe(index + 1);
      await expect(button).toBeDisabled();
      await button.evaluate((element: HTMLButtonElement) => element.click());
      expect(requests).toHaveLength(index + 1);
      requests[index].release();
      if (index === 1) {
        await expect(page.getByRole('alert')).toContainText('Не вдалося зберегти мітку файлу');
        await expect(button).toBeEnabled();
        await expect(button).toHaveAttribute('aria-pressed', 'true');
      } else {
        const nextAction = index === 0 ? 'Позначити як нове' : 'Позначити як переглянуте';
        await expect(
          row.getByRole('button', { name: `${nextAction}: report.txt`, exact: true }),
        ).toBeEnabled();
      }
    }
    await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
  } finally {
    for (const request of requests) request.release();
  }
});

for (const width of [1440, 390]) {
  for (const treeState of ['empty roots', 'pending roots', 'failed branch'] as const) {
    if (width === 390 && treeState === 'failed branch') continue;
    test(`@regression #3930 historical link ignores ${treeState} at ${width}px`, async ({
      page,
    }) => {
      const fixture = await installExplorerMocks(page);
      await page.setViewportSize({ width, height: 900 });
      const root = {
        ...fixture.entry(FOLDER_ID),
        entry_id: ROOT_ID,
        device_id: DEVICE_ID,
        parent_entry_id: null,
        name: 'C:\\',
      };
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locateRequests: unknown[] = [];
      let branches = 0;
      await page.route('**/api/device/files/roots', async (route) => {
        if (treeState === 'pending roots') await hold;
        return route
          .fulfill({ json: { roots: treeState === 'empty roots' ? [] : [root] } })
          .catch(() => {});
      });
      await page.route('**/api/device/files/locate', (route) => {
        locateRequests.push(route.request().postDataJSON());
        return route.fulfill({
          json: {
            file: fixture.entry(FILE_ID),
            ancestors: [fixture.entry(FOLDER_ID)],
            root_entry_id: ROOT_ID,
            current_revision: 2,
          },
        });
      });
      if (treeState === 'failed branch')
        await page.route('**/api/device/files/browse', async (route) => {
          branches++;
          await hold;
          return route.fulfill({ status: 500, body: 'tree unavailable' }).catch(() => {});
        });
      try {
        await page.goto(`/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1`);
        const pane = page.getByTestId('device-file-content-pane');
        await expect(pane.locator('pre')).toHaveText(FILE_TEXT);
        expect(locateRequests).toEqual([{ deviceId: DEVICE_ID, fileId: FILE_ID, revision: 1 }]);
        await expect.poll(() => fixture.writes).toContainEqual({ fileId: FILE_ID, revision: 1 });
        const path = pane.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
        await expectBreadcrumbFolders(page, path, ['C', 'Documents']);
        if (treeState === 'failed branch') await expect.poll(() => branches).toBeGreaterThan(0);
        release();
        if (treeState === 'failed branch')
          await expect(page.getByTestId('device-files-tree')).toHaveAttribute('aria-busy', 'false');
        await expect(pane.locator('pre')).toHaveText(FILE_TEXT);
        expect(locateRequests).toHaveLength(1);
      } finally {
        release();
      }
    });
  }
}

for (const width of [1440, 390]) {
  test(`@regression #3930 fullscreen keyboard survives MUI focus trapping at both file edges at ${width}px`, async ({
    page,
  }) => {
    await installExplorerMocks(page, 'Device Explorer', { pendingHasContent: true });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await page
      .getByRole('region', { name: 'Вміст папки', exact: true })
      .getByRole('button', { name: 'Відкрити файл report.txt', exact: true })
      .click();
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane.locator('pre')).toHaveText(FILE_TEXT);
    await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.locator('#device-file-fullscreen-title') });
    const focusContainer = page
      .locator('.MuiDialog-container')
      .filter({ has: page.locator('#device-file-fullscreen-title') });
    const trapFocus = async () => {
      await pane
        .locator('button[aria-label="На весь екран"]')
        .evaluate((button: HTMLButtonElement) => button.focus());
      await expect(focusContainer).toBeFocused();
    };
    const previous = dialog.locator('[data-attachment-preview-nav="prev"]:visible');
    const next = dialog.locator('[data-attachment-preview-nav="next"]:visible');
    await next.click();
    await expect(dialog.locator('pre')).toHaveText(NEXT_FILE_TEXT);
    await expect(next).toBeDisabled();
    await trapFocus();
    await page.keyboard.press('ArrowRight');
    await expectCenteredFileNavigation(dialog, '2 / 2');
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.locator('pre')).toHaveText(FILE_TEXT);
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('pre')).toHaveText(NEXT_FILE_TEXT);
    await previous.click();
    await expect(dialog.locator('pre')).toHaveText(FILE_TEXT);
    await expect(previous).toBeDisabled();
    await trapFocus();
    await page.keyboard.press('ArrowLeft');
    await expectCenteredFileNavigation(dialog, '1 / 2');
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('pre')).toHaveText(NEXT_FILE_TEXT);
    await dialog.getByRole('button', { name: 'Інформація', exact: true }).click();
    const info = page.getByRole('dialog', { name: 'Інформація про вкладення', exact: true });
    await expect(info).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await expect(page).toHaveURL(new RegExp(`file=${PENDING_ID}`));
    await expect(info).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(info).toHaveCount(0);
    await trapFocus();
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.locator('pre')).toHaveText(FILE_TEXT);
  });
}

for (const width of [1440, 390]) {
  for (const operation of ['first', 'append'] as const) {
    test(`@regression #3930 sidebar resumes nested ${operation} after closing at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const fixture = await installExplorerMocks(page);
      const nestedId = '018f0000-0000-7000-8000-000000000091';
      const requests: Record<string, unknown>[] = [];
      let release!: () => void;
      const hold = new Promise<void>((resolve) => {
        release = resolve;
      });
      await page.route('**/api/device/files/browse', async (route) => {
        const request = route.request().postDataJSON();
        if (request.parent_entry_id === FOLDER_ID)
          return route.fulfill({
            json: {
              breadcrumbs: [
                { entry_id: ROOT_ID, name: 'C:' },
                { entry_id: FOLDER_ID, name: 'Documents' },
              ],
              entries: [
                {
                  ...fixture.entry(FOLDER_ID),
                  entry_id: nestedId,
                  parent_entry_id: FOLDER_ID,
                  name: 'Nested',
                },
              ],
              next_cursor: null,
            },
          });
        if (request.parent_entry_id !== nestedId) return route.fallback();
        requests.push(request);
        const attempt = requests.length;
        if (attempt === (operation === 'first' ? 1 : 2)) {
          await hold;
          return route
            .fulfill({
              json: {
                breadcrumbs: [],
                entries: [{ ...fixture.entry(FILE_ID), name: 'obsolete.txt' }],
                next_cursor: null,
              },
            })
            .catch(() => {});
        }
        const initial = operation === 'append' && attempt === 1;
        return route.fulfill({
          json: {
            breadcrumbs: [],
            entries: [
              {
                ...fixture.entry(initial ? FILE_ID : PENDING_ID),
                parent_entry_id: nestedId,
                name: initial ? 'loaded.txt' : 'resumed.txt',
                has_content: true,
              },
            ],
            next_cursor: initial ? 'nested-tail' : null,
          },
        });
      });
      try {
        await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
        if (width === 390)
          await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
        const tree = page.getByTestId('device-files-tree');
        await tree.getByRole('button', { name: 'Розгорнути каталог Nested', exact: true }).click();
        await expect.poll(() => requests.length).toBe(operation === 'first' ? 1 : 2);
        await expect(tree).toHaveAttribute('aria-busy', 'true');
        await page
          .getByRole('button', {
            name: width === 390 ? 'Закрити: Файли' : 'Згорнути ліву панель',
            exact: true,
          })
          .click();
        await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
        await expect(tree.getByText('resumed.txt', { exact: true })).toBeVisible();
        await expect(tree).toHaveAttribute('aria-busy', 'false');
        expect(requests.at(-1)?.cursor).toBe(operation === 'append' ? 'nested-tail' : null);
        if (operation === 'append')
          await expect(tree.getByText('loaded.txt', { exact: true })).toBeVisible();
        release();
        await expect(tree.getByText('obsolete.txt', { exact: true })).toHaveCount(0);
      } finally {
        release();
      }
    });
  }
}

for (const searchMode of [false, true]) {
  test(`@regression #3930 unviewed preview retains both neighbors in ${searchMode ? 'search' : 'folder'}`, async ({
    page,
  }) => {
    const fixture = await installExplorerMocks(page, 'Device Explorer', {
      pendingHasContent: true,
    });
    const firstId = '018f0000-0000-7000-8000-000000000090';
    const entries = () => [
      { ...fixture.entry(FILE_ID), entry_id: firstId, file_id: firstId, name: 'a.txt' },
      fixture.entry(FILE_ID),
      fixture.entry(PENDING_ID),
    ];
    await page.route('**/api/device/files/browse', (route) => {
      if (route.request().postDataJSON().parent_entry_id !== FOLDER_ID) return route.fallback();
      return route.fulfill({
        json: {
          entries: entries(),
          next_cursor: null,
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:' },
            { entry_id: FOLDER_ID, name: 'Documents' },
          ],
        },
      });
    });
    await page.route('**/api/device/files/search', (route) =>
      route.fulfill({ json: { entries: entries(), next_cursor: null } }),
    );
    await page.route(`**/files/${DEVICE_ID}/${firstId}/revisions/1/content`, (route) =>
      route.fulfill({ contentType: 'text/plain', body: 'First neighbor' }),
    );
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Тільки непереглянуті', exact: true }).check();
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    if (searchMode) {
      const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
      await search.fill('txt');
      await search.press('Enter');
      await page
        .getByRole('table', { name: 'Результати пошуку', exact: true })
        .getByRole('button', { name: 'report.txt', exact: true })
        .click();
    } else {
      await page
        .getByRole('region', { name: 'Вміст папки', exact: true })
        .getByRole('button', { name: 'Відкрити файл report.txt', exact: true })
        .click();
    }
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane.locator('pre')).toHaveText(FILE_TEXT);
    await expect.poll(() => fixture.writes.some((write) => write.fileId === FILE_ID)).toBe(true);
    await expect(pane.getByRole('button', { name: 'Попереднє', exact: true })).toBeEnabled();
    await expect(pane.getByRole('button', { name: 'Наступне', exact: true })).toBeEnabled();
    await pane.getByRole('button', { name: 'Попереднє', exact: true }).click();
    await expect(pane.locator('#device-file-content-title')).toContainText('a.txt');
    await expect(pane.locator('pre')).toHaveText('First neighbor');
    await page.keyboard.press('ArrowRight');
    await expect(pane.locator('#device-file-content-title')).toContainText('report.txt');
    await page.keyboard.press('ArrowRight');
    await expect(pane.locator('#device-file-content-title')).toContainText('pending.txt');
    await expect(pane.locator('pre')).toHaveText(NEXT_FILE_TEXT);
    await page.keyboard.press('ArrowLeft');
    await expect(pane.locator('#device-file-content-title')).toContainText('report.txt');
    await pane
      .getByRole('button', { name: searchMode ? 'До результатів пошуку' : 'До папки', exact: true })
      .click();
    const listing = searchMode
      ? page.getByRole('table', { name: 'Результати пошуку', exact: true })
      : page.getByRole('region', { name: 'Вміст папки', exact: true });
    await expect(listing.locator(`[data-entry-id="${FILE_ID}"]`)).toHaveCount(0);
  });
}

test('@regression #3930 historical archive search preserves revision across pagination and reload', async ({
  page,
}) => {
  const fixture = await installExplorerMocks(page);
  const requests: Record<string, unknown>[] = [];
  await page.route('**/api/device/files/search', (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    return route.fulfill({
      json: {
        entries: [
          {
            ...fixture.entry(request.cursor ? PENDING_ID : FILE_ID),
            revision: request.archive_revision ?? 4,
          },
        ],
        next_cursor: request.cursor ? null : 'historical-page-2',
      },
    });
  });
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}&directory_revision=3`);
  const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
  await search.fill('report');
  await search.press('Enter');
  const results = page.getByRole('table', { name: 'Результати пошуку', exact: true });
  await expect(results.locator('[data-entry-id]')).toHaveCount(2);
  expect(requests).toHaveLength(2);
  for (const request of requests)
    expect(request).toMatchObject({ scope_entry_id: FOLDER_ID, archive_revision: 3 });
  await page.reload();
  await expect(results.locator('[data-entry-id]')).toHaveCount(2);
  expect(requests.at(-1)).toMatchObject({ archive_revision: 3, cursor: 'historical-page-2' });
  await search.click();
  await page.getByRole('menuitem', { name: 'Шукати на всьому пристрої', exact: true }).click();
  await expect.poll(() => requests.at(-1)?.global_search).toBe(true);
  expect(requests.at(-1)?.archive_revision).toBeNull();
});

async function captureNativeDownload(page: Page) {
  await page.addInitScript(() => {
    document.addEventListener(
      'click',
      (event) => {
        if (event.target instanceof HTMLAnchorElement && event.target.hasAttribute('download')) {
          event.preventDefault();
          document.documentElement.setAttribute('data-native-download', event.target.pathname);
        }
      },
      true,
    );
  });
}

async function installExplorerMocks(
  page: Page,
  deviceName = 'Device Explorer',
  options: { pendingHasContent?: boolean } = {},
) {
  const favorites = new Set<string>();
  const viewed = new Set<string>();
  const writes: { entryId?: string; fileId?: string; revision?: number; favorite?: boolean }[] = [];
  const root = () => ({
    entry_id: ROOT_ID,
    device_id: DEVICE_ID,
    parent_entry_id: null,
    kind: 'directory',
    name: 'C:\\',
    file_metadata_created_at: '2026-11-01T09:00:00Z',
    file_metadata_modified_at: '2026-11-02T09:00:00Z',
    content_uploaded_at: NOW,
    tags: [],
    created_at: NOW,
    updated_at: NOW,
    is_favorite: favorites.has(ROOT_ID),
  });
  const entry = (entryId: string) => ({
    entry_id: entryId,
    parent_entry_id: entryId === FOLDER_ID ? ROOT_ID : FOLDER_ID,
    kind: entryId === FOLDER_ID ? 'directory' : 'file',
    file_id: entryId === FOLDER_ID ? null : entryId,
    name: entryId === FOLDER_ID ? 'Documents' : entryId === FILE_ID ? 'report.txt' : 'pending.txt',
    path_components:
      entryId === FOLDER_ID
        ? ['Documents']
        : ['Documents', entryId === FILE_ID ? 'report.txt' : 'pending.txt'],
    absolute_path: entryId === FILE_ID ? 'C:\\Documents\\report.txt' : null,
    has_content: entryId === FILE_ID || (entryId === PENDING_ID && !!options.pendingHasContent),
    mime_type: entryId === FOLDER_ID ? null : 'text/plain',
    extension: entryId === FOLDER_ID ? null : 'txt',
    content_uploaded_at:
      entryId === FOLDER_ID ? NOW : entryId === FILE_ID ? '2026-11-04T09:00:00Z' : null,
    file_metadata_created_at: '2026-11-01T09:00:00Z',
    file_metadata_modified_at: '2026-11-02T09:00:00Z',
    created_at: NOW,
    updated_at: NOW,
    revision: entryId === FOLDER_ID ? null : 1,
    sync_id: null,
    source_file_state: null,
    tags: entryId === FILE_ID ? [TAG] : [],
    archive: null,
    is_archive: false,
    archive_origin: null,
    virtual_path: null,
    is_favorite: favorites.has(entryId),
    is_viewed: viewed.has(entryId),
    size_bytes: entryId === FILE_ID ? Buffer.byteLength(FILE_TEXT) : null,
  });
  await page.route('**/api-public/server-info', (route) =>
    route.fulfill({
      json: {
        mode: '',
        public_host: '',
        grafana_address: '',
        feature_delta: false,
        feature_analysis_map: false,
        feature_strict_networks: false,
        version: '',
      },
    }),
  );
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.fallback();
    const json = (body: unknown) => route.fulfill({ json: body });
    if (pathname === '/api/user')
      return json({
        id: 'explorer-tester',
        name: 'explorer-tester',
        roles: ['Cyber'],
        sigint_zone_id: null,
        organism_id: null,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
        rer_report_eligible: false,
      });
    if (pathname === '/api/system-settings/current')
      return json({ ...systemSettingsCurrentResponse(), devices_section_enabled: true });
    if (pathname === '/api/user/settings')
      return json({ tagsLayout: 'compact', disableAutoScroll: false });
    if (pathname === '/api/user/author-identities') return json({ authors: [] });
    if (pathname === '/api/sigint/units') return json(emptyUnitsListResponse());
    if (pathname === '/api/sigint/network-list') return json(emptyNetworksListResponse());
    if (pathname === '/api/device/detail')
      return json({
        id: DEVICE_ID,
        name: deviceName,
        aors: [],
        unit: null,
        external_url: null,
        custom_fields: {},
        created_by: 'operator',
        archived: false,
        created_at: NOW,
        updated_at: NOW,
        archived_at: null,
        audio_forwarding_configured: false,
      });
    if (pathname === '/api/device/audio/list') return json({ audio: [], next_cursor: null });
    if (pathname === '/api/device/analytics/tags') return json({ tags: [TAG] });
    if (pathname === '/api/device/files/filter-options')
      return json({ extensions: ['txt', 'pdf', 'jpg', 'zip'] });
    if (pathname === '/api/device/files/roots') return json({ roots: [root()] });
    if (pathname === '/api/device/files/subtree-counts')
      return json({
        counts: route
          .request()
          .postDataJSON()
          .directory_entry_ids.map((entryId: string) => ({
            entry_id: entryId,
            file_count: 2,
          })),
      });
    if (pathname === '/api/device/files/browse') {
      const request = route.request().postDataJSON();
      const folder = request.parent_entry_id === FOLDER_ID;
      const entries = folder ? [entry(FILE_ID), entry(PENDING_ID)] : [entry(FOLDER_ID)];
      return json({
        breadcrumbs: [
          { entry_id: ROOT_ID, name: 'C:\\' },
          ...(folder ? [{ entry_id: FOLDER_ID, name: 'Documents' }] : []),
        ],
        entries: entries.filter(
          (item) =>
            (!request.favorites_only || item.is_favorite) &&
            (!request.unviewed_only || !item.is_viewed),
        ),
        next_cursor: null,
      });
    }
    if (pathname === '/api/device/files/locate')
      return json({
        file: entry(FILE_ID),
        ancestors: [entry(FOLDER_ID)],
        root_entry_id: ROOT_ID,
        current_revision: 1,
      });
    if (pathname === '/api/device/files/search')
      return json({ entries: [entry(FILE_ID)], next_cursor: null });
    if (pathname === '/api/device/files/favorite') {
      const request = route.request().postDataJSON();
      if (request.favorite) favorites.add(request.entry_id);
      else favorites.delete(request.entry_id);
      writes.push({ entryId: request.entry_id, favorite: request.favorite });
      return json({ is_favorite: request.favorite, is_viewed: viewed.has(request.entry_id) });
    }
    if (pathname === '/api/device/files/viewed' || pathname === '/api/device/files/unviewed') {
      const request = route.request().postDataJSON();
      if (pathname.endsWith('/unviewed')) viewed.delete(request.file_id);
      else viewed.add(request.file_id);
      writes.push({ fileId: request.file_id, revision: request.revision });
      return json({
        is_favorite: favorites.has(request.file_id),
        is_viewed: viewed.has(request.file_id),
      });
    }
    const content = pathname.endsWith(`/files/${DEVICE_ID}/${FILE_ID}/revisions/1/content`)
      ? FILE_TEXT
      : options.pendingHasContent &&
          pathname.endsWith(`/files/${DEVICE_ID}/${PENDING_ID}/revisions/1/content`)
        ? NEXT_FILE_TEXT
        : null;
    if (content !== null)
      return route.fulfill({
        contentType: 'text/plain; charset=utf-8',
        headers: { 'Content-Length': String(Buffer.byteLength(content)) },
        body: route.request().method() === 'HEAD' ? undefined : content,
      });
    return json({});
  });
  return { writes, entry };
}

async function expectCenteredFileNavigation(scope: Locator, counterText: string) {
  const counter = scope.locator('[data-attachment-preview-counter]:visible');
  await expect(counter).toHaveText(counterText);
  await expect
    .poll(async () => {
      const bounds = await scope.boundingBox();
      const position = await counter.boundingBox();
      if (!bounds || !position) return Number.POSITIVE_INFINITY;
      return Math.abs(position.x + position.width / 2 - (bounds.x + bounds.width / 2));
    })
    .toBeLessThanOrEqual(2);
}

async function expectBreadcrumbFolders(page: Page, path: Locator, names: string[]) {
  await expect(path.getByRole('link', { name: 'До початку шляху', exact: true })).toBeVisible();
  const visible = (await path.getByRole('link').allTextContents()).slice(1);
  const trigger = path.getByRole('button', { name: 'Приховані папки шляху', exact: true });
  let hidden: string[] = [];
  if (await trigger.count()) {
    await trigger.click();
    const menu = page.getByRole('menu', { name: 'Приховані папки шляху', exact: true });
    hidden = await menu.getByRole('menuitem').allTextContents();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
  }
  expect([...hidden, ...visible]).toEqual(names);
}

for (const width of [1440, 390]) {
  for (const viewMode of ['grid', 'list']) {
    test(`@regression #3930 manual viewed markers persist without opening a file in ${viewMode} at ${width}px`, async ({
      page,
    }) => {
      await installExplorerMocks(page);
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
      const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
      const card = folder.locator(`[data-entry-id="${FILE_ID}"]`);
      const location = page.url();
      for (const viewed of [true, false, true]) {
        if (viewMode === 'list')
          await page.getByRole('button', { name: 'Список', exact: true }).click();
        const action = viewed ? 'Позначити як переглянуте' : 'Позначити як нове';
        const response = page.waitForResponse((response) =>
          response.url().endsWith(`/api/device/files/${viewed ? 'viewed' : 'unviewed'}`),
        );
        await card.getByRole('button', { name: `${action}: report.txt`, exact: true }).click();
        expect((await response).request().postDataJSON()).toEqual({
          device_id: DEVICE_ID,
          file_id: FILE_ID,
          revision: 1,
        });
        const nextAction = viewed ? 'Позначити як нове' : 'Позначити як переглянуте';
        await expect(
          card.getByRole('button', { name: `${nextAction}: report.txt`, exact: true }),
        ).toHaveAttribute('aria-pressed', String(viewed));
        await expect(page).toHaveURL(location);
        await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
        await page.reload();
        if (viewMode === 'list')
          await page.getByRole('button', { name: 'Список', exact: true }).click();
        await expect(
          card.getByRole('button', { name: `${nextAction}: report.txt`, exact: true }),
        ).toHaveAttribute('aria-pressed', String(viewed));
      }
      await page.route('**/api/device/files/unviewed', (route) =>
        route.fulfill({ status: 500, json: { message: 'Cannot save marker' } }),
      );
      await card
        .getByRole('button', { name: 'Позначити як нове: report.txt', exact: true })
        .click();
      await expect(
        card.getByRole('button', { name: 'Позначити як нове: report.txt', exact: true }),
      ).toBeEnabled();
      await expect(
        card.getByRole('button', { name: 'Позначити як нове: report.txt', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByRole('alert')).toContainText('Не вдалося зберегти мітку файлу');
      await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
    });
  }
}

for (const width of [1440, 390]) {
  for (const viewMode of ['grid', 'list']) {
    test(`@regression #3930 closing a file preserves paginated folder scroll in ${viewMode} at ${width}px`, async ({
      page,
    }) => {
      const { entry } = await installExplorerMocks(page, 'Device Explorer', {
        pendingHasContent: true,
      });
      const entries = [
        ...Array.from({ length: 94 }, (_, index) => ({
          ...entry(FILE_ID),
          entry_id: `018f0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
          file_id: `018f0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
          name: `document-${index}.txt`,
        })),
        entry(FILE_ID),
        entry(PENDING_ID),
      ];
      await page.route('**/api/device/files/browse', (route) => {
        const request = route.request().postDataJSON();
        if (request.parent_entry_id !== FOLDER_ID) return route.fallback();
        return route.fulfill({
          json: {
            breadcrumbs: [
              { entry_id: ROOT_ID, name: 'C:\\' },
              { entry_id: FOLDER_ID, name: 'Documents' },
            ],
            entries: request.cursor ? entries.slice(80) : entries.slice(0, 80),
            next_cursor: request.cursor ? null : 'scroll-page-2',
          },
        });
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
      if (viewMode === 'list')
        await page.getByRole('button', { name: 'Список', exact: true }).click();
      const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
      const items = page.getByRole(viewMode === 'grid' ? 'list' : 'table', {
        name: 'Файли та папки',
      });
      const scroller = viewMode === 'grid' ? folder : items.locator('..');
      await expect(items.locator('[data-entry-id]')).toHaveCount(80);
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(items.locator('[data-entry-id]')).toHaveCount(96);
      const openFile = items.getByRole('button', {
        name: 'Відкрити файл report.txt',
        exact: true,
      });
      await openFile.scrollIntoViewIfNeeded();
      await openFile.focus();
      if (viewMode === 'list') await scroller.evaluate((element) => (element.scrollLeft = 120));
      const position = await scroller.evaluate((element) => ({
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
      expect(position.top).toBeGreaterThan(100);
      if (viewMode === 'list') expect(position.left).toBe(120);
      await page.keyboard.press('Enter');
      const pane = page.getByTestId('device-file-content-pane');
      await expect(pane.locator('pre')).toContainText(FILE_TEXT);
      await expect(folder).toBeHidden();
      await page.keyboard.press('ArrowRight');
      await expect(pane.locator('pre')).toContainText(NEXT_FILE_TEXT);
      await pane.getByRole('button', { name: 'До папки', exact: true }).click();
      await expect(pane).toHaveCount(0);
      await expect(folder).toBeVisible();
      await expect(items.locator('[data-entry-id]')).toHaveCount(96);
      await expect
        .poll(() =>
          scroller.evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft })),
        )
        .toEqual(position);
      await expect(openFile).toBeInViewport();
      await openFile.click();
      await expect(pane.locator('pre')).toContainText(FILE_TEXT);
      await page.goBack();
      await expect(pane).toHaveCount(0);
      await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(position.top);
    });
  }
}

for (const width of [1440, 390]) {
  for (const viewMode of ['grid', 'list']) {
    test(`@regression #3930 returning from a child restores parent pages and scroll in ${viewMode} at ${width}px`, async ({
      page,
    }) => {
      const { entry } = await installExplorerMocks(page);
      const childId = '018f0000-0000-7000-8000-000000000007';
      const entries: ReturnType<typeof entry>[] = Array.from({ length: 240 }, (_, index) => ({
        ...entry(FILE_ID),
        entry_id: `018f0000-0000-7000-8000-${String(index + 3000).padStart(12, '0')}`,
        file_id: `018f0000-0000-7000-8000-${String(index + 3000).padStart(12, '0')}`,
        name: `document-${index}.txt`,
      }));
      entries[125] = {
        ...entry(FOLDER_ID),
        entry_id: childId,
        parent_entry_id: FOLDER_ID,
        name: 'Nested',
      };
      await page.route('**/api/device/files/browse', (route) => {
        const request = route.request().postDataJSON();
        if (![FOLDER_ID, childId].includes(request.parent_entry_id) || !request.sort_by)
          return route.fallback();
        const child = request.parent_entry_id === childId;
        const offset = Number(request.cursor ?? 0);
        return route.fulfill({
          json: {
            breadcrumbs: [
              { entry_id: ROOT_ID, name: 'C:\\' },
              { entry_id: FOLDER_ID, name: 'Documents' },
              ...(child ? [{ entry_id: childId, name: 'Nested' }] : []),
            ],
            entries: child ? [entry(FILE_ID)] : entries.slice(offset, offset + 80),
            next_cursor: !child && offset + 80 < entries.length ? String(offset + 80) : null,
          },
        });
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
      if (viewMode === 'list')
        await page.getByRole('button', { name: 'Список', exact: true }).click();
      const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
      const items = folder.getByRole(viewMode === 'grid' ? 'list' : 'table', {
        name: 'Файли та папки',
      });
      const scroller = viewMode === 'grid' ? folder : items.locator('..');
      await expect(items.locator('[data-entry-id]')).toHaveCount(80);
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(items.locator('[data-entry-id]')).toHaveCount(160);
      const child = items.getByRole('button', { name: 'Відкрити папку Nested', exact: true });
      for (const returnVia of ['breadcrumbs', 'history']) {
        await child.scrollIntoViewIfNeeded();
        await child.focus();
        if (viewMode === 'list') await scroller.evaluate((element) => (element.scrollLeft = 120));
        const position = await scroller.evaluate((element) => ({
          top: element.scrollTop,
          left: element.scrollLeft,
        }));
        expect(position.top).toBeGreaterThan(100);
        await page.keyboard.press('Enter');
        await expect(page).toHaveURL(new RegExp(`directory=${childId}`));
        await expect(items.locator('[data-entry-id]')).toHaveCount(1);
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
        if (returnVia === 'history') await page.goBack();
        else {
          const path = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
          await expectBreadcrumbFolders(page, path, ['C', 'Documents', 'Nested']);
          const parent = path.getByRole('link', { name: 'Documents', exact: true });
          if (await parent.count()) await parent.click();
          else {
            await path.getByRole('button', { name: 'Приховані папки шляху', exact: true }).click();
            await page
              .getByRole('menu', { name: 'Приховані папки шляху', exact: true })
              .getByRole('menuitem', { name: 'Documents', exact: true })
              .click();
          }
        }
        await expect(page).toHaveURL(new RegExp(`directory=${FOLDER_ID}`));
        await expect(items.locator('[data-entry-id]')).toHaveCount(160);
        await expect
          .poll(() =>
            scroller.evaluate((element) => ({ top: element.scrollTop, left: element.scrollLeft })),
          )
          .toEqual(position);
        await expect(child).toBeInViewport();
      }
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(items.locator('[data-entry-id]')).toHaveCount(240);
    });
  }
}

for (const width of [1440, 390]) {
  for (const viewMode of ['grid', 'list']) {
    test(`@regression #3930 automatic file pages pause in preview and recover from empty pages and errors in ${viewMode} at ${width}px`, async ({
      page,
    }) => {
      const fixture = await installExplorerMocks(page);
      const entries = Array.from({ length: 150 }, (_, index) => ({
        ...fixture.entry(FILE_ID),
        entry_id: `018f0000-0000-7000-8000-${String(index + 2000).padStart(12, '0')}`,
        file_id: `018f0000-0000-7000-8000-${String(index + 2000).padStart(12, '0')}`,
        name: `document-${index}.txt`,
      }));
      entries[49] = fixture.entry(FILE_ID);
      const requests: (string | null)[] = [];
      let releaseSecond!: () => void;
      const secondPage = new Promise<void>((resolve) => (releaseSecond = resolve));
      let failed = false;
      await page.route('**/api/device/files/browse', async (route) => {
        const request = route.request().postDataJSON();
        if (request.parent_entry_id !== FOLDER_ID || request.sort_by !== 'name')
          return route.fallback();
        const cursor = request.cursor ?? null;
        requests.push(cursor);
        let result: typeof entries = [],
          next = 'first-files';
        if (cursor === 'first-files') {
          result = entries.slice(0, 50);
          next = 'second-files';
        } else if (cursor === 'second-files') {
          await secondPage;
          result = entries.slice(50, 100);
          next = 'empty-page';
        } else if (cursor === 'empty-page') {
          next = 'last-files';
        } else if (cursor === 'last-files') {
          if (!failed) {
            failed = true;
            return route.fulfill({ status: 500, json: { message: 'Pagination failure' } });
          }
          result = entries.slice(100);
          next = '';
        }
        return route.fulfill({
          json: {
            breadcrumbs: [
              { entry_id: ROOT_ID, name: 'C:\\' },
              { entry_id: FOLDER_ID, name: 'Documents' },
            ],
            entries: result,
            next_cursor: next || null,
          },
        });
      });
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
      if (viewMode === 'list')
        await page.getByRole('button', { name: 'Список', exact: true }).click();
      const folder = page.getByRole('region', {
        name: 'Вміст папки',
        exact: true,
        includeHidden: true,
      });
      const items = folder.getByRole(viewMode === 'grid' ? 'list' : 'table', {
        name: 'Файли та папки',
        includeHidden: true,
      });
      const scroller = viewMode === 'grid' ? folder : items.locator('..');
      await expect(folder.locator('[data-entry-id]')).toHaveCount(50);
      expect(requests).toEqual([null, 'first-files']);
      await expect(folder.getByRole('button', { name: 'Завантажити ще', exact: true })).toHaveCount(
        0,
      );
      await scroller.evaluate((element) => {
        element.scrollLeft = element.scrollWidth;
        element.scrollTop = element.scrollHeight;
      });
      await expect.poll(() => requests).toEqual([null, 'first-files', 'second-files']);
      await expect(folder.getByRole('status')).toHaveText('Завантаження файлів…');
      await expect(folder.locator('[data-device-file-loading-skeleton]')).toHaveCount(6);
      await expect(folder.locator('[data-entry-id]')).toHaveCount(50);
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(folder.locator('[data-device-file-loading-skeleton]').last()).toBeInViewport();
      await items.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
      const pane = page.getByTestId('device-file-content-pane');
      await expect(pane.locator('pre')).toContainText(FILE_TEXT);
      releaseSecond();
      await expect(folder.locator('[data-entry-id]')).toHaveCount(100);
      await expect(folder.locator('[data-device-file-loading-skeleton]')).toHaveCount(0);
      await page.waitForTimeout(100);
      expect(requests).toHaveLength(3);
      await pane.getByRole('button', { name: 'До папки', exact: true }).click();
      await expect(folder).toBeVisible();
      await scroller.evaluate((element) => (element.scrollTop = element.scrollHeight));
      await expect(folder.getByRole('button', { name: 'Повторити', exact: true })).toBeVisible();
      await expect(folder.locator('[data-entry-id]')).toHaveCount(100);
      await page.waitForTimeout(100);
      expect(requests).toEqual([null, 'first-files', 'second-files', 'empty-page', 'last-files']);
      await folder.getByRole('button', { name: 'Повторити', exact: true }).click();
      await expect(folder.locator('[data-entry-id]')).toHaveCount(150);
      await expect(folder.getByTestId('device-files-load-more')).toHaveCount(0);
      expect(requests).toEqual([
        null,
        'first-files',
        'second-files',
        'empty-page',
        'last-files',
        'last-files',
      ]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
    });
  }
}

for (const width of [1440, 390]) {
  test(`@regression #3930 centered file navigation changes siblings and preserves fullscreen at ${width}px`, async ({
    page,
  }) => {
    await installExplorerMocks(page, 'Device Explorer', { pendingHasContent: true });
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await page
      .getByRole('list', { name: 'Файли та папки' })
      .getByRole('button', { name: 'Відкрити файл report.txt', exact: true })
      .click();
    const pane = page.getByTestId('device-file-content-pane');
    const filePath = pane.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
    const previous = pane.locator('[data-attachment-preview-nav="prev"]:visible');
    const next = pane.locator('[data-attachment-preview-nav="next"]:visible');
    await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    await expectBreadcrumbFolders(page, filePath, ['C', 'Documents']);
    await expect(filePath.locator('[aria-current="page"]')).toHaveText('report.txt');
    await expect(
      page.getByRole('navigation', { name: 'Навігаційний шлях пристрою' }).getByRole('link'),
    ).toHaveText(['Device Explorer', 'Файли']);
    await expectCenteredFileNavigation(pane, '1 / 2');
    await expect(previous).toBeDisabled();
    await expect(next).toBeEnabled();
    await next.click();
    await expect(pane.locator('pre')).toContainText(NEXT_FILE_TEXT);
    await expect(filePath.locator('[aria-current="page"]')).toHaveText('pending.txt');
    await expect(page).toHaveURL(new RegExp(`file=${PENDING_ID}`));
    await expectCenteredFileNavigation(pane, '2 / 2');
    await expect(next).toBeDisabled();
    await previous.click();
    await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    await expect(page).toHaveURL(new RegExp(`file=${FILE_ID}`));
    await pane.locator('pre').click();
    await page.keyboard.press('ArrowLeft');
    await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    await page.keyboard.press('ArrowRight');
    await expect(pane.locator('pre')).toContainText(NEXT_FILE_TEXT);
    await expect(page).toHaveURL(new RegExp(`file=${PENDING_ID}`));
    await page.keyboard.press('ArrowRight');
    await expectCenteredFileNavigation(pane, '2 / 2');
    await page.keyboard.press('ArrowLeft');
    await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    if (width === 1440) {
      await page.getByRole('button', { name: 'report.txt', exact: true }).click();
      await page.keyboard.press('ArrowRight');
      await expect(pane.locator('pre')).toContainText(NEXT_FILE_TEXT);
      await page.keyboard.press('ArrowLeft');
      await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    }
    await pane.getByRole('button', { name: 'Інформація', exact: true }).click();
    const info = page.getByRole('dialog', { name: 'Інформація про вкладення', exact: true });
    await expect(info).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page).toHaveURL(new RegExp(`file=${FILE_ID}`));
    await expect(info).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(info).toHaveCount(0);
    await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
    const dialog = page
      .getByRole('dialog')
      .filter({ has: page.locator('#device-file-fullscreen-title') });
    const fullscreenPath = dialog.getByRole('navigation', {
      name: 'Шлях до файлу',
      exact: true,
    });
    await expectBreadcrumbFolders(page, fullscreenPath, ['C', 'Documents']);
    await expect(fullscreenPath.locator('[aria-current="page"]')).toHaveText('report.txt');
    await expectCenteredFileNavigation(dialog, '1 / 2');
    await dialog.locator('[data-attachment-preview-nav="next"]:visible').click();
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('pre')).toContainText(NEXT_FILE_TEXT);
    await expect(fullscreenPath.locator('[aria-current="page"]')).toHaveText('pending.txt');
    await expect(page).toHaveURL(new RegExp(`file=${PENDING_ID}`));
    await expectCenteredFileNavigation(dialog, '2 / 2');
    await expect(dialog.locator('[data-attachment-preview-nav="next"]:visible')).toBeDisabled();
    await dialog.locator('[data-attachment-preview-nav="prev"]:visible').click();
    await expect(dialog.locator('pre')).toContainText(FILE_TEXT);
    await expect(fullscreenPath.locator('[aria-current="page"]')).toHaveText('report.txt');
    await expect(page).toHaveURL(new RegExp(`file=${FILE_ID}`));
    await expect(dialog.locator('[data-attachment-preview-nav="prev"]:visible')).toBeDisabled();
    await page.keyboard.press('ArrowRight');
    await expect(dialog.locator('pre')).toContainText(NEXT_FILE_TEXT);
    await expect(fullscreenPath.locator('[aria-current="page"]')).toHaveText('pending.txt');
    await expect(page).toHaveURL(new RegExp(`file=${PENDING_ID}`));
    await page.keyboard.press('ArrowLeft');
    await expect(dialog.locator('pre')).toContainText(FILE_TEXT);
    await expect(fullscreenPath.locator('[aria-current="page"]')).toHaveText('report.txt');
    await expect(dialog).toBeVisible();
    await fullscreenPath.getByRole('link', { name: 'До початку шляху', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files`);
    await expect(
      page
        .getByRole('list', { name: 'Файли та папки', exact: true })
        .getByRole('button', { name: 'Відкрити папку C:\\', exact: true }),
    ).toBeVisible();
  });
}

test('@regression #3930 folder links, breadcrumbs, cards and personal viewed marks work together', async ({
  page,
}, testInfo) => {
  await page.clock.install();
  const tracker = await installExplorerMocks(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/devices/${DEVICE_ID}/files`);
  await expect(page.getByRole('button', { name: 'Оновити файлові дані', exact: true })).toHaveCount(
    0,
  );
  const cards = page.getByRole('list', { name: 'Файли та папки' });
  const pageBreadcrumbs = page.getByRole('navigation', { name: 'Навігаційний шлях пристрою' });
  const breadcrumbs = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
  const filePath = page.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
  await expect(
    breadcrumbs.getByRole('link', { name: 'До початку шляху', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Пошук файлів за назвою' })).toBeInViewport();
  await expect(cards.locator(`[data-entry-id="${ROOT_ID}"]`)).toContainText('Створено: 01.11.2026');
  await expect(cards.locator(`[data-entry-id="${ROOT_ID}"]`)).toContainText('Змінено: 02.11.2026');
  await cards.getByRole('button', { name: 'Відкрити папку C:\\', exact: true }).click();
  const folderCard = cards.locator(`[data-entry-id="${FOLDER_ID}"]`);
  await expect(folderCard).toContainText('Створено: 01.11.2026');
  await expect(folderCard).toContainText('Змінено: 02.11.2026');
  await cards.getByRole('button', { name: 'Додати в обране: Documents', exact: true }).click();
  await expect.poll(() => tracker.writes).toContainEqual({ entryId: FOLDER_ID, favorite: true });
  await cards.getByRole('button', { name: 'Відкрити папку Documents', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`directory=${FOLDER_ID}`));
  await expect(pageBreadcrumbs.getByRole('link')).toHaveText(['Device Explorer', 'Файли']);
  await expect(breadcrumbs.getByRole('link')).toHaveText(['', 'C', 'Documents']);
  await expect(breadcrumbs.getByRole('link', { name: 'Documents', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  await page.reload();
  const fileCard = cards.locator(`[data-entry-id="${FILE_ID}"]`);
  await expect(fileCard.getByText('нове', { exact: true })).toBeVisible();
  await expect(fileCard).not.toContainText(TAG.name);
  await expect(page.getByTestId('device-files-tree')).not.toContainText(TAG.name);
  await expect(cards.locator(`[data-entry-id="${PENDING_ID}"]`)).toHaveClass(/opacity-55/);
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Список', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const table = page.getByRole('table', { name: 'Файли та папки' });
  const fileRow = table.locator(`tr[data-entry-id="${FILE_ID}"]`);
  for (const name of [
    'Назва',
    'Перегляд',
    'Обране',
    'Дата завантаження',
    'Дата створення',
    'Дата зміни',
    'Розмір',
    'Тип',
    'Теги',
  ])
    await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
  await expect(fileRow.getByRole('cell').nth(1)).toHaveText('Нове');
  await expect(fileRow.getByRole('cell').nth(2).getByRole('button')).toHaveAttribute(
    'aria-pressed',
    'false',
  );
  await expect(fileRow.getByRole('cell').nth(3)).toContainText('04.11.2026');
  await expect(fileRow.getByRole('cell').nth(4)).toContainText('01.11.2026');
  await expect(fileRow.getByRole('cell').nth(5)).toContainText('02.11.2026');
  await expect(fileRow.getByRole('cell').nth(6)).toContainText(
    String(Buffer.byteLength(FILE_TEXT)),
  );
  await expect(fileRow.getByRole('cell').nth(7)).toHaveText('Документи');
  await expect(fileRow.getByRole('cell').nth(8)).toContainText(TAG.name);
  await expect(table.locator(`tr[data-entry-id="${PENDING_ID}"]`)).toHaveClass(/opacity-55/);
  await expect(
    table.locator(`tr[data-entry-id="${PENDING_ID}"]`).getByRole('cell').nth(3),
  ).toHaveText('—');
  await expect(
    table.locator(`tr[data-entry-id="${PENDING_ID}"]`).getByRole('cell').nth(6),
  ).toHaveText('—');
  const directoryUrl = page.url();
  await fileRow.getByRole('button', { name: 'Додати в обране: report.txt', exact: true }).click();
  await expect.poll(() => tracker.writes).toContainEqual({ entryId: FILE_ID, favorite: true });
  await expect(page).toHaveURL(directoryUrl);
  expect(tracker.writes.filter((write) => write.fileId)).toEqual([]);
  await fileRow.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
  await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
    FILE_TEXT,
  );
  await expect.poll(() => tracker.writes).toContainEqual({ fileId: FILE_ID, revision: 1 });
  await filePath.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(
    fileRow.getByRole('cell').nth(1).locator('[aria-label="Переглянуто"]'),
  ).toBeVisible();
  await expect(fileRow).not.toContainText('Нове');
  await page.clock.fastForward(400);
  await fileRow
    .getByRole('button', { name: 'Прибрати з обраного: report.txt', exact: true })
    .click();
  await expect.poll(() => tracker.writes).toContainEqual({ entryId: FILE_ID, favorite: false });
  await breadcrumbs.getByRole('link', { name: 'C', exact: true }).click();
  const folderRow = table.locator(`tr[data-entry-id="${FOLDER_ID}"]`);
  await expect(folderRow.getByRole('cell').nth(3)).toContainText('03.11.2026');
  await expect(folderRow.getByRole('cell').nth(4)).toContainText('01.11.2026');
  await expect(folderRow.getByRole('cell').nth(5)).toContainText('02.11.2026');
  await expect(folderRow.getByRole('cell').nth(6)).toHaveText('—');
  await expect(folderRow.getByRole('cell').nth(7)).toHaveText('Папка');
  await expect(folderRow).not.toContainText('Нове');
  await table.getByRole('button', { name: 'Відкрити папку Documents', exact: true }).click();
  await expect(fileRow).toBeVisible();
  await page.getByRole('button', { name: 'Плитка', exact: true }).click();
  await page.getByRole('button', { name: 'Згорнути ліву панель', exact: true }).click();
  await expect(page.getByTestId('device-files-sidebar')).toBeHidden();
  await expect(fileCard).toBeVisible();
  await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
  await fileCard.getByRole('button', { name: 'Додати в обране: report.txt', exact: true }).click();
  await expect.poll(() => tracker.writes).toContainEqual({ entryId: FILE_ID, favorite: true });
  await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Тільки обране', exact: true }).check();
  await expect(cards.locator('li')).toHaveCount(1);
  await expect(fileCard).toBeVisible();
  await page.getByRole('checkbox', { name: 'Тільки обране', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await page.screenshot({
    path: testInfo.outputPath('device-explorer-dark.png'),
    animations: 'disabled',
  });

  await fileCard.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`file=${FILE_ID}`));
  await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
    FILE_TEXT,
  );
  await expect.poll(() => tracker.writes).toContainEqual({ fileId: FILE_ID, revision: 1 });
  await page.reload();
  await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
    FILE_TEXT,
  );
  await filePath.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(fileCard.locator('[aria-label="Переглянуто"]')).toBeVisible();
  await expect(fileCard.getByText('нове', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Тільки непереглянуті', exact: true }).check();
  await expect(fileCard).toHaveCount(0);
  await expect(cards.locator(`[data-entry-id="${PENDING_ID}"]`)).toBeVisible();
  await page.getByRole('checkbox', { name: 'Тільки непереглянуті', exact: true }).uncheck();
  await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
  await breadcrumbs.getByRole('link', { name: 'C', exact: true }).click();
  await expect(
    cards.getByRole('button', { name: 'Відкрити папку Documents', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(fileCard).toBeVisible();
  await breadcrumbs.getByRole('link', { name: 'До початку шляху', exact: true }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files`);
  await expect(
    cards.getByRole('button', { name: 'Відкрити папку C:\\', exact: true }),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test('@regression #3930 mobile folder links keep header navigation and tree drawer usable', async ({
  page,
}, testInfo) => {
  await installExplorerMocks(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
  const breadcrumbs = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
  const cards = page.getByRole('list', { name: 'Файли та папки' });
  await expect(breadcrumbs.getByRole('link', { name: 'Documents', exact: true })).toBeVisible();
  await expect(cards.locator(`[data-entry-id="${FILE_ID}"]`)).toBeVisible();
  for (const theme of ['light', 'dark']) {
    await page.evaluate(
      (value) => document.documentElement.setAttribute('data-bs-theme', value),
      theme,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`device-explorer-mobile-${theme}.png`),
      animations: 'disabled',
    });
  }
  await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: 'Файли', exact: true });
  await expect(drawer.getByTestId('device-files-tree')).toBeVisible();
  await expect(
    drawer.getByRole('button', { name: 'Оновити файлові дані', exact: true }),
  ).toHaveCount(0);
  await drawer.getByRole('button', { name: 'Закрити: Файли', exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: 'Список', exact: true }).click();
  const table = page.getByRole('table', { name: 'Файли та папки' });
  await table.getByRole('columnheader', { name: 'Теги', exact: true }).scrollIntoViewIfNeeded();
  await expect(table.getByRole('columnheader', { name: 'Теги', exact: true })).toBeInViewport();
  expect(
    await table.evaluate((element) => {
      const viewport = element.parentElement!;
      const bounds = viewport.getBoundingClientRect();
      return (
        viewport.scrollLeft > 0 &&
        bounds.left >= 0 &&
        bounds.top >= 0 &&
        bounds.right <= innerWidth &&
        bounds.bottom <= innerHeight
      );
    }),
  ).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'Плитка', exact: true }).click();
  await breadcrumbs.getByRole('button', { name: 'Приховані папки шляху', exact: true }).click();
  await page.getByRole('menuitem', { name: 'C', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(
    cards.getByRole('button', { name: 'Відкрити папку Documents', exact: true }),
  ).toBeVisible();
});

test('@regression #3930 breadcrumb menus follow available width and navigate hidden archive folders', async ({
  page,
}) => {
  const fixture = await installExplorerMocks(page);
  const folders = [
    { entry_id: ROOT_ID, name: 'C:\\' },
    ...Array.from({ length: 7 }, (_, index) => ({
      entry_id:
        index === 6 ? FOLDER_ID : `018f0000-0000-7000-8000-${String(index + 20).padStart(12, '0')}`,
      name: `Рівень ${index + 1}`,
      archive_revision: 7,
    })),
  ];
  await page.route('**/api/device/files/browse', (route) => {
    const request = route.request().postDataJSON();
    const index = folders.findIndex((folder) => folder.entry_id === request.parent_entry_id);
    if (index < 0) return route.fallback();
    const next = folders[index + 1];
    return route.fulfill({
      json: {
        breadcrumbs: folders.slice(0, index + 1),
        entries: next
          ? [{ ...fixture.entry(FOLDER_ID), ...next, parent_entry_id: request.parent_entry_id }]
          : [fixture.entry(FILE_ID)],
        next_cursor: null,
      },
    });
  });
  await page.setViewportSize({ width: 1920, height: 900 });
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}&context=kept`);
  for (const kind of ['папки', 'файлу']) {
    if (kind === 'файлу') {
      await page.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
      await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
        FILE_TEXT,
      );
    }
    const path = page.getByRole('navigation', { name: `Шлях до ${kind}`, exact: true });
    const trigger = path.getByRole('button', { name: 'Приховані папки шляху', exact: true });
    await expect(path.getByRole('link')).toHaveCount(9);
    await expect(trigger).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(trigger).toBeVisible();
    await expect(path.locator('[aria-current="page"]')).toBeInViewport();
    await expectBreadcrumbFolders(page, path, [
      'C',
      ...folders.slice(1).map((folder) => folder.name),
    ]);
    await page.setViewportSize({ width: 1920, height: 900 });
    await expect(trigger).toHaveCount(0);
    await expect(path.getByRole('link')).toHaveCount(9);
    if (kind === 'файлу') {
      await page.setViewportSize({ width: 390, height: 900 });
      await expect(trigger).toBeVisible();
      await trigger.focus();
      await page.keyboard.press('Enter');
      const menu = page.getByRole('menu', { name: 'Приховані папки шляху', exact: true });
      await expect(menu.getByRole('menuitem', { name: 'C', exact: true })).toBeFocused();
      await page.keyboard.press('ArrowDown');
      await page.keyboard.press('ArrowDown');
      const target = menu.getByRole('menuitem', { name: 'Рівень 2', exact: true });
      await expect(target).toBeFocused();
      await expect(target).toHaveAttribute('href', /directory_revision=7/);
      await expect(target).toHaveAttribute('href', /context=kept/);
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
      await expect(page).toHaveURL(new RegExp(`directory=${folders[2].entry_id}`));
      await expect(page).toHaveURL(/directory_revision=7/);
      await expect(page).toHaveURL(/context=kept/);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  }
});

test('@regression #3930 long breadcrumbs stay on one line without moving toolbar actions', async ({
  page,
}, testInfo) => {
  const deviceName = 'Пристрій з дуже довгою назвою для перевірки навігації '.repeat(8);
  const folderName = 'Довга назва папки для перевірки шляху '.repeat(8).trim();
  const fileName = `${'Довга назва файлу — український текст та символи #3930 '.repeat(8)}.txt`;
  const fixture = await installExplorerMocks(page, deviceName);
  await page.route('**/api/device/files/browse', (route) => {
    if (route.request().postDataJSON().parent_entry_id !== FOLDER_ID) return route.fallback();
    return route.fulfill({
      json: {
        breadcrumbs: [
          { entry_id: ROOT_ID, name: 'C:\\' },
          { entry_id: FOLDER_ID, name: folderName },
        ],
        entries: [fixture.entry(FILE_ID), fixture.entry(PENDING_ID)],
        next_cursor: null,
      },
    });
  });
  await page.route('**/api/device/files/locate', (route) =>
    route.fulfill({
      json: {
        file: {
          ...fixture.entry(FILE_ID),
          name: fileName,
          path_components: [folderName, fileName],
          absolute_path: `C:\\${folderName}\\${fileName}`,
        },
        ancestors: [{ ...fixture.entry(FOLDER_ID), name: folderName }],
        root_entry_id: ROOT_ID,
        current_revision: 1,
      },
    }),
  );
  for (const width of [1440, 1024, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}`);
    const breadcrumbs = page.getByRole('navigation', { name: 'Навігаційний шлях пристрою' });
    await expect(breadcrumbs).toContainText(deviceName);
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    const reference = await breadcrumbs.getByRole('heading').evaluate((heading) => {
      const style = getComputedStyle(heading);
      const header = heading.closest('.device-page-header')!;
      return {
        fontSize: style.fontSize,
        fontWeight: style.fontWeight,
        lineHeight: style.lineHeight,
        headerHeight: header.getBoundingClientRect().height,
        headerBackground: getComputedStyle(header).backgroundColor,
      };
    });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await expect(breadcrumbs.getByRole('link')).toHaveText([deviceName, 'Файли']);
    const folderPath = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
    await expectBreadcrumbFolders(page, folderPath, ['C', folderName]);
    await expect(folderPath).toHaveAttribute('title', `C / ${folderName}`);
    await expect(folderPath.getByRole('button', { name: 'Приховані папки шляху' })).toBeVisible();
    await expect(folderPath.locator('ol').first()).toHaveCSS('white-space', 'nowrap');
    await expect(
      page.locator('.device-page-header').getByRole('textbox', { name: 'Пошук файлів за назвою' }),
    ).toHaveCount(0);
    for (const name of ['Фільтри файлів', 'Плитка', 'Список']) {
      await expect(page.getByRole('button', { name, exact: true })).toBeInViewport();
    }
    await expect(breadcrumbs.getByRole('heading')).toHaveCSS('font-size', reference.fontSize);
    await expect(breadcrumbs.getByRole('heading')).toHaveCSS('font-weight', reference.fontWeight);
    await expect(breadcrumbs.getByRole('heading')).toHaveCSS('line-height', reference.lineHeight);
    await expect(breadcrumbs.locator('ol')).toHaveCSS('text-overflow', 'ellipsis');
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    const layout = await breadcrumbs.evaluate((element) => {
      const path = element.querySelector('ol')!;
      const header = element.closest('.device-page-header')!;
      return {
        pathHeight: path.getBoundingClientRect().height,
        truncated: path.scrollWidth > path.clientWidth,
        headerHeight: header.getBoundingClientRect().height,
        headerBackground: getComputedStyle(header).backgroundColor,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(layout.pathHeight).toBeLessThanOrEqual(Number.parseFloat(reference.lineHeight) + 1);
    expect(layout.truncated).toBe(true);
    expect(layout.pageOverflow).toBe(false);
    expect(layout.headerBackground).toBe(reference.headerBackground);
    if (width >= 1024) {
      expect(layout.headerHeight).toBe(reference.headerHeight);
    }
    const folderLayout = await folderPath.evaluate((element) => {
      const path = element.querySelector('ol')!;
      const header = document.querySelector('.device-page-header')!;
      const search = document.querySelector('[aria-label="Пошук файлів за назвою"]')!;
      const controls = ['Фільтри файлів', 'Плитка', 'Список'].map((label) =>
        document.querySelector(`[aria-label="${label}"]`)!,
      );
      const center = (target: Element) => {
        const rect = target.getBoundingClientRect();
        return rect.top + rect.height / 2;
      };
      return {
        pathHeight: path.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(path).lineHeight),
        truncated: path.scrollWidth > path.clientWidth,
        pathTop: path.getBoundingClientRect().top,
        headerBottom: header.getBoundingClientRect().bottom,
        pathCenter: center(path),
        controlCenters: [search, ...controls].map(center),
        pathWidth: path.getBoundingClientRect().width,
        pathRight: path.getBoundingClientRect().right,
        searchLeft: search.getBoundingClientRect().left,
        searchHeight: search.parentElement!.getBoundingClientRect().height,
        rowHeight: element.parentElement!.parentElement!.getBoundingClientRect().height,
        buttonSizes: controls.map((button) => ({
          height: button.getBoundingClientRect().height,
          iconHeight: button.querySelector('svg')!.getBoundingClientRect().height,
        })),
      };
    });
    expect(folderLayout.pathHeight).toBeLessThanOrEqual(folderLayout.lineHeight + 1);
    expect(folderLayout.truncated).toBe(false);
    expect(folderLayout.pathTop).toBeGreaterThanOrEqual(folderLayout.headerBottom);
    expect(folderLayout.pathWidth).toBeGreaterThan(0);
    expect(folderLayout.pathRight).toBeLessThanOrEqual(folderLayout.searchLeft);
    for (const center of folderLayout.controlCenters)
      expect(Math.abs(center - folderLayout.pathCenter)).toBeLessThanOrEqual(2);
    await page.screenshot({
      path: testInfo.outputPath(`one-line-header-${width}.png`),
      animations: 'disabled',
    });
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    const filters = page.getByRole('form', { name: 'Фільтри файлів', exact: true });
    await expect(filters).toBeVisible();
    const filterBounds = await filters.boundingBox();
    const pathBounds = await folderPath.boundingBox();
    const listBounds = await page
      .getByRole('button', { name: 'Список', exact: true })
      .boundingBox();
    const contentBounds = await page
      .getByRole('region', { name: 'Вміст папки', exact: true })
      .boundingBox();
    const cardsBounds = await page
      .getByRole('list', { name: 'Файли та папки', exact: true })
      .boundingBox();
    expect(filterBounds!.x).toBeCloseTo(pathBounds!.x, 0);
    expect(filterBounds!.x + filterBounds!.width).toBeCloseTo(listBounds!.x + listBounds!.width, 0);
    expect(filterBounds!.x).toBeCloseTo(contentBounds!.x, 0);
    expect(cardsBounds!.x).toBeCloseTo(contentBounds!.x, 0);
    expect(cardsBounds!.x + cardsBounds!.width).toBeCloseTo(
      filterBounds!.x + filterBounds!.width,
      0,
    );
    expect(contentBounds!.x + contentBounds!.width).toBeCloseTo(width, 0);
    expect(contentBounds!.x + contentBounds!.width).toBeGreaterThan(
      filterBounds!.x + filterBounds!.width,
    );
    if (width >= 1024) {
      const toggleBounds = await page
        .getByRole('button', { name: 'Розгорнути праву панель', exact: true })
        .boundingBox();
      expect(filterBounds!.x + filterBounds!.width).toBeCloseTo(
        toggleBounds!.x + toggleBounds!.width,
        0,
      );
    }
    await page.screenshot({
      path: testInfo.outputPath(`aligned-filters-${width}.png`),
      animations: 'disabled',
    });

    await page.goto(`/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1`);
    const pane = page.getByTestId('device-file-content-pane');
    const filePath = pane.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
    await expect(pane.locator('pre')).toContainText(FILE_TEXT);
    await expect(breadcrumbs.getByRole('link')).toHaveText([deviceName, 'Файли']);
    await expectBreadcrumbFolders(page, filePath, ['C', folderName]);
    await expect(filePath.locator('[aria-current="page"]')).toHaveText(fileName);
    await expect(filePath.locator('[aria-current="page"]')).toHaveAttribute('title', fileName);
    await expect(filePath).toHaveAttribute('title', `C / ${folderName} / ${fileName}`);
    await expect(filePath.getByRole('button', { name: 'Приховані папки шляху' })).toBeVisible();
    await expect(filePath.locator('ol').first()).toHaveCSS('white-space', 'nowrap');
    for (const name of ['Інформація', 'На весь екран', 'Скачати файл', 'До папки']) {
      await expect(pane.getByRole('button', { name, exact: true })).toBeInViewport();
    }
    const fileActionSize = await pane
      .getByRole('button', { name: 'На весь екран', exact: true })
      .evaluate((button) => ({
        height: button.getBoundingClientRect().height,
        iconHeight: button.querySelector('svg')!.getBoundingClientRect().height,
        rowHeight: button.parentElement!.parentElement!.getBoundingClientRect().height,
      }));
    expect(folderLayout.searchHeight).toBeLessThanOrEqual(fileActionSize.height + 1);
    expect(folderLayout.rowHeight).toBeLessThanOrEqual(fileActionSize.rowHeight + 1);
    for (const button of folderLayout.buttonSizes) {
      expect(button.height).toBeCloseTo(fileActionSize.height, 0);
      expect(button.iconHeight).toBeCloseTo(fileActionSize.iconHeight, 0);
    }
    const fileLayout = await filePath.evaluate((element) => {
      const path = element.querySelector('ol')!;
      const info = element
        .closest('[data-testid="device-file-content-pane"]')!
        .querySelector('[aria-label="Інформація"]')!;
      return {
        pathHeight: path.getBoundingClientRect().height,
        lineHeight: Number.parseFloat(getComputedStyle(path).lineHeight),
        truncated: path.scrollWidth > path.clientWidth,
        pathRight: path.getBoundingClientRect().right,
        infoLeft: info.getBoundingClientRect().left,
        pageOverflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(fileLayout.pathHeight).toBeLessThanOrEqual(fileLayout.lineHeight + 1);
    expect(fileLayout.truncated).toBe(false);
    expect(fileLayout.pathRight).toBeLessThanOrEqual(fileLayout.infoLeft);
    expect(fileLayout.pageOverflow).toBe(false);
    await pane.getByRole('button', { name: 'Інформація', exact: true }).click();
    await expect(
      page.getByRole('dialog', { name: 'Інформація про вкладення', exact: true }),
    ).toContainText(fileName);
    await page.keyboard.press('Escape');
    await page.screenshot({
      path: testInfo.outputPath(`one-line-file-header-${width}.png`),
      animations: 'disabled',
    });
  }
});

test('@regression #3930 legacy file links restore their path without a directory query', async ({
  page,
}) => {
  const tracker = await installExplorerMocks(page);
  await page.goto(`/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1`);
  await expect(page.getByTestId('device-file-content-pane').locator('pre')).toContainText(
    FILE_TEXT,
  );
  const breadcrumbs = page.getByRole('navigation', { name: 'Навігаційний шлях пристрою' });
  await expect(breadcrumbs.getByRole('link')).toHaveText(['Device Explorer', 'Файли']);
  const filePath = page.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
  await expect(filePath.locator('[aria-current="page"]')).toHaveText('report.txt');
  await expect(filePath.getByRole('link', { name: 'Documents', exact: true })).toBeVisible();
  await expect.poll(() => tracker.writes).toContainEqual({ fileId: FILE_ID, revision: 1 });
  await filePath.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Файли та папки' })).toContainText('report.txt');
});

test('@regression #3930 denied direct file links report the error without marking a file viewed', async ({
  page,
}) => {
  const tracker = await installExplorerMocks(page);
  await page.route('**/api/device/files/locate', (route) =>
    route.fulfill({ status: 403, contentType: 'text/plain', body: 'forbidden' }),
  );
  await page.goto(`/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1`);
  await expect(page.getByRole('alert')).toContainText('Не вдалося відкрити файл за посиланням');
  await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
  expect(tracker.writes).toEqual([]);
});

for (const width of [1440, 390]) {
  test(`@regression #3930 file requests follow visible content and reuse loaded folders at ${width}px`, async ({
    page,
  }) => {
    const fixture = await installExplorerMocks(page, 'Device Explorer', {
      pendingHasContent: true,
    });
    const requests: string[] = [];
    const browse: Record<string, unknown>[] = [];
    const counts: Record<string, unknown>[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      requests.push(path);
      if (path === '/api/device/files/browse') browse.push(request.postDataJSON());
      if (path === '/api/device/files/subtree-counts') counts.push(request.postDataJSON());
    });
    const childId = '018f0000-0000-7000-8000-000000000007';
    await page.route('**/api/device/files/browse', (route) => {
      if (route.request().postDataJSON().parent_entry_id !== FOLDER_ID) return route.fallback();
      return route.fulfill({
        json: {
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:\\' },
            { entry_id: FOLDER_ID, name: 'Documents' },
          ],
          entries: [
            {
              ...fixture.entry(FOLDER_ID),
              entry_id: childId,
              parent_entry_id: FOLDER_ID,
              name: 'Child',
            },
            fixture.entry(FILE_ID),
          ],
          next_cursor: null,
        },
      });
    });
    await page.addInitScript(() => localStorage.setItem('echo.device-files.view-mode.v1', 'list'));
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await expect(
      page.getByRole('region', { name: 'Вміст папки', exact: true }).getByRole('table'),
    ).toBeVisible();
    if (width === 1440)
      await expect(
        page.getByTestId('device-files-tree').getByText('Documents', { exact: true }),
      ).toBeVisible();
    expect(browse.filter((request) => request.parent_entry_id === FOLDER_ID)).toHaveLength(1);
    expect(browse.filter((request) => request.parent_entry_id === ROOT_ID)).toHaveLength(
      width === 1440 ? 1 : 0,
    );
    for (const path of [
      '/api/device/audio/list',
      '/api/sigint/units',
      '/api/sigint/network-list',
      '/api/device/analytics/tags',
      '/api/device/files/filter-options',
    ])
      expect(requests.filter((request) => request === path)).toHaveLength(0);
    expect(requests.filter((request) => request === '/api/system-settings/current')).toHaveLength(
      1,
    );
    expect(counts).toHaveLength(0);
    await page.getByRole('button', { name: 'Плитка', exact: true }).click();
    await expect.poll(() => counts.length).toBe(1);
    expect(counts[0].directory_entry_ids).toEqual([childId]);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    expect(browse.filter((request) => request.parent_entry_id === FOLDER_ID)).toHaveLength(1);

    const filterButton = page.getByRole('button', { name: 'Фільтри файлів', exact: true });
    const filterPanel = page.getByRole('form', { name: 'Фільтри файлів', exact: true });
    await filterButton.click();
    await expect(filterPanel).toBeVisible();
    await expect
      .poll(() => requests.filter((path) => path === '/api/device/files/filter-options').length)
      .toBe(1);
    await expect
      .poll(() => requests.filter((path) => path === '/api/device/analytics/tags').length)
      .toBe(1);
    await page.waitForTimeout(450);
    await filterButton.click();
    await expect(filterPanel).toBeHidden();

    if (width === 390) {
      await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
      await expect(
        page.getByTestId('device-files-tree').getByText('Documents', { exact: true }),
      ).toBeVisible();
      expect(browse.filter((request) => request.parent_entry_id === FOLDER_ID)).toHaveLength(1);
      await page.getByRole('button', { name: 'Закрити: Файли', exact: true }).click();
    } else await page.getByRole('button', { name: 'Згорнути ліву панель', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    await input.fill('report');
    await input.press('Enter');
    await expect(page.getByRole('table', { name: 'Результати пошуку', exact: true })).toBeVisible();
    const previousBrowse = browse.length;
    await page.waitForTimeout(450);
    await filterButton.click();
    await page.getByRole('checkbox', { name: 'Тільки обране', exact: true }).check();
    await expect
      .poll(() => requests.filter((path) => path === '/api/device/files/search').length)
      .toBe(2);
    expect(browse).toHaveLength(previousBrowse);
    expect(counts).toHaveLength(1);
    expect(requests.filter((path) => path === '/api/device/files/filter-options')).toHaveLength(1);
    expect(requests.filter((path) => path === '/api/device/analytics/tags')).toHaveLength(1);
    await page.getByRole('button', { name: 'До пристрою', exact: true }).click();
    await expect.poll(() => requests.filter((path) => path === '/api/sigint/units').length).toBe(1);
    await expect
      .poll(() => requests.filter((path) => path === '/api/sigint/network-list').length)
      .toBe(1);
  });

  test(`@regression #3930 search mode preserves scope results and folder navigation at ${width}px`, async ({
    page,
  }, testInfo) => {
    const fixture = await installExplorerMocks(page, 'Device Explorer', {
      pendingHasContent: true,
    });
    const childFolder = {
      ...fixture.entry(FOLDER_ID),
      entry_id: '018f0000-0000-7000-8000-000000000007',
      parent_entry_id: FOLDER_ID,
      name: 'Nested',
      path_components: ['Documents', 'Nested'],
    };
    await page.route('**/api/device/files/browse', (route) => {
      const parentId = route.request().postDataJSON().parent_entry_id;
      if (parentId !== FOLDER_ID && parentId !== childFolder.entry_id) return route.fallback();
      return route.fulfill({
        json: {
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:\\' },
            { entry_id: FOLDER_ID, name: 'Documents' },
            ...(parentId === childFolder.entry_id
              ? [{ entry_id: childFolder.entry_id, name: childFolder.name }]
              : []),
          ],
          entries:
            parentId === FOLDER_ID
              ? [childFolder, fixture.entry(FILE_ID), fixture.entry(PENDING_ID)]
              : [],
          next_cursor: null,
        },
      });
    });
    const requests: Record<string, unknown>[] = [];
    await page.route('**/api/device/files/search', (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: {
          entries: [fixture.entry(FILE_ID), fixture.entry(PENDING_ID), fixture.entry(FOLDER_ID)],
          next_cursor: null,
        },
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    const results = page.getByRole('table', { name: 'Результати пошуку', exact: true });
    const folderPath = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
    const expectResultsPath = async () => {
      await expect(folderPath.locator('ol').first().getByRole('listitem')).toHaveCount(2);
    };
    const scopeMenu = page.getByRole('menu', { name: 'Область пошуку', exact: true });
    const globalSearch = scopeMenu.getByRole('menuitem', {
      name: 'Шукати на всьому пристрої',
      exact: true,
    });
    await search.click();
    await expect(scopeMenu).toBeVisible();
    await expect(globalSearch).toBeDisabled();
    await expect(scopeMenu.getByRole('checkbox')).toHaveCount(0);
    await expect(scopeMenu.getByRole('button', { name: 'Знайти', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Знайти файли', exact: true })).toHaveCount(0);
    const expectMenuWidth = async () => {
      await expect
        .poll(async () => {
          const field = await search.locator('..').boundingBox();
          const menu = await scopeMenu.boundingBox();
          return Math.abs(field!.width - menu!.width);
        })
        .toBeLessThan(1);
    };
    await expectMenuWidth();
    await search.fill('report');
    await expect(globalSearch).toBeEnabled();
    await expectMenuWidth();
    const icon = search.locator('..').locator('svg').first();
    const iconBounds = await icon.boundingBox();
    const inputBounds = await search.boundingBox();
    expect(iconBounds!.x + iconBounds!.width).toBeLessThanOrEqual(inputBounds!.x);
    expect(iconBounds!.width).toBe(20);
    expect(
      await globalSearch.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    ).toBeLessThan(
      await search.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
    );
    await scopeMenu.screenshot({ path: testInfo.outputPath('search-scope-menu.png') });
    await search.press('Escape');
    await expect(scopeMenu).toBeHidden();
    await search.click();
    await expect(scopeMenu).toBeVisible();
    await search.press('ArrowDown');
    await expect(globalSearch).toBeFocused();
    await globalSearch.press('Escape');
    await expect(scopeMenu).toBeHidden();
    await expect(search).toBeFocused();
    await search.click();
    await search.press('Enter');
    await expect(results.getByRole('columnheader')).toHaveText(['Назва', 'Шлях', 'Дії']);
    await expectResultsPath();
    await expect(
      results
        .locator(`[data-entry-id="${FOLDER_ID}"]`)
        .getByRole('cell')
        .last()
        .getByRole('button'),
    ).toHaveCount(1);
    expect(requests.at(-1)).toMatchObject({
      scope_entry_id: FOLDER_ID,
      global_search: false,
      rank_by_relevance: true,
    });
    for (const [id, text] of [
      [FILE_ID, FILE_TEXT],
      [PENDING_ID, NEXT_FILE_TEXT],
    ] as const) {
      await results.locator(`[data-entry-id="${id}"]`).getByRole('button').first().click();
      await expect(page.getByTestId('device-file-content-pane').locator('pre')).toHaveText(text);
      await page.getByRole('button', { name: 'До результатів пошуку', exact: true }).click();
      await expect(results).toBeVisible();
      await expect(search).toHaveValue('report');
      await expectResultsPath();
    }
    expect(requests).toHaveLength(1);
    await results.getByRole('button', { name: 'Documents', exact: true }).click();
    await expect(results).toBeHidden();
    await expect(page).toHaveURL(/search_view=folder/);
    await expect(
      folderPath.getByRole('link', { name: 'Результати пошуку', exact: true }),
    ).toBeVisible();
    await expect(folderPath).toHaveAttribute('title', 'Documents');
    await expect(folderPath.locator('ol').first().getByRole('listitem')).toHaveCount(3);
    await expect(page).toHaveURL(new RegExp(`search_root=${FOLDER_ID}`));
    await page.reload();
    await expect(folderPath).toHaveAttribute('title', 'Documents');
    await expect(folderPath.locator('ol').first().getByRole('listitem')).toHaveCount(3);
    await page
      .getByRole('list', { name: 'Файли та папки', exact: true })
      .getByRole('button', { name: 'Відкрити папку Nested', exact: true })
      .click();
    await expect(folderPath).toHaveAttribute('title', 'Documents / Nested');
    await expect(folderPath.locator('ol').first().getByRole('listitem')).toHaveCount(4);
    await page.goBack();
    await expect(folderPath).toHaveAttribute('title', 'Documents');
    await page.goForward();
    await expect(folderPath).toHaveAttribute('title', 'Documents / Nested');
    await folderPath.getByRole('link', { name: 'Documents', exact: true }).click();
    await page.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
    const filePath = page.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
    await expect(filePath).toHaveAttribute('title', 'Documents / report.txt');
    await expect(filePath.getByRole('link', { name: 'C', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'До папки', exact: true }).click();
    await expect(folderPath).toHaveAttribute('title', 'Documents');
    await folderPath.getByRole('link', { name: 'Результати пошуку', exact: true }).click();
    await expect(results).toBeVisible();
    await expect(page).not.toHaveURL(/search_root=/);
    await expectResultsPath();
    await page.screenshot({
      path: testInfo.outputPath('returned-search-results.png'),
      animations: 'disabled',
    });
    await page.goBack();
    await expect(folderPath.getByRole('link', { name: 'Documents', exact: true })).toBeVisible();
    await page.goForward();
    await expect(results).toBeVisible();
    await expectResultsPath();
    await results
      .getByRole('button', { name: 'Перейти до папки: report.txt', exact: true })
      .click();
    await expect(results).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]search=/);
    await expect(search).toHaveValue('');
    await page.goBack();
    await expect(results).toBeVisible();
    await page.reload();
    await expect(results).toBeVisible();
    await expect(search).toHaveValue('report');
    await expectResultsPath();
    await search.click();
    await globalSearch.click();
    await expect.poll(() => requests.at(-1)?.global_search).toBe(true);
    await expect(page).toHaveURL(/search_global=1/);
    await expect(
      page.getByRole('region', { name: 'Результати пошуку файлів', exact: true }),
    ).toHaveAttribute('aria-busy', 'false');
    await expect(results.locator('[data-entry-id]')).toHaveCount(3);
    await page.screenshot({ path: testInfo.outputPath('search-mode.png') });
    await search.press('Enter');
    await expect.poll(() => requests.at(-1)?.global_search).toBe(false);
    await expect(page).not.toHaveURL(/search_global=1/);
    await expect(
      page.getByRole('region', { name: 'Результати пошуку файлів', exact: true }),
    ).toHaveAttribute('aria-busy', 'false');
    await expect(results.locator('[data-entry-id]')).toHaveCount(3);
    await results
      .getByRole('button', { name: 'Перейти до папки: report.txt', exact: true })
      .click();
    await expect(page).not.toHaveURL(/[?&]search=/);
    await expect(search).toHaveValue('');
    await search.fill('report');
    await search.press('Enter');
    await expect(results).toBeVisible();
    await page.getByRole('button', { name: 'Завершити пошук', exact: true }).click();
    await expect(results).toBeHidden();
    await expect(page).not.toHaveURL(/[?&]search=/);
    await search.fill('report');
    await search.press('Enter');
    await expect(results).toBeVisible();
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    await page.getByRole('checkbox', { name: 'Тільки обране', exact: true }).check();
    await expect.poll(() => requests.at(-1)?.filters).toMatchObject({ favorites_only: true });
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    await expect(results.locator(`[data-entry-id="${FOLDER_ID}"]`)).toBeVisible();
    await expect(results.locator(`[data-entry-id="${FILE_ID}"]`)).toHaveCount(0);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

test('@regression #3930 session polling refreshes changed file data without reloading an unchanged preview', async ({
  page,
}) => {
  await installExplorerMocks(page, 'Device Explorer', { pendingHasContent: true });
  await page.clock.install();
  const syncId = '018f0000-0000-7000-8000-000000000008';
  let contentCount = 1;
  let analyzedCount = 0;
  let summaries = 0;
  let roots = 0;
  let browses = 0;
  let viewed = 0;
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/files/roots')) roots += 1;
    if (path.endsWith('/files/browse')) browses += 1;
    if (path.endsWith('/files/viewed')) viewed += 1;
  });
  await page.route('**/api/device/files/sessions/list', (route) =>
    route.fulfill({
      json: {
        sessions: [
          {
            sync_id: syncId,
            device_id: DEVICE_ID,
            mode: 'automatic',
            status: 'open',
            analysis_run_id: null,
            next_batch_index: 1,
            counts: { received: 2, accepted: 2, created: 2, updated: 0, rejected: 0 },
            created_at: NOW,
            updated_at: NOW,
            completed_at: null,
            expires_at: null,
          },
        ],
        next_cursor: null,
      },
    }),
  );
  await page.route('**/api/device/files/sessions/summaries', (route) => {
    summaries += 1;
    return route.fulfill({
      json: {
        summaries: route
          .request()
          .postDataJSON()
          .sync_ids.map((id: string) => ({
            sync_id: id,
            analysis: {
              total_file_count: 2,
              files_with_content_count: contentCount,
              analyzed_file_count: analyzedCount,
              items: [],
              stats: null,
            },
          })),
      },
    });
  });
  await page.route('**/api/device/analytics/summary', (route) =>
    route.fulfill({
      json: {
        total_file_count: 2,
        files_with_content_count: contentCount,
        analyzed_file_count: analyzedCount,
        items: [],
        stats: null,
      },
    }),
  );
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
  await page.getByRole('button', { name: 'Розгорнути праву панель', exact: true }).click();
  await expect.poll(() => summaries).toBe(1);
  await page
    .getByRole('list', { name: 'Файли та папки', exact: true })
    .getByRole('button', { name: 'Відкрити файл report.txt', exact: true })
    .click();
  const preview = page.getByTestId('device-file-content-pane');
  await expect(preview.locator('pre')).toHaveText(FILE_TEXT);
  const previousRoots = roots;
  const previousBrowses = browses;
  analyzedCount = 1;
  await page.clock.fastForward(16000);
  await expect.poll(() => summaries).toBe(2);
  await expect(preview.locator('pre')).toHaveText(FILE_TEXT);
  expect(roots).toBe(previousRoots);
  expect(browses).toBe(previousBrowses);
  expect(viewed).toBe(1);
  contentCount = 2;
  await page.clock.fastForward(16000);
  await expect.poll(() => summaries).toBe(3);
  await expect.poll(() => roots).toBe(previousRoots + 1);
  await expect(preview.locator('pre')).toHaveText(FILE_TEXT);
  expect(viewed).toBe(1);
});

test('@regression #3930 search auto loading shows skeletons and restores result scroll after preview', async ({
  page,
}) => {
  const fixture = await installExplorerMocks(page, 'Device Explorer', { pendingHasContent: true });
  const firstPage = Array.from({ length: 99 }, (_, index) => ({
    ...fixture.entry(FILE_ID),
    entry_id: `018f0000-0000-7000-8001-${String(index).padStart(12, '0')}`,
    file_id: `018f0000-0000-7000-8001-${String(index).padStart(12, '0')}`,
    name: `report-${index}.txt`,
  }));
  firstPage.push(fixture.entry(PENDING_ID));
  let release = () => {};
  const secondPage = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cursors: (string | null)[] = [];
  await page.route('**/api/device/files/search', async (route) => {
    const { cursor } = route.request().postDataJSON();
    cursors.push(cursor);
    if (cursor) await secondPage;
    return route.fulfill({
      json: {
        entries: cursor ? [fixture.entry(FILE_ID)] : firstPage,
        next_cursor: cursor ? null : 'search-next',
      },
    });
  });
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
  const input = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
  await input.fill('report');
  await input.press('Enter');
  const viewport = page.getByRole('region', { name: 'Результати пошуку файлів', exact: true });
  await expect(viewport.locator('[data-entry-id]')).toHaveCount(100);
  await viewport.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(viewport.locator('[data-device-file-loading-skeleton]').first()).toBeVisible();
  release();
  await expect(viewport.locator('[data-entry-id]')).toHaveCount(101);
  const pending = viewport
    .locator(`[data-entry-id="${PENDING_ID}"]`)
    .getByRole('button', { name: 'pending.txt', exact: true });
  await pending.scrollIntoViewIfNeeded();
  const position = await viewport.evaluate((element) => element.scrollTop);
  expect(position).toBeGreaterThan(500);
  await pending.click();
  await expect(page.getByTestId('device-file-content-pane').locator('pre')).toHaveText(
    NEXT_FILE_TEXT,
  );
  await page.getByRole('button', { name: 'До результатів пошуку', exact: true }).click();
  await expect(viewport).toBeVisible();
  await expect
    .poll(() => viewport.evaluate((element) => element.scrollTop))
    .toBeCloseTo(position, 0);
  await expect(viewport.locator('[data-entry-id]')).toHaveCount(101);
  expect(cursors).toEqual([null, 'search-next']);
});

test('@regression #3930 archive folder breadcrumbs pin only archive segments to their revision', async ({
  page,
}) => {
  const fixture = await installExplorerMocks(page);
  await captureNativeDownload(page);
  const archiveId = '018f0000-0000-7000-8000-000000000006';
  const archiveFolderId = '018f0000-0000-7000-8000-000000000007';
  const archiveJobId = '018f0000-0000-7000-8000-000000000008';
  const browseRequests: { parent_entry_id: string; archive_revision: number | null }[] = [];
  const locateRequests: { fileId: string; revision: number }[] = [];
  const archiveDownloads: string[] = [];
  const archive = {
    ...fixture.entry(FILE_ID),
    entry_id: archiveId,
    file_id: archiveId,
    name: 'archive.zip',
    mime_type: 'application/zip',
    extension: 'zip',
    revision: 1,
    is_archive: true,
  };
  const archiveFolder = {
    ...fixture.entry(FOLDER_ID),
    entry_id: archiveFolderId,
    parent_entry_id: archiveId,
    name: 'nested',
    revision: 1,
    archive_origin: { archive_id: archiveJobId, source_file_id: archiveId, source_revision: 1 },
  };
  const archiveFile = {
    ...fixture.entry(FILE_ID),
    parent_entry_id: archiveFolderId,
    absolute_path: null,
    virtual_path: 'nested/report.txt',
    archive_origin: archiveFolder.archive_origin,
  };
  const path = [
    { entry_id: ROOT_ID, name: 'C:\\', archive_revision: null },
    { entry_id: FOLDER_ID, name: 'Documents', archive_revision: null },
    { entry_id: archiveId, name: 'archive.zip', archive_revision: 1 },
    { entry_id: archiveFolderId, name: 'nested', archive_revision: 1 },
  ];
  await page.route('**/api/device/files/browse', (route) => {
    const request = route.request().postDataJSON();
    browseRequests.push(request);
    const index = path.findIndex((item) => item.entry_id === request.parent_entry_id);
    if (index < 2 && request.archive_revision !== null)
      return route.fulfill({ status: 400, json: { code: 'invalid_request' } });
    if (index >= 2 && request.archive_revision !== 1)
      return route.fulfill({ status: 404, json: { code: 'wrong_archive_revision' } });
    const entries =
      index === 0
        ? [fixture.entry(FOLDER_ID)]
        : index === 1
          ? [{ ...archive, revision: 2, has_content: false, is_archive: false }]
          : index === 2
            ? [archiveFolder]
            : [archiveFile];
    return route.fulfill({
      json: {
        entries,
        breadcrumbs: path.slice(0, index + 1),
        archive_source:
          index >= 2 ? { device_id: DEVICE_ID, file_id: archiveId, revision: 1 } : null,
        next_cursor: null,
      },
    });
  });
  await page.route(`**/api/device/files/${DEVICE_ID}/${archiveId}/revisions/*/content`, (route) => {
    archiveDownloads.push(`${route.request().method()} ${route.request().url()}`);
    expect(route.request().url()).toContain('/revisions/1/content');
    return route.fulfill({
      contentType: 'application/octet-stream',
      headers: {
        'Content-Disposition': 'attachment; filename="archive.zip"',
        'Content-Length': '4',
      },
      body: route.request().method() === 'HEAD' ? undefined : 'PK\u0005\u0006',
    });
  });
  await page.route('**/api/device/files/locate', (route) => {
    const request = route.request().postDataJSON();
    locateRequests.push(request);
    const member = request.fileId === FILE_ID;
    return route.fulfill({
      json: {
        file: member ? archiveFile : archive,
        ancestors: [fixture.entry(FOLDER_ID), ...(member ? [archive, archiveFolder] : [])],
        root_entry_id: ROOT_ID,
        current_revision: member ? 1 : 2,
      },
    });
  });
  await page.route(`**/api/device/files/${DEVICE_ID}/${archiveId}/revisions/1/archive`, (route) =>
    route.fulfill({
      json: {
        source: { device_id: DEVICE_ID, file_id: archiveId, revision: 1 },
        archive: {
          archive_id: archiveJobId,
          root_entry_id: archiveId,
          state: 'ready',
          reason: null,
          message: null,
          limit_name: null,
        },
        next_attempt_at: null,
        poll_after_ms: 2000,
        updated_at: NOW,
      },
    }),
  );
  await page.goto(`/devices/${DEVICE_ID}/files?directory=${archiveFolderId}&directory_revision=1`);
  const breadcrumbs = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
  await expect(breadcrumbs.getByRole('link', { name: 'nested', exact: true })).toBeVisible();
  const archiveDownload = page.getByRole('button', {
    name: 'Скачати початковий архів',
    exact: true,
  });
  await expect(archiveDownload).toBeVisible();
  await archiveDownload.click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-native-download',
    `/api/device/files/${DEVICE_ID}/${archiveId}/revisions/1/content`,
  );
  expect(archiveDownloads.map((request) => request.split(' ')[0])).toEqual(['HEAD']);
  await expect(page).toHaveURL(new RegExp(`directory=${archiveFolderId}&directory_revision=1`));
  await expect
    .poll(() =>
      locateRequests.some((request) => request.fileId === archiveId && request.revision === 1),
    )
    .toBe(true);
  await page.getByRole('button', { name: 'Відкрити файл report.txt', exact: true }).click();
  const filePath = page.getByRole('navigation', { name: 'Шлях до файлу', exact: true });
  await expect(filePath.getByRole('link')).toHaveText([
    '',
    'C',
    'Documents',
    'archive.zip',
    'nested',
  ]);
  await expect(filePath.locator('[aria-current="page"]')).toHaveText('report.txt');
  await expect(filePath.getByRole('link', { name: 'archive.zip', exact: true })).toHaveAttribute(
    'href',
    new RegExp(`directory=${archiveId}&directory_revision=1`),
  );
  await filePath.getByRole('link', { name: 'nested', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`directory=${archiveFolderId}&directory_revision=1`));
  await breadcrumbs.getByRole('link', { name: 'archive.zip', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`directory=${archiveId}&directory_revision=1`));
  await expect(
    page.getByRole('button', { name: 'Відкрити папку nested', exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Відкрити папку nested', exact: true }),
  ).toBeVisible();
  await expect(archiveDownload).toBeVisible();
  await page.goto(`/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1`);
  await expect(filePath.getByRole('link')).toHaveText([
    '',
    'C',
    'Documents',
    'archive.zip',
    'nested',
  ]);
  await expect(filePath.getByRole('link', { name: 'Documents', exact: true })).toHaveAttribute(
    'href',
    `/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`,
  );
  await filePath.getByRole('link', { name: 'Documents', exact: true }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
  await expect(
    page.getByRole('button', { name: 'Відкрити файл archive.zip', exact: true }),
  ).toBeVisible();
  await expect(archiveDownload).toHaveCount(0);
  await page.goto(
    `/devices/${DEVICE_ID}/files?file=${FILE_ID}&revision=1&directory=${archiveFolderId}&directory_revision=1&keep=1`,
  );
  const rootLink = filePath.getByRole('link', { name: 'До початку шляху', exact: true });
  await expect(rootLink).toHaveAttribute('href', `/devices/${DEVICE_ID}/files?keep=1`);
  await rootLink.click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?keep=1`);
  await expect(
    page
      .getByRole('list', { name: 'Файли та папки', exact: true })
      .getByRole('button', { name: 'Відкрити папку C:\\', exact: true }),
  ).toBeVisible();
  expect(
    browseRequests
      .filter((request) => [ROOT_ID, FOLDER_ID].includes(request.parent_entry_id))
      .every((request) => request.archive_revision === null),
  ).toBe(true);
  await expect(page.getByRole('alert')).toHaveCount(0);
});

for (const width of [1440, 390]) {
  test(`@regression #3930 password locks identify only protected archives across grid table and search at ${width}px`, async ({
    page,
  }, testInfo) => {
    const { entry } = await installExplorerMocks(page);
    const protectedId = '018f0000-0000-7000-8000-000000000006';
    const invalidId = '018f0000-0000-7000-8000-000000000007';
    const summary = {
      archive_id: null,
      root_entry_id: null,
      state: 'failed',
      reason: 'password_protected',
      message: 'Архів захищений паролем',
      limit_name: null,
    };
    const archive = {
      ...entry(FILE_ID),
      name: 'archive.zip',
      mime_type: 'application/zip',
      extension: 'zip',
      is_archive: true,
      tags: [],
    };
    const entries = [
      {
        ...archive,
        entry_id: protectedId,
        file_id: protectedId,
        name: 'protected.zip',
        archive: summary,
      },
      {
        ...archive,
        entry_id: invalidId,
        file_id: invalidId,
        name: 'invalid.zip',
        archive: { ...summary, reason: 'invalid_archive', message: 'Некоректний архів' },
      },
      archive,
      entry(PENDING_ID),
    ];
    await page.route('**/api/device/files/browse', (route) => {
      if (route.request().postDataJSON().parent_entry_id !== FOLDER_ID) return route.fallback();
      return route.fulfill({
        json: {
          archive_source: null,
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:\\' },
            { entry_id: FOLDER_ID, name: 'Documents' },
          ],
          entries,
          next_cursor: null,
        },
      });
    });
    await page.route('**/api/device/files/search', (route) =>
      route.fulfill({ json: { entries, next_cursor: null } }),
    );
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const cards = page.getByRole('list', { name: 'Файли та папки', exact: true });
    const lock = (scope: Locator) =>
      scope.getByRole('img', { name: 'Архів захищений паролем', exact: true });
    await expect(lock(cards)).toHaveCount(1);
    await expect(lock(cards.locator(`[data-entry-id="${protectedId}"]`))).toBeVisible();
    await expect(lock(cards).locator('title')).toHaveText('Архів захищений паролем');
    await expect(lock(cards).getByTestId('FolderZipOutlinedIcon')).toBeVisible();
    await expect(lock(cards).getByTestId('LockOutlinedIcon')).toBeVisible();
    const heights = await cards
      .locator(':scope > [data-entry-id]')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...heights) - Math.min(...heights)).toBeLessThan(1);
    if (width === 1440) {
      const tree = page.getByTestId('device-files-tree');
      await expect(lock(tree)).toHaveCount(1);
      await expect(lock(tree).getByTestId('FolderZipOutlinedIcon')).toBeVisible();
      await expect(lock(tree).getByTestId('LockOutlinedIcon')).toBeVisible();
      await expect(tree.getByRole('button', { name: 'protected.zip', exact: true })).toContainText(
        'protected.zip',
      );
    }
    await cards.screenshot({ path: testInfo.outputPath('password-lock-grid.png') });
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const table = page.getByRole('table', { name: 'Файли та папки', exact: true });
    await expect(lock(table)).toHaveCount(1);
    await expect(lock(table.locator(`[data-entry-id="${protectedId}"]`))).toBeVisible();
    await expect(lock(table).getByTestId('FolderZipOutlinedIcon')).toBeVisible();
    await expect(lock(table).getByTestId('LockOutlinedIcon')).toBeVisible();
    const rowHeights = await table
      .locator('tbody tr')
      .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
    expect(Math.max(...rowHeights) - Math.min(...rowHeights)).toBeLessThan(1);
    const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    await search.fill('zip');
    await search.press('Enter');
    const results = page.getByRole('table', { name: 'Результати пошуку', exact: true });
    await expect(lock(results)).toHaveCount(1);
    await expect(lock(results).getByTestId('FolderZipOutlinedIcon')).toBeVisible();
    await expect(lock(results).getByTestId('LockOutlinedIcon')).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}

for (const width of [1440, 390]) {
  test(`@regression #3930 empty nested archive folders download their own original and retry errors at ${width}px`, async ({
    page,
  }, testInfo) => {
    const fixture = await installExplorerMocks(page);
    await captureNativeDownload(page);
    await page.setViewportSize({ width, height: 800 });
    const outerId = '018f0000-0000-7000-8000-000000000006';
    const innerId = '018f0000-0000-7000-8000-000000000007';
    const emptyId = '018f0000-0000-7000-8000-000000000008';
    const jobId = '018f0000-0000-7000-8000-000000000009';
    const requests: string[] = [];
    let unavailable = true;
    const outer = {
      ...fixture.entry(FILE_ID),
      entry_id: outerId,
      file_id: outerId,
      name: 'outer.zip',
      mime_type: 'application/zip',
      extension: 'zip',
      revision: 7,
      is_archive: true,
    };
    const inner = {
      ...outer,
      entry_id: innerId,
      file_id: innerId,
      parent_entry_id: outerId,
      name: 'nested.7z',
      extension: '7z',
      archive_origin: { archive_id: jobId, source_file_id: outerId, source_revision: 7 },
    };
    const empty = {
      ...fixture.entry(FOLDER_ID),
      entry_id: emptyId,
      parent_entry_id: innerId,
      name: 'empty',
      revision: 7,
      archive_origin: { archive_id: jobId, source_file_id: innerId, source_revision: 7 },
    };
    const path = [
      { entry_id: ROOT_ID, name: 'C:\\', archive_revision: null },
      { entry_id: FOLDER_ID, name: 'Documents', archive_revision: null },
      { entry_id: outerId, name: outer.name, archive_revision: 7 },
      { entry_id: innerId, name: inner.name, archive_revision: 7 },
      { entry_id: emptyId, name: empty.name, archive_revision: 7 },
    ];
    await page.route('**/api/device/files/browse', (route) => {
      const request = route.request().postDataJSON();
      const index = path.findIndex((item) => item.entry_id === request.parent_entry_id);
      return route.fulfill({
        json: {
          entries: [[fixture.entry(FOLDER_ID)], [outer], [inner], [empty], []][index],
          breadcrumbs: path.slice(0, index + 1),
          archive_source:
            index < 2
              ? null
              : { device_id: DEVICE_ID, file_id: index === 2 ? outerId : innerId, revision: 7 },
          next_cursor: null,
        },
      });
    });
    await page.route('**/revisions/7/archive', (route) =>
      route.fulfill({
        json: {
          source: {
            device_id: DEVICE_ID,
            file_id: route.request().url().includes(outerId) ? outerId : innerId,
            revision: 7,
          },
          archive: {
            archive_id: jobId,
            root_entry_id: outerId,
            state: 'ready',
            reason: null,
            message: null,
            limit_name: null,
          },
          next_attempt_at: null,
          poll_after_ms: 2000,
          updated_at: NOW,
        },
      }),
    );
    await page.route(`**/api/device/files/${DEVICE_ID}/*/revisions/*/content`, (route) => {
      requests.push(`${route.request().method()} ${route.request().url()}`);
      expect(route.request().url()).toContain(`/${innerId}/revisions/7/content`);
      if (unavailable)
        return route.fulfill({ status: 503, json: { message: 'Сховище тимчасово недоступне' } });
      return route.fulfill({
        contentType: 'application/octet-stream',
        headers: {
          'Content-Disposition': 'attachment; filename="nested.7z"',
          'Content-Length': '4',
        },
        body: route.request().method() === 'HEAD' ? undefined : '7zBC',
      });
    });
    const href = `/devices/${DEVICE_ID}/files?directory=${emptyId}&directory_revision=7`;
    await page.goto(href);
    await expect(
      page.getByText('За заданими фільтрами нічого не знайдено.', { exact: true }),
    ).toBeVisible();
    const button = page.getByRole('button', { name: 'Скачати початковий архів', exact: true });
    await button.click();
    await expect(page.getByRole('alert')).toContainText('Помилка скачування файлу');
    expect(requests).toHaveLength(1);
    await expect(button).toBeEnabled();
    unavailable = false;
    await page.reload();
    await button.click();
    await expect(page.locator('html')).toHaveAttribute(
      'data-native-download',
      `/api/device/files/${DEVICE_ID}/${innerId}/revisions/7/content`,
    );
    expect(requests.map((request) => request.split(' ')[0])).toEqual(['HEAD', 'HEAD']);
    await expect(page).toHaveURL(href);
    const breadcrumbs = page.getByRole('navigation', { name: 'Шлях до папки', exact: true });
    await expect(breadcrumbs.locator('[aria-current="page"]')).toHaveText('empty');
    await expect(
      page.getByText('За заданими фільтрами нічого не знайдено.', { exact: true }),
    ).toBeVisible();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
      .toBe(true);
    await breadcrumbs
      .locator('../..')
      .screenshot({ path: testInfo.outputPath('archive-download.png') });
  });
}

test('@regression #3930 long search paths stay inside table cells and do not block adjacent files', async ({
  page,
}, testInfo) => {
  const { entry } = await installExplorerMocks(page, 'Device Explorer', {
    pendingHasContent: true,
  });
  await page.setViewportSize({ width: 1280, height: 800 });
  const name = 'echo-unsupported-binary-with-a-long-name.txt';
  await page.route('**/api/device/files/search', (route) =>
    route.fulfill({
      json: {
        entries: [FILE_ID, PENDING_ID].map((id) => ({
          ...entry(id),
          name,
          absolute_path: `C:\\Лабораторія #3930\\Довга назва папки для перевірки пошуку\\${id}\\${name}`,
        })),
        next_cursor: null,
      },
    }),
  );
  for (const [id, content] of [
    [FILE_ID, FILE_TEXT],
    [PENDING_ID, NEXT_FILE_TEXT],
  ] as const) {
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    await search.fill(name);
    await search.press('Enter');
    const cards = page.getByRole('table', { name: 'Результати пошуку', exact: true });
    await expect(cards.locator('tr[data-entry-id]')).toHaveCount(2);
    const target = cards.locator(`[data-entry-id="${id}"]`);
    const bounds = await target.boundingBox();
    const titleBounds = await target.getByRole('button', { name, exact: true }).boundingBox();
    expect(titleBounds!.x).toBeGreaterThanOrEqual(bounds!.x);
    expect(titleBounds!.x + titleBounds!.width).toBeLessThanOrEqual(bounds!.x + bounds!.width);
    if (id === FILE_ID) await cards.screenshot({ path: testInfo.outputPath('search-cards.png') });
    await target.getByRole('button', { name: name, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`file=${id}`));
    await expect(page.getByTestId('device-file-content-pane').locator('pre')).toHaveText(content);
  }
});

for (const width of [1440, 390]) {
  test(`@regression #3930 sorting menu and table headers share direction and reset folder and search pagination at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await page.clock.install();
    const fixture = await installExplorerMocks(page);
    const folderId = '018f0000-0000-7000-8000-000000000007';
    const gammaId = '018f0000-0000-7000-8000-000000000006';
    const entries = new Map([
      [
        folderId,
        {
          ...fixture.entry(FOLDER_ID),
          entry_id: folderId,
          parent_entry_id: FOLDER_ID,
          name: 'Nested',
          size_bytes: 13,
        },
      ],
      ...[
        [FILE_ID, 'alpha.txt', 20],
        [PENDING_ID, 'beta.txt', 5],
        [gammaId, 'gamma.txt', 10],
      ].map(
        ([id, name, size]) =>
          [
            String(id),
            {
              ...fixture.entry(FILE_ID),
              entry_id: String(id),
              file_id: String(id),
              name: String(name),
              path_components: ['Documents', String(name)],
              size_bytes: Number(size),
            },
          ] as const,
      ),
    ]);
    const orders: Record<string, string[]> = {
      name: [FILE_ID, PENDING_ID, gammaId],
      size: [PENDING_ID, gammaId, FILE_ID],
      uploaded_at: [gammaId, FILE_ID, PENDING_ID],
      created_at: [PENDING_ID, FILE_ID, gammaId],
      modified_at: [FILE_ID, gammaId, PENDING_ID],
    };
    const listingOrder = (field: string, direction = 'ascending', search = false) => {
      const files = [...orders[field]];
      if (search) return direction === 'descending' ? files.reverse() : files;
      if (field === 'size') {
        const entries = [...files.slice(0, 2), folderId, ...files.slice(2)];
        return direction === 'descending' ? entries.reverse() : entries;
      }
      const entries =
        field === 'name' ? [folderId, ...files] : [files[0], folderId, ...files.slice(1)];
      return direction === 'descending' ? entries.reverse() : entries;
    };

    const browseRequests: Record<string, unknown>[] = [];
    const searchRequests: Record<string, unknown>[] = [];
    for (const search of [false, true]) {
      await page.route(`**/api/device/files/${search ? 'search' : 'browse'}`, (route) => {
        const request = route.request().postDataJSON();
        if (!search && request.parent_entry_id !== FOLDER_ID) return route.fallback();
        const field = request.sort_by ?? 'name';
        const ordered = listingOrder(field, request.sort_direction ?? 'ascending', search);
        const offset = request.cursor ? 2 : 0;
        if (search || request.include_breadcrumbs)
          (search ? searchRequests : browseRequests).push(request);
        return route.fulfill({
          json: {
            ...(search
              ? {}
              : {
                  breadcrumbs: [
                    { entry_id: ROOT_ID, name: 'C:\\' },
                    { entry_id: FOLDER_ID, name: 'Documents' },
                  ],
                }),
            entries: ordered.slice(offset, offset + 2).map((id) => entries.get(id)),
            next_cursor:
              offset + 2 < ordered.length ? `${field}:${request.sort_direction}:2` : null,
          },
        });
      });
    }
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const content = page.getByRole('region', { name: 'Вміст папки', exact: true });
    const ids = () =>
      content
        .locator('[data-entry-id]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-entry-id')),
        );
    const sort = page.getByRole('button', { name: 'Сортування файлів', exact: true });
    const toolbar = sort.locator('..');
    await expect
      .poll(() =>
        toolbar
          .getByRole('button')
          .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label'))),
      )
      .toEqual(['Фільтри файлів', 'Сортування файлів', 'Плитка', 'Список']);
    const choose = async (label: string) => {
      await page.clock.fastForward(450);
      await sort.click();
      const menu = page.getByRole('menu', { name: 'Сортування файлів', exact: true });
      await expect(menu.getByRole('menuitemradio')).toHaveText([
        'Назва',
        'Розмір',
        'Дата завантаження',
        'Дата створення',
        'Дата зміни',
      ]);
      await expect(menu.locator('[aria-checked="true"]')).toHaveCount(1);
      await menu.getByRole('menuitemradio', { name: label, exact: true }).click();
      await expect(menu).toBeHidden();
    };
    await expect.poll(ids).toEqual(listingOrder('name'));
    await expect(content.getByRole('button', { name: 'Завантажити ще', exact: true })).toHaveCount(
      0,
    );
    for (const [field, label] of [
      ['size', 'Розмір'],
      ['uploaded_at', 'Дата завантаження'],
      ['created_at', 'Дата створення'],
      ['modified_at', 'Дата зміни'],
      ['name', 'Назва'],
    ]) {
      await choose(label);
      await expect.poll(ids).toEqual(listingOrder(field));
      expect(browseRequests.at(-2)).toMatchObject({
        sort_by: field,
        sort_direction: 'ascending',
        cursor: null,
      });
      await expect(sort).toHaveAttribute('aria-description', `${label}: за зростанням`);
      expect(browseRequests.at(-1)).toMatchObject({
        sort_by: field,
        sort_direction: 'ascending',
        cursor: `${field}:ascending:2`,
      });
      await choose(label);
      await expect.poll(ids).toEqual(listingOrder(field, 'descending'));
      expect(browseRequests.at(-2)).toMatchObject({
        sort_by: field,
        sort_direction: 'descending',
        cursor: null,
      });
      await expect(sort).toHaveAttribute('aria-description', `${label}: за спаданням`);
    }
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const table = content.getByRole('table', { name: 'Файли та папки' });
    await expect(table).toBeVisible();
    await expect(
      table.locator(`[data-entry-id="${folderId}"]`).getByRole('cell').nth(6),
    ).toHaveText('13 Б');
    await expect.poll(ids).toEqual(listingOrder('name', 'descending'));
    await expect(table.getByRole('columnheader', { name: 'Назва', exact: true })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    for (const label of ['Перегляд', 'Обране', 'Тип', 'Теги'])
      await expect(
        table.getByRole('columnheader', { name: label, exact: true }).getByRole('button'),
      ).toHaveCount(0);
    for (const [field, label] of [
      ['size', 'Розмір'],
      ['uploaded_at', 'Дата завантаження'],
      ['created_at', 'Дата створення'],
      ['modified_at', 'Дата зміни'],
      ['name', 'Назва'],
    ]) {
      const header = table.getByRole('columnheader', { name: label, exact: true });
      const button = header.getByRole('button', { name: label, exact: true });
      await button.click();
      await expect.poll(ids).toEqual(listingOrder(field));
      await expect(header).toHaveAttribute('aria-sort', 'ascending');
      await expect(table.locator('th[aria-sort]')).toHaveCount(1);
      await expect(sort).toHaveAttribute('aria-description', `${label}: за зростанням`);
      expect(browseRequests.at(-2)).toMatchObject({
        sort_by: field,
        sort_direction: 'ascending',
        cursor: null,
      });
      if (field === 'size') await button.press('Enter');
      else await button.click();
      await expect.poll(ids).toEqual(listingOrder(field, 'descending'));
      await expect(header).toHaveAttribute('aria-sort', 'descending');
      await expect(sort).toHaveAttribute('aria-description', `${label}: за спаданням`);
      expect(browseRequests.at(-2)).toMatchObject({
        sort_by: field,
        sort_direction: 'descending',
        cursor: null,
      });
      await page.clock.fastForward(450);
      await sort.click();
      const menu = page.getByRole('menu', { name: 'Сортування файлів', exact: true });
      await expect(menu.getByRole('menuitemradio', { name: label, exact: true })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await expect(menu.getByRole('menuitemradio', { name: label, exact: true })).toHaveAttribute(
        'aria-description',
        'За спаданням',
      );
      await page.keyboard.press('Escape');
      await expect(sort).toBeFocused();
    }
    const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
    await search.fill('txt');
    await search.press('Enter');
    const results = page.getByRole('table', { name: 'Результати пошуку', exact: true });
    await expect(results.locator('[data-entry-id]')).toHaveCount(3);
    await expect(sort).toBeHidden();
    expect(searchRequests.at(-2)).toMatchObject({
      name_query: 'txt',
      rank_by_relevance: true,
      scope_entry_id: FOLDER_ID,
      cursor: null,
    });
    await page.getByRole('button', { name: 'Завершити пошук', exact: true }).click();
    await expect(table).toBeVisible();
    await expect(table.getByRole('columnheader', { name: 'Назва', exact: true })).toHaveAttribute(
      'aria-sort',
      'descending',
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
  });
}

for (const width of [1440, 390]) {
  test(`@regression #3930 list column resizing preserves sorting and browser preferences at ${width}px`, async ({
    page,
  }, testInfo) => {
    await installExplorerMocks(page);
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const table = page.getByRole('table', { name: 'Файли та папки', exact: true });
    const headers = table.locator('thead th');
    const widths = () =>
      headers.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().width),
      );
    const header = (label: string) => table.getByRole('columnheader', { name: label, exact: true });
    const handle = (label: string) =>
      table.getByRole('separator', { name: `Змінити ширину колонки «${label}»`, exact: true });
    await expect(table.getByRole('separator')).toHaveCount(9);
    const initial = await widths();
    const nameHandle = handle('Назва');
    await nameHandle.scrollIntoViewIfNeeded();
    const bounds = (await nameHandle.boundingBox())!;
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.down();
    await page.mouse.move(bounds.x + bounds.width / 2 + 80, bounds.y + bounds.height / 2, {
      steps: 8,
    });
    await page.mouse.up();
    await expect.poll(async () => (await widths())[0]).toBeCloseTo(initial[0] + 80, 0);
    const resized = await widths();
    for (let index = 1; index < initial.length; index++)
      expect(resized[index]).toBeCloseTo(initial[index], 0);
    await page.mouse.move(bounds.x + bounds.width / 2 + 95, bounds.y + bounds.height / 2);
    expect((await widths())[0]).toBeCloseTo(resized[0], 0);
    await expect(header('Назва')).toHaveAttribute('aria-sort', 'ascending');

    for (const [index, label] of [
      'Назва',
      'Перегляд',
      'Обране',
      'Дата завантаження',
      'Дата створення',
      'Дата зміни',
      'Розмір',
      'Тип',
      'Теги',
    ].entries()) {
      const separator = handle(label);
      await separator.scrollIntoViewIfNeeded();
      const before = (await widths())[index];
      await separator.press('ArrowRight');
      await expect.poll(async () => (await widths())[index]).toBeCloseTo(before + 10, 0);
      await expect(separator).toBeFocused();
    }
    await nameHandle.press('End');
    const maximum = (await widths())[0];
    await nameHandle.press('ArrowRight');
    expect((await widths())[0]).toBeCloseTo(maximum, 0);
    await nameHandle.press('Home');
    const minimum = (await widths())[0];
    expect(minimum).toBeLessThan(initial[0]);
    await nameHandle.press('ArrowLeft');
    expect((await widths())[0]).toBeCloseTo(minimum, 0);
    await nameHandle.dblclick();
    await expect.poll(async () => (await widths())[0]).toBeCloseTo(initial[0], 0);
    await expect(header('Назва')).toHaveAttribute('aria-sort', 'ascending');
    const saved = await widths();
    const expectSavedWidths = async () => {
      await expect(table).toBeVisible();
      await expect
        .poll(async () =>
          (await widths()).every((value, index) => Math.abs(value - saved[index]) < 1),
        )
        .toBe(true);
    };
    await page.getByRole('button', { name: 'Плитка', exact: true }).click();
    await expect(table).toHaveCount(0);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    await expectSavedWidths();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Список', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expectSavedWidths();
    await header('Назва').getByRole('button', { name: 'Назва', exact: true }).click();
    await expect(header('Назва')).toHaveAttribute('aria-sort', 'descending');
    await expectSavedWidths();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.screenshot({
      path: testInfo.outputPath(`resized-file-columns-${width}.png`),
      animations: 'disabled',
    });
  });
}

for (const width of [1440, 390]) {
  test(`@regression #3930 view mode survives reloads and toolbar dots stay separate from open controls at ${width}px`, async ({
    page,
  }) => {
    await page.clock.install();
    await installExplorerMocks(page);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const filter = page.getByRole('button', { name: 'Фільтри файлів', exact: true });
    const sort = page.getByRole('button', {
      name: 'Сортування файлів',
      exact: true,
      includeHidden: true,
    });
    const filterDot = filter.locator('.MuiBadge-badge');
    const sortDot = sort.locator('.MuiBadge-badge');
    await expect(filter).not.toHaveClass(/MuiIconButton-colorPrimary/);
    await expect(filterDot).toHaveClass(/MuiBadge-invisible/);
    await expect(sort).not.toHaveClass(/MuiIconButton-colorPrimary/);
    await expect(sortDot).toHaveClass(/MuiBadge-invisible/);
    await filter.click();
    await expect(filter).toHaveClass(/MuiIconButton-colorPrimary/);
    const panel = page.getByRole('form', { name: 'Фільтри файлів', exact: true });
    await panel.getByRole('button', { name: 'Скинути фільтри', exact: true }).click();
    await expect(filterDot).toHaveClass(/MuiBadge-invisible/);
    const includeMissing = panel.getByRole('checkbox', {
      name: 'Показувати файли без контенту',
      exact: true,
    });
    await includeMissing.check();
    await expect(filterDot).not.toHaveClass(/MuiBadge-invisible/);
    await includeMissing.uncheck();
    await expect(filterDot).toHaveClass(/MuiBadge-invisible/);
    await panel.getByRole('checkbox', { name: 'Тільки обране', exact: true }).check();
    await expect(filterDot).not.toHaveClass(/MuiBadge-invisible/);
    await page.clock.runFor(450);
    await filter.click();
    await expect(filter).not.toHaveClass(/MuiIconButton-colorPrimary/);
    await expect(filterDot).not.toHaveClass(/MuiBadge-invisible/);
    await sort.click();
    await expect(sort).toHaveClass(/MuiIconButton-colorPrimary/);
    const menu = page.getByRole('menu', { name: 'Сортування файлів', exact: true });
    await menu.getByRole('menuitemradio', { name: 'Розмір', exact: true }).click();
    await expect(sort).not.toHaveClass(/MuiIconButton-colorPrimary/);
    await expect(sortDot).not.toHaveClass(/MuiBadge-invisible/);
    await page.clock.runFor(450);
    await sort.click();
    await expect(sort).toHaveClass(/MuiIconButton-colorPrimary/);
    await page.keyboard.press('Escape');
    await expect(sort).not.toHaveClass(/MuiIconButton-colorPrimary/);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Список', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('table', { name: 'Файли та папки' })).toBeVisible();
    await page.getByRole('button', { name: 'Плитка', exact: true }).click();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Плитка', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(page.getByRole('list', { name: 'Файли та папки' })).toBeVisible();
  });
}

for (const width of [1440, 390]) {
  test(`@regression #3930 list tags stay on one line and reveal full names on hover at ${width}px`, async ({
    page,
  }, testInfo) => {
    const fixture = await installExplorerMocks(page);
    const tags = [
      { ...TAG, name: 'Демонстрація' },
      ...['Файли', 'Візів', 'Відео', 'Аудіо', 'Документи', 'Дані'].map((name, index) => ({
        id: `018f0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
        name,
      })),
    ];
    const longName = 'ДужеДовгаНазваТегу'.repeat(12);
    const plainId = '018f0000-0000-7000-8000-000000000090';
    await page.route('**/api/device/files/browse', (route) => {
      const request = route.request().postDataJSON();
      if (request.parent_entry_id !== FOLDER_ID) return route.fallback();
      return route.fulfill({
        json: {
          entries: [
            { ...fixture.entry(FILE_ID), name: 'tagged.txt', tags },
            {
              ...fixture.entry(FILE_ID),
              entry_id: PENDING_ID,
              file_id: PENDING_ID,
              name: 'long-tag.txt',
              tags: [{ ...TAG, name: longName }],
            },
            {
              ...fixture.entry(FILE_ID),
              entry_id: plainId,
              file_id: plainId,
              name: 'plain.txt',
              tags: [],
            },
          ],
          next_cursor: null,
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:\\' },
            { entry_id: FOLDER_ID, name: 'Documents' },
          ],
        },
      });
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const table = page.getByRole('table', { name: 'Файли та папки', exact: true });
    const row = (id: string) => table.locator(`tbody tr[data-entry-id="${id}"]`);
    const cell = (id: string) => row(id).getByRole('cell').nth(8);
    const badges = (id: string) => cell(id).locator('[data-file-tag-visible]');
    const overflow = (id: string) => cell(id).locator('[data-file-tag-overflow]');
    const resize = table.getByRole('separator', {
      name: 'Змінити ширину колонки «Теги»',
      exact: true,
    });
    await resize.press('ArrowRight');
    await expect(badges(FILE_ID)).toHaveCount(3);
    await expect(badges(FILE_ID)).toHaveText(tags.slice(0, 3).map((tag) => tag.name));
    await expect(overflow(FILE_ID)).toHaveText('+4');
    await expect(row(plainId)).toBeVisible();
    const baselineHeight = (await row(plainId).boundingBox())!.height;
    const assertHeights = async () => {
      for (const id of [FILE_ID, PENDING_ID]) {
        await expect
          .poll(async () => Math.abs((await row(id).boundingBox())!.height - baselineHeight))
          .toBeLessThan(1);
      }
    };
    await assertHeights();
    await resize.press('Home');
    await expect(badges(FILE_ID)).toHaveCount(1);
    await expect(overflow(FILE_ID)).toHaveText('+6');
    await expect(overflow(PENDING_ID)).toHaveCount(0);
    for (const [id, names] of [
      [FILE_ID, tags.map((tag) => tag.name).join(', ')],
      [PENDING_ID, longName],
    ]) {
      const summary = cell(id).locator('[data-file-tag-summary]');
      const label = badges(id).first().locator('.echo-chip__label');
      await summary.scrollIntoViewIfNeeded();
      await expect.poll(() => label.evaluate((e) => e.scrollWidth > e.clientWidth)).toBe(true);
      await expect(label).toHaveCSS('white-space', 'nowrap');
      await expect(label).toHaveCSS('text-overflow', 'ellipsis');
      await summary.hover();
      const tooltip = page.getByRole('tooltip');
      await expect(tooltip).toHaveText(names);
      await page.keyboard.press('Escape');
      await expect(tooltip).toBeHidden();
      await page.mouse.move(0, 0);
    }
    await assertHeights();
    await expect(cell(plainId)).toHaveText('—');
    await resize.press('End');
    await expect(badges(FILE_ID)).toHaveCount(3);
    await expect(overflow(FILE_ID)).toHaveText('+4');
    for (const label of await badges(FILE_ID).locator('.echo-chip__label').all()) {
      await expect.poll(() => label.evaluate((e) => e.scrollWidth <= e.clientWidth)).toBe(true);
    }
    await assertHeights();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await resize.dblclick();
    await resize.press('ArrowRight');
    await expect(badges(FILE_ID)).toHaveCount(3);
    await expect(overflow(FILE_ID)).toHaveText('+4');
    await cell(FILE_ID).locator('[data-file-tag-summary]').hover();
    await expect(page.getByRole('tooltip')).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`file-tag-badges-${width}.png`),
      animations: 'disabled',
    });
  });
}

for (const width of [1440, 390]) {
  test(`@regression #3930 file filters update the tree and folder immediately at ${width}px`, async ({
    page,
  }) => {
    await page.clock.install();
    const fixture = await installExplorerMocks(page);
    await page.setViewportSize({ width, height: 1000 });
    const photo = {
      ...fixture.entry(PENDING_ID),
      name: 'photo.jpg',
      extension: 'jpg',
      mime_type: 'image/jpeg',
      has_content: true,
    };
    const sheet = {
      ...fixture.entry(PENDING_ID),
      entry_id: '018f0000-0000-7000-8000-000000000099',
      file_id: '018f0000-0000-7000-8000-000000000099',
      name: 'data.csv',
      extension: 'csv',
      mime_type: 'text/csv',
      has_content: true,
    };
    const report = { ...fixture.entry(FILE_ID), is_favorite: true, is_viewed: true };
    const extraRoot = '018f0000-0000-7000-8000-000000000098';
    await page.route('**/api/device/files/roots', async (route) => {
      const filters = route.request().postDataJSON().filters;
      const filtered =
        filters &&
        (filters.favorites_only ||
          filters.unviewed_only ||
          filters.archive_failed ||
          filters.archive_encrypted ||
          filters.file_types.length ||
          filters.extensions.length ||
          filters.tag_ids.length ||
          filters.untagged);
      await new Promise((resolve) => setTimeout(resolve, 30));
      const root = {
        ...fixture.entry(FOLDER_ID),
        entry_id: ROOT_ID,
        device_id: DEVICE_ID,
        parent_entry_id: null,
        name: 'C:\\',
      };
      await route.fulfill({
        json: { roots: filtered ? [root] : [root, { ...root, entry_id: extraRoot, name: 'D:\\' }] },
      });
    });
    const requests: any[] = [];
    await page.route('**/api/device/files/filter-options', (route) =>
      route.fulfill({ json: { extensions: ['txt', 'jpg', 'csv'] } }),
    );
    await page.route('**/api/device/files/browse', (route) => {
      const request = route.request().postDataJSON();
      requests.push(request);
      const filters = request.filters;
      let entries =
        request.parent_entry_id === FOLDER_ID
          ? [report, photo, sheet]
          : request.parent_entry_id === ROOT_ID
            ? [fixture.entry(FOLDER_ID)]
            : [];
      if (request.parent_entry_id === FOLDER_ID && filters) {
        if (filters.favorites_only) entries = [report];
        else if (filters.unviewed_only) entries = [photo, sheet];
        else if (filters.archive_failed || filters.archive_encrypted) entries = [];
        else if (filters.file_types.length || filters.extensions.length) entries = [photo, sheet];
        else if (filters.tag_ids.length) entries = [report];
        else if (filters.untagged) entries = [photo, sheet];
      }
      return route.fulfill({
        json: {
          breadcrumbs: [
            { entry_id: ROOT_ID, name: 'C:\\' },
            ...(request.parent_entry_id === FOLDER_ID
              ? [{ entry_id: FOLDER_ID, name: 'Documents' }]
              : []),
          ],
          entries,
          next_cursor: null,
        },
      });
    });
    await page.goto(`/devices/${DEVICE_ID}/files?directory=${FOLDER_ID}`);
    const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
    await page.getByRole('button', { name: 'Фільтри файлів', exact: true }).click();
    const panel = page.getByRole('form', { name: 'Фільтри файлів', exact: true });
    await expect(panel.getByLabel('MIME-типи')).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Застосувати', exact: true })).toHaveCount(0);
    const expectEntries = async (names: string[]) => {
      for (const name of ['report.txt', 'photo.jpg', 'data.csv'])
        await expect(
          folder.getByRole('button', { name: `Відкрити файл ${name}`, exact: true }),
        ).toHaveCount(names.includes(name) ? 1 : 0);
      if (width < 1000) await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
      const tree = page.getByTestId('device-files-tree');
      for (const name of ['report.txt', 'photo.jpg', 'data.csv'])
        await expect(tree.getByText(name, { exact: true })).toHaveCount(
          names.includes(name) ? 1 : 0,
        );
      if (width < 1000) await page.keyboard.press('Escape');
    };
    for (const [label, names, key] of [
      ['Тільки обране', ['report.txt'], 'favorites_only'],
      ['Тільки непереглянуті', ['photo.jpg', 'data.csv'], 'unviewed_only'],
      ['З помилкою розпакування', [], 'archive_failed'],
      ['Захищені паролем', [], 'archive_encrypted'],
    ] as const) {
      await panel.getByRole('checkbox', { name: label, exact: true }).check();
      await expectEntries([...names]);
      await expect
        .poll(
          () =>
            requests.filter(
              (request) => request.parent_entry_id === FOLDER_ID && request.filters?.[key],
            ).length,
        )
        .toBe(1);
      await page.clock.runFor(450);
      await panel.getByRole('button', { name: 'Скинути фільтри', exact: true }).click();
      await expectEntries(['report.txt', 'photo.jpg', 'data.csv']);
    }
    const types = panel.getByRole('combobox', { name: 'Типи файлів', exact: true });
    await types.click();
    await page.getByRole('option', { name: 'Зображення', exact: true }).click();
    await page.getByRole('option', { name: 'Таблиці', exact: true }).click();
    await page.keyboard.press('Escape');
    await expectEntries(['photo.jpg', 'data.csv']);
    expect(requests.at(-1).filters.file_types).toEqual(['image', 'spreadsheet']);
    await page.clock.runFor(450);
    await panel.getByRole('button', { name: 'Скинути фільтри', exact: true }).click();
    const extensions = panel.getByRole('combobox', { name: 'Розширення', exact: true });
    await extensions.click();
    await page.getByRole('option', { name: 'jpg', exact: true }).click();
    await page.getByRole('option', { name: 'csv', exact: true }).click();
    await page.keyboard.press('Escape');
    await expectEntries(['photo.jpg', 'data.csv']);
    expect(requests.at(-1).filters.extensions).toEqual(['jpg', 'csv']);
    await expect(panel.locator('.MuiChip-root').first()).toHaveCSS('font-size', '13px');
    await page.clock.runFor(450);
    await panel.getByRole('button', { name: 'Скинути фільтри', exact: true }).click();
    await panel.getByRole('checkbox', { name: 'Без тегів', exact: true }).check();
    await expectEntries(['photo.jpg', 'data.csv']);
  });
}
