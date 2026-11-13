import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type {
  DeviceDocumentSettings,
  DeviceFileGeodataPreviewRsp,
  SyncDeviceFilesReq,
} from '../../src/Bindings';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import {
  localFilePreviewBackend,
  previewPost,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import { loadDeviceFilePreviewFixture } from './device-file-preview.fixtures';
import {
  openDeviceArchiveFolder,
  openDeviceFilePreview,
  openDeviceFilePreviewEntry,
  selectDeviceFilePreviewEntry,
  type FilePreviewBackend,
} from './device-file-preview.ui';
import { createConverterTransportFixture } from './device-file-preview-converter-fixture';

test.setTimeout(90_000);

async function expectViewerReady(pane: Locator, id: string) {
  if (id === 'document-txt')
    await expect(pane.locator('pre')).toContainText('Контрольний файл Echo');
  else if (id === 'document-xlsx')
    await expect(pane.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
  else if (id === 'image-png') {
    await expect
      .poll(() =>
        pane
          .locator('[data-image-preview-image]')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  } else if (id === 'audio-wav') {
    await expect
      .poll(() =>
        pane
          .locator('custom-audio-player')
          .evaluate(
            (player: HTMLElement & { audio?: HTMLAudioElement }) => player.audio?.readyState ?? 0,
          ),
      )
      .toBeGreaterThanOrEqual(1);
  } else if (id === 'video-mp4') {
    await expect
      .poll(() => pane.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(1);
  } else await expect(pane.locator('.leaflet-container')).toBeVisible();
}

async function selectFile(page: Page, backend: FilePreviewBackend, id: string) {
  const { fixture } = await loadDeviceFilePreviewFixture(id);
  const entry = backend.fixtures.seeded.find((item) => item.fixtureId === id)!;
  return selectFileEntry(page, entry.file.fileId, fixture.fileName);
}

async function selectFileEntry(page: Page, fileId: string, fileName: string) {
  await page
    .getByRole('navigation', { name: 'Навігаційний шлях пристрою', exact: true })
    .getByRole('link', { name: 'C', exact: true })
    .click();
  return selectDeviceFilePreviewEntry(page, fileId, fileName);
}

async function convertedFixture(backend: FilePreviewBackend) {
  const entry = await createConverterTransportFixture(backend);
  const base = entry.originalHref.replace(/\/content$/, '/preview/geodata');
  const generation = '11111111-1111-4111-8111-111111111111';
  const status: DeviceFileGeodataPreviewRsp = {
    fileId: entry.file.fileId,
    revision: entry.file.revision,
    generation,
    status: 'idle',
    retryable: false,
    retryAfterMs: null,
    resultSizeBytes: null,
    resultUrl: null,
    errorCode: null,
    errorMessage: null,
  };
  return { entry, base, status };
}

test('@regression controlled converter transport reaches a real KMZ parser and retains the exact original', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const { entry, base, status } = await convertedFixture(backend);
    const kmz = (await loadDeviceFilePreviewFixture('native-map-kmz')).bytes;
    let prepared = 0;
    await page.route(`**${base}`, async (route) => {
      if (route.request().method() === 'POST') prepared += 1;
      await route.fulfill({
        json: transformCamelToSnake({
          ...status,
          status: prepared ? 'ready' : 'idle',
          resultUrl: prepared ? `${base}/${status.generation}/content` : null,
          resultSizeBytes: prepared ? kmz.length : null,
        }),
      });
    });
    await page.route(`**${base}/${status.generation}/content`, (route) =>
      route.fulfill({ body: kmz, contentType: 'application/vnd.google-earth.kmz' }),
    );
    const pane = await openDeviceFilePreviewEntry(
      page,
      backend,
      entry.file.fileId,
      entry.file.name,
    );
    await expect(pane.locator('.leaflet-container')).toBeVisible();
    await expect(pane.locator('[data-map-preview-polygons]')).toHaveAttribute(
      'data-map-preview-polygons',
      '1',
    );
    expect(prepared).toBe(1);
    const saved = page.waitForEvent('download');
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    expect(await readFile((await (await saved).path())!)).toEqual(entry.bytes);
    expect((await (await backend.login('reader')).head(entry.originalHref)).status()).toBe(200);
  } finally {
    await backend.dispose();
  }
});

test('@regression converter waits 120 seconds and status refresh creates no second job', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    await page.clock.install();
    const { entry, base, status } = await convertedFixture(backend);
    let gets = 0;
    let prepares = 0;
    await page.route(`**${base}`, async (route) => {
      if (route.request().method() === 'POST') prepares += 1;
      else gets += 1;
      await route.fulfill({
        json: transformCamelToSnake({ ...status, status: prepares ? 'running' : 'idle' }),
      });
    });
    const pane = await openDeviceFilePreviewEntry(
      page,
      backend,
      entry.file.fileId,
      entry.file.name,
    );
    await expect.poll(() => prepares).toBe(1);
    for (let poll = 2; poll <= 60; poll += 1) {
      await page.clock.runFor(2000);
      await expect.poll(() => gets).toBe(poll);
    }
    await expect(pane.getByRole('button', { name: 'Перевірити стан', exact: true })).toHaveCount(0);
    await page.clock.runFor(2000);
    await expect(pane).toContainText('Підготовка триває.');
    await pane.getByRole('button', { name: 'Перевірити стан', exact: true }).click();
    await expect.poll(() => gets).toBe(61);
    expect(prepares).toBe(1);
  } finally {
    await backend.dispose();
  }
});

