import { expect, test, type Page, type Route } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { zipSync } from 'fflate';
import type {
  BrowseDeviceFilesRsp,
  DeviceArchiveStatus,
  DeviceFileTreeEntry,
} from '../../src/Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import {
  localFilePreviewBackend,
  previewPost,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';

type Backend = Awaited<ReturnType<typeof localFilePreviewBackend>>;

function thumbnailUrl(deviceId: string, fileId: string, revision: number) {
  return `/api/device/files/${deviceId}/${fileId}/revisions/${revision}/thumbnail`;
}

async function fixtureFolder(page: Page, backend: Backend, fixtureId = 'image-jpeg') {
  const seeded = backend.fixtures.seeded.find((entry) => entry.fixtureId === fixtureId);
  const deviceId = backend.fixtures.deviceId;
  if (!seeded || !deviceId) throw new Error(`Missing thumbnail fixture: ${fixtureId}`);
  const reader = await backend.login('reader');
  await page.context().addCookies((await reader.storageState()).cookies);
  const directory = await previewPost<BrowseDeviceFilesRsp>(reader, '/api/device/files/browse', {
    deviceId,
    parentEntryId: seeded.file.parentEntryId,
    limit: 100,
  });
  const entry = directory.entries.find((entry) => entry.fileId === seeded.file.fileId);
  if (!entry) throw new Error(`Missing published thumbnail entry: ${fixtureId}`);
  return {
    deviceId,
    directory,
    entry,
    reader,
    url: `/devices/${deviceId}/files?directory=${entry.parentEntryId}`,
  };
}

function observeOriginalReadsAndViewedWrites(page: Page) {
  const originals: string[] = [];
  const viewed: { file_id: string; revision: number }[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (/\/revisions\/\d+\/(content|preview\/media)$/.test(path)) originals.push(path);
    if (path === '/api/device/files/viewed') viewed.push(request.postDataJSON());
  });
  return { originals, viewed };
}

async function mockDirectory(
  page: Page,
  directory: BrowseDeviceFilesRsp,
  parentEntryId: string,
  entries: () => DeviceFileTreeEntry[],
) {
  await page.route('**/api/device/files/browse', (route) => {
    if (route.request().postDataJSON().parent_entry_id !== parentEntryId) return route.continue();
    return route.fulfill({
      json: transformCamelToSnake({ ...directory, entries: entries(), nextCursor: null }),
    });
  });
}

async function fulfillThumbnail(route: Route, body: Buffer) {
  await route.fulfill({
    contentType: 'image/jpeg',
    headers: { 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' },
    body,
  });
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(180_000);
  await page.setViewportSize({ width: 1440, height: 900 });
});

