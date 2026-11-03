import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile, writeFile } from 'node:fs/promises';
import type {
  BrowseDeviceFilesReq,
  BrowseDeviceFilesRsp,
  ListLoginsRsp,
  Login,
  SearchDeviceFilesReq,
  SearchDeviceFilesRsp,
  UpdateLoginReq,
} from '../../src/Bindings';
import { localFilePreviewBackend, previewPost } from './device-file-preview-backend';
import { loadDeviceFilePreviewFixture } from './device-file-preview.fixtures';
import {
  ensureDeviceFilePreviewFixture,
  openDeviceFilePreview,
  type FilePreviewBackend,
} from './device-file-preview.ui';

test.setTimeout(60_000);

async function selectSearchFile(page: Page, backend: FilePreviewBackend, id: string) {
  const { fixture } = await loadDeviceFilePreviewFixture(id);
  const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === id)!;
  await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(fixture.fileName);
  await page.getByRole('button', { name: 'Знайти', exact: true }).click();
  await page
    .getByRole('region', { name: 'Результати пошуку файлів' })
    .locator(`[data-entry-id="${entry.file.fileId}"]`)
    .getByRole('button', { name: fixture.fileName, exact: true })
    .click();
  const pane = page.getByTestId('device-file-content-pane');
  await expect(pane.locator('#device-file-content-title')).toContainText(fixture.fileName);
  return pane;
}

async function expectOriginalBytes(page: Page, pane: Locator, id: string) {
  const expected = (await loadDeviceFilePreviewFixture(id)).bytes;
  const saved = page.waitForEvent('download');
  await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
  const download = await saved;
  expect(await readFile((await download.path())!)).toEqual(expected);
}

async function expectViewer(pane: Locator, id: string) {
  if (id === 'image-png') {
    const image = pane.locator('[data-image-preview-image]');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
  } else if (id === 'document-pdf') {
    await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  } else if (id === 'archive-zip') {
    await expect(
      pane.getByRole('button', { name: /^(Розгорнути|Згорнути) каталог nested$/ }),
    ).toBeVisible({ timeout: 45_000 });
  } else if (id === 'native-map-kml') {
    await expect(pane.locator('.leaflet-container')).toBeVisible();
    await expect(pane.locator('.leaflet-overlay-pane canvas').first()).toBeAttached();
  } else if (id === 'audio-wav') {
    const player = pane.locator('custom-audio-player');
    await expect(player).toBeVisible();
    await expect
      .poll(() =>
        player.evaluate(
          (node: HTMLElement & { audio?: HTMLAudioElement }) => node.audio?.readyState ?? 0,
        ),
      )
      .toBeGreaterThanOrEqual(1);
  } else if (id === 'video-mp4') {
    await expect(pane.locator('video')).toBeVisible();
    await expect
      .poll(() => pane.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(1);
  } else {
    await expect(pane.locator('pre')).toContainText('Версія: поточна.');
  }
}

test('@regression retained historical text uses session tree/search revision and original bytes', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const old = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'historical-text')!;
    const current = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'current-text')!;
    expect(old.file.fileId).toBe(current.file.fileId);
    expect(old.file.revision).toBeLessThan(current.file.revision);
    expect(old.file.syncId).not.toBe(current.file.syncId);
    const reader = await backend.login('reader');
    for (const [entry, syncId] of [
      [old, old.file.syncId],
      [current, null],
    ] as const) {
      const browse = await previewPost<BrowseDeviceFilesRsp>(reader, '/api/device/files/browse', {
        deviceId: backend.fixtures.deviceId!,
        syncId,
        archiveRevision: null,
        parentEntryId: entry.file.parentEntryId,
        includeBreadcrumbs: true,
        limit: 100,
        cursor: null,
        hasContent: null,
        tagIds: null,
        tagMatch: null,
        untagged: null,
      } satisfies BrowseDeviceFilesReq);
      expect(browse.entries.find((file) => file.fileId === entry.file.fileId)?.revision).toBe(
        entry.file.revision,
      );
      const search = await previewPost<SearchDeviceFilesRsp>(reader, '/api/device/files/search', {
        deviceId: backend.fixtures.deviceId!,
        syncId,
        scopeEntryId: entry.file.rootEntryId,
        nameQuery: entry.file.name,
        kinds: null,
        mimeTypes: null,
        extensions: null,
        fileMetadataModifiedFrom: null,
        fileMetadataModifiedTo: null,
        limit: 100,
        cursor: null,
        tagIds: null,
        tagMatch: null,
        untagged: null,
      } satisfies SearchDeviceFilesReq);
      expect(search.entries.find((file) => file.fileId === entry.file.fileId)?.revision).toBe(
        entry.file.revision,
      );
    }
    let { pane } = await openDeviceFilePreview(page, backend, 'current-text');
    await expect(pane.locator('pre')).toHaveText(
      (await loadDeviceFilePreviewFixture('current-text')).bytes.toString('utf8'),
    );
    await expect(pane).toContainText(`Ревізія ${current.file.revision} · Поточна`);
    await expectOriginalBytes(page, pane, 'current-text');
    await page.goto(`/devices/${backend.fixtures.deviceId}?sync_id=${old.file.syncId}`);
    await openDeviceSection(page, 'Файли');
    await page
      .getByRole('button', { name: /Вибрати каталог C:/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Показати пошук файлів', exact: true }).click();
    pane = await selectSearchFile(page, backend, 'historical-text');
    await expect(pane.locator('pre')).toHaveText(
      (await loadDeviceFilePreviewFixture('historical-text')).bytes.toString('utf8'),
    );
    await expect(pane).toContainText(`Ревізія ${old.file.revision} · Із вибраної сесії`);
    await expectOriginalBytes(page, pane, 'historical-text');
  } finally {
    await backend.dispose();
  }
});