test('@regression converter retry carries generation and 409 refreshes the current result', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const { entry, base, status } = await convertedFixture(backend);
    const kmz = (await loadDeviceFilePreviewFixture('native-map-kmz')).bytes;
    let retries = 0;
    let prepares = 0;
    await page.route(`**${base}`, async (route) => {
      if (route.request().method() === 'POST') prepares += 1;
      await route.fulfill({
        json: transformCamelToSnake({
          ...status,
          status: retries ? 'ready' : 'failed',
          retryable: true,
          errorMessage: retries ? null : 'Тимчасова помилка конвертера.',
          resultUrl: retries ? `${base}/${status.generation}/content` : null,
          resultSizeBytes: retries ? kmz.length : null,
        }),
      });
    });
    await page.route(`**${base}/retry`, async (route) => {
      expect(route.request().postDataJSON()).toEqual({ expected_generation: status.generation });
      retries += 1;
      await route.fulfill({ status: 409, body: 'generation changed' });
    });
    await page.route(`**${base}/${status.generation}/content`, (route) =>
      route.fulfill({ body: kmz, contentType: 'application/vnd.google-earth.kmz' }),
    );
    const pane = await openDeviceFilePreviewEntry(
      page,
      backend,
      entry.file.fileId,
      entry.file.name,
    );
    await expect(pane.getByRole('alert').first()).toContainText('Тимчасова помилка');
    await pane.getByRole('button', { name: 'Повторити підготовку', exact: true }).click();
    await expect(pane.locator('.leaflet-container')).toBeVisible();
    expect(retries).toBe(1);
    expect(prepares).toBe(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression late converter result cannot replace a newer A to B to A session', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  let release: (() => void) | undefined;
  try {
    const { entry, base, status } = await convertedFixture(backend);
    let gets = 0;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${base}`, async (route) => {
      gets += 1;
      if (gets === 1) {
        await pending;
        await route.fulfill({ status: 500, body: 'retired converter error' }).catch(() => {});
      } else await route.fulfill({ json: transformCamelToSnake({ ...status, status: 'running' }) });
    });
    await openDeviceFilePreviewEntry(page, backend, entry.file.fileId, entry.file.name);
    const timeOrigin = await page.evaluate(() => performance.timeOrigin);
    await expect.poll(() => gets).toBe(1);
    const text = await selectFile(page, backend, 'current-text');
    await expect(text.locator('pre')).toContainText('Версія: поточна.');
    const pane = await selectFileEntry(page, entry.file.fileId, entry.file.name);
    await expect.poll(() => gets).toBe(2);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
    release!();
    await expect(pane).toContainText('Підготовка мапи…');
    await expect(pane).not.toContainText('retired converter error');
    await expect(pane.getByRole('alert')).toHaveCount(0);
  } finally {
    release?.();
    await backend.dispose();
  }
});

for (const id of ['document-txt', 'document-xlsx', 'image-png', 'native-map-kml']) {
  test(`@regression retired ${id} GET error cannot replace A to B to A`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    let release: (() => void) | undefined;
    try {
      const entry = backend.fixtures.seeded.find((item) => item.fixtureId === id)!;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      let gets = 0;
      await page.route(`**${entry.originalHref}`, async (route) => {
        if (route.request().method() !== 'GET') return route.continue();
        gets += 1;
        if (gets === 1) {
          await pending;
          await route.fulfill({ status: 500, body: 'retired source failure' }).catch(() => {});
        } else await route.continue();
      });
      await openDeviceFilePreview(page, backend, id);
      await expect.poll(() => gets).toBe(1);
      const text = await selectFile(page, backend, 'current-text');
      await expect(text.locator('pre')).toContainText('Версія: поточна.');
      const pane = await selectFile(page, backend, id);
      await expect.poll(() => gets).toBe(2);
      release!();
      await expectViewerReady(pane, id);
      await expect(pane.getByRole('alert')).toHaveCount(0);
      const saved = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      expect(await readFile((await (await saved).path())!)).toEqual(
        (await loadDeviceFilePreviewFixture(id)).bytes,
      );
    } finally {
      release?.();
      await backend.dispose();
    }
  });
  for (const status of [401, 403, 404, 500, 'disconnect'] as const) {
    test(`@regression ${id} handles GET ${status} after successful real HEAD`, async ({ page }) => {
      const backend = await localFilePreviewBackend();
      try {
        const entry = backend.fixtures.seeded.find((item) => item.fixtureId === id)!;
        let heads = 0;
        let failures = 0;
        let failed = true;
        await page.route(`**${entry.originalHref}`, async (route) => {
          if (route.request().method() === 'HEAD') {
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            heads += 1;
            await route.fulfill({ response });
          } else if (failed) {
            failures += 1;
            if (status === 'disconnect') await route.abort('connectionreset');
            else await route.fulfill({ status, body: 'controlled transport failure' });
          } else await route.continue();
        });
        const { pane } = await openDeviceFilePreview(page, backend, id);
        await expect.poll(() => failures).toBeGreaterThan(0);
        expect(heads).toBeGreaterThan(0);
        if (status === 401) await expect(page).toHaveURL(/\/login(?:\?|$)/);
        else {
          await expect(pane.getByRole('alert').first()).toBeVisible();
          if (status === 500 || status === 'disconnect') {
            failed = false;
            await pane.getByRole('button', { name: 'Повторити', exact: true }).click();
            await expectViewerReady(pane, id);
            await expect(pane.getByRole('alert')).toHaveCount(0);
            const saved = page.waitForEvent('download');
            await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
            expect(await readFile((await (await saved).path())!)).toEqual(
              (await loadDeviceFilePreviewFixture(id)).bytes,
            );
          } else
            await expect(
              pane.getByRole('button', { name: 'Скачати файл', exact: true }),
            ).toBeDisabled();
        }
      } finally {
        await backend.dispose();
      }
    });
  }
}

test('@regression real parser completion retired during A to B to A cannot publish stale geometry', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    await page.addInitScript(() => {
      const state = window as typeof window & {
        releasePreviewWorker?: () => void;
        previewWorkerHeld?: boolean;
      };
      const NativeWorker = window.Worker;
      let delay = true;
      window.Worker = class extends NativeWorker {
        private readonly delayed: boolean;
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          this.delayed = delay && String(url).includes('kmz-preview.worker');
          if (this.delayed) delay = false;
        }
        addEventListener(
          type: string,
          listener: EventListenerOrEventListenerObject,
          options?: boolean | AddEventListenerOptions,
        ) {
          if (this.delayed && type === 'message') {
            super.addEventListener(
              type,
              (event) => {
                state.previewWorkerHeld = true;
                state.releasePreviewWorker = () => {
                  if (typeof listener === 'function') listener.call(this, event);
                  else listener.handleEvent(event);
                };
              },
              options,
            );
          } else super.addEventListener(type, listener, options);
        }
      };
    });
    await openDeviceFilePreview(page, backend, 'native-map-kml');
    await expect
      .poll(() =>
        page.evaluate(
          () => (window as typeof window & { previewWorkerHeld?: boolean }).previewWorkerHeld,
        ),
      )
      .toBe(true);
    const text = await selectFile(page, backend, 'current-text');
    await expect(text.locator('pre')).toContainText('Версія: поточна.');
    const pane = await selectFile(page, backend, 'native-map-kml');
    await expect(pane.locator('.leaflet-container')).toBeVisible();
    const geometry = await pane
      .locator('[data-map-preview-polygons]')
      .getAttribute('data-map-preview-polygons');
    await page.evaluate(() =>
      (window as typeof window & { releasePreviewWorker?: () => void }).releasePreviewWorker?.(),
    );
    await expect(pane.locator('[data-map-preview-polygons]')).toHaveAttribute(
      'data-map-preview-polygons',
      geometry!,
    );
    await expect(pane.getByRole('alert')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

for (const [id, outcome] of [
  ['document-docx', 'corrupt'],
  ['document-xlsx', 'corrupt'],
  ['image-png', 'corrupt'],
  ['archive-zip', 'corrupt'],
  ['native-map-kml', 'corrupt'],
  ['native-map-kmz', 'oversized'],
  ['native-map-kml', 'no-geometry'],
] as const) {
  test(`@regression actual ${id} ${outcome} has a final explanation and exact original`, async ({
    page,
  }) => {
    if (outcome === 'oversized') test.setTimeout(180_000);
    const backend = await localFilePreviewBackend();
    try {
      const fixture = (await loadDeviceFilePreviewFixture(id)).fixture;
      const custom = {
        ...fixture,
        id: `${id}-${outcome}`,
        fileName: `${outcome}-${fixture.fileName}`,
      };
      const bytes =
        outcome === 'oversized'
          ? Buffer.alloc(25 * 1024 * 1024 + 1)
          : Buffer.from(
              outcome === 'no-geometry'
                ? '<kml xmlns="http://www.opengis.net/kml/2.2"><Document/></kml>'
                : 'corrupt operational parser input',
            );
      const source = await backend.login('source');
      const file = await syncPreviewFile(source, backend.fixtures.deviceId!, custom);
      await uploadPreviewContent(source, backend.fixtures.deviceId!, file, bytes);
      await openDeviceFilePreview(page, backend, 'current-text');
      await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(custom.fileName);
      await page.getByRole('button', { name: 'Знайти', exact: true }).click({ noWaitAfter: true });
      await page
        .getByRole('region', { name: 'Результати пошуку файлів' })
        .locator(`[data-entry-id="${file.fileId}"]`)
        .getByRole('button', { name: custom.fileName, exact: true })
        .click({ noWaitAfter: true });
      const pane = page.getByTestId('device-file-content-pane');
      if (outcome === 'no-geometry') await expect(pane).toContainText('немає геометрій');
      else if (id === 'archive-zip')
        await expect(pane.getByRole('status')).toHaveText('Архів пошкоджено');
      else {
        await expect(pane.getByRole('alert').first()).toBeVisible();
        if (outcome === 'oversized') await expect(pane).toContainText(/ліміт|завелик/i);
      }
      const saved = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      expect(await readFile((await (await saved).path())!)).toEqual(bytes);
      const next = await selectFile(page, backend, 'current-text');
      await expect(next.locator('pre')).toContainText('Версія: поточна.');
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression thousand-file catalogue fetches no unselected bytes or preview jobs', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const backend = await localFilePreviewBackend();
  try {
    const source = await backend.login('source');
    await previewPost(source, '/api/device/files/sync', {
      deviceId: backend.fixtures.deviceId!,
      files: Array.from({ length: 1000 }, (_, index) => ({
        absolutePath: `C:\\large-preview\\item-${index}.gpx`,
        mimeType: 'application/gpx+xml',
        extension: 'gpx',
        fileMetadataCreatedAt: null,
        fileMetadataModifiedAt: new Date().toISOString(),
        sourceFileState: null,
      })),
    } satisfies SyncDeviceFilesReq);
    const gpx = await loadDeviceFilePreviewFixture('converted-map-gpx');
    const readyIds: string[] = [];
    for (let batch = 0; batch < 10; batch += 1) {
      await Promise.all(
        Array.from({ length: 4 }, async (_, offset) => {
          const index = batch * 4 + offset;
          const fixture = {
            ...gpx.fixture,
            id: `large-ready-${index}`,
            fileName: `item-000${index}-ready.gpx`,
          };
          const file = await syncPreviewFile(source, backend.fixtures.deviceId!, fixture);
          await uploadPreviewContent(source, backend.fixtures.deviceId!, file, gpx.bytes);
          readyIds.push(file.fileId);
        }),
      );
    }
    const reader = await backend.login('reader');
    await page.context().addCookies((await reader.storageState()).cookies);
    const content: string[] = [];
    page.on('request', (request) => {
      if (/\/content$|\/preview\//.test(new URL(request.url()).pathname))
        content.push(request.url());
    });
    await page.goto(`/devices/${backend.fixtures.deviceId}`);
    await openDeviceSection(page, 'Файли');
    await page
      .getByRole('button', { name: /Вибрати каталог C:/ })
      .first()
      .click();
    await page.getByRole('button', { name: 'Показати пошук файлів', exact: true }).click();
    await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill('item-');
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    const results = page.getByRole('region', { name: 'Результати пошуку файлів' });
    await expect(results.locator('[data-entry-id]').first()).toBeVisible();
    await expect(results.locator(`[data-entry-id="${readyIds[0]}"]`)).toBeVisible();
    await expect(page.getByRole('textbox', { name: 'Назва містить', exact: true })).toBeEditable();
    await page
      .getByRole('textbox', { name: 'Назва містить', exact: true })
      .fill('no-such-preview-file');
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await expect(results.locator('[data-entry-id]')).toHaveCount(0);
    expect(content).toEqual([]);
  } finally {
    await backend.dispose();
  }
});

for (const id of ['document-txt', 'document-xlsx', 'image-png', 'native-map-kml']) {
  test(`@regression ${id} retries an actual truncated HTTP body`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    let partialBodies = 0;
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': '10000',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
      });
      response.flushHeaders();
      response.write('incomplete operational file bytes', () => {
        partialBodies += 1;
        response.socket?.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Missing loopback fault server');
      const entry = backend.fixtures.seeded.find((item) => item.fixtureId === id)!;
      let fail = true;
      await page.route(`**${entry.originalHref}`, async (route) => {
        if (fail && route.request().method() === 'GET')
          await route.fulfill({
            status: 307,
            headers: { location: `http://127.0.0.1:${address.port}/partial` },
          });
        else await route.continue();
      });
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expect(pane.getByRole('alert').first()).toBeVisible();
      expect(partialBodies).toBe(1);
      fail = false;
      await pane.getByRole('button', { name: 'Повторити', exact: true }).click();
      await expectViewerReady(pane, id);
      await expect(pane.getByRole('alert')).toHaveCount(0);
      const saved = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      expect(await readFile((await (await saved).path())!)).toEqual(
        (await loadDeviceFilePreviewFixture(id)).bytes,
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await backend.dispose();
    }
  });
}