for (const fixtureId of ['image-jpeg', 'video-mp4']) {
  test(`@regression #3930 actual ${fixtureId} thumbnail does not download or mark the original`, async ({
    page,
    request,
  }, testInfo) => {
    const backend = await localFilePreviewBackend();
    try {
      if (fixtureId === 'image-jpeg') await page.setViewportSize({ width: 390, height: 844 });
      const folder = await fixtureFolder(page, backend, fixtureId);
      await mockDirectory(page, folder.directory, folder.entry.parentEntryId, () =>
        folder.directory.entries.map((entry) => ({ ...entry, isViewed: false })),
      );
      const tracker = observeOriginalReadsAndViewedWrites(page);
      const href = thumbnailUrl(folder.deviceId, folder.entry.fileId!, folder.entry.revision!);
      const ready = page.waitForResponse(
        (response) => new URL(response.url()).pathname === href && response.status() === 200,
        { timeout: 120_000 },
      );
      await page.goto(folder.url);
      const card = page
        .getByRole('list', { name: 'Файли та папки' })
        .locator(`[data-entry-id="${folder.entry.entryId}"]`);
      const image = card.locator('[data-device-file-thumbnail-image]');
      const response = await ready;
      expect(response.headers()['content-type']).toContain('image/jpeg');
      expect(response.headers()['cache-control']).toBe('private, no-store');
      const bytes = await response.body();
      expect(bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(bytes.length).toBeLessThanOrEqual(2 * 1024 * 1024);
      const denied = await request.get(href);
      expect(denied.status()).toBe(401);
      expect(denied.headers()['content-type'] ?? '').not.toContain('image/jpeg');
      await expect(image).toBeVisible();
      await expect
        .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
        .toBeGreaterThan(0);
      expect(await image.evaluate((node) => getComputedStyle(node).objectFit)).toBe('cover');
      await expect(card.locator('video, audio')).toHaveCount(0);
      expect(tracker.originals).toEqual([]);
      expect(tracker.viewed).toEqual([]);
      await card.screenshot({ path: testInfo.outputPath(`${fixtureId}-thumbnail.png`) });
      await card
        .getByRole('button', { name: `Відкрити файл ${folder.entry.name}`, exact: true })
        .click();
      await expect
        .poll(() => tracker.viewed)
        .toContainEqual(
          expect.objectContaining({
            file_id: folder.entry.fileId,
            revision: folder.entry.revision,
          }),
        );
      await expect(page.getByTestId('device-file-content-pane')).toBeVisible();
      await expect.poll(() => tracker.originals.length).toBeGreaterThan(0);
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression #3930 persisted ZIP image and video members receive thumbnails and open their originals', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const deviceId = backend.fixtures.deviceId!;
    const source = await backend.login('source');
    const reader = await backend.login('reader');
    const image = await loadDeviceFilePreviewFixture('image-jpeg');
    const video = await loadDeviceFilePreviewFixture('video-mp4');
    const file = await syncPreviewFile(source, deviceId, {
      ...DEVICE_FILE_PREVIEW_FIXTURES.find((fixture) => fixture.id === 'archive-zip')!,
      id: `thumbnail-archive-${randomUUID()}`,
      fileName: 'thumbnails.zip',
    });
    await uploadPreviewContent(
      source,
      deviceId,
      file,
      Buffer.from(zipSync({ 'images/picture.jpg': image.bytes, 'movie.mp4': video.bytes })),
    );
    const archiveUrl = `/api/device/files/${deviceId}/${file.fileId}/revisions/${file.revision}/archive`;
    await expect
      .poll(
        async () => {
          const response = await reader.get(archiveUrl);
          expect(response.status()).toBe(200);
          return transformSnakeToCamel<DeviceArchiveStatus>(await response.json()).archive.state;
        },
        { timeout: 60_000, intervals: [1000] },
      )
      .toBe('ready');
    const browse = (parentEntryId: string) =>
      previewPost<BrowseDeviceFilesRsp>(reader, '/api/device/files/browse', {
        deviceId,
        parentEntryId,
        archiveRevision: file.revision,
      });
    const root = await browse(file.fileId);
    const movie = root.entries.find((entry) => entry.name === 'movie.mp4')!;
    const images = root.entries.find((entry) => entry.name === 'images')!;
    const picture = (await browse(images.entryId)).entries.find(
      (entry) => entry.name === 'picture.jpg',
    )!;
    const thumbnails: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path.endsWith('/thumbnail')) thumbnails.push(path);
    });
    const tracker = observeOriginalReadsAndViewedWrites(page);
    await page.context().addCookies((await reader.storageState()).cookies);
    await page.goto(
      `/devices/${deviceId}/files?directory=${file.fileId}&directory_revision=${file.revision}`,
    );
    const cards = page.getByRole('list', { name: 'Файли та папки' });
    for (const member of [movie, picture]) {
      expect(member.fileId).not.toBe(file.fileId);
      expect(member.archiveOrigin?.sourceFileId).toBe(file.fileId);
      const thumbnail = cards
        .locator(`[data-entry-id="${member.entryId}"]`)
        .locator('[data-device-file-thumbnail-image]');
      await expect
        .poll(() => thumbnail.evaluate((node: HTMLImageElement) => node.naturalWidth), {
          timeout: 60_000,
        })
        .toBeGreaterThan(0);
      expect(thumbnails).toContain(thumbnailUrl(deviceId, member.fileId!, member.revision!));
      expect(thumbnails).not.toContain(thumbnailUrl(deviceId, file.fileId, file.revision));
      expect(tracker.originals).toEqual([]);
      expect(tracker.viewed).toEqual([]);
      if (member === movie)
        await cards.getByRole('button', { name: 'Відкрити папку images', exact: true }).click();
    }
    await cards.getByRole('button', { name: 'Відкрити файл picture.jpg', exact: true }).click();
    const viewer = page.getByTestId('device-file-content-pane');
    await expect
      .poll(() =>
        viewer
          .locator('[data-image-preview-image]')
          .evaluate((node: HTMLImageElement) => node.naturalWidth),
      )
      .toBeGreaterThan(0);
    await expect
      .poll(() => tracker.viewed)
      .toContainEqual(
        expect.objectContaining({ file_id: picture.fileId, revision: picture.revision }),
      );
    expect(tracker.originals).toContain(
      `/api/device/files/${deviceId}/${picture.fileId}/revisions/${picture.revision}/content`,
    );
  } finally {
    await backend.dispose();
  }
});