test('#3778 @regression ZIP nested member uses safe basename, exact bytes and native download', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane, entry } = await openDeviceFilePreview(page, backend, 'archive-zip');
    const directory = pane.getByRole('button', { name: 'Розгорнути каталог nested', exact: true });
    await expect(directory).toBeVisible({ timeout: 45_000 });
    await directory.click();
    await pane.getByRole('button', { name: 'Дані.csv', exact: true }).click();
    await expect(pane.locator('#device-file-content-title')).toContainText('Дані.csv');
    const member = pane.getByRole('button', { name: 'Скачати файл', exact: true });
    await expect(member).toBeEnabled();
    await expect
      .poll(() =>
        member.evaluate(
          (button) =>
            button.getBoundingClientRect().bottom <=
            button.closest('header')!.getBoundingClientRect().bottom,
        ),
      )
      .toBe(true);
    const checked = page.waitForResponse(
      (response) =>
        response.url().endsWith('/content') &&
        !response.url().endsWith(entry.originalHref) &&
        response.request().method() === 'HEAD' &&
        response.status() === 200,
    );
    const saved = page.waitForEvent('download');
    await member.click();
    await checked;
    const download = await saved;
    expect(download.suggestedFilename()).toBe('Дані.csv');
    expect(await readFile((await download.path())!)).toEqual(
      (await loadDeviceFilePreviewFixture('document-csv')).bytes,
    );
  } finally {
    await backend.dispose();
  }
});

test('@regression ZIP traversal and absolute names never become member downloads', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    await ensureDeviceFilePreviewFixture(backend, 'unsafe-zip-names');
    const { pane } = await openDeviceFilePreview(page, backend, 'unsafe-zip-names');
    await expect(pane.getByRole('status')).toContainText('Архів містить небезпечний шлях');
    await expect(pane.locator('button[data-testid^="device-file-"]')).toHaveCount(1);
    await expect(pane.getByRole('button', { name: '../escape.txt', exact: true })).toHaveCount(0);
    await expect(pane.getByRole('button', { name: '/absolute.txt', exact: true })).toHaveCount(0);
    await expectOriginalBytes(page, pane, 'unsafe-zip-names');
  } finally {
    await backend.dispose();
  }
});