test('@regression original viewers run with extraction and AI explicitly disabled', async ({
  page,
}) => {
  test.setTimeout(240_000);
  const backend = await localFilePreviewBackend();
  try {
    const admin = await backend.login('admin');
    const disabled: DeviceDocumentSettings = {
      enabled: false,
      summariesEnabled: false,
      positionsEnabled: false,
      aiEngineId: null,
      positionEngineId: null,
    };
    const savedSettings = await admin.post('/api/admin/device-documents/settings', {
      data: disabled,
    });
    expect(savedSettings.status()).toBe(200);
    const settings: DeviceDocumentSettings = await savedSettings.json();
    expect(settings.enabled).toBe(false);
    const enrichment: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/api/device/files/ai/'))
        enrichment.push(request.url());
    });
    for (const id of [
      'document-txt',
      'document-xlsx',
      'image-png',
      'audio-wav',
      'video-mp4',
      'archive-zip',
      'native-map-kml',
    ]) {
      if (id === 'archive-zip') {
        const { folder } = await openDeviceArchiveFolder(page, backend, id);
        await expect(
          folder.getByRole('button', { name: 'Відкрити файл Звіт.txt', exact: true }),
        ).toBeVisible();
        await expect(folder.getByRole('alert')).toHaveCount(0);
        continue;
      }
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expectViewerReady(pane, id);
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
      await expect(pane.getByRole('alert')).toHaveCount(0);
    }
    expect(enrichment).toEqual([]);
  } finally {
    await backend.dispose();
  }
});