test('@regression #3930 thumbnails limit requests, defer distant tiles and cancel when entering the table', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  const held: Route[] = [];
  try {
    const folder = await fixtureFolder(page, backend);
    const { bytes } = await loadDeviceFilePreviewFixture('image-jpeg');
    const entries = Array.from({ length: 40 }, (_, index) => {
      const id = `018f0000-0000-7000-8000-${String(index + 100).padStart(12, '0')}`;
      return { ...folder.entry, entryId: id, fileId: id, name: `photo-${index}.jpg` };
    });
    await mockDirectory(page, folder.directory, folder.entry.parentEntryId, () => entries);
    const requested: string[] = [];
    const failed = new Set<string>();
    let holdRequests = true;
    page.on('requestfailed', (request) => {
      if (new URL(request.url()).pathname.endsWith('/thumbnail')) failed.add(request.url());
    });
    await page.route('**/revisions/*/thumbnail*', async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      if (holdRequests) held.push(route);
      else await fulfillThumbnail(route, bytes);
    });
    await page.goto(folder.url);
    await expect.poll(() => requested.length).toBe(4);
    const last = entries.at(-1)!;
    const lastUrl = thumbnailUrl(folder.deviceId, last.fileId!, last.revision!);
    expect(requested).not.toContain(lastUrl);
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    await expect(page.getByRole('table', { name: 'Файли та папки' })).toBeVisible();
    await expect.poll(() => failed.size).toBe(4);
    await Promise.allSettled(held.splice(0).map((route) => route.abort()));
    expect(requested).toHaveLength(4);
    holdRequests = false;
    await page.getByRole('button', { name: 'Плитка', exact: true }).click();
    await expect.poll(() => requested.length).toBeGreaterThan(4);
    const cards = page.getByRole('list', { name: 'Файли та папки' });
    await cards.locator(`[data-entry-id="${last.entryId}"]`).scrollIntoViewIfNeeded();
    await expect.poll(() => requested).toContain(lastUrl);
    expect(requested.filter((url) => url === lastUrl)).toHaveLength(1);
  } finally {
    await page.goto('about:blank');
    for (const route of held) await route.abort().catch(() => {});
    await backend.dispose();
  }
});

