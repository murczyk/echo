import { openDeviceSection } from './device-pages.ui';
import { readFile } from 'node:fs/promises';
import { createServer, request as proxyRequest } from 'node:http';
import { expect, test, type Page, type Route } from '@playwright/test';
import { emptyNetworksListResponse, emptyUnitsListResponse } from './fixture-responses';

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

test('@regression #3928 overview shows static tags without filters and keeps navigation usable across layouts', async ({
  page,
}, testInfo) => {
  await installMocks(page);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const tags = Array.from({ length: 16 }, (_, index) => ({
    id: `018f0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`,
    name: index === 0 ? 'Бойові документи' : `Аналітичний тег ${index + 1}`,
  }));
  let tagFileRequests = 0;
  const extensions = [
    { extension: 'pdf', content_count: 127, content_bytes: 861000000 },
    { extension: 'xlsx', content_count: 127, content_bytes: 77000000 },
    { extension: 'zip', content_count: 38, content_bytes: 22000000 },
  ];
  await page.route('**/api/device/analytics/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/tags')) return fulfillJson(route, { tags });
    if (path.endsWith('/files')) {
      tagFileRequests += 1;
      return fulfillJson(route, { files: [], next_cursor: null });
    }
    if (path.endsWith('/summary'))
      return fulfillJson(route, {
        total_file_count: 292,
        files_with_content_count: 292,
        analyzed_file_count: 258,
        stats: {
          directory_count: 49,
          file_count: 292,
          content_count: 292,
          content_bytes: 960000000,
          first_content_at: NOW,
          last_content_at: NOW,
          content_pending: false,
          backfilled_at: NOW,
          extensions,
          days: extensions.map((entry) => ({ day: '2026-07-24', ...entry })),
        },
        items: tags.map((tag) => ({ tag, file_count: 53, latest_file_entry_created_at: NOW })),
      });
    return route.fallback();
  });
  await page.setViewportSize({ width: 1770, height: 1328 });
  await page.goto(`/devices/${DEVICE_ID}`);
  const overview = page.getByTestId('device-details-overview');
  const activity = page.getByTestId('device-analytics-activity');
  const activityToggle = activity.getByRole('button', { name: /Статистика завантажень/ });
  const breadcrumbs = page.getByRole('navigation', { name: 'Навігаційний шлях пристрою' });
  await expect(breadcrumbs.getByRole('link')).toHaveText(['Device Alpha']);
  await expect(breadcrumbs.getByRole('link')).toHaveAttribute('aria-current', 'page');
  await expect(overview.getByRole('button', { name: 'Основне', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
  await activityToggle.click();
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'false');
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('overview-collapsed-dark.png'),
  });
  await overview.getByRole('button', { name: 'Основне', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(overview.getByRole('button', { name: 'Основне', exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(overview.getByText('Device Alpha', { exact: true })).toBeInViewport();
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('overview-expanded-dark.png'),
  });
  await overview.getByRole('button', { name: 'Основне', exact: true }).click();
  await activityToggle.click();
  await expect(page.getByRole('img', { name: 'Завантаження файлів за днями' })).toBeVisible();
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('overview-days-dark.png'),
  });
  for (const [label, chart] of [
    ['За кількістю', 'Кількість файлів за типами'],
    ['За розміром', 'Розмір файлів за типами'],
  ]) {
    await page.getByRole('button', { name: label, exact: true }).click();
    await expect(page.getByRole('img', { name: chart })).toBeVisible();
    await expect(page.getByRole('list', { name: 'Типи файлів' })).toContainText('.pdf');
  }
  await page.screenshot({
    animations: 'disabled',
    path: testInfo.outputPath('overview-size-dark.png'),
  });
  await expect(page.getByTestId('device-analytics-progress')).toContainText('292/292');
  await expect(page.getByTestId('device-analytics-progress')).toContainText('Завантажено аудіо73');
  await page.getByRole('button', { name: 'Аудіо', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Завантаження аудіо за днями' })).toBeVisible();
  await expect(activity).toContainText('Аудіо');
  await page.getByRole('button', { name: 'За днями', exact: true }).click();
  for (const width of [1770, 1280, 1024, 768, 390, 360]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-bs-theme', theme),
        theme,
      );
      await expect(
        page.getByRole('region', { name: 'Відомості пристрою', exact: true }),
      ).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Аналітика файлів' })).toHaveCount(0);
      await expect(page.getByTestId('device-sync-sessions-sidebar')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /праву панель/ })).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Сесії', exact: true })).toHaveCount(0);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      expect(
        await page
          .getByTestId('device-details-content')
          .evaluate((node) => node.scrollWidth <= node.clientWidth),
      ).toBe(true);
      await page.locator('#device-details-analytical-panel').evaluate((node) => {
        node.scrollTop = 0;
      });
      await page.screenshot({
        animations: 'disabled',
        path: testInfo.outputPath(`overview-${width}-${theme}.png`),
      });
    }
  }
  await page.setViewportSize({ width: 1280, height: 1000 });
  const tagList = page.getByRole('list', { name: 'Аналітичні теги', exact: true });
  await expect(tagList.getByRole('listitem')).toHaveCount(16);
  await expect(tagList.getByRole('button')).toHaveCount(0);
  await expect(tagList.getByRole('link')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Фільтр за тегами' })).toHaveCount(0);
  await tagList.getByRole('listitem').filter({ hasText: 'Бойові документи' }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}`);
  expect(tagFileRequests).toBe(0);
  await openDeviceSection(page, 'Журнал');
  await expect(page.getByRole('table', { name: 'Журнал синхронізації файлів' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Фільтр за тегами' })).toBeVisible();
  await page.getByLabel('Без тегів', { exact: true }).check();
  await openDeviceSection(page, 'Пристрій');
  await expect(page.getByRole('region', { name: 'Фільтр за тегами' })).toHaveCount(0);
  await expect(tagList.getByRole('listitem')).toHaveCount(16);
  await openDeviceSection(page, 'Аудіо');
  await expect(page.getByTestId('device-audio-tab')).toBeVisible();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const [label, suffix] of [
      ['Файли', 'files'],
      ['Журнал', 'journal'],
      ['Аудіо', 'audio'],
    ]) {
      await openDeviceSection(page, label);
      await expect(page).toHaveURL(new RegExp(`/devices/${DEVICE_ID}/${suffix}\\?untagged=1$`));
      await expect(page.getByRole('navigation', { name: 'Меню пристрою' })).toHaveCount(0);
      await expect(page.getByTestId('device-details-content').getByRole('tab')).toHaveCount(0);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await expect(page.getByRole('button', { name: 'До пристрою', exact: true })).toBeVisible();
      await expect(breadcrumbs.getByRole('link')).toHaveText(['Device Alpha', label]);
      await expect(breadcrumbs.getByRole('link', { name: label, exact: true })).toHaveAttribute(
        'aria-current',
        'page',
      );
      const deviceLink = breadcrumbs.getByRole('link', { name: 'Device Alpha', exact: true });
      await expect(deviceLink).toHaveAttribute('href', `/devices/${DEVICE_ID}?untagged=1`);
      await deviceLink.click();
      await expect(page).toHaveURL(`/devices/${DEVICE_ID}?untagged=1`);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`/devices/${DEVICE_ID}/${suffix}\\?untagged=1$`));
      if (suffix === 'files') {
        await expect(
          page.getByRole('button', {
            name: width === 390 ? 'Сесії' : 'Розгорнути праву панель',
            exact: true,
          }),
        ).toBeVisible();
      } else {
        await expect(page.getByTestId('device-sync-sessions-sidebar')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /праву панель/ })).toHaveCount(0);
        await expect(page.getByRole('button', { name: 'Сесії', exact: true })).toHaveCount(0);
      }
    }
  }
  await page.getByRole('button', { name: 'До пристрою', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Меню пристрою' })).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`/devices/${DEVICE_ID}/audio\\?untagged=1$`));
  await expect(page.getByRole('navigation', { name: 'Меню пристрою' })).toHaveCount(0);
  await page.goForward();
  await expect(page.getByRole('navigation', { name: 'Меню пристрою' })).toBeVisible();
  let audioUnavailable = true;
  let uploadedCount = 73;
  await page.route('**/api/device/audio/activity', (route) =>
    audioUnavailable
      ? route.fulfill({ status: 500, json: { message: 'Audio statistics unavailable' } })
      : fulfillJson(route, {
          uploaded_count: uploadedCount,
          days: uploadedCount
            ? [{ day: '2026-07-24', content_count: uploadedCount, content_bytes: 1024 }]
            : [],
        }),
  );
  await page.reload({ waitUntil: 'domcontentloaded' });
  const audioCard = page
    .getByText('Завантажено аудіо', { exact: true })
    .locator('..')
    .locator('..');
  await expect(audioCard).toContainText('—');
  await expect(audioCard).not.toContainText('73');
  await expect(page.getByTestId('device-analytics-progress')).toContainText('292/292');
  audioUnavailable = false;
  await audioCard.getByRole('button', { name: 'Повторити', exact: true }).click();
  await expect(audioCard).toContainText('73');
  uploadedCount = 0;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(audioCard).toContainText('0');
  await expect(activityToggle).toHaveAttribute('aria-expanded', 'true');
  await page.getByRole('button', { name: 'Аудіо', exact: true }).click();
  await expect(page.getByText('Завантажених аудіо ще немає.', { exact: true })).toBeVisible();
  expect(errors).toEqual([]);
});

test('@smoke @regression #3390 #3928 restores file session and tag-filter history', async ({
  page,
}, testInfo) => {
  await installMocks(page);
  const syncIds = ['018f0000-0000-7000-8000-000000000021', '018f0000-0000-7000-8000-000000000022'];
  const sessions = syncIds.map((id, index) => ({
    sync_id: id,
    device_id: DEVICE_ID,
    mode: 'automatic',
    status: 'completed',
    analysis_run_id: null,
    next_batch_index: 1,
    counts: { received: 2, accepted: 2, created: 2, updated: 0, rejected: 0 },
    created_at: `2026-09-21T1${index}:00:00Z`,
    updated_at: `2026-09-21T1${index}:01:00Z`,
    completed_at: `2026-09-21T1${index}:01:00Z`,
    expires_at: null,
  }));
  const scopes: Array<{ path: string; syncId: string | null; untagged: boolean | null }> = [];
  await page.route('**/api/device/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON();
    if (path.endsWith('/sessions/list')) return fulfillJson(route, { sessions, next_cursor: null });
    if (path.endsWith('/sessions/get'))
      return fulfillJson(route, {
        sync: sessions.find((session) => session.sync_id === body.sync_id),
      });
    if (path.endsWith('/sessions/summaries'))
      return fulfillJson(route, {
        summaries: body.sync_ids.map((id: string) => ({
          sync_id: id,
          analysis: {
            total_file_count: 2,
            files_with_content_count: 1,
            analyzed_file_count: 2,
            items: [],
          },
        })),
      });
    if (/\/(roots|browse|search|journal|summary|files|subtree-counts)$/.test(path))
      scopes.push({ path, syncId: body.sync_id ?? null, untagged: body.untagged ?? null });
    return route.fallback();
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(`/devices/${DEVICE_ID}?sync_id=${syncIds[0]}&keep=1`);
  const uploadStats = page.getByTestId('device-analytics-activity');
  await expect(uploadStats.getByRole('button', { name: /Статистика завантажень/ })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(uploadStats).toContainText('Аудіо за весь час');
  await expect(uploadStats.getByRole('img', { name: 'Завантаження аудіо за днями' })).toBeVisible();
  await expect(uploadStats.getByRole('button', { name: 'За днями', exact: true })).toHaveCount(0);
  await uploadStats.getByRole('button', { name: /Статистика завантажень/ }).click();
  const right = page.getByTestId('device-sync-sessions-sidebar');
  await expect(right).toHaveCount(0);
  await expect(page.getByRole('button', { name: /праву панель/ })).toHaveCount(0);
  for (const theme of ['light', 'dark']) {
    for (const tab of ['Пристрій', 'Файли', 'Журнал', 'Аудіо']) {
      if (tab === 'Файли')
        await page.goto(`/devices/${DEVICE_ID}/files?sync_id=${syncIds[0]}&keep=1`);
      await openDeviceSection(page, tab);
      await page.evaluate(
        (theme) => document.documentElement.setAttribute('data-bs-theme', theme),
        theme,
      );
      if (tab !== 'Файли') {
        await expect(right).toHaveCount(0);
        await expect(page.getByRole('button', { name: /праву панель/ })).toHaveCount(0);
        continue;
      }
      await expect(right).toBeVisible();
      const left = page.getByTestId('device-files-sidebar');
      const rightBox = await right.boundingBox();
      const center = await page.getByTestId('device-details-content').boundingBox();
      expect(rightBox && center).toBeTruthy();
      expect(center!.x + center!.width).toBeLessThanOrEqual(rightBox!.x);
      await expect(left).toBeVisible();
      const leftBox = await left.boundingBox();
      expect(Math.abs(leftBox!.y - rightBox!.y)).toBeLessThan(2);
      expect(Math.abs(leftBox!.height - rightBox!.height)).toBeLessThan(2);
      expect(await left.evaluate((node) => getComputedStyle(node).backgroundColor)).toBe(
        await right.evaluate((node) => getComputedStyle(node).backgroundColor),
      );
      await page.screenshot({ path: testInfo.outputPath(`sidebars-${theme}.png`) });
    }
  }
  await page.goto(`/devices/${DEVICE_ID}/files?sync_id=${syncIds[0]}&keep=1`);
  await expect(right.locator(`[data-sync-id="${syncIds[0]}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await right.locator(`[data-sync-id="${syncIds[1]}"]`).click();
  await expect(page).toHaveURL(new RegExp(`sync_id=${syncIds[1]}&keep=1`));
  await expect(page).toHaveURL(new RegExp(`/devices/${DEVICE_ID}/files\\?`));
  await page
    .getByRole('navigation', { name: 'Навігаційний шлях пристрою' })
    .getByRole('link', { name: 'Device Alpha', exact: true })
    .click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}?keep=1`);
  await page.goBack();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?sync_id=${syncIds[1]}&keep=1`);
  await expect(page.getByTestId('device-details-navigation')).toHaveCount(0);
  await expect
    .poll(() => scopes.filter((scope) => scope.path.endsWith('/roots')).at(-1)?.syncId)
    .toBe(syncIds[1]);
  await page.getByRole('button', { name: 'Згорнути праву панель' }).click();
  await expect(right).toBeHidden();
  await expect(page).toHaveURL(new RegExp(`sync_id=${syncIds[1]}`));
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`sync_id=${syncIds[0]}`));
  await expect(right).toBeHidden();
  await page.goForward();
  await expect
    .poll(() => scopes.filter((scope) => scope.path.endsWith('/roots')).at(-1)?.syncId)
    .toBe(syncIds[1]);
  await page.reload();
  await expect(right).toBeVisible();
  await expect(right.locator(`[data-sync-id="${syncIds[1]}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const showTagFilters = async () => {
    await page.getByRole('button', { name: 'Показати пошук файлів', exact: true }).click();
    const filters = page.getByRole('button', { name: /додаткові фільтри$/ });
    await expect(filters).toBeVisible();
    if ((await filters.getAttribute('aria-expanded')) !== 'true') await filters.click();
  };
  await showTagFilters();
  const untagged = page.getByLabel('Без тегів', { exact: true });
  await untagged.check();
  await right.getByRole('button', { name: /Усі сесії/ }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?keep=1&untagged=1`);
  await showTagFilters();
  await untagged.uncheck();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?keep=1`);
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`sync_id=${syncIds[1]}`));
  await expect(untagged).toBeChecked();
  await expect
    .poll(() => scopes.filter((scope) => scope.path.endsWith('/browse')).at(-1)?.untagged)
    .toBe(true);
  await page.goForward();
  await expect(untagged).not.toBeChecked();
  await expect
    .poll(() => scopes.filter((scope) => scope.path.endsWith('/browse')).at(-1)?.untagged)
    .toBeNull();
  await page.goBack();
  await expect(untagged).toBeChecked();
  await showTagFilters();
  await untagged.uncheck();
  for (const width of [1280, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    const rightBox = await right.boundingBox();
    const centerBox = await page.getByTestId('device-details-content').boundingBox();
    expect(centerBox!.x + centerBox!.width).toBeLessThanOrEqual(rightBox!.x);
    expect(rightBox!.x + rightBox!.width).toBeLessThanOrEqual(width);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(right).toBeHidden();
  await page.getByRole('button', { name: 'Сесії', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Сесії синхронізації' })).toBeVisible();
  await expect(right).toBeVisible();
  await right.getByRole('button', { name: /Усі сесії/ }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?keep=1`);
  await expect(right).toBeHidden();
  await page.goBack();
  await openDeviceSection(page, 'Журнал');
  await expect
    .poll(() => scopes.filter((scope) => scope.path.endsWith('/journal')).at(-1)?.syncId)
    .toBeNull();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/journal?keep=1`);
  await expect(right).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Сесії', exact: true })).toHaveCount(0);
});

test('@smoke #3390 rejects an invalid files session URL without showing unfiltered results', async ({
  page,
}) => {
  await installMocks(page);
  await page.route('**/api/device/files/sessions/**', (route) => {
    if (route.request().url().endsWith('/list'))
      return fulfillJson(route, { sessions: [], next_cursor: null });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/devices/${DEVICE_ID}/files?sync_id=`);
  const center = page.getByTestId('device-details-content');
  await expect(center.getByRole('alert')).toContainText('Некоректний ідентифікатор сесії');
  await expect(center.locator('#device-details-files-panel')).toHaveCount(0);
  await page.goto(`/devices/${DEVICE_ID}/files?sync_id=018f0000-0000-7000-8000-000000000099`);
  await expect(center.getByRole('alert')).toBeVisible();
  await expect(center.locator('#device-details-files-panel')).toHaveCount(0);
  await center.getByRole('button', { name: 'Показати всі сесії' }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files`);
  await expect(center.locator('#device-details-files-panel')).toBeVisible();
});

test('@regression #3928 ignores session URLs outside files on desktop and mobile', async ({
  page,
}) => {
  await installMocks(page);
  const sessionRequests: string[] = [];
  const scopes: Array<{ path: string; syncId: string | null }> = [];
  await page.route('**/api/device/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/sessions/')) sessionRequests.push(path);
    if (/\/(summary|journal)$/.test(path))
      scopes.push({ path, syncId: route.request().postDataJSON().sync_id ?? null });
    return route.fallback();
  });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const suffix of ['', '/journal', '/audio']) {
      for (const syncId of ['', '018f0000-0000-7000-8000-000000000099']) {
        await page.goto(`/devices/${DEVICE_ID}${suffix}?sync_id=${syncId}&keep=1`);
        const panel =
          suffix === '/audio'
            ? page.getByTestId('device-audio-tab')
            : page.locator(
                suffix === '/journal'
                  ? '#device-details-journal-panel'
                  : '#device-details-analytical-panel',
              );
        await expect(panel).toBeVisible();
        if (suffix !== '/audio') {
          const endpoint = suffix === '/journal' ? '/journal' : '/summary';
          await expect.poll(() => scopes.at(-1)?.path.endsWith(endpoint)).toBe(true);
          expect(scopes.at(-1)?.syncId).toBeNull();
        }
        await expect(page.getByText(/^(Сесія:|Вибрана сесія$)/)).toHaveCount(0);
        await expect(page.getByTestId('device-sync-sessions-sidebar')).toHaveCount(0);
        if (suffix !== '') {
          await expect(
            page
              .getByRole('navigation', { name: 'Навігаційний шлях пристрою' })
              .getByRole('link', { name: 'Device Alpha', exact: true }),
          ).toHaveAttribute('href', `/devices/${DEVICE_ID}?keep=1`);
        }
      }
    }
  }
  expect(sessionRequests).toEqual([]);
  expect(scopes.every((scope) => scope.syncId === null)).toBe(true);
});

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
    rer_report_enabled: false,
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
    hide_networks: false,
    disable_bot_tags: false,
    duty_exclude_menu_enabled: true,
    analysis_aor_filter_enabled: false,
    ai_position_highlights_enabled: false,
    two_factor_auth_enabled: true,
    api_rate_limit_replenish_interval_ms: 500,
    api_rate_limit_burst_size: 5,
    exclude_orbit_other_units: false,
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
  audioForwardingConfigured: boolean;
  submittedCreateName: string | undefined;
  releaseSubtreeCounts: () => void;
};

async function installMocks(page: Page, roles = ['Cyber']): Promise<ApiTracker> {
  let releaseSubtreeCounts: () => void = () => undefined;
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
    audioForwardingConfigured: false,
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
        roles,
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
    if (pathname === '/api/user/author-identities') {
      await fulfillJson(route, { authors: [] });
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
    if (pathname === '/api/device/filter-options') {
      await fulfillJson(route, { aors: [], creators: [], tags: [] });
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
    if (pathname === '/api/device/tags') {
      await fulfillJson(route, []);
      return;
    }
    if (pathname === '/api/device/units') {
      await fulfillJson(route, { units: [] });
      return;
    }
    if (pathname === '/api/sigint/units') {
      await fulfillJson(route, emptyUnitsListResponse());
      return;
    }
    if (pathname === '/api/sigint/network-list') {
      await fulfillJson(route, emptyNetworksListResponse());
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
        audio_forwarding_configured: tracker.audioForwardingConfigured,
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
    if (pathname === '/api/device/audio/forwarding') {
      return fulfillJson(route, { version: null, enabled: false, groups: [] });
    }
    if (pathname === '/api/device/audio/activity') {
      return fulfillJson(route, {
        uploaded_count: 73,
        days: [{ day: '2026-07-24', content_count: 73, content_bytes: 1024 }],
      });
    }
    if (pathname === '/api/device/audio/list') {
      await fulfillJson(route, { audio: [], next_cursor: null });
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
        files_with_content_count: 1,
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

test('@regression #3928 Admin rebuilds device statistics from settings with confirmation and keeps form drafts', async ({
  page,
}) => {
  const tracker = await installMocks(page, ['Admin']);
  const requests: unknown[] = [];
  let listRequests = 0;
  let fail = false;
  let releaseRebuild = () => {};
  await page.route('**/api/device/list', (route) => {
    listRequests += 1;
    return fulfillJson(route, {
      list: [
        {
          id: DEVICE_ID,
          name: 'Device Alpha',
          aors: [],
          unit: null,
          external_url: null,
          custom_fields: {},
          created_by: 'operator',
          archived: false,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
        },
      ],
      total: 1,
      has_more: false,
      status_counts: { active: 1, archived: 0 },
    });
  });
  await page.route('**/api/device/stats/rebuild', async (route) => {
    requests.push(route.request().postDataJSON());
    if (fail) return route.fulfill({ status: 500, json: { message: 'Stats fixture unavailable' } });
    await new Promise<void>((resolve) => {
      releaseRebuild = resolve;
    });
    return fulfillJson(route, {
      directory_count: 7,
      file_count: 66,
      content_count: 64,
      content_bytes: 42000,
      batch_count: 1,
    });
  });
  const label = 'Перерахувати статистику пристрою';
  const drawer = page.locator('.MuiDrawer-paper').filter({
    has: page.getByRole('heading', { name: 'Редагувати пристрій', exact: true }),
  });
  const confirmation = page.getByRole('dialog', {
    name: 'Перерахувати статистику пристрою?',
    exact: true,
  });
  for (const [width, path] of [
    [1280, `/devices/${DEVICE_ID}`],
    [390, '/devices'],
  ] as const) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(path);
    await expect(page.getByRole('button', { name: label, exact: true })).toHaveCount(0);
    await page
      .getByRole('button', {
        name: path === '/devices' ? 'Редагувати' : 'Редагувати пристрій',
        exact: true,
      })
      .click();
    const draft = `Unsaved device ${width}`;
    await drawer.getByRole('textbox', { name: /^Назва/ }).fill(draft);
    const rebuild = drawer.getByRole('button', { name: label, exact: true });
    const previousRequests = requests.length;
    await rebuild.click();
    await expect(confirmation).toBeVisible();
    expect(requests).toHaveLength(previousRequests);
    await confirmation.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(confirmation).toBeHidden();
    expect(requests).toHaveLength(previousRequests);
    await page.waitForTimeout(410);
    await rebuild.click();
    const previousRefresh =
      path === '/devices' ? listRequests : tracker.analyticsSummaryRequestCount;
    await confirmation.getByRole('button', { name: 'Перерахувати', exact: true }).click();
    await expect.poll(() => requests.length).toBe(previousRequests + 1);
    await expect(
      confirmation.getByRole('button', { name: 'Скасувати', exact: true }),
    ).toBeDisabled();
    expect(requests.at(-1)).toEqual({ device_id: DEVICE_ID });
    releaseRebuild();
    await expect(confirmation).toBeHidden();
    await expect(drawer).toContainText('Статистику перераховано: 64 завантажень');
    await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveValue(draft);
    await expect
      .poll(() => (path === '/devices' ? listRequests : tracker.analyticsSummaryRequestCount))
      .toBeGreaterThan(previousRefresh);
  }
  await drawer.getByRole('button', { name: 'Закрити форму', exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await drawer.getByRole('textbox', { name: /^Назва/ }).fill('Keep this draft after a failure');
  fail = true;
  await drawer.getByRole('button', { name: label, exact: true }).click();
  await confirmation.getByRole('button', { name: 'Перерахувати', exact: true }).click();
  await expect(drawer.getByRole('alert')).toContainText('Не вдалося перерахувати статистику');
  await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveValue(
    'Keep this draft after a failure',
  );
});

for (const routeName of ['list', 'details']) {
  test(`@regression #3569 CyberViewer device permissions in ${routeName}`, async ({ page }) => {
    await installMocks(page, ['CyberViewer']);
    await page.route('**/api/device/list', (route) =>
      fulfillJson(route, {
        list: [
          {
            id: DEVICE_ID,
            name: 'Device Alpha',
            aors: [],
            unit: null,
            external_url: null,
            custom_fields: {},
            created_by: 'operator',
            archived: false,
            created_at: NOW,
            updated_at: NOW,
            archived_at: null,
          },
        ],
        total: 1,
        has_more: false,
        status_counts: { active: 1, archived: 0 },
      }),
    );
    await page.goto(routeName === 'list' ? '/devices' : `/devices/${DEVICE_ID}`);
    if (routeName === 'list') {
      await expect(page.getByRole('button', { name: 'Дії', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
    } else {
      await page.getByRole('button', { name: 'Редагувати пристрій', exact: true }).click();
    }
    const drawer = page.locator('.MuiDrawer-paper').filter({
      has: page.getByRole('heading', { name: 'Редагувати пристрій' }),
    });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: 'Перерахувати статистику пристрою', exact: true }),
    ).toHaveCount(0);
    await expect(drawer.getByRole('textbox', { name: 'Зовнішнє посилання' })).toBeEditable();
    await expect(drawer.getByRole('textbox', { name: 'Опис пристрою' })).toBeEditable();
    await expect(drawer.getByRole('combobox', { name: 'Теги', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('button', { name: 'Архівувати', exact: true })).toHaveCount(0);
    await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveCount(0);
    await expect(drawer.getByRole('combobox', { name: 'Смуги' })).toHaveCount(0);
    await expect(drawer.getByRole('combobox', { name: 'Підрозділ' })).toHaveCount(0);
    await expect(drawer.getByLabel('Пересилати нові аудіо в групи')).toHaveCount(0);
  });

  test(`@regression Cyber device metadata permissions in ${routeName}`, async ({ page }) => {
    test.setTimeout(60_000);
    await installMocks(page, ['Cyber']);
    let device = {
      id: DEVICE_ID,
      name: null as string | null,
      aors: [{ id: 1, name: 'Північ' }],
      unit: { id: 7, name: 'Unit Seven' },
      external_url: null,
      custom_fields: {},
      created_by: 'operator',
      archived: false,
      created_at: NOW,
      updated_at: NOW,
      archived_at: null,
    };
    const aors = [
      { id: 1, name: 'Північ' },
      { id: 2, name: 'Південь' },
    ];
    const units = [
      { id: 7, name: 'Unit Seven', active: true },
      { id: 8, name: 'Unit Eight', active: true },
    ];
    const updates: Array<Record<string, unknown>> = [];
    await page.route('**/api/device/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/device/detail') return fulfillJson(route, device);
      if (path === '/api/device/list') {
        return fulfillJson(route, {
          list: [device],
          total: 1,
          has_more: false,
          status_counts: { active: 1, archived: 0 },
        });
      }
      if (path === '/api/device/aors') return fulfillJson(route, aors);
      if (path === '/api/device/units') return fulfillJson(route, { units });
      if (path === '/api/device/archive') {
        device = { ...device, archived: true };
        return fulfillJson(route, device);
      }
      if (path === '/api/device/update') {
        const patch = route.request().postDataJSON();
        updates.push(patch);
        device = {
          ...device,
          name: patch.name ?? device.name,
          aors: patch.aor_ids ? aors.filter((aor) => patch.aor_ids.includes(aor.id)) : device.aors,
          unit: patch.unit_id ? units.find((unit) => unit.id === patch.unit_id)! : device.unit,
        };
        return fulfillJson(route, device);
      }
      return route.fallback();
    });
    const openEditor = async () => {
      if (routeName === 'list') {
        await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
      } else {
        await page.getByRole('button', { name: 'Редагувати пристрій', exact: true }).click();
      }
    };
    await page.goto(routeName === 'list' ? '/devices' : `/devices/${DEVICE_ID}`);
    await openEditor();
    const drawer = page.locator('.MuiDrawer-paper').filter({
      has: page.getByRole('heading', { name: 'Редагувати пристрій' }),
    });
    await expect(drawer).toBeVisible();
    await expect(
      drawer.getByRole('button', { name: 'Перерахувати статистику пристрою', exact: true }),
    ).toHaveCount(0);
    await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveValue('');
    await drawer.getByRole('combobox', { name: 'Смуги' }).fill('Південь');
    await page.getByRole('option', { name: 'Південь' }).click();
    await page.keyboard.press('Escape');
    await drawer.getByRole('combobox', { name: 'Підрозділ' }).fill('Unit Eight');
    await page.getByRole('option', { name: 'Unit Eight' }).click();
    await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(drawer).toBeHidden();
    expect(updates).toEqual([
      {
        device_id: DEVICE_ID,
        aor_ids: [1, 2],
        unit_id: 8,
      },
    ]);
    await page.reload();
    await openEditor();
    await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveValue('');
    await drawer.getByRole('textbox', { name: /^Назва/ }).fill('Cyber renamed');
    await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(drawer).toBeHidden();
    expect(updates[1]).toEqual({ device_id: DEVICE_ID, name: 'Cyber renamed' });
    await page.reload();
    await openEditor();
    await expect(drawer.getByRole('textbox', { name: /^Назва/ })).toHaveValue('Cyber renamed');
    await expect(drawer.getByRole('combobox', { name: 'Підрозділ' })).toHaveValue('Unit Eight');
    await expect(drawer).toContainText('Південь');
    await drawer.getByRole('textbox', { name: /^Назва/ }).fill(' ');
    await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(drawer).toContainText('Вкажіть назву пристрою.');
    expect(updates).toHaveLength(2);
    if (routeName === 'details') {
      await drawer.getByRole('button', { name: 'Архівувати', exact: true }).click();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Архівувати', exact: true })
        .click();
      await expect(drawer).toBeHidden();
      await expect(
        page.getByRole('button', { name: 'Редагувати пристрій', exact: true }),
      ).toHaveCount(0);
    }
  });
}