test('@regression ZIP cached member is stopped when actual reader access is revoked', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  const admin = await backend.login('admin');
  const readerApi = await backend.login('reader');
  let reader: Login | undefined;
  const updateRoles = async (roles: string[]) => {
    if (!reader?.organismId) throw new Error('Missing owned reader organism');
    await previewPost(admin, '/api/login/update', {
      id: reader.id,
      login: reader.login,
      roles,
      organismId: reader.organismId,
      sigintZoneId: reader.sigintZoneId,
      deleted: false,
      password: null,
      deltaLogin: reader.deltaLogin,
      deactivationReason: null,
      description: reader.description,
      passwordAuthEnabled: reader.passwordAuthEnabled,
      clearTotp: false,
    } satisfies UpdateLoginReq);
  };
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'archive-zip');
    const directory = pane.getByRole('button', { name: 'Розгорнути каталог nested', exact: true });
    await expect(directory).toBeVisible({ timeout: 45_000 });
    await directory.click();
    const selectedHead = page.waitForResponse(
      (response) => response.request().method() === 'HEAD' && response.url().endsWith('/content'),
    );
    await pane.getByRole('button', { name: 'Дані.csv', exact: true }).click();
    await expect(pane.locator('#device-file-content-title')).toContainText('Дані.csv');
    const member = pane.getByRole('button', { name: 'Скачати файл', exact: true });
    await expect(member).toBeEnabled();
    const memberUrl = (await selectedHead).url();
    expect((await readerApi.head(memberUrl)).status()).toBe(200);
    const users = await previewPost<ListLoginsRsp>(admin, '/api/logins', {
      sortBy: null,
      filterByRoles: null,
    });
    reader = users.users.find((user) => user.id === backend.fixtures.actors.reader.id);
    if (!reader) throw new Error('Missing actual reader actor');
    await updateRoles(['Api']);
    const response = await readerApi.get(memberUrl);
    expect(response.status()).toBe(403);
    expect(await response.text()).not.toContain('Дані.csv');
    const downloads: string[] = [];
    page.on('download', (download) => downloads.push(download.suggestedFilename()));
    const denied = page.waitForResponse(
      (response) =>
        response.url() === memberUrl &&
        response.request().method() === 'HEAD' &&
        response.status() === 403,
    );
    await member.click();
    await denied;
    await expect(pane.getByRole('alert')).toContainText(/доступ|заборон|forbidden|403/i);
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    expect(downloads).toEqual([]);
  } finally {
    if (reader) await updateRoles(reader.roles);
    await backend.dispose();
  }
});