test('@regression #3930 member thumbnails use their own revision and ignore stale responses after refresh', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  let delayed: Route | undefined;
  try {
    const folder = await fixtureFolder(page, backend);
    const { bytes } = await loadDeviceFilePreviewFixture('image-jpeg');
    let revision = 7;
    const entry = () => ({
      ...folder.entry,
      revision,
      archiveOrigin: {
        archiveId: '018f0000-0000-7000-8000-000000000500',
        sourceFileId: '018f0000-0000-7000-8000-000000000501',
        sourceRevision: 99,
      },
    });
    await mockDirectory(page, folder.directory, folder.entry.parentEntryId, () => [entry()]);
    const requested: string[] = [];
    await page.route('**/revisions/*/thumbnail*', async (route) => {
      const path = new URL(route.request().url()).pathname;
      requested.push(path);
      if (path.includes('/revisions/7/')) delayed = route;
      else await fulfillThumbnail(route, bytes);
    });
    const tracker = observeOriginalReadsAndViewedWrites(page);
    await page.goto(folder.url);
    const firstUrl = thumbnailUrl(folder.deviceId, folder.entry.fileId!, 7);
    await expect.poll(() => requested).toContain(firstUrl);
    revision = 8;
    await page.getByRole('button', { name: 'Розгорнути праву панель', exact: true }).click();
    await page.getByRole('button', { name: 'Оновити сесії', exact: true }).click();
    const secondUrl = thumbnailUrl(folder.deviceId, folder.entry.fileId!, 8);
    await expect.poll(() => requested).toContain(secondUrl);
    const image = page
      .getByRole('list', { name: 'Файли та папки' })
      .locator('[data-device-file-thumbnail-image]');
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
      .toBeGreaterThan(0);
    const currentSrc = await image.getAttribute('src');
    await delayed?.fulfill({ status: 422, json: { msg: 'Old revision failed' } }).catch(() => {});
    await expect(image).toHaveAttribute('src', currentSrc!);
    await expect(image.locator('..')).toHaveAttribute('data-device-file-thumbnail-state', 'loaded');
    expect(requested.every((url) => url === firstUrl || url === secondUrl)).toBe(true);
    expect(tracker.originals).toEqual([]);
    expect(tracker.viewed).toEqual([]);
  } finally {
    await page.goto('about:blank');
    await delayed?.abort().catch(() => {});
    await backend.dispose();
  }
});

test('@regression #3930 unavailable thumbnails retain icons without fetching originals or polling forever', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const folder = await fixtureFolder(page, backend);
    const entries = [
      { ...folder.entry, name: 'broken.jpg' },
      {
        ...folder.entry,
        entryId: '018f0000-0000-7000-8000-000000000600',
        fileId: '018f0000-0000-7000-8000-000000000600',
        name: 'missing.jpg',
        hasContent: false,
      },
      {
        ...folder.entry,
        entryId: '018f0000-0000-7000-8000-000000000601',
        fileId: '018f0000-0000-7000-8000-000000000601',
        name: 'large.jpg',
        sizeBytes: 1_000_000_001,
      },
    ];
    await mockDirectory(page, folder.directory, folder.entry.parentEntryId, () => entries);
    const requested: string[] = [];
    await page.route('**/revisions/*/thumbnail*', async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await route.fulfill({ status: 422, json: { msg: 'Cannot decode thumbnail' } });
    });
    const tracker = observeOriginalReadsAndViewedWrites(page);
    await page.goto(folder.url);
    const cards = page.getByRole('list', { name: 'Файли та папки' });
    await expect(cards.locator('[data-device-file-thumbnail-state="failed"]')).toHaveCount(1);
    await page.clock.install();
    await page.clock.fastForward(35_000);
    await expect(cards.locator('[data-device-file-thumbnail-image]')).toHaveCount(0);
    expect(requested).toEqual([
      thumbnailUrl(folder.deviceId, folder.entry.fileId!, folder.entry.revision!),
    ]);
    expect(tracker.originals).toEqual([]);
    expect(tracker.viewed).toEqual([]);
    for (const entry of entries)
      await expect(
        cards.getByRole('button', { name: `Відкрити файл ${entry.name}`, exact: true }),
      ).toBeEnabled();
  } finally {
    await backend.dispose();
  }
});