test('@regression #3646 forwarding warning follows device status for viewers on desktop and mobile', async ({
  page,
}) => {
  const tracker = await installMocks(page, ['CyberViewer']);
  const warning = page.getByRole('img', { name: 'Пересилання аудіо не налаштоване', exact: true });
  const warningTooltip = page.getByRole('tooltip').filter({
    hasText: 'Пересилання аудіо в групи не налаштоване для цього пристрою.',
  });
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/devices/${DEVICE_ID}`);
    await expect(warning).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Навігаційний шлях пристрою' })
        .getByRole('link', { name: 'Device Alpha', exact: true }),
    ).toBeInViewport();
    const menu = page.getByRole('navigation', { name: 'Меню пристрою' });
    for (const name of ['Файли', 'Журнал', 'Аудіо']) {
      await expect(menu.getByRole('link', { name, exact: true })).toBeInViewport();
    }
    await warning.focus();
    await expect(warningTooltip).toHaveText(
      'Пересилання аудіо в групи не налаштоване для цього пристрою.',
    );
    await page.keyboard.press('Tab');
    await warning.hover();
    await expect(warningTooltip).toBeVisible();
  }
  tracker.audioForwardingConfigured = true;
  await page.reload();
  await expect(page.getByRole('link', { name: 'Аудіо', exact: true })).toBeVisible();
  await expect(warning).toHaveCount(0);
});

test('@regression #3646 forwarding saves visible group deltas and preserves the draft after a conflict', async ({
  page,
}) => {
  await installMocks(page, ['Cyber']);
  await page.route('**/api/device/audio/forwarding', (route) =>
    fulfillJson(route, {
      version: '018f0000-0000-7000-8000-000000000050',
      enabled: false,
      groups: [{ master_key: 'echo_native.visible', name: 'Доступна група', selected: false }],
    }),
  );
  const updates: Array<Record<string, unknown>> = [];
  await page.route('**/api/device/update', async (route) => {
    updates.push(route.request().postDataJSON());
    await route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({
        message: 'Налаштування пересилання змінилися. Оновіть форму та повторіть зміни.',
      }),
    });
  });
  await page.goto(`/devices/${DEVICE_ID}`);
  const warning = page.getByRole('img', { name: 'Пересилання аудіо не налаштоване', exact: true });
  await expect(warning).toBeVisible();
  await page.getByRole('button', { name: 'Редагувати пристрій', exact: true }).click();
  const drawer = page
    .locator('.MuiDrawer-paper')
    .filter({ has: page.getByRole('heading', { name: 'Редагувати пристрій' }) });
  await drawer.getByLabel('Пересилати нові аудіо в групи').check();
  await drawer.getByRole('combobox', { name: 'Групи для пересилання' }).click();
  await page.getByRole('option', { name: 'Доступна група' }).click();
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => updates.length).toBe(1);
  expect(updates[0]).toEqual({
    device_id: DEVICE_ID,
    audio_forwarding: {
      version: '018f0000-0000-7000-8000-000000000050',
      enabled: true,
      add_groups: ['echo_native.visible'],
      remove_groups: [],
    },
  });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByLabel('Пересилати нові аудіо в групи')).toBeChecked();
  await expect(drawer).toContainText('Доступна група');
  await expect(
    page.getByText('Налаштування пересилання змінилися.', { exact: false }).first(),
  ).toBeVisible();
  const device = await page.evaluate(async (id) => {
    const response = await fetch('/api/device/detail', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_id: id }),
    });
    return response.json();
  }, DEVICE_ID);
  await page.route('**/api/device/update', (route) =>
    fulfillJson(route, { ...device, audio_forwarding_configured: true }),
  );
  await drawer.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(drawer).toBeHidden();
  await page.getByRole('button', { name: 'Редагувати пристрій', exact: true }).click();
  await drawer.getByLabel('Пересилати нові аудіо в групи').check();
  await drawer.getByRole('combobox', { name: 'Групи для пересилання' }).click();
  await page.getByRole('option', { name: 'Доступна група' }).click();
  await page.keyboard.press('Escape');
  await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(drawer).toBeHidden();
  await expect(warning).toHaveCount(0);
});

test('@smoke device details uses separate pages, an IDE-style Files sidebar, and a synchronization journal', async ({
  page,
}) => {
  test.setTimeout(60_000);
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

  const deviceMenu = page.getByRole('navigation', { name: 'Меню пристрою' });
  await expect(deviceMenu).toBeVisible({
    timeout: 30_000,
  });
  await expect(deviceMenu.getByRole('link')).toHaveText(['Файли', 'Журнал', 'Аудіо']);
  await expect(page.getByRole('link', { name: 'Файли' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Журнал' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Аналітика файлів' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Відомості пристрою', exact: true })).toBeVisible();
  await expect(page.getByText('Документи', { exact: true })).toBeVisible();
  const analyticsProgress = page.getByTestId('device-analytics-progress');
  await expect(analyticsProgress).toContainText('Файлів з контентом / усього');
  await expect(analyticsProgress).toContainText('1/2');
  await expect(analyticsProgress).toContainText('2');
  await expect(analyticsProgress).toContainText('Завантажено аудіо');
  await expect(analyticsProgress).toContainText('1');
  await expect.poll(() => tracker.analyticsTagsRequestCount).toBe(1);
  await expect.poll(() => tracker.analyticsSummaryRequestCount).toBe(1);
  expect(tracker.journalRequestCount).toBe(0);
  expect(tracker.rootsRequestCount).toBe(0);
  const metadataPanel = page.getByTestId('device-details-overview');
  await metadataPanel.getByRole('button', { name: 'Основне', exact: true }).click();
  await expect(metadataPanel).toBeVisible();
  await expect(metadataPanel).toContainText('Назва');
  await expect(metadataPanel).toContainText('Device Alpha');
  await expect(metadataPanel).not.toContainText('Джерельна мітка');
  const metadataBox = await metadataPanel.boundingBox();
  expect(metadataBox?.width).toBeGreaterThan(420);

  await openDeviceSection(page, 'Журнал');
  const journalTable = page.getByRole('table', {
    name: 'Журнал синхронізації файлів',
  });
  await expect(journalTable).toBeVisible();
  await expect(page.getByTestId('device-details-navigation')).toHaveCount(0);
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

  await openDeviceSection(page, 'Пристрій');
  await openDeviceSection(page, 'Журнал');
  await expect(journalTable).toBeVisible();
  await expect.poll(() => tracker.journalRequestCount).toBe(2);
  expect(tracker.rootsRequestCount).toBe(0);

  await openDeviceSection(page, 'Файли');
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
  await expect(filesSidebar.getByLabel('Завантаження кількості файлів')).toHaveCount(0);
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
    .getByText('/', { exact: true })
    .boundingBox();
  const documentsLabel = filesSidebar.getByLabel('Вибрати каталог documents як область пошуку');
  const documentsLabelBox = await documentsLabel
    .getByText('documents', { exact: true })
    .boundingBox();
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
    sync_id: null,
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

  const mainPanel = page.getByTestId('device-details-content');
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
  await expect(page.getByRole('button', { name: 'Про пристрій', exact: true })).toBeVisible();
  await expect(filesSidebar).toBeVisible();
  const tabletSidebarBox = await filesSidebar.boundingBox();
  const tabletMainBox = await mainPanel.boundingBox();
  expect(tabletSidebarBox!.y).toBeGreaterThanOrEqual(tabletMainBox!.y);
  expect(tabletSidebarBox!.x + tabletSidebarBox!.width).toBeLessThanOrEqual(
    tabletMainBox!.x + tabletMainBox!.width,
  );
  await expect(contentPane).toBeHidden();

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

  await openDeviceSection(page, 'Журнал');
  await expect(journalTable).toBeHidden();
  await expect(page.getByRole('list', { name: 'Журнал синхронізації файлів' })).toContainText(
    '/var/log/journal.log',
  );
  await expect(metadataPanel).toBeHidden();
  await page.getByRole('button', { name: 'Про пристрій', exact: true }).click();
  await expect(page.getByTestId('device-details-left-panel')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Про пристрій', exact: true })).toBeFocused();

  tracker.deviceArchived = true;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('button', { name: 'До пристрою', exact: true })).toBeVisible();
  await openDeviceSection(page, 'Файли');
  const archivedFilesSidebar = page.getByTestId('device-files-sidebar');
  await expect(archivedFilesSidebar.getByText('root.log', { exact: true })).toBeVisible();
  expect(browserFailures).toEqual([]);
});
for (const width of [1440, 390]) {
  test(`device file tree filters content and resets pagination at width ${width}`, async ({
    page,
  }) => {
    const tracker = await installMocks(page);
    tracker.releaseSubtreeCounts();
    await page.setViewportSize({ width, height: 1000 });
    const requests: Array<{ has_content: boolean | null; cursor: string | null }> = [];
    await page.route('**/api/device/files/browse', async (route) => {
      const body = route.request().postDataJSON();
      if (body.parent_entry_id !== POSIX_ROOT_ID)
        return fulfillJson(route, { breadcrumbs: [], entries: [], next_cursor: null });
      requests.push(body);
      const names =
        body.has_content === true
          ? ['available.txt']
          : body.has_content === false
            ? ['missing.txt']
            : ['available.txt', 'missing.txt'];
      await fulfillJson(route, {
        breadcrumbs: [],
        entries: names.map((name, index) => ({
          ...entry({
            entryId: `018f0000-0000-7000-8000-00000000003${index}`,
            parentEntryId: POSIX_ROOT_ID,
            kind: 'file',
            name,
          }),
          has_content: name === 'available.txt',
        })),
        next_cursor: null,
      });
    });
    await page.goto(`/devices/${DEVICE_ID}`);
    await openDeviceSection(page, 'Файли');
    const sidebar = page.getByTestId('device-files-sidebar');
    const filter = sidebar.getByRole('button', { name: /^Фільтри файлів/ });
    const tree = sidebar.getByTestId('device-files-tree');
    await expect(tree.getByText('available.txt', { exact: true })).toBeVisible();
    await expect(tree.getByText('missing.txt', { exact: true })).toBeVisible();
    for (const [label, value] of [
      ['З контентом', true],
      ['Без контенту', false],
      ['Усі файли', null],
    ] as const) {
      await filter.click();
      await page
        .getByRole('menu', { name: 'Фільтри файлів' })
        .getByRole('menuitemradio', { name: label, exact: true })
        .click();
      await expect.poll(() => requests.at(-1)?.has_content).toBe(value);
      expect(requests.at(-1)?.cursor).toBeNull();
      await expect(tree.getByText('Немає файлів за вибраним фільтром')).toHaveCount(
        value === null ? 0 : 1,
      );
      await expect(tree.getByText('available.txt', { exact: true })).toHaveCount(
        value === false ? 0 : 1,
      );
      await expect(tree.getByText('missing.txt', { exact: true })).toHaveCount(
        value === true ? 0 : 1,
      );
    }
  });
}

test('@regression #3926 device rating, tags, sorting and archive work on desktop and mobile', async ({
  page,
}, testInfo) => {
  await installMocks(page, ['Cyber']);
  await page.setViewportSize({ width: 1920, height: 1080 });
  let device = {
    id: DEVICE_ID,
    name: 'Device Alpha',
    rating: 2,
    description: null as string | null,
    tags: ['Перший', 'Другий', 'Третій', 'Четвертий'],
    aors: [],
    unit: null,
    external_url: null,
    custom_fields: {},
    created_by: 'operator',
    archived: false,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null as string | null,
    audio_forwarding_configured: false,
    stats: null,
  };
  const updates: Array<Record<string, unknown>> = [];
  const sorts: string[][] = [];
  let archives = 0;
  let unarchives = 0;
  await page.route('**/api/device/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/device/list') {
      const request = route.request().postDataJSON();
      sorts.push(request.sort_by);
      const matches =
        request.archived_filter === 'all' ||
        device.archived === (request.archived_filter === 'archived_only');
      return fulfillJson(route, {
        list: matches ? [device] : [],
        total: matches ? 1 : 0,
        has_more: false,
        status_counts: { active: device.archived ? 0 : 1, archived: device.archived ? 1 : 0 },
      });
    }
    if (path === '/api/device/detail') return fulfillJson(route, device);
    if (path === '/api/device/tags') return fulfillJson(route, ['Існуючий']);
    if (path === '/api/device/update') {
      const patch = route.request().postDataJSON();
      updates.push(patch);
      device = { ...device, ...patch };
      return fulfillJson(route, device);
    }
    if (path === '/api/device/unarchive') {
      expect(route.request().postDataJSON()).toEqual({ device_id: DEVICE_ID });
      unarchives += 1;
      device = { ...device, archived: false, archived_at: null };
      return fulfillJson(route, device);
    }
    if (path === '/api/device/archive') {
      expect(route.request().postDataJSON()).toEqual({ device_id: DEVICE_ID });
      archives += 1;
      device = { ...device, archived: true, archived_at: NOW };
      return fulfillJson(route, device);
    }
    return route.fallback();
  });
  await page.route('**/api/user/author-identities', (route) =>
    fulfillJson(route, {
      authors: [
        {
          id: '00000000-0000-0000-0000-000000000001',
          login: 'operator',
          display_name: 'Демо · Кібер Альфа',
          delta_login: null,
        },
      ],
    }),
  );
  await page.goto('/devices');
  const table = page.getByRole('table', { name: 'Пристрої', exact: true });
  await expect.poll(() => sorts.at(-1)).toEqual(['last_content_at_desc']);
  const statusGroup = page.getByRole('group', { name: 'Стан пристроїв' });
  await expect(statusGroup.getByRole('button', { name: 'Активні', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  const creator = table.getByRole('cell').filter({ hasText: 'Демо · Кібер Альфа' });
  await expect(creator).toBeVisible();
  await expect(creator.getByRole('button')).toHaveCount(0);
  await creator.click();
  await expect(page.getByRole('dialog', { name: 'Інформація про автора' })).toHaveCount(0);
  await expect(table.getByRole('columnheader', { name: 'Стан', exact: true })).toHaveCount(0);
  await expect(table.getByRole('img', { name: 'Активний', exact: true })).toBeVisible();
  const tags = table.getByRole('cell').filter({ hasText: 'Перший' });
  await expect(tags.getByText('Четвертий', { exact: true })).toHaveCount(0);
  await tags.hover();
  await expect(page.getByRole('tooltip')).toContainText('Четвертий');
  await table
    .locator('label')
    .filter({ hasText: /^4 із 5$/ })
    .click();
  await expect.poll(() => updates.at(-1)?.rating).toBe(4);
  await expect(table.getByLabel('4 із 5', { exact: true })).toBeEnabled();
  await table
    .locator('label')
    .filter({ hasText: /^4 із 5$/ })
    .click();
  await expect.poll(() => updates.at(-1)?.rating).toBe(0);
  await expect(table.getByLabel('Без оцінки', { exact: true })).toBeEnabled();
  await table
    .locator('label')
    .filter({ hasText: /^4 із 5$/ })
    .click();
  await expect.poll(() => updates.at(-1)?.rating).toBe(4);
  for (const [title, key] of [
    ['Смуги', 'aors'],
    ['Підрозділ', 'unit'],
    ['Створив', 'created_by'],
    ['Активність', 'last_content_at'],
    ['Розмір', 'content_bytes'],
  ]) {
    await table
      .getByRole('columnheader')
      .filter({ hasText: title })
      .getByText(title, { exact: true })
      .click();
    await expect.poll(() => sorts.at(-1)?.[0]).toMatch(new RegExp(`^${key}_(asc|desc)$`));
  }
  await expect(table.getByRole('button', { name: 'Дії', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Створити/ })).toHaveCount(0);
  await table.getByRole('button', { name: 'Редагувати', exact: true }).click();
  const drawer = page
    .locator('.MuiDrawer-paper')
    .filter({ has: page.getByRole('heading', { name: 'Редагувати пристрій' }) });
  await drawer.getByRole('textbox', { name: 'Опис пристрою' }).fill('Опис для операторів');
  const tagInput = drawer.getByRole('combobox', { name: 'Теги', exact: true });
  await tagInput.fill('Існуючий');
  await page.getByRole('option', { name: 'Існуючий', exact: true }).click();
  await tagInput.fill('Новий');
  await tagInput.press('Enter');
  await drawer.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(drawer).toBeHidden();
  expect(updates.at(-1)).toMatchObject({
    description: 'Опис для операторів',
    tags: ['Перший', 'Другий', 'Третій', 'Четвертий', 'Існуючий', 'Новий'],
  });
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await page.screenshot({
    path: testInfo.outputPath('devices-desktop-dark.png'),
    animations: 'disabled',
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole('link', { name: 'Device Alpha', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await drawer.getByRole('button', { name: 'Архівувати', exact: true }).click();
  const confirmation = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Архівувати пристрій?' }) });
  await confirmation.getByRole('button', { name: 'Скасувати', exact: true }).click();
  expect(archives).toBe(0);
  await drawer.getByRole('button', { name: 'Закрити форму', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();

  await expect(drawer.getByRole('textbox', { name: 'Опис пристрою' })).toHaveValue(
    'Опис для операторів',
  );
  await page.screenshot({
    path: testInfo.outputPath('device-edit-mobile-dark.png'),
    animations: 'disabled',
  });
  await drawer.getByRole('button', { name: 'Архівувати', exact: true }).click();
  await confirmation.getByRole('button', { name: 'Архівувати', exact: true }).click();
  await expect.poll(() => archives).toBe(1);
  await expect(page.getByRole('link', { name: 'Device Alpha', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Архів', exact: true }).click();
  await expect(page.getByRole('link', { name: 'Device Alpha', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Архівний', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await expect(drawer.getByRole('textbox', { name: 'Опис пристрою' })).toBeDisabled();
  await expect(drawer.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
  await drawer.getByRole('button', { name: 'Розархівувати', exact: true }).click();
  const restore = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('heading', { name: 'Розархівувати пристрій?' }) });
  await restore.getByRole('button', { name: 'Розархівувати', exact: true }).click();
  await expect.poll(() => unarchives).toBe(1);
  await page.getByRole('button', { name: 'Активні', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Активний', exact: true })).toBeVisible();
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.getByRole('button', { name: 'Архів', exact: true }).click();
  device = { ...device, archived: true, archived_at: NOW };
  await page.reload();
  await table.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await drawer.getByRole('button', { name: 'Розархівувати', exact: true }).click();
  await restore.getByRole('button', { name: 'Розархівувати', exact: true }).click();
  await expect.poll(() => unarchives).toBe(2);
});

// Regression: https://github.com/echoua/echo/pull/3500
test('@smoke @regression device files previews read only, explains unavailable states and downloads original bytes', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60_000);
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
    { name: 'unsupported.bin', bytes: Buffer.from([0, 1, 2, 3]) },
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
    mime_type: sample.name.endsWith('.zip') ? 'application/zip' : 'application/octet-stream',
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
    await openDeviceSection(page, 'Файли');
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
      } else if (sample.name.endsWith('zip')) {
        await expect(pane.getByText('Архів порожній.', { exact: true })).toBeVisible();
      } else {
        await expect(
          pane.getByRole('heading', { name: 'Перегляд формату BIN не підтримується' }),
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
      const archive = samples[4];
      const archiveUrl = `/api/device/files/${DEVICE_ID}/${files[4].file_id}/revisions/1/content`;
      await tree.getByRole('button', { name: missingFile.name, exact: true }).click();
      await tree.getByRole('button', { name: archive.name, exact: true }).click();
      for (const failure of ['error', 'interrupted'] as const) {
        downloadResponse = failure;
        expect((await page.request.head(new URL(archiveUrl, page.url()).href)).status()).toBe(200);
        await downloadButton.click();
        const alert = pane.getByRole('alert').filter({ hasText: 'Помилка скачування файлу' });
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
    await expect(pane.locator('header')).toBeVisible();
    await expect
      .poll(async () => {
        const headerBounds = await pane.locator('header').boundingBox();
        const downloadBounds = await pane
          .getByRole('button', { name: 'Скачати файл' })
          .boundingBox();
        return Boolean(
          headerBounds &&
          downloadBounds &&
          downloadBounds.x + downloadBounds.width <= headerBounds.x + headerBounds.width,
        );
      })
      .toBe(true);
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

test('@regression #3757 file URL expands ancestors and highlights a file beyond the first page', async ({
  page,
}) => {
  const tracker = await installMocks(page);
  tracker.releaseSubtreeCounts();
  const fileId = '018f0000-0000-7000-8000-000000000099';
  const file = {
    ...entry({
      entryId: fileId,
      parentEntryId: DOCUMENTS_ID,
      kind: 'file',
      name: 'linked.txt',
      absolutePath: '/documents/linked.txt',
    }),
    file_id: fileId,
    revision: 2,
    has_content: false,
  };
  await page.route('**/api/device/files/locate', (route) => {
    expect(route.request().postDataJSON()).toEqual({ deviceId: DEVICE_ID, fileId, revision: 2 });
    return route.fulfill({
      json: {
        file,
        ancestors: [
          entry({
            entryId: DOCUMENTS_ID,
            parentEntryId: POSIX_ROOT_ID,
            kind: 'directory',
            name: 'documents',
          }),
        ],
        rootEntryId: POSIX_ROOT_ID,
        currentRevision: 3,
      },
    });
  });
  const href = `/devices/${DEVICE_ID}?file=${fileId}&revision=2`;
  await page.goto(href);
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files?file=${fileId}&revision=2`);
  await expect(page.getByTestId('device-details-navigation')).toHaveCount(0);
  await expect(page.getByTestId(`device-file-${fileId}`)).toHaveAttribute('aria-current', 'true');
  await expect(page.getByTestId('device-file-content-pane')).toContainText('linked.txt');
  await expect(page.getByTestId('device-file-content-pane')).toContainText(
    'Ревізія 2 · За посиланням',
  );
  await page.reload();
  await expect(page.getByTestId(`device-file-${fileId}`)).toHaveAttribute('aria-current', 'true');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('device-file-content-pane')).toBeVisible();
  await page.getByRole('button', { name: 'До файлів', exact: true }).click();
  await expect(page).toHaveURL(`/devices/${DEVICE_ID}/files`);
  await expect(page.getByTestId(`device-file-${fileId}`)).toBeVisible();
});