for (const id of [
  'document-pdf',
  'image-png',
  'archive-zip',
  'native-map-kml',
  'audio-wav',
  'video-mp4',
]) {
  test(`@regression ${['audio-wav', 'video-mp4'].includes(id) ? '@new-api ' : ''}narrow fullscreen Escape focus and layout ${id}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expectViewer(pane, id);
      await expect(
        pane.getByRole('button', { name: 'Скачати файл', exact: true }),
      ).toBeInViewport();
      const fullscreen = pane.getByRole('button', { name: 'На весь екран', exact: true });
      await fullscreen.click();
      const dialog = page.getByRole('dialog');
      await expect(dialog).toBeVisible();
      await expectViewer(dialog, id);
      await expect(
        dialog.getByRole('button', { name: 'Скачати файл', exact: true }),
      ).toBeInViewport();
      await expectOriginalBytes(page, dialog, id);
      if (id === 'document-pdf' || id === 'video-mp4') {
        await dialog.getByRole('button', { name: 'Збільшити масштаб', exact: true }).click();
        await expect(dialog).toContainText('125%');
      } else if (id === 'image-png') {
        const image = dialog.locator('[data-image-preview-image]');
        await dialog.locator('[data-image-preview-stage]').hover();
        await page.keyboard.down('Control');
        await page.mouse.wheel(0, -200);
        await page.keyboard.up('Control');
        await expect
          .poll(async () => Number(await image.getAttribute('data-image-preview-zoom')))
          .toBeGreaterThan(100);
      } else if (id === 'native-map-kml') {
        const geometry = dialog.locator('.leaflet-overlay-pane canvas').first();
        const beforeZoom = await geometry.evaluate((canvas: HTMLCanvasElement) =>
          canvas.toDataURL(),
        );
        await dialog.locator('.leaflet-container').hover();
        await page.mouse.wheel(0, -300);
        await expect
          .poll(() => geometry.evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL()))
          .not.toBe(beforeZoom);
      }
      expect(
        await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      const focusPath = test.info().outputPath('fullscreen-focus-before-escape.json');
      await writeFile(
        focusPath,
        JSON.stringify(
          await page.evaluate(() => ({
            tag: document.activeElement?.tagName,
            label: document.activeElement?.getAttribute('aria-label'),
            text: document.activeElement?.textContent?.slice(0, 80),
            inDialog: document.querySelector('[role="dialog"]')?.contains(document.activeElement),
            documentFocused: document.hasFocus(),
          })),
        ),
      );
      await test.info().attach('fullscreen-focus-before-escape', {
        path: focusPath,
        contentType: 'application/json',
      });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(fullscreen).toBeFocused();
      await expectViewer(pane, id);
      await page.getByRole('button', { name: 'До файлів', exact: true }).click();
      await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
      await expect(
        page.getByRole('region', { name: 'Результати пошуку файлів' }).getByRole('button', {
          name: (await loadDeviceFilePreviewFixture(id)).fixture.fileName,
          exact: true,
        }),
      ).toBeFocused();
    } finally {
      await backend.dispose();
    }
  });
}

for (const [id, selector] of [
  ['image-png', '[data-image-preview-image]'],
  ['document-pdf', '.react-pdf__Page__canvas'],
  ['native-map-kml', '.leaflet-container'],
] as const) {
  test(`@regression actual file change and SPA route retire ${id} viewer`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expectViewer(pane, id);
      const previous = await pane.locator(selector).first().elementHandle();
      if (id === 'native-map-kml')
        expect(
          await previous!.evaluate(
            (node) => (node as HTMLElement & { _leaflet_id?: number })._leaflet_id,
          ),
        ).toEqual(expect.any(Number));
      const imageHref =
        id === 'image-png' ? await pane.locator(selector).getAttribute('src') : null;
      const replacement = await selectSearchFile(page, backend, 'current-text');
      await expectViewer(replacement, 'current-text');
      expect(await previous!.evaluate((node) => node.isConnected)).toBe(false);
      if (id === 'native-map-kml')
        expect(
          await previous!.evaluate(
            (node) => (node as HTMLElement & { _leaflet_id?: number })._leaflet_id,
          ),
        ).toBeUndefined();
      if (imageHref) {
        expect(imageHref).toMatch(/^blob:/);
        expect(
          await page.evaluate(async (href) => {
            try {
              await fetch(href);
              return true;
            } catch {
              return false;
            }
          }, imageHref),
        ).toBe(false);
      }
      await selectSearchFile(page, backend, id);
      await expectViewer(pane, id);
      const beforeRoute = await pane.locator(selector).first().elementHandle();
      await page.getByRole('button', { name: 'До списку пристроїв', exact: true }).click();
      await expect(page).toHaveURL(/\/devices$/);
      await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
      expect(await beforeRoute!.evaluate((node) => node.isConnected)).toBe(false);
      if (id === 'native-map-kml')
        expect(
          await beforeRoute!.evaluate(
            (node) => (node as HTMLElement & { _leaflet_id?: number })._leaflet_id,
          ),
        ).toBeUndefined();
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression @new-api no Alpine converted GPX reports unavailable service and retains exact original', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'converted-map-gpx')!;
    const unavailable = page.waitForResponse(
      (response) =>
        response.url().includes(`/revisions/${entry.file.revision}/preview/geodata`) &&
        response.status() === 503,
    );
    const { pane } = await openDeviceFilePreview(page, backend, 'converted-map-gpx');
    await unavailable;
    await expect(pane.getByRole('alert').first()).toContainText(/недоступ|Alpine/i);
    await expect(pane.locator('.leaflet-container')).toHaveCount(0);
    await expectOriginalBytes(page, pane, 'converted-map-gpx');
  } finally {
    await backend.dispose();
  }
});