test('@regression #3926 system setting switches file-type activity to file/audio uploads', async ({
  page,
}) => {
  test.setTimeout(60_000);
  await installMocks(page, ['Admin', 'Cyber']);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Kyiv' }).format(new Date());
  const old = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86400000).toISOString().slice(0, 10);
  let enabled = false;
  let failSave = false;
  let audioOnly = false;
  const patches: unknown[] = [];
  await page.route('**/api/admin/device/settings', async (route) => {
    const body = route.request().postDataJSON();
    if ('activitySplitFilesAudio' in body) {
      patches.push(body);
      if (failSave) {
        failSave = false;
        return route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ message: 'Save failed' }),
        });
      }
      enabled = body.activitySplitFilesAudio;
    }
    return fulfillJson(route, { hasMattermostWebhook: true, activitySplitFilesAudio: enabled });
  });
  await page.route('**/api/device/list', (route) =>
    fulfillJson(route, {
      list: [
        {
          id: DEVICE_ID,
          name: 'Activity Alpha',
          rating: 0,
          tags: [],
          aors: [],
          unit: null,
          created_by: 'operator',
          archived: false,
          created_at: NOW,
          updated_at: NOW,
          archived_at: null,
          activity_split_files_audio: enabled,
          audio_days: enabled
            ? [{ day: audioOnly ? old : today, content_count: 3, content_bytes: 300 }]
            : null,
          stats: {
            directory_count: 0,
            file_count: audioOnly ? 0 : 6,
            content_count: audioOnly ? 0 : 6,
            content_bytes: audioOnly ? 0 : 600,
            first_content_at: NOW,
            last_content_at: NOW,
            content_pending: false,
            backfilled_at: NOW,
            extensions: [],
            days: audioOnly
              ? []
              : [
                  { day: today, extension: 'pdf', content_count: 2, content_bytes: 200 },
                  { day: today, extension: 'jpg', content_count: 3, content_bytes: 300 },
                  { day: today, extension: 'wav', content_count: 1, content_bytes: 100 },
                ],
          },
        },
      ],
      total: 1,
      has_more: false,
      status_counts: { active: 1, archived: 0 },
    }),
  );
  await page.goto('/devices');
  const fileChart = page.getByRole('img', { name: 'Завантаження файлів за днями', exact: true });
  const colorCount = (chart: ReturnType<Page['getByRole']>, index: number) =>
    chart
      .locator(`g[data-day-index="${index}"]`)
      .evaluate(
        (group) =>
          new Set(
            [...group.querySelectorAll('path, rect')]
              .map((node) => node.getAttribute('fill'))
              .filter((color) => color && color !== 'currentColor'),
          ).size,
      );
  await expect(fileChart).toBeVisible();
  expect(await colorCount(fileChart, 6)).toBe(3);
  await fileChart.locator('g[data-day-index="6"]').hover();
  await expect(page.getByRole('tooltip')).toContainText('Документи');
  await expect(
    page.getByRole('tooltip').getByText('Аудіо', { exact: true }).locator('../..'),
  ).toHaveText(/Аудіо\s*1\s*·/);
  await page.goto('/admin/device-analytics?tab=general');
  await expect(
    page.getByRole('tab', { name: 'Основні налаштування', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  const toggle = page.getByRole('checkbox', { name: 'Розбивка «Файли / Аудіо»', exact: true });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  failSave = true;
  await page.getByRole('button', { name: 'Зберегти відображення', exact: true }).click();
  await expect(
    page
      .getByRole('alert')
      .filter({ hasText: 'Не вдалося зберегти налаштування активності' })
      .first(),
  ).toBeVisible();
  expect(enabled).toBe(false);
  await page.getByRole('button', { name: 'Зберегти відображення', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Зберегти відображення', exact: true }),
  ).toBeDisabled();
  expect(patches).toEqual([{ activitySplitFilesAudio: true }, { activitySplitFilesAudio: true }]);
  await page.reload();
  await expect(toggle).toBeChecked();
  await page.goto('/devices');
  const uploadChart = page.getByRole('img', {
    name: 'Завантаження файлів та аудіо за днями',
    exact: true,
  });
  await expect(uploadChart).toBeVisible();
  expect(await colorCount(uploadChart, 6)).toBe(2);
  await uploadChart.locator('g[data-day-index="6"]').hover();
  const tooltip = page.getByRole('tooltip');
  await expect(tooltip.getByText('Файли', { exact: true }).locator('../..')).toHaveText(
    /Файли\s*6\s*·/,
  );
  await expect(tooltip.getByText('Аудіо', { exact: true }).locator('../..')).toHaveText(
    /Аудіо\s*3\s*·/,
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(uploadChart).toBeVisible();
  expect(await colorCount(uploadChart, 6)).toBe(2);
  audioOnly = true;
  await page.reload();
  await expect(uploadChart.locator('g[data-day-index="0"]')).toHaveAttribute('opacity', '0.4');
  await page.goto('/admin/device-analytics?tab=general');
  await expect(toggle).toBeEnabled();
  await toggle.uncheck();
  await page.getByRole('button', { name: 'Зберегти відображення', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Зберегти відображення', exact: true }),
  ).toBeDisabled();
  await page.goto('/devices');
  await expect(page.getByText('Нема активності', { exact: true })).toBeVisible();
  await expect(uploadChart).toHaveCount(0);
});

test('@regression #3926 sidebar facets combine and persist for read-only users on desktop and mobile', async ({
  page,
}, testInfo) => {
  await installMocks(page, ['CyberViewer']);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const units = [
    { id: 7, name: 'Unit Alpha' },
    { id: 8, name: 'Unit Bravo' },
  ];
  const aors = [
    { id: 4, name: 'Північ' },
    { id: 5, name: 'Південь' },
  ];
  const devices = [
    ['Alpha', 'author-a', 4, 7, 'Пріоритет', false],
    ['Bravo', 'author-b', 4, 8, 'Інший', false],
    ['Charlie', 'author-a', 5, 7, 'Інший', false],
    ['Archive', 'author-b', 5, 8, 'Архівний', true],
  ].map(([name, creator, aor, unit, tag, archived], index) => ({
    id: `018f0000-0000-7000-8000-00000000010${index}`,
    name,
    created_by: creator,
    aors: aors.filter((item) => item.id === aor),
    unit: units.find((item) => item.id === unit),
    tags: [tag],
    archived,
    archived_at: archived ? NOW : null,
    rating: 0,
    created_at: NOW,
    updated_at: NOW,
    stats: null,
    audio_days: null,
    activity_split_files_audio: false,
  }));
  const requests: Array<Record<string, any>> = [];
  let editCatalogRequests = 0;
  await page.route('**/api/device/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/device/filter-options')
      return fulfillJson(route, {
        aors,
        creators: [
          { login: 'author-a', display_name: 'Автор Альфа' },
          { login: 'author-b', display_name: null },
        ],
        tags: ['Пріоритет', 'Інший', 'Архівний'],
      });
    if (path === '/api/device/unit-stats')
      return fulfillJson(route, { units: units.map((unit) => ({ unit, count: 2 })) });
    if (['/api/device/units', '/api/device/aors', '/api/device/tags'].includes(path))
      editCatalogRequests += 1;
    if (path !== '/api/device/list') return route.fallback();
    const req = route.request().postDataJSON();
    requests.push(req);
    const filtered = devices.filter(
      (device) =>
        (!req.aor_ids?.length || device.aors.some((aor) => req.aor_ids.includes(aor.id))) &&
        (!req.created_by?.length || req.created_by.includes(device.created_by)) &&
        (!req.tags?.length || device.tags.some((tag) => req.tags.includes(tag))) &&
        (!req.unit_ids?.length || req.unit_ids.includes(device.unit?.id)) &&
        (!req.filter_text || String(device.name).includes(req.filter_text)),
    );
    const matches = filtered.filter(
      (device) =>
        req.archived_filter === 'all' ||
        device.archived === (req.archived_filter === 'archived_only'),
    );
    return fulfillJson(route, {
      list: matches,
      total: matches.length,
      has_more: false,
      status_counts: {
        active: filtered.filter((device) => !device.archived).length,
        archived: filtered.filter((device) => device.archived).length,
      },
    });
  });
  await page.goto('/devices');
  const rows = page.getByRole('table', { name: 'Пристрої', exact: true }).getByRole('row');
  await expect(rows).toHaveCount(4);
  await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
  async function select(label: string, value: string) {
    const input = page.getByRole('combobox', { name: label, exact: true });
    await input.fill(value);
    await page.getByRole('option', { name: value, exact: true }).click();
    await input.press('Escape');
  }
  async function clear(label: string, button: string) {
    const input = page.getByRole('combobox', { name: label, exact: true });
    await input.click();
    await page.getByRole('button', { name: button, exact: true }).click();
    await input.press('Escape');
  }
  await select('Смуги', 'Північ');
  await expect(rows).toHaveCount(3);
  await select('Створив', 'Автор Альфа');
  await expect(rows).toHaveCount(2);
  await select('Теги', 'Пріоритет');
  await expect
    .poll(() => requests.at(-1))
    .toMatchObject({ aor_ids: [4], created_by: ['author-a'], tags: ['Пріоритет'] });
  await expect(page.getByRole('link', { name: 'Alpha', exact: true })).toBeVisible();
  const savedUrl = page.url();
  await page.reload();
  await expect(rows).toHaveCount(2);
  await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
  await expect(
    page
      .getByRole('combobox', { name: 'Теги', exact: true })
      .locator('..')
      .getByText('Пріоритет', { exact: true }),
  ).toBeVisible();
  await clear('Смуги', 'Очистити смуги');
  await select('Теги', 'Інший');
  await expect(rows).toHaveCount(3);
  await clear('Створив', 'Очистити створювачів');
  await expect(rows).toHaveCount(4);
  await page
    .getByRole('list', { name: 'Дерево підрозділів' })
    .getByText('Unit Alpha', { exact: true })
    .click();
  await expect.poll(() => requests.at(-1)?.unit_ids).toEqual([7]);
  await expect(rows).toHaveCount(3);
  await page.screenshot({
    path: testInfo.outputPath('device-sidebar-filters-desktop.png'),
    animations: 'disabled',
  });
  await page.locator('#active-filters-button').click();
  await page.getByRole('button', { name: 'Очистити все', exact: true }).click();
  await expect
    .poll(() => requests.at(-1))
    .toMatchObject({
      aor_ids: null,
      created_by: null,
      tags: null,
      unit_ids: null,
      archived_filter: 'active_only',
    });
  await expect(rows).toHaveCount(4);
  await page.goto(savedUrl);
  await expect(rows).toHaveCount(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Показати панель фільтрів', exact: true }).click();
  await clear('Теги', 'Очистити теги');
  await select('Теги', 'Архівний');
  await page.getByRole('button', { name: 'Сховати панель фільтрів', exact: true }).click();
  await expect(page.getByText('Пристрої не знайдено', { exact: true })).toBeVisible();
  await expect.poll(() => requests.at(-1)?.tags).toEqual(['Архівний']);
  await page.screenshot({
    path: testInfo.outputPath('device-sidebar-filters-mobile.png'),
    animations: 'disabled',
  });
  expect(editCatalogRequests).toBe(0);
  expect(errors).toEqual([]);
});

test('@regression #3926 virtual device list appends skeleton rows and discards stale continuations', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);
  await installMocks(page, ['Cyber']);
  await page.setViewportSize({ width: 1920, height: 1080 });
  const devices = Array.from({ length: 350 }, (_, index) => ({
    id: `018f0000-0000-7000-8000-${String(index).padStart(12, '0')}`,
    name: `Device ${String(index).padStart(3, '0')}`,
    rating: 0,
    tags: [],
    aors: [],
    unit: null,
    created_by: 'operator',
    archived: false,
    created_at: NOW,
    updated_at: NOW,
    archived_at: null,
    stats: null,
    audio_days: null,
    activity_split_files_audio: false,
  }));
  const archived = Array.from({ length: 120 }, (_, index) => ({
    ...devices[0],
    id: `018f0000-0000-7000-8000-${String(350 + index).padStart(12, '0')}`,
    name: `Archive ${index}`,
    archived: true,
    archived_at: NOW,
  }));
  const requests: Array<{ offset: number; filter_text: string | null; archived_filter: string }> =
    [];
  let holdOffset: number | null = null;
  let pending: Route | null = null;
  let failNextAppend = false;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  function responseFor(route: Route) {
    const req = route.request().postDataJSON();
    const filtered = [...devices, ...archived].filter(
      (device) => !req.filter_text || device.name.includes(req.filter_text),
    );
    const matches = filtered.filter(
      (device) =>
        req.archived_filter === 'all' ||
        device.archived === (req.archived_filter === 'archived_only'),
    );
    return {
      list: matches.slice(req.offset, req.offset + req.limit),
      total: matches.length,
      has_more: req.offset + req.limit < matches.length,
      status_counts: {
        active: filtered.filter((device) => !device.archived).length,
        archived: filtered.filter((device) => device.archived).length,
      },
    };
  }
  await page.route('**/api/device/list', async (route) => {
    const req = route.request().postDataJSON();
    requests.push(req);
    if (req.offset === holdOffset) {
      pending = route;
      return;
    }
    if (req.offset === 100 && failNextAppend) {
      failNextAppend = false;
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'pagination unavailable' }),
      });
    }
    return fulfillJson(route, responseFor(route));
  });
  const table = page.getByRole('table', { name: 'Пристрої', exact: true });
  const scroll = page.locator('#devices-table-scroll');
  const placeholders = page.locator('tbody tr[id^="device-loading-row-"]');
  const loading = page.getByText('Завантаження наступних пристроїв', { exact: true });
  async function frames() {
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
  }
  async function bottom() {
    await scroll.evaluate((node) => {
      node.scrollTop = node.scrollHeight;
      for (let index = 0; index < 5; index += 1) node.dispatchEvent(new Event('scroll'));
    });
  }
  function responseAt(offset: number) {
    return page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/device/list' &&
        response.request().postDataJSON().offset === offset &&
        response.status() === 200,
    );
  }
  await page.goto('/devices');
  await expect(table.getByRole('link', { name: 'Device 000', exact: true })).toBeVisible();
  expect(await table.locator('tbody tr').count()).toBeLessThan(100);
  for (const name of [
    'Перейти до першої або останньої сторінки',
    'Попередня сторінка',
    'Наступна сторінка',
    'Завантажити ще',
  ]) {
    await expect(page.getByRole('button', { name, exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: /Створити/ })).toHaveCount(0);
  expect(
    Math.abs(
      await scroll.evaluate((node) => window.innerHeight - node.getBoundingClientRect().bottom),
    ),
  ).toBeLessThanOrEqual(2);
  requests.length = 0;
  holdOffset = 100;
  await bottom();
  await expect.poll(() => requests.filter((request) => request.offset === 100).length).toBe(1);
  await bottom();
  expect(requests.filter((request) => request.offset === 100)).toHaveLength(1);
  await expect(placeholders).toHaveCount(3);
  await expect(placeholders.locator('button, a, input')).toHaveCount(0);
  await expect(table.getByRole('link', { name: 'Device 099', exact: true })).toBeVisible();
  await placeholders.last().scrollIntoViewIfNeeded();
  await expect(placeholders.last()).toBeInViewport();
  await page.screenshot({
    path: testInfo.outputPath('devices-loading-rows.png'),
    animations: 'disabled',
  });
  const firstPending = pending!;
  pending = null;
  holdOffset = 200;
  await fulfillJson(firstPending, responseFor(firstPending));
  await expect(placeholders).toHaveCount(0);
  await bottom();
  await expect.poll(() => pending !== null).toBe(true);
  await expect(table.getByRole('link', { name: 'Device 199', exact: true })).toBeVisible();
  expect(requests.map((request) => request.offset)).toEqual([100, 200]);
  const search = page.getByPlaceholder('Пошук', { exact: true });
  await search.fill('Device 34');
  await expect(table.getByRole('link', { name: 'Device 340', exact: true })).toBeVisible();
  holdOffset = null;
  await fulfillJson(pending!, responseFor(pending!)).catch(() => undefined);
  pending = null;
  await expect(table.getByRole('link', { name: 'Device 340', exact: true })).toBeVisible();
  expect(requests.at(-1)).toMatchObject({ offset: 0, filter_text: 'Device 34' });
  await search.fill('');
  await expect(table.getByRole('link', { name: 'Device 000', exact: true })).toBeVisible();
  requests.length = 0;
  for (const offset of [100, 200, 300]) {
    const response = responseAt(offset);
    await bottom();
    await (await response).finished();
    await frames();
    await expect(loading).toHaveCount(0);
  }
  await bottom();
  await frames();
  await expect(table.getByRole('link', { name: 'Device 349', exact: true })).toBeVisible();
  expect(requests.map((request) => request.offset)).toEqual([100, 200, 300]);
  expect(await table.locator('tbody tr').count()).toBeLessThan(100);
  await page.getByRole('button', { name: 'Архів', exact: true }).click();
  await expect(table.getByRole('link', { name: 'Archive 0', exact: true })).toBeVisible();
  await frames();
  expect(await scroll.evaluate((node) => node.scrollTop)).toBe(0);
  expect(
    requests
      .filter((request) => request.archived_filter === 'archived_only')
      .map((request) => request.offset),
  ).toEqual([0]);
  await page.getByRole('button', { name: 'Активні', exact: true }).click();
  await expect(table.getByRole('link', { name: 'Device 000', exact: true })).toBeVisible();
  failNextAppend = true;
  await bottom();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Помилка завантаження пристроїв' }),
  ).toBeVisible();
  await expect(placeholders).toHaveCount(0);
  const failedCount = requests.length;
  await bottom();
  await frames();
  expect(requests).toHaveLength(failedCount);
  const retried = responseAt(100);
  await page.getByRole('button', { name: 'Повторити', exact: true }).click();
  await (await retried).finished();
  await frames();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Помилка завантаження пристроїв' }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('device-virtual-scroll-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/devices');
  const mobile = page.getByTestId('devices-mobile-scroll');
  await expect(mobile.locator('ul > li')).toHaveCount(100);
  await expect(page.getByRole('button', { name: 'Наступна сторінка', exact: true })).toHaveCount(0);
  holdOffset = 100;
  await mobile.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect(
    page.getByRole('status', { name: 'Завантаження пристроїв', exact: true }),
  ).toBeVisible();
  await expect(mobile.locator('ul > li')).toHaveCount(100);
  await expect.poll(() => pending !== null).toBe(true);
  await page
    .getByRole('status', { name: 'Завантаження пристроїв', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: testInfo.outputPath('devices-loading-cards.png'),
    animations: 'disabled',
  });
  holdOffset = null;
  await fulfillJson(pending!, responseFor(pending!));
  pending = null;
  await expect(mobile.locator('ul > li')).toHaveCount(200);
  await expect(
    page.getByRole('status', { name: 'Завантаження пристроїв', exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath('device-virtual-scroll-mobile.png'),
    animations: 'disabled',
  });
  expect(errors).toEqual([]);
});
