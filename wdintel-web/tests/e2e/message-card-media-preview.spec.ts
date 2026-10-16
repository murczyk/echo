import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';

import {
  buildMessageCardMediaPreviewInboxResponse,
  createDeferredMediaResponse,
  KML_PREVIEW_FIXTURE,
  MACOS_ZIP_MEMBER_NAMES,
  MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES,
  openLegacyKmlPreviewHost,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

function resolveFixtureUrl(page: Page, pathname: string) {
  return new URL(pathname, page.url()).href;
}

async function expectDownloadFile(locator: Locator, fileName: string) {
  const [download] = await Promise.all([
    locator.page().waitForEvent('download'),
    locator.click({ force: true, noWaitAfter: true }),
  ]);
  expect(download.suggestedFilename()).toBe(fileName);
}

async function expectDownloadInsideTile(tile: Locator, fileName: string) {
  const download = tile.locator('[data-message-card-attachment-download="true"]');
  await expect(download).toBeVisible();
  const tileBox = await tile.boundingBox();
  const downloadBox = await download.boundingBox();
  if (tileBox == null || downloadBox == null) throw new Error('Attachment tile is not laid out');
  expect(downloadBox.x).toBeGreaterThanOrEqual(tileBox.x);
  expect(downloadBox.x + downloadBox.width).toBeLessThanOrEqual(tileBox.x + tileBox.width);
  await expectDownloadFile(download, fileName);
}

async function expectKmzDownloadChoice(
  dialog: Locator,
  label: string,
  fileName?: string,
  contents?: string,
) {
  const button = dialog.getByRole('button', { name: 'Скачати' });
  await button.focus();
  await button.press('Enter');
  const item = dialog.page().getByRole('menuitem', { name: label });
  await expect(item).toBeVisible();
  const [download] = await Promise.all([
    item.page().waitForEvent('download'),
    item.click({ force: true, noWaitAfter: true }),
  ]);
  if (fileName != null) expect(download.suggestedFilename()).toBe(fileName);
  if (contents != null) {
    const path = await download.path();
    if (path == null) throw new Error('Download has no local file');
    expect(await readFile(path, 'utf8')).toBe(contents);
  }
}

async function createPlayableVideoFixture(page: Page): Promise<Buffer> {
  const base64 = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 160;
    canvas.height = 90;
    const context = canvas.getContext('2d');
    context?.fillRect(0, 0, canvas.width, canvas.height);
    const recorder = new MediaRecorder(canvas.captureStream(10), {
      mimeType: 'video/webm;codecs=vp8',
    });
    const chunks: Blob[] = [];
    recorder.addEventListener('dataavailable', (event) => chunks.push(event.data));
    const stopped = new Promise<void>((resolve) =>
      recorder.addEventListener('stop', () => resolve()),
    );
    recorder.start();
    await new Promise((resolve) => setTimeout(resolve, 500));
    recorder.stop();
    await stopped;
    const bytes = new Uint8Array(await new Blob(chunks, { type: recorder.mimeType }).arrayBuffer());
    let text = '';
    for (const byte of bytes) text += String.fromCharCode(byte);
    return btoa(text);
  });
  return Buffer.from(base64, 'base64');
}

async function openImagePreview(page: Page) {
  await page.getByRole('button', { name: 'Відкрити зображення' }).first().click();
  return page.getByRole('dialog', { name: 'Перегляд зображення' });
}

async function openVideoPreview(page: Page) {
  await page.getByRole('button', { name: 'Відкрити відео' }).first().click();
  return page.getByRole('dialog', { name: 'Перегляд відео' });
}

async function openAudioPreviewFromMixedCarousel(page: Page) {
  const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
  if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
  await openImagePreview(page);
  for (let index = 0; index < 6; index += 1) {
    await page.getByRole('button', { name: 'Наступне' }).click();
  }
  return page.getByRole('dialog', { name: 'Перегляд аудіо' });
}

async function openTextPreview(page: Page) {
  const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
  if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
  await page
    .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text })
    .click();
  return page.getByRole('dialog', { name: 'Перегляд документа' });
}

async function openMarkdownPreview(page: Page) {
  const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
  if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
  await page
    .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown })
    .click();
  return page.getByRole('dialog', { name: 'Перегляд документа' });
}

async function openZipPreview(page: Page) {
  const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
  if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
  await page.getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.zip }).click();
  return page.getByRole('dialog', { name: 'Перегляд документа' });
}

async function openLegacyOfficePreview(page: Page, name: string) {
  const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
  if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
  await page.getByRole('button', { name }).click();
  return page.getByRole('dialog', { name: 'Перегляд документа' });
}

async function expectOpenInNewTab(link: Locator, expectedUrl: string) {
  await expect(link).toHaveAttribute('href', new URL(expectedUrl).pathname);
  await expect(link).toHaveAttribute('target', '_blank');
}

async function expectDownloadAndFilename(page: Page, link: Locator, expectedFilename: string) {
  const [download] = await Promise.all([page.waitForEvent('download'), link.click()]);
  expect(download.suggestedFilename()).toBe(expectedFilename);
}

async function expectPreviewCounter(dialog: Locator, value: string) {
  const counter = dialog.locator(`[data-attachment-preview-counter="true"]:visible`, {
    hasText: value,
  });
  await expect(counter).toHaveCount(1);
  await expect(counter).toHaveText(value);
}

async function verifyEscapeClose(page: Page, dialog: Locator, reopen: () => Promise<Locator>) {
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);

  dialog = await reopen();
  await expect(dialog.getByRole('button', { name: 'Повноекранний режим' })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Вийти з повноекранного режиму' })).toHaveCount(
    0,
  );
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

// Regression: https://github.com/echoua/echo/pull/3268
test.describe('@smoke @regression', () => {
  test('ECHO-3660 streams managed playback after readiness and retains original download controls', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');
    const fixture = await createPlayableVideoFixture(page);
    const originalUrl = '/api/messenger/media/browser-cache-test';
    const inbox = buildMessageCardMediaPreviewInboxResponse();
    const attachment = inbox.inbox_items[0][1].media?.find((item) => item.id === 'e2e-video-1');
    expect(attachment).toBeDefined();
    if (!attachment) throw new Error('Missing video fixture');
    attachment.href = originalUrl;
    await page.route('**/api/rer-importer/get-inbox', (route) => route.fulfill({ json: inbox }));
    let readinessRequests = 0;
    let streamingRequests = 0;
    await page.route('**/api/messenger/media/browser-cache-test**', async (route) => {
      const request = route.request();
      if (new URL(request.url()).pathname.endsWith('/playback')) {
        if (request.headers()['x-echo-media-cache-preflight'] === '1') {
          readinessRequests += 1;
          expect(request.headers().range).toBe('bytes=0-0');
          if (readinessRequests === 1) {
            await route.fulfill({ status: 503, headers: { 'Retry-After': '2' } });
            return;
          }
        } else {
          streamingRequests += 1;
        }
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers().range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2]
          ? Math.min(Number(range[2]), fixture.length - 1)
          : fixture.length - 1;
        await route.fulfill({
          status: range ? 206 : 200,
          contentType: 'video/webm',
          headers: {
            'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${fixture.length}` } : {}),
          },
          body: fixture.subarray(start, end + 1),
        });
        return;
      }
      await route.fulfill({ status: 404 });
    });
    await page.reload();
    await page.getByRole('button', { name: /^Розгорнути медіа:/ }).click();
    const dialog = await openVideoPreview(page);
    const video = dialog.locator('video');
    await expect(video).toHaveAttribute('src', resolveFixtureUrl(page, `${originalUrl}/playback`));
    await video.evaluate(async (element) => {
      element.muted = true;
      element.loop = true;
      await element.play();
    });
    await expect(video).toHaveJSProperty('paused', false);
    expect(readinessRequests).toBe(2);
    expect(streamingRequests).toBeGreaterThan(0);
    await expect(dialog.getByRole('link', { name: 'Відкрити в новій вкладці' })).toHaveAttribute(
      'href',
      originalUrl,
    );
    await expect(dialog.getByRole('button', { name: 'Скачати' })).toBeVisible();
  });

  test('ECHO-3769 starts streaming, retries a busy segment, seeks, and stops on close', async ({
    page,
  }) => {
    const directory = await mkdtemp(resolve(tmpdir(), 'echo-video-preview-'));
    try {
      for (const start of [0, 8]) {
        const length = start === 0 ? 8 : 4;
        execFileSync('ffmpeg', [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'testsrc2=size=320x180:rate=30',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=440:sample_rate=48000',
          '-t',
          String(length),
          '-c:v',
          'libx264',
          '-threads',
          '2',
          '-preset',
          'ultrafast',
          '-tune',
          'zerolatency',
          '-g',
          '30',
          '-sc_threshold',
          '0',
          '-c:a',
          'aac',
          '-af',
          'aresample=48000,atrim=end=' + (length - 1024 / 48000) + ',asetpts=PTS+1024',
          '-avoid_negative_ts',
          'disabled',
          '-output_ts_offset',
          String(start),
          '-muxdelay',
          '0',
          '-f',
          'hls',
          '-hls_time',
          '1',
          '-hls_playlist_type',
          'vod',
          '-hls_flags',
          'temp_file+independent_segments',
          '-start_number',
          String(start),
          '-hls_segment_filename',
          resolve(directory, '%d.ts'),
          resolve(directory, 'part' + start + '.m3u8'),
        ]);
      }
      await writeFile(
        resolve(directory, 'preview.m3u8'),
        '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXT-X-INDEPENDENT-SEGMENTS\n' +
          Array.from({ length: 12 }, (_, index) => '#EXTINF:1.000000,\n' + index + '.ts\n').join(
            '',
          ) +
          '#EXT-X-ENDLIST\n',
      );
      await openMessageCardPreviewHost(page, 'duty');
      const originalUrl = '/api/messenger/media/streaming-preview-test';
      const inbox = buildMessageCardMediaPreviewInboxResponse();
      const attachment = inbox.inbox_items[0][1].media?.find((item) => item.id === 'e2e-video-1');
      if (!attachment) throw new Error('Missing video fixture');
      attachment.href = originalUrl;
      await page.route('**/api/rer-importer/get-inbox', (route) => route.fulfill({ json: inbox }));
      let segmentRequests = 0;
      let originalRequests = 0;
      await page.route('**/api/messenger/media/streaming-preview-test**', async (route) => {
        const path = new URL(route.request().url()).pathname;
        if (path === originalUrl) {
          originalRequests += 1;
          await route.fulfill({ status: 500 });
        } else if (path.endsWith('/playback')) {
          await route.fulfill({
            status: 307,
            headers: { Location: originalUrl + '/playback/preview.m3u8' },
          });
        } else if (path.endsWith('.m3u8')) {
          await route.fulfill({
            contentType: 'application/vnd.apple.mpegurl',
            body: await readFile(resolve(directory, 'preview.m3u8')),
          });
        } else {
          segmentRequests += 1;
          if (segmentRequests === 1) {
            await route.fulfill({ status: 503, headers: { 'Retry-After': '1' } });
            return;
          }
          const name = path.split('/').pop()!;
          await route.fulfill({
            contentType: 'video/mp2t',
            body: await readFile(resolve(directory, name)),
          });
        }
      });
      await page.reload();
      await page.getByRole('button', { name: /^Розгорнути медіа:/ }).click();
      const dialog = await openVideoPreview(page);
      const video = dialog.locator('video');
      await expect
        .poll(() => video.evaluate((video) => video.readyState))
        .toBeGreaterThanOrEqual(2);
      await video.evaluate(async (video) => {
        video.muted = true;
        await video.play();
      });
      await expect.poll(() => video.evaluate((video) => video.currentTime)).toBeGreaterThan(2.5);
      await video.evaluate((video) => {
        video.currentTime = 10;
      });
      await expect.poll(() => video.evaluate((video) => video.currentTime)).toBeGreaterThan(10.5);
      await video.evaluate((video) => {
        video.currentTime = 7;
      });
      await expect.poll(() => video.evaluate((video) => video.currentTime)).toBeGreaterThan(9);
      expect(originalRequests).toBe(0);
      await expect(dialog.getByRole('link', { name: 'Відкрити в новій вкладці' })).toHaveAttribute(
        'href',
        originalUrl,
      );
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      const countAfterClose = segmentRequests;
      await page.waitForTimeout(1000);
      expect(segmentRequests).toBe(countAfterClose);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} document, map, and other attachment tiles download inside their borders`, async ({
      page,
    }) => {
      await openMessageCardPreviewHost(page, host, { withZip: true, withKmlPreviews: true });
      const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
      if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
      const tiles = page.locator('[data-message-card-attachment-tile="true"]');

      await expectDownloadInsideTile(
        tiles.filter({
          has: page.getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text }),
        }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text,
      );
      await expectDownloadInsideTile(
        tiles.filter({ hasText: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.binary }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.binary,
      );
      await expectDownloadInsideTile(
        tiles.filter({
          has: page.getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kml }),
        }),
        'e2e-route_files.zip',
      );
      await expectDownloadInsideTile(
        tiles.filter({
          has: page.getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kmz }),
        }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kmz,
      );
      await expectDownloadInsideTile(
        tiles.filter({
          has: page.getByRole('button', {
            name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.denseKml,
          }),
        }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.denseKml,
      );
    });
  }

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} ZIP previews download a member and navigate to an adjacent document`, async ({
      page,
    }) => {
      await openMessageCardPreviewHost(page, host, { withZip: true });
      let releaseZip!: () => void;
      const zipReady = new Promise<void>((resolve) => {
        releaseZip = resolve;
      });
      await page.route(
        '**/test-assets/message-card-media-preview/e2e-preview.zip',
        async (route) => {
          await zipReady;
          await route.fallback();
        },
      );
      const dialog = await openZipPreview(page);
      try {
        const stage = dialog.locator('[data-attachment-preview-swipe-content]');
        const loading = dialog.getByRole('status');
        await expect(loading).toBeVisible();
        const stageBox = await stage.boundingBox();
        const loadingBox = await loading.boundingBox();
        if (stageBox == null || loadingBox == null)
          throw new Error('ZIP loading stage is not laid out');
        expect(
          Math.abs(loadingBox.x + loadingBox.width / 2 - stageBox.x - stageBox.width / 2),
        ).toBeLessThan(2);
        expect(
          Math.abs(loadingBox.y + loadingBox.height / 2 - stageBox.y - stageBox.height / 2),
        ).toBeLessThan(2);
      } finally {
        releaseZip();
      }
      await expect(dialog.getByText('nested/member.txt')).toBeVisible();
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        dialog.getByRole('button', { name: 'Скачати nested/member.txt' }).click(),
      ]);
      expect(download.suggestedFilename()).toBe('member.txt');
      await dialog.getByRole('button', { name: 'Попереднє' }).click();
      await expect(dialog.getByText('E2E Markdown preview')).toBeVisible();
    });
  }

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} ZIP MIME opens a misleading PDF-named archive`, async ({ page }) => {
      await openMessageCardPreviewHost(page, host, { withZip: true });
      const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
      if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.misleadingZip })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Перегляд документа' });
      await expect(dialog.getByText('nested/member.txt')).toBeVisible();
      await expectDownloadFile(
        dialog.getByRole('button', { name: 'Скачати nested/member.txt' }),
        'member.txt',
      );
      await expectDownloadFile(
        dialog.getByRole('link', { name: 'Скачати' }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.misleadingZip,
      );
    });
  }

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} macOS ZIP preview shows Cyrillic files without Finder metadata`, async ({
      page,
    }) => {
      await openMessageCardPreviewHost(page, host, { withZip: true });
      const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
      if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.macZip })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Перегляд документа' });
      await expect(dialog.getByText('Файлів: 5;', { exact: false })).toBeVisible();
      for (const name of MACOS_ZIP_MEMBER_NAMES)
        await expect(dialog.getByText(name, { exact: true })).toBeVisible();
      const rows = dialog.locator('[data-zip-entry-index]');
      await expect(
        rows.filter({ hasText: 'Фото.png' }).locator('svg[data-testid="ImageIcon"]'),
      ).toBeVisible();
      await expect(
        rows.filter({ hasText: 'Мапа.kml' }).locator('svg[data-testid="MapOutlinedIcon"]'),
      ).toBeVisible();
      await expect(
        rows.filter({ hasText: 'Наказ.pdf' }).locator('svg[data-testid="DescriptionOutlinedIcon"]'),
      ).toBeVisible();
      const row = rows.filter({ hasText: 'Звіт.txt' });
      const nameBox = await row.locator('[data-zip-entry-name="true"]').boundingBox();
      const sizeBox = await row.locator('[data-zip-entry-size="true"]').boundingBox();
      const downloadBox = await row.getByRole('button', { name: 'Скачати Звіт.txt' }).boundingBox();
      if (nameBox == null || sizeBox == null || downloadBox == null)
        throw new Error('ZIP member row is not laid out');
      expect(nameBox.x + nameBox.width).toBeLessThanOrEqual(sizeBox.x + 1);
      expect(sizeBox.x + sizeBox.width).toBeLessThanOrEqual(downloadBox.x + 1);
      expect(
        Math.abs(nameBox.y + nameBox.height / 2 - sizeBox.y - sizeBox.height / 2),
      ).toBeLessThan(2);
      await expect(dialog.getByText('__MACOSX', { exact: false })).toHaveCount(0);
      await expect(dialog.getByText('._', { exact: false })).toHaveCount(0);
      await expectDownloadFile(
        dialog.getByRole('button', { name: `Скачати ${MACOS_ZIP_MEMBER_NAMES[0]}` }),
        MACOS_ZIP_MEMBER_NAMES[0],
      );
      await expectDownloadFile(
        dialog.getByRole('link', { name: 'Скачати' }),
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.macZip,
      );
    });
  }

  for (const host of ['duty', 'analysis'] as const) {
    // Regression: https://github.com/echoua/echo/issues/3405
    test(`${host} message card preview smoke covers the shared contract`, async ({ page }) => {
      await openMessageCardPreviewHost(page, host, { withLegacyOffice: true });

      await expect(
        page.getByRole('link', {
          name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1}`,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Відкрити аудіо:/ })).toHaveCount(0);
      await expect(
        page.getByRole('link', {
          name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1}`,
        }),
      ).toBeVisible();

      const imageDialog = await openImagePreview(page);
      await expect(imageDialog).toBeVisible();
      await expect(imageDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
      await expect(
        imageDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      ).toBeVisible();
      await expect(imageDialog.getByRole('link', { name: 'Скачати' })).toBeVisible();
      await imageDialog.getByRole('button', { name: 'Закрити' }).click();

      const videoDialog = await openVideoPreview(page);
      await expect(videoDialog).toBeVisible();
      await expect(videoDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
      await expect(
        videoDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      ).toBeVisible();
      await expect(videoDialog.getByRole('button', { name: 'Скачати' })).toBeVisible();
      await videoDialog.getByRole('button', { name: 'Закрити' }).click();

      const textDialog = await openTextPreview(page);
      await expect(textDialog).toBeVisible();
      await expect(page.getByText('E2E TXT preview line 1')).toBeVisible();
      await expect(textDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
      await expect(
        textDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      ).toBeVisible();
      await expect(textDialog.getByRole('link', { name: 'Скачати' })).toBeVisible();
      await expect(textDialog.getByRole('button', { name: 'Повноекранний режим' })).toHaveCount(0);
      await expect(
        textDialog.getByRole('button', { name: 'Вийти з повноекранного режиму' }),
      ).toHaveCount(0);
      await textDialog.getByRole('button', { name: 'Закрити' }).click();

      const markdownDialog = await openMarkdownPreview(page);
      await expect(markdownDialog).toBeVisible();
      await expect(
        markdownDialog.getByRole('heading', { name: 'E2E Markdown preview', level: 1 }),
      ).toBeVisible();
      await expect(markdownDialog.getByText('first item')).toBeVisible();
      await markdownDialog.getByRole('button', { name: 'Закрити' }).click();

      const docDialog = await openLegacyOfficePreview(
        page,
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.doc,
      );
      await expect(docDialog.getByText('Український абзац')).toBeVisible();
      await expect(docDialog.locator('table').first()).toBeVisible();
      expect(
        await docDialog.locator('ol').evaluateAll((lists) => {
          const [outer, nested] = lists;
          return (
            lists.every((list) => {
              return getComputedStyle(list).listStyleType === 'none';
            }) &&
            outer != null &&
            nested != null &&
            nested.getBoundingClientRect().left > outer.getBoundingClientRect().left
          );
        }),
      ).toBe(true);
      expect(
        await docDialog.locator('ul').evaluateAll((lists) => {
          return lists.every((list) => getComputedStyle(list).listStyleType === 'none');
        }),
      ).toBe(true);
      await expect(docDialog.getByRole('link', { name: 'Скачати' })).toBeVisible();
      await docDialog.getByRole('button', { name: 'Закрити' }).click();

      const xlsDialog = await openLegacyOfficePreview(
        page,
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.xls,
      );
      await expect(xlsDialog.getByText('Ідентифікатор')).toBeVisible();
      await xlsDialog.getByRole('button', { name: 'Sparse' }).click();
      await expect(xlsDialog.getByText('Змішані текст')).toBeVisible();
      await expect(xlsDialog.getByRole('link', { name: 'Скачати' })).toBeVisible();
      await xlsDialog.getByRole('button', { name: 'Закрити' }).click();
    });
  }

  test('ECHO-3521 keeps conversion retry visible until the converted KMZ is ready @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty', { withKmlPreviews: true });
    let conversionStatus = 'error';
    let statusPolls = 0;
    let releaseRetry!: () => void;
    const retryResponseGate = new Promise<void>((resolve) => {
      releaseRetry = resolve;
    });
    await page.route('**/api/messenger/media/e2e-kml/kmz-conversion/status', (route) => {
      statusPolls += 1;
      return route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          status: conversionStatus,
          error: conversionStatus === 'error' ? 'worker.rs line 251' : null,
          converted_file_name: conversionStatus === 'done' ? 'e2e-route_converted.kmz' : null,
        }),
      });
    });
    await page.route('**/api/messenger/media/e2e-kml/kmz-conversion/retry', async (route) => {
      await retryResponseGate;
      conversionStatus = 'pending';
      await route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({ status: 'pending', error: null, converted_file_name: null }),
      });
    });

    const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
    if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
    await page
      .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kml })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Попередній перегляд KML' });
    await expect(dialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
    const retryButton = dialog.getByRole('button', { name: 'Повторити конвертацію KMZ' });
    await expect(retryButton).toBeVisible();
    await retryButton.hover();
    const tooltip = page.getByRole('tooltip');
    await expect(tooltip).toContainText('Повторити конвертацію KMZ');
    await expect(tooltip.getByText('worker.rs line 251')).toBeHidden();
    await tooltip.getByText('Технічні деталі').click();
    await expect(tooltip.getByText('worker.rs line 251')).toBeVisible();

    await retryButton.click();
    const progressButton = dialog.getByRole('button', { name: 'Конвертація KMZ триває' });
    await expect(progressButton).toBeVisible();
    await expect(progressButton).toBeDisabled();
    releaseRetry();
    await expect.poll(() => statusPolls).toBeGreaterThan(1);
    await expect(progressButton).toBeVisible();
    conversionStatus = 'done';
    await expect(retryButton).toHaveCount(0);
    await expect(progressButton).toHaveCount(0);
    await expect(page.getByText('Конвертований KMZ готовий до завантаження.')).toBeVisible();
    await expectKmzDownloadChoice(
      dialog,
      'Завантажити конвертований KMZ',
      'e2e-route_converted.kmz',
    );
  });

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} legacy Elm route previews native KML/KMZ and preserves downloads`, async ({
      page,
    }) => {
      const requests: string[] = [];
      let downloads = 0;
      page.on('request', (request) => requests.push(request.url()));
      page.on('download', () => {
        downloads += 1;
      });
      await openLegacyKmlPreviewHost(page, host);

      const beforeKmlRequests = requests.length;
      await page.getByRole('button', { name: 'legacy-route.kml' }).click();
      const kmlDialog = page.getByRole('dialog', { name: 'Попередній перегляд KML' });
      await expect(kmlDialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      await expect
        .poll(() => requests.slice(beforeKmlRequests))
        .toContainEqual(
          expect.stringContaining('/api/messenger/media/legacy-kml/kmz-conversion/status'),
        );
      await expectKmzDownloadChoice(kmlDialog, 'Завантажити оригінал', 'legacy-route.kml');
      await expectKmzDownloadChoice(
        kmlDialog,
        'Завантажити конвертований KMZ',
        'legacy-route_converted.kmz',
      );
      await kmlDialog.getByRole('button', { name: 'Закрити' }).click();

      for (const [fileName, label, originalFileName] of [
        ['legacy-route.kmz', 'Попередній перегляд KMZ', 'e2e-route.kmz'],
      ] as const) {
        const beforeRequests = requests.length;
        await page.getByRole('button', { name: fileName, exact: true }).click();
        const dialog = page.getByRole('dialog', { name: label });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
        await expect
          .poll(() => requests.slice(beforeRequests))
          .toContainEqual(
            expect.stringContaining(`/test-assets/message-card-media-preview/${originalFileName}`),
          );
        expect(requests.slice(beforeRequests)).not.toContainEqual(
          expect.stringContaining('/kmz-conversion/status'),
        );
        const downloadButton = dialog.getByRole('button', { name: 'Скачати' });
        await downloadButton.click();
        const originalDownload = page.getByRole('menuitem', { name: 'Завантажити оригінал' });
        await expect(originalDownload).toBeVisible();
        await expect(
          page.getByRole('menuitem', { name: 'Завантажити конвертований KMZ' }),
        ).toHaveCount(0);
        const downloadsBefore = downloads;
        await originalDownload.click({ noWaitAfter: true });
        await downloadButton.click();
        await originalDownload.click({ force: true, noWaitAfter: true });
        await expect.poll(() => downloads).toBe(downloadsBefore + 1);
        await dialog.getByRole('button', { name: 'Закрити' }).click();
      }

      const beforeMimeOnlyKmlRequests = requests.length;
      const mimeOnlyKmlSource = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/test-assets/message-card-media-preview/legacy-kml-without-extension') &&
          response.request().method() === 'GET',
      );
      const mimeOnlyKmlStatus = page.waitForResponse(
        (response) =>
          response
            .url()
            .includes('/api/messenger/media/legacy-kml-without-extension/kmz-conversion/status') &&
          response.request().method() === 'GET',
      );
      await page.getByRole('button', { name: 'legacy-route', exact: true }).click();
      const mimeOnlyKmlDialog = page.getByRole('dialog', { name: 'Попередній перегляд KML' });
      await expect(mimeOnlyKmlDialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      expect((await mimeOnlyKmlSource).headers()['content-disposition']).toBe(
        "inline; filename*=UTF-8''legacy-route",
      );
      expect((await mimeOnlyKmlStatus).status()).toBe(404);
      await expect
        .poll(() => requests.slice(beforeMimeOnlyKmlRequests))
        .toContainEqual(
          expect.stringContaining(
            '/api/messenger/media/legacy-kml-without-extension/kmz-conversion/status',
          ),
        );
      await expect(
        mimeOnlyKmlDialog.getByRole('button', { name: 'Повторити конвертацію KMZ' }),
      ).toHaveCount(0);
      await mimeOnlyKmlDialog.getByRole('button', { name: 'Скачати' }).click();
      await expect(page.getByRole('menuitem', { name: 'Завантажити оригінал' })).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: 'Завантажити конвертований KMZ' }),
      ).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expectKmzDownloadChoice(
        mimeOnlyKmlDialog,
        'Завантажити оригінал',
        undefined,
        `${KML_PREVIEW_FIXTURE}\n`,
      );
      await mimeOnlyKmlDialog.getByRole('button', { name: 'Закрити' }).click();

      const beforeMimeOnlyKmzRequests = requests.length;
      await page.getByRole('button', { name: 'legacy-route.bin', exact: true }).click();
      const mimeOnlyKmzDialog = page.getByRole('dialog', { name: 'Попередній перегляд KMZ' });
      await expect(mimeOnlyKmzDialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      expect(requests.slice(beforeMimeOnlyKmzRequests)).not.toContainEqual(
        expect.stringContaining('/kmz-conversion/status'),
      );
      await mimeOnlyKmzDialog.getByRole('button', { name: 'Скачати' }).click();
      await expect(page.getByRole('menuitem', { name: 'Завантажити оригінал' })).toBeVisible();
      await expect(
        page.getByRole('menuitem', { name: 'Завантажити конвертований KMZ' }),
      ).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expectKmzDownloadChoice(mimeOnlyKmzDialog, 'Завантажити оригінал', 'legacy-route.bin');
      await mimeOnlyKmzDialog.getByRole('button', { name: 'Закрити' }).click();

      await expect(page.getByRole('link', { name: 'legacy-not-geodata.bin' })).toBeVisible();

      const beforeLimitRequests = requests.length;
      await page.getByRole('button', { name: 'legacy-oversized.kml' }).click();
      const limitDialog = page.getByRole('dialog', { name: 'Попередній перегляд KML' });
      await expect(
        limitDialog.getByText(
          'Перевищено ліміт попереднього перегляду 25 МіБ. Оригінал можна завантажити.',
        ),
      ).toBeVisible();
      expect(requests.slice(beforeLimitRequests)).not.toContainEqual(
        expect.stringContaining('/test-assets/message-card-media-preview/e2e-route.kml'),
      );
      await expectKmzDownloadChoice(limitDialog, 'Завантажити оригінал', 'legacy-oversized.kml');
      await limitDialog.getByRole('button', { name: 'Закрити' }).click();

      const beforeConvertedRequests = requests.length;
      await page.getByRole('button', { name: 'legacy-route.gpx' }).click();
      const convertedDialog = page.getByRole('dialog', {
        name: 'Попередній перегляд конвертованого KMZ',
      });
      await expect(convertedDialog).toBeVisible();
      await expect(convertedDialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      await expect
        .poll(() => requests.slice(beforeConvertedRequests))
        .toContainEqual(
          expect.stringContaining('/api/messenger/media/legacy-gpx/kmz-conversion/status'),
        );
      await expectKmzDownloadChoice(
        convertedDialog,
        'Завантажити конвертований KMZ',
        'legacy-route_converted.kmz',
      );
      await expectKmzDownloadChoice(convertedDialog, 'Завантажити оригінал', 'legacy-route.gpx');
    });
  }

  test('duty message card preview stays open and closes on mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await openMessageCardPreviewHost(page, 'duty');

    const imageDialog = await openImagePreview(page);
    await expect(imageDialog).toBeVisible();
    await imageDialog.getByRole('button', { name: 'Закрити' }).click();
    await expect(imageDialog).toHaveCount(0);
  });

  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} native KML and KMZ previews retain map and carousel behavior`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 375, height: 844 });
      await openMessageCardPreviewHost(page, host, { withKmlPreviews: true });
      const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
      if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();

      await expectDownloadFile(
        page.getByRole('link', {
          name: `Завантажити оригінал і конвертований KMZ: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kml}`,
        }),
        'e2e-route_files.zip',
      );
      await expect(
        page.getByRole('link', {
          name: `Завантажити оригінал і конвертований KMZ: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kmz}`,
        }),
      ).toHaveCount(0);

      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kml })
        .click();
      await expect(page.getByRole('dialog', { name: 'Попередній перегляд KML' })).toBeVisible();
      const dialog = page.getByRole('dialog');
      await expect(dialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      await expectKmzDownloadChoice(
        dialog,
        'Завантажити оригінал',
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kml,
      );
      await expect(dialog.getByRole('button', { name: 'Закрити' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Попереднє' })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Наступне' })).toBeVisible();
      await expectKmzDownloadChoice(
        dialog,
        'Завантажити конвертований KMZ',
        'e2e-route_converted.kmz',
      );

      const counter = dialog.locator('[data-attachment-preview-counter="true"]:visible');
      const beforeDrag = await counter.textContent();
      const map = dialog.locator('[data-kmz-preview-map="true"]');
      const box = await map.boundingBox();
      if (box == null) throw new Error('KMZ preview map is not laid out');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20);
      await page.mouse.up();
      await expect(counter).toHaveText(beforeDrag ?? '');

      await dialog.getByRole('button', { name: 'Закрити' }).click();
      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kmz })
        .click();
      await expect(page.getByRole('dialog', { name: 'Попередній перегляд KMZ' })).toBeVisible();
      await expect(dialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      await expectKmzDownloadChoice(
        dialog,
        'Завантажити оригінал',
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.kmz,
      );
      await expect(
        page.getByRole('menuitem', { name: 'Завантажити конвертований KMZ' }),
      ).toHaveCount(0);
      await dialog.getByRole('button', { name: 'Скачати' }).click();
      await expect(page.getByRole('menuitem', { name: 'Завантажити оригінал' })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('menuitem', { name: 'Завантажити оригінал' })).toHaveCount(0);
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Закрити' }).click();

      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.gpx })
        .click();
      await expect(
        page.getByRole('dialog', { name: 'Попередній перегляд конвертованого KMZ' }),
      ).toBeVisible();
      await expect(dialog.locator('[data-kmz-preview-map="true"]')).toBeVisible();
      await expectKmzDownloadChoice(
        dialog,
        'Завантажити оригінал',
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.gpx,
      );
      await expectKmzDownloadChoice(
        dialog,
        'Завантажити конвертований KMZ',
        'e2e-route_converted.kmz',
      );
    });

    test(`${host} dense point-only KML keeps a stable map while zooming into details`, async ({
      page,
    }) => {
      await openMessageCardPreviewHost(page, host, { withKmlPreviews: true });
      const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
      if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
      await page
        .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.denseKml })
        .click();
      const dialog = page.getByRole('dialog', { name: 'Попередній перегляд KML' });
      const map = dialog.locator('[data-kmz-preview-map="true"]');
      await expect(map).toBeVisible();
      await expect(map).toHaveAttribute('data-kmz-preview-point-mode', 'overview');
      const mapIdentity = await map.evaluate((element) => {
        const identity = crypto.randomUUID();
        element.setAttribute('data-e2e-map-identity', identity);
        return identity;
      });
      const box = await map.boundingBox();
      if (box == null) throw new Error('Dense KML preview map is not laid out');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      for (let index = 0; index < 5; index += 1) await page.mouse.wheel(0, -480);
      await expect(map).toHaveAttribute('data-kmz-preview-point-mode', 'detail');
      await expect(map).toHaveAttribute('data-e2e-map-identity', mapIdentity);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2 + 80, box.y + box.height / 2 + 20);
      await page.mouse.up();
      await expect(map).toHaveAttribute('data-kmz-preview-point-mode', 'detail');
    });
  }

  test('DOC/XLS malformed input preserves the shared download fallback', async ({ page }) => {
    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host, { withLegacyOffice: true });
      await page.route(
        `**/test-assets/message-card-media-preview/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.xls}`,
        (route) =>
          route.fulfill({ contentType: 'application/vnd.ms-excel', body: 'not a CFB file' }),
      );

      const dialog = await openLegacyOfficePreview(
        page,
        MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.xls,
      );
      await expect(dialog.getByText('Помилка перегляду')).toBeVisible();
      await expect(dialog.getByRole('link', { name: 'Скачати' })).toBeVisible();
      await dialog.getByRole('button', { name: 'Закрити' }).click();
    }
  });

  test('DOC table-cell paragraphs retain visible line breaks', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty', { withLegacyOffice: true });
    await page.route('**/test-assets/message-card-media-preview/e2e-preview.doc', async (route) => {
      await route.fulfill({
        contentType: 'application/msword',
        body: await readFile(
          resolve(process.cwd(), 'tests/fixtures/legacy-office/table-cell-paragraphs.doc'),
        ),
      });
    });

    const dialog = await openLegacyOfficePreview(
      page,
      MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.doc,
    );
    const cell = dialog.locator('td', { hasText: 'First cell paragraph one' });
    await expect(cell).toHaveText('First cell paragraph one\nFirst cell paragraph two');
    await expect(cell).toHaveCSS('white-space', 'pre-line');
  });

  test('image thumbnail loading fills the tile without blocking its download overlay', async ({
    page,
  }) => {
    for (const host of ['duty', 'analysis'] as const) {
      const deferredImageResponse = createDeferredMediaResponse();
      try {
        await openMessageCardPreviewHost(page, host, { deferredImageResponse });
        await deferredImageResponse.waitForRequest();

        const preview = page.getByRole('button', { name: 'Відкрити зображення' }).first();
        const shell = preview.locator('..');
        const skeleton = preview.locator('[data-message-card-thumbnail-skeleton="true"]');
        const download = shell.getByRole('link', { name: /Завантажити вкладення:/ });
        await expect(skeleton).toBeVisible();
        await expect(download).toBeVisible();
        const [shellBox, previewBox, skeletonBox, downloadBox] = await Promise.all([
          shell.boundingBox(),
          preview.boundingBox(),
          skeleton.boundingBox(),
          download.boundingBox(),
        ]);
        expect(shellBox?.width).toBe(72);
        expect(shellBox?.height).toBe(72);
        expect(previewBox).toEqual(shellBox);
        expect(skeletonBox).toEqual(shellBox);
        expect(downloadBox?.x).toBeGreaterThanOrEqual((shellBox?.x ?? 0) + 45);
        expect(downloadBox?.y).toBeGreaterThanOrEqual(shellBox?.y ?? 0);
        expect((downloadBox?.x ?? 0) + (downloadBox?.width ?? 0)).toBeLessThanOrEqual(
          (shellBox?.x ?? 0) + (shellBox?.width ?? 0),
        );
        expect((downloadBox?.y ?? 0) + (downloadBox?.height ?? 0)).toBeLessThanOrEqual(
          (shellBox?.y ?? 0) + (shellBox?.height ?? 0),
        );

        deferredImageResponse.release();
        await expect(preview).toHaveAttribute('data-picture-thumb-state', 'loaded');
        const image = preview.locator('img');
        await expect(image).toBeVisible();
        expect(await image.boundingBox()).toEqual(shellBox);

        await expectDownloadAndFilename(
          page,
          download,
          MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1,
        );
        await expect(page.getByRole('dialog', { name: 'Перегляд зображення' })).toHaveCount(0);
        await download.hover();
        await expect(page.getByRole('tooltip', { name: /Завантажити вкладення:/ })).toBeVisible();
        await preview.click({ position: { x: 12, y: 60 } });
        const dialog = page.getByRole('dialog', { name: 'Перегляд зображення' });
        await expect(dialog).toBeVisible();
        await dialog.getByRole('button', { name: 'Закрити' }).click();
      } finally {
        deferredImageResponse.release();
      }
    }
  });
});

test.describe('message card media preview contract', () => {
  // Regression: https://github.com/echoua/echo/issues/3368
  test('ECHO-3368 centres every primary image-click zoom @regression', async ({ page }) => {
    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host);
      const dialog = await openImagePreview(page);
      const image = dialog.locator('[data-image-preview-image]');
      const positions = [
        { horizontal: 0.5, vertical: 0.5 },
        { horizontal: 0.05, vertical: 0.5 },
        { horizontal: 0.95, vertical: 0.5 },
        { horizontal: 0.5, vertical: 0.05 },
        { horizontal: 0.5, vertical: 0.95 },
      ];
      for (const position of positions) {
        const box = await image.boundingBox();
        expect(box).not.toBeNull();
        const point = {
          x: (box?.x ?? 0) + (box?.width ?? 0) * position.horizontal,
          y: (box?.y ?? 0) + (box?.height ?? 0) * position.vertical,
        };
        await page.mouse.click(point.x, point.y);
        await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
        await expect(image).toHaveAttribute('data-image-preview-pan-x', '0');
        await expect(image).toHaveAttribute('data-image-preview-pan-y', '0');
        await page.waitForTimeout(600);
        await page.mouse.click(point.x, point.y);
        await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
        await page.waitForTimeout(400);
      }
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3368
  test('ECHO-3368 zooms image clicks and dismisses only exposed image-stage background @regression', async ({
    page,
  }) => {
    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host);
      const dialog = await openImagePreview(page);
      const stage = dialog.locator('[data-image-preview-stage]');
      const image = dialog.locator('[data-image-preview-image]');
      await expect(image).toBeVisible();
      await image.click({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');

      await page.waitForTimeout(600);
      await image.dblclick({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
      await expect(dialog).toBeVisible();

      await page.waitForTimeout(600);
      await image.click({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');

      const imageBox = await image.boundingBox();
      const initialPanY = await image.getAttribute('data-image-preview-pan-y');
      expect(imageBox).not.toBeNull();
      await page.mouse.move(
        (imageBox?.x ?? 0) + (imageBox?.width ?? 0) / 2,
        (imageBox?.y ?? 0) + (imageBox?.height ?? 0) / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        (imageBox?.x ?? 0) + (imageBox?.width ?? 0) / 2 + 60,
        (imageBox?.y ?? 0) + (imageBox?.height ?? 0) / 2 + 20,
      );
      await page.mouse.up();
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
      await expect(image).not.toHaveAttribute('data-image-preview-pan-y', initialPanY ?? '0');
      await expect(dialog).toBeVisible();

      const returnStartPanY = await image.getAttribute('data-image-preview-pan-y');
      await page.mouse.move(
        (imageBox?.x ?? 0) + (imageBox?.width ?? 0) / 2,
        (imageBox?.y ?? 0) + (imageBox?.height ?? 0) / 2,
      );
      await page.mouse.down();
      await page.mouse.move(
        (imageBox?.x ?? 0) + (imageBox?.width ?? 0) / 2 - 40,
        (imageBox?.y ?? 0) + (imageBox?.height ?? 0) / 2,
      );
      await page.mouse.move(
        (imageBox?.x ?? 0) + (imageBox?.width ?? 0) / 2,
        (imageBox?.y ?? 0) + (imageBox?.height ?? 0) / 2,
      );
      await page.mouse.up();
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
      await expect(image).toHaveAttribute('data-image-preview-pan-y', returnStartPanY ?? '0');
      await expect(dialog).toBeVisible();

      await page.waitForTimeout(600);
      await image.click({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
      await expect(image).toHaveAttribute('data-image-preview-pan-x', '0');
      await expect(image).toHaveAttribute('data-image-preview-pan-y', '0');

      await page.waitForTimeout(600);
      await image.click({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
      await image.dblclick({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
      await expect(image).toHaveAttribute('data-image-preview-pan-x', '0');
      await expect(image).toHaveAttribute('data-image-preview-pan-y', '0');
      await expect(dialog).toBeVisible();

      const box = await stage.boundingBox();
      await page.waitForTimeout(600);
      await stage.click({ position: { x: 4, y: 4 }, force: true });
      await expect(dialog).toHaveCount(0);
      expect(box).not.toBeNull();
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3368
  test('ECHO-3368 preserves content interactions for non-image previews @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const videoFixture = await createPlayableVideoFixture(page);
    await page.route('**/test-assets/message-card-media-preview/e2e-video-1.mp4', async (route) => {
      await route.fulfill({ contentType: 'video/webm', body: videoFixture });
    });
    const videoDialog = await openVideoPreview(page);
    const video = videoDialog.locator('video');
    await expect(video).toBeVisible();
    await video.evaluate(async (element) => {
      element.muted = true;
      element.loop = true;
      await element.play();
    });
    await expect(video).toHaveJSProperty('paused', false);
    await video.click({ force: true });
    await expect(videoDialog).toBeVisible();
    const [videoStage, videoBox] = await Promise.all([
      videoDialog.locator('[data-attachment-preview-stage="video"]').boundingBox(),
      video.boundingBox(),
    ]);
    expect(videoStage).not.toBeNull();
    expect(videoBox).not.toBeNull();
    expect((videoStage?.y ?? 0) + 4).toBeLessThan(videoBox?.y ?? 0);
    await videoDialog
      .locator('[data-attachment-preview-stage="video"]')
      .click({ position: { x: 4, y: 4 }, force: true });
    await expect(videoDialog).toHaveCount(0);

    const documentDialog = await openTextPreview(page);
    await documentDialog.getByText('E2E TXT preview line 1').click();
    await expect(documentDialog).toBeVisible();
    await documentDialog.getByRole('button', { name: 'Закрити' }).click();

    const coordinateControl = page.getByRole('button', {
      name: /^(Розгорнути|Згорнути) координати:/,
    });
    if ((await coordinateControl.getAttribute('aria-expanded')) !== 'true')
      await coordinateControl.click();
    const coordinateButton = page.getByRole('button', { name: /Open .* on map/ }).first();
    await coordinateButton.click();
    const coordinateDialog = page.getByRole('dialog', { name: 'Перегляд координат' });
    await expect(coordinateDialog.locator('[data-coordinate-marker-count]')).toBeVisible();
    await coordinateDialog.locator('[data-coordinate-marker-count]').click({ force: true });
    await expect(coordinateDialog).toBeVisible();
    await coordinateDialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  });

  // Regression: https://github.com/echoua/echo/issues/3368
  test('ECHO-3368 keeps audio content protected and dismisses its outer stage background @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty', { enableAudioTranscription: true });
    const dialog = await openAudioPreviewFromMixedCarousel(page);
    const transcription = dialog.getByText('E2E audio transcription');
    await expect(transcription).toBeVisible();
    await transcription.click();
    await expect(dialog).toBeVisible();

    const stage = dialog.locator('[data-attachment-preview-stage="audio"]');
    const content = dialog.locator('[data-audio-preview-content]');
    const [stageBox, contentBox] = await Promise.all([stage.boundingBox(), content.boundingBox()]);
    expect(stageBox).not.toBeNull();
    expect(contentBox).not.toBeNull();
    const backgroundY = (stageBox?.y ?? 0) + 4;
    expect(backgroundY).toBeLessThan(contentBox?.y ?? 0);
    await stage.click({ position: { x: 4, y: 4 }, force: true });
    await expect(dialog).toHaveCount(0);
  });

  // Regression: https://github.com/echoua/echo/issues/3368
  test('ECHO-3368 protects completed OCR and summary panels @regression', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty', { withCompletedOcrAndSummary: true });
    const dialog = await openImagePreview(page);
    await dialog.getByRole('button', { name: 'Переглянути OCR' }).click();

    const iframe = dialog.locator('iframe[title="OCR"]');
    await expect(iframe).toBeVisible();
    const ocrText = iframe.contentFrame().getByText('E2E OCR text');
    await ocrText.click();
    await iframe
      .contentFrame()
      .locator('body')
      .click({ position: { x: 4, y: 120 } });
    const ocrScroll = dialog.locator('[data-ocr-scroll-container]');
    const ocrScrollBefore = await ocrScroll.evaluate((element) => element.scrollTop);
    await ocrScroll.hover();
    await page.mouse.wheel(0, 400);
    await expect
      .poll(() => ocrScroll.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(ocrScrollBefore);
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Розгорнути OCR' }).click();
    await expect(dialog.locator('iframe[title="OCR"]')).toBeVisible();
    await dialog.getByRole('button', { name: 'Повернути розділений перегляд' }).click();

    await dialog.getByRole('button', { name: 'Закрити OCR' }).click();
    await dialog.getByRole('button', { name: 'Показати стислий опис' }).click();
    const summary = dialog.getByRole('region', { name: 'Стислий опис документа' });
    await expect(summary.getByText('E2E completed media summary')).toBeVisible();
    await summary.getByText('E2E completed media summary').click();
    await summary.click({ position: { x: 4, y: 4 } });
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: 'Закрити стислий опис' }).click();
    await expect(dialog).toBeVisible();
  });

  // Regression: https://github.com/echoua/echo/issues/3368
  test.describe('ECHO-3368 touch gestures @regression', () => {
    test.use({ hasTouch: true });

    test('restores carousel swiping after a completed pinch and reset', async ({
      page,
      context,
    }) => {
      await openMessageCardPreviewHost(page, 'duty');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const dialog = await openImagePreview(page);
      const stage = dialog.locator('[data-image-preview-stage]');
      const image = dialog.locator('[data-image-preview-image]');
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 120, y, id: 1 },
          { x: x + 120, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(image).not.toHaveAttribute('data-image-preview-zoom', '100');

      await page.waitForTimeout(400);
      await image.click({ force: true });
      await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: x + 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expectPreviewCounter(dialog, '2 / 7');
    });

    test('keeps the carousel suppressed until a pinch has fully ended', async ({
      page,
      context,
    }) => {
      await openMessageCardPreviewHost(page, 'duty');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const dialog = await openImagePreview(page);
      const stage = dialog.locator('[data-image-preview-stage]');
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 120, y, id: 1 },
          { x: x + 120, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        touchPoints: [{ x: x - 40, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 140, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expectPreviewCounter(dialog, '1 / 7');

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: x + 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expectPreviewCounter(dialog, '2 / 7');
    });

    test('recovers from a cancelled pinch before the next pinch starts', async ({
      page,
      context,
    }) => {
      await openMessageCardPreviewHost(page, 'duty');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const dialog = await openImagePreview(page);
      const stage = dialog.locator('[data-image-preview-stage]');
      const image = dialog.locator('[data-image-preview-image]');
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchCancel', touchPoints: [] });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 120, y, id: 1 },
          { x: x + 120, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(image).not.toHaveAttribute('data-image-preview-zoom', '100');
    });

    test('supports touch carousel, pinch, and pan gestures', async ({ page, context }) => {
      await openMessageCardPreviewHost(page, 'duty');
      const client = await context.newCDPSession(page);
      await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
      const dialog = await openImagePreview(page);
      const stage = dialog.locator('[data-image-preview-stage]');
      const image = dialog.locator('[data-image-preview-image]');
      const stageNavigation = dialog.locator('[data-attachment-preview-stage-nav]');
      await expect(stageNavigation).toHaveCount(2);
      await expect(stageNavigation.nth(0)).toBeHidden();
      await expect(stageNavigation.nth(1)).toBeHidden();
      const box = await stage.boundingBox();
      expect(box).not.toBeNull();
      const x = (box?.x ?? 0) + (box?.width ?? 0) / 2;
      const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: (box?.x ?? 0) + 4, y: (box?.y ?? 0) + 4, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(dialog).toBeVisible();

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x: x + 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x: x - 100, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expectPreviewCounter(dialog, '2 / 7');
      await expect(image).toHaveAttribute('data-image-preview-natural-width', '900');

      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [
          { x: x - 40, y, id: 1 },
          { x: x + 40, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [
          { x: x - 120, y, id: 1 },
          { x: x + 120, y, id: 2 },
        ],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(image).not.toHaveAttribute('data-image-preview-zoom', '100');

      const panBefore = await image.getAttribute('data-image-preview-pan-y');
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        touchPoints: [{ x, y, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', {
        type: 'touchMove',
        touchPoints: [{ x, y: y + 50, id: 1 }],
      });
      await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await expect(image).not.toHaveAttribute('data-image-preview-pan-y', panBefore ?? '0');
      await expect(dialog).toBeVisible();
    });
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  test('ECHO-3324 keeps exactly one collapsed attachment section open @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
    const coordinates = page.getByRole('button', {
      name: /^(Розгорнути|Згорнути) координати:/,
    });
    const audio = page.getByRole('button', { name: /^(Розгорнути|Згорнути) аудіо:/ });
    await expect(media).toHaveAttribute('aria-expanded', 'true');
    await expect(coordinates).toHaveAttribute('aria-expanded', 'false');
    await expect(audio).toHaveAttribute('aria-expanded', 'false');

    await audio.click();
    await expect(media).toHaveAttribute('aria-expanded', 'false');
    await expect(audio).toHaveAttribute('aria-expanded', 'true');
    await expect(coordinates).toHaveAttribute('aria-expanded', 'false');

    await coordinates.click();
    await expect(media).toHaveAttribute('aria-expanded', 'false');
    await expect(audio).toHaveAttribute('aria-expanded', 'false');
    await expect(coordinates).toHaveAttribute('aria-expanded', 'true');

    await coordinates.click();
    await expect(coordinates).toHaveAttribute('aria-expanded', 'false');
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  test('ECHO-3324 aligns coordinate tiles with media tiles at wide and narrow card widths @regression', async ({
    page,
  }) => {
    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host, {
        revealCoordinates: true,
        withPartialCoordinateError: true,
      });
      const card = page.locator('.message-card-root').first();
      const mediaControl = card.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
      const coordinateControl = card.getByRole('button', {
        name: /^(Розгорнути|Згорнути) координати:/,
      });

      for (const cardWidth of [920, 768, 480, 360, 330]) {
        await card.evaluate((element, width) => {
          const item = element.closest<HTMLElement>('.message-card-item');
          if (item) item.style.width = `${width}px`;
        }, cardWidth);

        if ((await mediaControl.getAttribute('aria-expanded')) !== 'true')
          await mediaControl.click();
        await expect(mediaControl).toHaveAttribute('aria-expanded', 'true');
        const imageTile = card.locator('[data-picture-thumb-layout]').first();
        const videoTile = card.locator('[data-video-thumb-state]').first();
        const [imageBox, videoBox] = await Promise.all([
          imageTile.boundingBox(),
          videoTile.boundingBox(),
        ]);
        expect(imageBox?.width).toBe(72);
        expect(imageBox?.height).toBe(72);
        expect(videoBox?.width).toBe(72);
        expect(videoBox?.height).toBe(72);

        if ((await coordinateControl.getAttribute('aria-expanded')) !== 'true')
          await coordinateControl.click();
        await expect(coordinateControl).toHaveAttribute('aria-expanded', 'true');

        const coordinateHost = card.locator('[data-coordinate-preview-root]');
        const coordinateTile = card.locator('[data-coordinate-preview-tile]');
        const coordinateCount = coordinateTile.locator('[data-coordinate-preview-count]');
        const retryOverlay = card.locator('[data-coordinate-preview-retry-overlay]');
        await expect(coordinateHost).toBeVisible();
        await expect(coordinateTile).toBeVisible();
        await expect(coordinateCount).toHaveText('1');
        await expect(retryOverlay).toBeVisible();
        const [hostBox, coordinateBox] = await Promise.all([
          coordinateHost.boundingBox(),
          coordinateTile.boundingBox(),
        ]);
        expect(hostBox?.width).toBe(hostBox?.height);
        expect(hostBox?.width).toBe(72);
        expect(coordinateBox?.width).toBe(coordinateBox?.height);
        expect(coordinateBox?.width).toBe(hostBox?.width);
        expect(coordinateBox?.width).toBe(72);
        expect(coordinateBox?.width).toBe(imageBox?.width);
        expect(coordinateBox?.height).toBe(imageBox?.height);
        const [overlayBox, hostOverflow] = await Promise.all([
          retryOverlay.boundingBox(),
          coordinateHost.evaluate((element) => getComputedStyle(element).overflow),
        ]);
        expect(hostOverflow).toBe('hidden');
        expect(overlayBox?.x).toBeGreaterThanOrEqual(hostBox?.x ?? 0);
        expect((overlayBox?.x ?? 0) + (overlayBox?.width ?? 0)).toBeLessThanOrEqual(
          (hostBox?.x ?? 0) + (hostBox?.width ?? 0),
        );
        expect(overlayBox?.y).toBeGreaterThanOrEqual(hostBox?.y ?? 0);
        expect((overlayBox?.y ?? 0) + (overlayBox?.height ?? 0)).toBeLessThanOrEqual(
          (hostBox?.y ?? 0) + (hostBox?.height ?? 0),
        );
      }
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  test('ECHO-3324 keeps complete coordinate failures square and retries into a map @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty', {
      revealCoordinates: true,
      withCompleteCoordinateError: true,
    });
    const card = page.locator('.message-card-root').first();

    for (const cardWidth of [920, 330]) {
      await card.evaluate((element, width) => {
        const item = element.closest<HTMLElement>('.message-card-item');
        if (item) item.style.width = `${width}px`;
      }, cardWidth);
      const host = card.locator('[data-coordinate-preview-root]');
      const failureTile = card.locator('[data-coordinate-preview-retry-tile]');
      const retry = failureTile.getByRole('button', { name: 'Повторити завантаження координат' });
      await host.scrollIntoViewIfNeeded();
      await expect(failureTile).toBeVisible();
      await expect(retry).toBeVisible();
      const [hostBox, tileBox, retryBox, hostOverflow] = await Promise.all([
        host.boundingBox(),
        failureTile.boundingBox(),
        retry.boundingBox(),
        host.evaluate((element) => getComputedStyle(element).overflow),
      ]);
      expect(hostBox?.width).toBe(hostBox?.height);
      expect(hostBox?.width).toBe(72);
      expect(tileBox?.width).toBe(hostBox?.width);
      expect(tileBox?.height).toBe(hostBox?.height);
      expect(hostOverflow).toBe('hidden');
      expect(retryBox?.x).toBeGreaterThanOrEqual(hostBox?.x ?? 0);
      expect((retryBox?.x ?? 0) + (retryBox?.width ?? 0)).toBeLessThanOrEqual(
        (hostBox?.x ?? 0) + (hostBox?.width ?? 0),
      );
      expect(retryBox?.y).toBeGreaterThanOrEqual(hostBox?.y ?? 0);
      expect((retryBox?.y ?? 0) + (retryBox?.height ?? 0)).toBeLessThanOrEqual(
        (hostBox?.y ?? 0) + (hostBox?.height ?? 0),
      );
    }

    const failureTile = card.locator('[data-coordinate-preview-retry-tile]');
    const retry = failureTile.getByRole('button', { name: 'Повторити завантаження координат' });
    await retry.click();
    await expect(retry).toBeDisabled();
    await expect(card.locator('[data-coordinate-preview-tile]')).toBeVisible();
    await expect(failureTile).toHaveCount(0);
  });

  // Regression: https://github.com/echoua/echo/issues/3324
  test('ECHO-3324 renders numeric coordinate counts inside shared Duty and Analysis tiles @regression', async ({
    page,
  }) => {
    const coordinateLabel = '50.45044, 30.52355 — сектор Північний';

    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host, {
        revealCoordinates: true,
        coordinateLabel,
        coordinatePointCount: 9,
      });
      const card = page.locator('.message-card-root').first();
      const coordinateTile = card.locator('[data-coordinate-preview-tile]');
      const coordinateButton = card.getByRole('button', {
        name: `Open ${coordinateLabel} on map`,
      });
      const count = coordinateTile.locator('[data-coordinate-preview-count]');
      const mediaControl = card.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
      const coordinateControl = card.getByRole('button', {
        name: /^(Розгорнути|Згорнути) координати:/,
      });

      for (const cardWidth of [920, 330]) {
        await card.evaluate((element, width) => {
          const item = element.closest<HTMLElement>('.message-card-item');
          if (item) item.style.width = `${width}px`;
        }, cardWidth);

        if ((await mediaControl.getAttribute('aria-expanded')) !== 'true')
          await mediaControl.click();
        const [imageBox, videoBox] = await Promise.all([
          card.locator('[data-picture-thumb-layout]').first().boundingBox(),
          card.locator('[data-video-thumb-state]').first().boundingBox(),
        ]);
        if ((await coordinateControl.getAttribute('aria-expanded')) !== 'true')
          await coordinateControl.click();
        await expect(coordinateTile).toBeVisible();
        await expect(count).toHaveText('9');
        expect(await count.textContent()).toBe('9');
        const [tileBox, countBox, countMetrics, coordinateStacking] = await Promise.all([
          coordinateTile.boundingBox(),
          count.boundingBox(),
          count.evaluate((element) => {
            const styles = getComputedStyle(element);
            return {
              whiteSpace: styles.whiteSpace,
              textOverflow: styles.textOverflow,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight,
              lineHeight: Number.parseFloat(styles.lineHeight),
            };
          }),
          coordinateTile.evaluate((element) => {
            const map = element.querySelector<HTMLElement>('.coordinate-thumbnail__map');
            const shade = element.querySelector<HTMLElement>('.coordinate-thumbnail__shade');
            const count = element.querySelector<HTMLElement>('.coordinate-thumbnail__count');
            return {
              map: map == null ? null : Number.parseInt(getComputedStyle(map).zIndex, 10),
              shade: shade == null ? null : Number.parseInt(getComputedStyle(shade).zIndex, 10),
              count: count == null ? null : Number.parseInt(getComputedStyle(count).zIndex, 10),
            };
          }),
        ]);
        expect(tileBox?.width).toBe(72);
        expect(tileBox?.height).toBe(72);
        expect(imageBox?.width).toBe(72);
        expect(imageBox?.height).toBe(72);
        expect(videoBox?.width).toBe(72);
        expect(videoBox?.height).toBe(72);
        expect(countMetrics.whiteSpace).toBe('normal');
        expect(countMetrics.textOverflow).not.toBe('ellipsis');
        expect(countMetrics.scrollWidth).toBeLessThanOrEqual(countMetrics.clientWidth + 1);
        expect(countBox?.x).toBeGreaterThanOrEqual(tileBox?.x ?? 0);
        expect((countBox?.x ?? 0) + (countBox?.width ?? 0)).toBeLessThanOrEqual(
          (tileBox?.x ?? 0) + (tileBox?.width ?? 0),
        );
        expect((countBox?.y ?? 0) + (countBox?.height ?? 0)).toBeLessThanOrEqual(
          (tileBox?.y ?? 0) + (tileBox?.height ?? 0),
        );
        expect((countBox?.x ?? 0) + (countBox?.width ?? 0)).toBeGreaterThan(
          (tileBox?.x ?? 0) + (tileBox?.width ?? 0) / 2,
        );
        expect((countBox?.y ?? 0) + (countBox?.height ?? 0)).toBeLessThan(
          (tileBox?.y ?? 0) + (tileBox?.height ?? 0) / 2,
        );
        expect(coordinateStacking).toEqual({ map: 1, shade: 2, count: 3 });
        await expect(coordinateTile.locator('.coordinate-preview-mgrs-label')).toHaveCount(0);
      }

      await coordinateButton.click();
      const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Закрити' }).click();
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3380
  test('ECHO-3380 keeps the coordinate hover preview tile-driven, side by side, and non-scrollable @regression', async ({
    page,
  }) => {
    test.setTimeout(90_000);
    const transparentPng = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL5WQAAAABJRU5ErkJggg==',
      'base64',
    );
    let imageryLoaded = Promise.resolve();
    await page.route('**/World_Imagery/MapServer/tile/**', async (route) => {
      await imageryLoaded;
      await route.fulfill({ contentType: 'image/png', body: transparentPng });
    });
    await page.route('**/Reference/World_Boundaries_and_Places/MapServer/tile/**', (route) =>
      route.fulfill({ contentType: 'image/png', body: transparentPng }),
    );

    const viewports = [
      { name: 'desktop', size: { width: 1280, height: 720 } },
      { name: 'constrained', size: { width: 360, height: 480 } },
      { name: 'short', size: { width: 800, height: 320 } },
    ];

    for (const host of ['duty', 'analysis'] as const) {
      let resolveCurrentImagery!: () => void;
      imageryLoaded = new Promise((resolve) => {
        resolveCurrentImagery = resolve;
      });
      await page.setViewportSize(viewports[0].size);
      await openMessageCardPreviewHost(page, host, { revealCoordinates: true });
      const card = page.locator('.message-card-root').first();
      const coordinateControl = card.getByRole('button', {
        name: /^(Розгорнути|Згорнути) координати:/,
      });
      const tile = card.locator('[data-coordinate-preview-tile]');
      const button = tile.getByRole('button', { name: /Open .* on map/ });
      resolveCurrentImagery();
      await expect(tile.locator('.coordinate-preview-map-skeleton')).toHaveCount(0);
      await expect(tile.locator('.leaflet-interactive')).toHaveCount(0);

      for (const { size } of viewports) {
        await page.setViewportSize(size);
        await page.waitForTimeout(500);
        if ((await coordinateControl.getAttribute('aria-expanded')) !== 'true') {
          await coordinateControl.click();
        }
        await expect(tile).toBeVisible();
        await page.waitForTimeout(300);
        await button.hover();
        await page.waitForTimeout(300);
        await expect(tile.locator('.coordinate-preview-mgrs-label')).toHaveCount(0);
        const preview = page.locator('[data-coordinate-hover-preview]');
        await expect(preview).toHaveCount(1);
        await expect(
          page.locator('.MuiTooltip-tooltip', { hasText: 'Відкрити на мапі' }),
        ).toHaveCount(0);
        const mapRegions = preview.locator('.coordinate-hover-preview__map-region');
        await expect(mapRegions).toHaveCount(2);
        await expect(preview.locator('.leaflet-interactive')).toHaveCount(0);
        await expect(mapRegions.nth(0).locator('.coordinate-preview-mgrs-label')).toHaveCount(0);
        await expect(mapRegions.nth(1).locator('.coordinate-preview-mgrs-label')).toHaveCount(1);
        const [previewBox, viewport, overviewRegion, detailRegion, layout] = await Promise.all([
          preview.boundingBox(),
          page.evaluate(() => ({ width: innerWidth, height: innerHeight })),
          mapRegions.nth(0).boundingBox(),
          mapRegions.nth(1).boundingBox(),
          preview.evaluate((element) => {
            const detail = element.querySelector(
              '.coordinate-hover-preview__map-region + .coordinate-hover-preview__map-region',
            );
            return {
              overflowY: getComputedStyle(element).overflowY,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              detailBorderTop: detail == null ? '' : getComputedStyle(detail).borderTopWidth,
              detailBorderLeft: detail == null ? '' : getComputedStyle(detail).borderLeftWidth,
            };
          }),
        ]);
        expect(previewBox?.x).toBeGreaterThanOrEqual(8);
        expect((previewBox?.x ?? 0) + (previewBox?.width ?? 0)).toBeLessThanOrEqual(
          viewport.width - 8,
        );
        expect(previewBox?.y).toBeGreaterThanOrEqual(8);
        expect((previewBox?.y ?? 0) + (previewBox?.height ?? 0)).toBeLessThanOrEqual(
          viewport.height - 8,
        );
        expect(overviewRegion?.x).toBeLessThan(detailRegion?.x ?? 0);
        expect(overviewRegion?.y).toBe(detailRegion?.y);
        expect(overviewRegion?.height).toBe(detailRegion?.height);
        expect(overviewRegion?.width).toBeGreaterThan(0);
        expect(overviewRegion?.height).toBeGreaterThan(0);
        expect(detailRegion?.width).toBeGreaterThan(0);
        expect(detailRegion?.height).toBeGreaterThan(0);
        expect(layout.scrollHeight).toBeLessThanOrEqual(layout.clientHeight + 1);
        expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1);
        expect(['auto', 'scroll']).not.toContain(layout.overflowY);
        expect(layout.detailBorderTop).toBe('0px');
        expect(layout.detailBorderLeft).toBe('1px');

        await preview.hover();
        await expect(preview).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(preview).toHaveCount(0);
        await button.focus();
        await expect(preview).toBeVisible();
        await button.evaluate((element) => element.click());
        await expect(preview).toHaveCount(0);
        const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
        await expect(dialog).toBeVisible();
        const fullscreenMap = dialog.locator('.coordinate-fullscreen-map');
        await expect(fullscreenMap).toHaveCount(1);
        const fullscreenLabels = fullscreenMap.locator('.coordinate-preview-mgrs-label');
        await expect(fullscreenLabels).toHaveCount(1);
        const [mapBox, labelBox] = await Promise.all([
          fullscreenMap.boundingBox(),
          fullscreenLabels.first().boundingBox(),
        ]);
        expect(labelBox?.x).toBeGreaterThanOrEqual(mapBox?.x ?? 0);
        expect((labelBox?.x ?? 0) + (labelBox?.width ?? 0)).toBeLessThanOrEqual(
          (mapBox?.x ?? 0) + (mapBox?.width ?? 0),
        );
        await page.getByRole('button', { name: 'Закрити', exact: true }).click();
      }
    }
  });

  // Regression: https://github.com/echoua/echo/issues/3453
  test('resolves a Palitra coordinate into the fullscreen MGRS map in both hosts @regression', async ({
    page,
  }) => {
    for (const host of ['duty', 'analysis'] as const) {
      const listRequest = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === '/api/palitra/v2/list-map' &&
          request.method() === 'POST',
      );
      const pointSearchRequest = page.waitForRequest(
        (request) =>
          new URL(request.url()).pathname === '/api/palitra/points/search' &&
          request.method() === 'POST',
      );
      await openMessageCardPreviewHost(page, host, {
        revealCoordinates: true,
        palitraEtalon: 'E2E-ПАЛІТРА',
      });
      const [listRequestResult, pointSearchRequestResult] = await Promise.all([
        listRequest,
        pointSearchRequest,
      ]);
      expect(listRequestResult).toBeTruthy();
      expect(JSON.parse(pointSearchRequestResult.postData() ?? '{}')).toMatchObject({
        palitra_ids: [1],
        point_labels: ['E2E-ПАЛІТРА'],
      });
      const tile = page
        .locator('.message-card-root')
        .first()
        .locator('[data-coordinate-preview-tile]');
      await tile.getByRole('button', { name: /Open .* on map/ }).click();
      const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
      const fullscreenMap = dialog.locator('.coordinate-fullscreen-map');
      await expect(fullscreenMap).toHaveCount(1);
      await expect(fullscreenMap).toHaveAttribute('data-coordinate-marker-count', '1');
      const fullscreenLabels = fullscreenMap.locator('.coordinate-preview-mgrs-label');
      await expect(fullscreenLabels).toHaveCount(1);
      await expect(fullscreenLabels).toHaveText(/\d{1,2}[C-X] [A-Z]{2} \d+ \d+/);
      const [mapBox, labelBox] = await Promise.all([
        fullscreenMap.boundingBox(),
        fullscreenLabels.boundingBox(),
      ]);
      expect(labelBox?.x).toBeGreaterThanOrEqual((mapBox?.x ?? 0) - 1);
      expect((labelBox?.x ?? 0) + (labelBox?.width ?? 0)).toBeLessThanOrEqual(
        (mapBox?.x ?? 0) + (mapBox?.width ?? 0) + 1,
      );
      expect(labelBox?.y).toBeGreaterThanOrEqual((mapBox?.y ?? 0) - 1);
      expect((labelBox?.y ?? 0) + (labelBox?.height ?? 0)).toBeLessThanOrEqual(
        (mapBox?.y ?? 0) + (mapBox?.height ?? 0) + 1,
      );
      await page.mouse.click(
        (mapBox?.x ?? 0) + (mapBox?.width ?? 0) / 2,
        (mapBox?.y ?? 0) + (mapBox?.height ?? 0) / 2,
      );
      await expect(dialog.locator('[data-coordinate-panel="true"]')).toBeVisible();
      await expect(dialog.locator('[data-coordinate-palitra-identity="true"]')).toHaveText(
        'E2E-ПАЛІТРА',
      );
      await dialog.getByRole('button', { name: 'Закрити картку координати' }).click();
      await expect(dialog.locator('[data-coordinate-panel="true"]')).toBeHidden();
      await expect(fullscreenLabels).toHaveCount(1);
      await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    }
  });
  test('image previews preserve carousel order, info, and download', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    let imageDialog = await openImagePreview(page);
    await expectPreviewCounter(imageDialog, '1 / 7');

    await imageDialog.getByRole('button', { name: 'Інформація' }).click();
    await expect(
      page
        .getByRole('dialog', { name: 'Інформація про вкладення' })
        .getByText(MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1, { exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toHaveCount(0);
    await expect(imageDialog).toBeVisible();

    await expectOpenInNewTab(
      imageDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      resolveFixtureUrl(
        page,
        `/test-assets/message-card-media-preview/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1}`,
      ),
    );

    await expectDownloadAndFilename(
      page,
      imageDialog.getByRole('link', { name: 'Скачати' }),
      MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1,
    );

    await imageDialog.getByRole('button', { name: 'Наступне' }).click();
    await expectPreviewCounter(imageDialog, '2 / 7');

    await page.keyboard.press('ArrowLeft');
    await expectPreviewCounter(imageDialog, '1 / 7');

    await verifyEscapeClose(page, imageDialog, () => openImagePreview(page));
  });

  // Regression: https://github.com/echoua/echo/issues/3460
  test('ECHO-3460 reveals stage navigation only beside the hovered desktop edge @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const imageDialog = await openImagePreview(page);
    const dialog = page.getByRole('dialog', { name: /^Перегляд / });
    const stage = imageDialog.locator('[data-image-preview-stage]');
    const previous = dialog.locator('[data-attachment-preview-stage-nav="prev"]');
    const next = dialog.locator('[data-attachment-preview-stage-nav="next"]');
    const box = await stage.boundingBox();
    expect(box).not.toBeNull();
    const y = (box?.y ?? 0) + (box?.height ?? 0) / 2;

    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) / 2, y);
    await expect(previous).toBeHidden();
    await expect(next).toBeHidden();

    await page.mouse.move((box?.x ?? 0) + 24, y);
    await expect(previous).toBeVisible();
    await expect(next).toBeHidden();
    await previous.click();
    await expectPreviewCounter(dialog, '7 / 7');
    await expect(previous).toBeVisible();
    await previous.click();
    await expectPreviewCounter(dialog, '6 / 7');

    await page.mouse.move((box?.x ?? 0) + (box?.width ?? 0) - 24, y);
    await expect(previous).toBeHidden();
    await expect(next).toBeVisible();
    await next.click();
    await expectPreviewCounter(dialog, '7 / 7');
    await expect(next).toBeVisible();
    await next.click();
    await expectPreviewCounter(dialog, '1 / 7');
  });
  test('video previews preserve carousel controls, info, and download', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const videoDialog = await openVideoPreview(page);
    await expectPreviewCounter(videoDialog, '3 / 7');
    await expect(videoDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
    await expectOpenInNewTab(
      videoDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      resolveFixtureUrl(
        page,
        `/test-assets/message-card-media-preview/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1}`,
      ),
    );
    await expectDownloadAndFilename(
      page,
      videoDialog.getByRole('button', { name: 'Скачати' }),
      MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1,
    );

    await videoDialog.getByRole('button', { name: 'Наступне' }).click();
    await expectPreviewCounter(videoDialog, '4 / 7');

    await page.keyboard.press('ArrowLeft');
    await expectPreviewCounter(videoDialog, '3 / 7');

    await verifyEscapeClose(page, videoDialog, () => openVideoPreview(page));
  });
  test('txt, markdown, and audio previews preserve content, mixed carousel order, and normal escape close', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const textDialog = await openTextPreview(page);
    await expectPreviewCounter(textDialog, '5 / 7');
    await expect(page.getByText('E2E TXT preview line 1')).toBeVisible();
    await expect(textDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
    await expectOpenInNewTab(
      textDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      resolveFixtureUrl(
        page,
        `/test-assets/message-card-media-preview/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text}`,
      ),
    );
    await expectDownloadAndFilename(
      page,
      textDialog.getByRole('link', { name: 'Скачати' }),
      MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text,
    );
    await expect(textDialog.getByRole('button', { name: 'Зменшити' })).toHaveCount(0);
    await expect(textDialog.getByRole('button', { name: 'Повноекранний режим' })).toHaveCount(0);
    await expect(
      textDialog.getByRole('button', { name: 'Вийти з повноекранного режиму' }),
    ).toHaveCount(0);

    await textDialog.getByRole('button', { name: 'Наступне' }).click();

    const markdownDialog = page.getByRole('dialog', { name: 'Перегляд документа' });
    await expectPreviewCounter(markdownDialog, '6 / 7');
    await expect(
      markdownDialog.getByRole('heading', { name: 'E2E Markdown preview', level: 1 }),
    ).toBeVisible();
    await expect(markdownDialog.getByText('first item')).toBeVisible();
    await expectOpenInNewTab(
      markdownDialog.getByRole('link', { name: 'Відкрити в новій вкладці' }),
      resolveFixtureUrl(
        page,
        `/test-assets/message-card-media-preview/${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown}`,
      ),
    );
    await expectDownloadAndFilename(
      page,
      markdownDialog.getByRole('link', { name: 'Скачати' }),
      MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.markdown,
    );

    await markdownDialog.getByRole('button', { name: 'Наступне' }).click();
    const audioDialog = page.getByRole('dialog', { name: 'Перегляд аудіо' });
    await expectPreviewCounter(audioDialog, '7 / 7');
    await expect(audioDialog.locator('custom-audio-player')).toHaveCount(1);
    await expect(
      audioDialog.getByRole('heading', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.audio }),
    ).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expectPreviewCounter(page.getByRole('dialog', { name: 'Перегляд зображення' }), '1 / 7');
    await page.keyboard.press('Escape');
    await expect(audioDialog).toHaveCount(0);
  });

  // Regression: https://github.com/echoua/echo/issues/3405
  test('audio preview matches the reference layout and remains usable at narrow widths @regression', async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 1024 });

    for (const host of ['duty', 'analysis'] as const) {
      await openMessageCardPreviewHost(page, host, { enableAudioTranscription: true });
      await page.getByRole('button', { name: /^(Розгорнути|Згорнути) аудіо:/ }).click();
      const audioDialog = await openAudioPreviewFromMixedCarousel(page);
      const content = audioDialog.locator('[data-audio-preview-content]');
      const playerFrame = audioDialog.locator('[data-audio-preview-player]');
      const player = playerFrame.locator('custom-audio-player');
      const playerHost = audioDialog.locator('[data-audio-player-host]');
      const transcription = audioDialog.locator('[data-audio-preview-transcription]');
      await expect(player).toHaveClass(/layout-compact/);
      await expect(transcription).toContainText('E2E audio transcription\nwith a second line');

      const [contentBox, playerBox, transcriptionBox] = await Promise.all([
        content.boundingBox(),
        playerFrame.boundingBox(),
        transcription.boundingBox(),
      ]);
      expect(contentBox?.width).toBe(685);
      expect(playerBox?.width).toBe(685);
      expect(playerBox?.height).toBe(40);
      expect(transcriptionBox?.y).toBe((playerBox?.y ?? 0) + (playerBox?.height ?? 0) + 32);
      expect(transcriptionBox?.x).toBe(contentBox?.x);
      await expect(transcription.locator('.MuiTypography-root')).toHaveCSS('font-size', '14px');
      await expect(transcription.locator('.MuiTypography-root')).toHaveCSS('line-height', '20px');

      await audioDialog.screenshot({ path: testInfo.outputPath(`echo-3405-audio-${host}.png`) });
      const playerId = await player.evaluate((element) => {
        const audioPlayer = element as HTMLElement & { dataset: DOMStringMap };
        audioPlayer.dataset.e2ePlayerId ??= `audio-player-${crypto.randomUUID()}`;
        return audioPlayer.dataset.e2ePlayerId;
      });
      await player.locator('#layoutToggleBtn').click();
      await expect(player).toHaveClass(/layout-extended/);
      const [expandedFrameBox, expandedHostBox, expandedPlayerBox] = await Promise.all([
        playerFrame.boundingBox(),
        playerHost.boundingBox(),
        player.boundingBox(),
      ]);
      expect(expandedFrameBox?.width).toBe(685);
      expect(expandedHostBox?.width).toBe(685);
      expect(expandedHostBox?.height).toBe(expandedPlayerBox?.height);
      expect(expandedHostBox?.height).toBeGreaterThan(40);
      await expect(player.locator('#autoplayBtn')).toBeVisible();
      await expect(player.locator('#waveOverlayBtn')).toBeVisible();
      await expect(player.locator('#setABtn')).toBeVisible();
      expect(
        await player.evaluate((element) => {
          const host = element.parentElement;
          const playerSurface = element.shadowRoot?.querySelector<HTMLElement>('.audio-player');
          const controls = ['autoplayBtn', 'waveOverlayBtn', 'setABtn'].map((id) =>
            element.shadowRoot?.getElementById(id),
          );
          const contains = (container: Element | null, child: Element | null) => {
            if (!container || !child) return false;
            const containerBox = container.getBoundingClientRect();
            const childBox = child.getBoundingClientRect();
            return (
              childBox.left >= containerBox.left &&
              childBox.right <= containerBox.right &&
              childBox.top >= containerBox.top &&
              childBox.bottom <= containerBox.bottom
            );
          };

          return {
            hostOverflow: host ? getComputedStyle(host).overflow : null,
            controlsInsideHost: controls.every((control) => contains(host, control)),
            controlsInsidePlayer: controls.every((control) => contains(playerSurface, control)),
          };
        }),
      ).toEqual({
        hostOverflow: 'visible',
        controlsInsideHost: true,
        controlsInsidePlayer: true,
      });
      await audioDialog.screenshot({
        path: testInfo.outputPath(`echo-3405-audio-expanded-${host}.png`),
      });
      await player.locator('#layoutToggleBtn').click();
      await expect(player).toHaveClass(/layout-compact/);
      expect(await player.evaluate((element) => element.dataset.e2ePlayerId)).toBe(playerId);
      expect((await playerHost.boundingBox())?.height).toBe(40);
      await audioDialog.getByRole('button', { name: 'Закрити' }).click();
    }

    await page.setViewportSize({ width: 375, height: 500 });
    await openMessageCardPreviewHost(page, 'duty', { enableAudioTranscription: true });
    await page.getByRole('button', { name: /^(Розгорнути|Згорнути) аудіо:/ }).click();
    const narrowDialog = await openAudioPreviewFromMixedCarousel(page);
    const narrowPlayer = narrowDialog.locator('custom-audio-player');
    const narrowStage = narrowDialog.locator('[data-attachment-preview-stage="audio"]');
    await narrowPlayer.locator('#layoutToggleBtn').click();
    await expect(narrowPlayer).toHaveClass(/layout-extended/);
    await narrowPlayer.locator('#setABtn').scrollIntoViewIfNeeded();
    await expect(narrowPlayer.locator('#setABtn')).toBeVisible();
    const [narrowStageBox, narrowPlayerBox] = await Promise.all([
      narrowStage.boundingBox(),
      narrowPlayer.boundingBox(),
    ]);
    expect(narrowPlayerBox?.x).toBeGreaterThanOrEqual(narrowStageBox?.x ?? 0);
    expect((narrowPlayerBox?.x ?? 0) + (narrowPlayerBox?.width ?? 0)).toBeLessThanOrEqual(
      (narrowStageBox?.x ?? 0) + (narrowStageBox?.width ?? 0),
    );
    await narrowDialog.screenshot({
      path: testInfo.outputPath('echo-3405-audio-expanded-narrow.png'),
    });
  });

  // Regression: https://github.com/echoua/echo/issues/3405
  test('audio preview preserves paused autoplay and settings through mixed-carousel navigation @regression', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');
    await page.getByRole('button', { name: /^(Розгорнути|Згорнути) аудіо:/ }).click();
    const audioDialog = await openAudioPreviewFromMixedCarousel(page);
    await expectPreviewCounter(audioDialog, '7 / 7');
    await expect(audioDialog.locator('custom-audio-player')).toHaveCount(1);
    await audioDialog
      .locator('custom-audio-player')
      .evaluate((player: { setAutoplay: (autoplay: boolean) => void }) => player.setAutoplay(true));
    await audioDialog.getByRole('button', { name: 'Закрити' }).click();
    const reopenedAudioDialog = await openAudioPreviewFromMixedCarousel(page);
    const audioPlayer = reopenedAudioDialog.locator('custom-audio-player');
    await page.waitForTimeout(500);
    await expect(
      audioPlayer.evaluate((player: { isPlaying: boolean }) => player.isPlaying),
    ).resolves.toBe(false);
    await audioPlayer.evaluate((player: { setLoop: (loop: boolean) => void }) =>
      player.setLoop(true),
    );
    await audioPlayer.locator('#playPauseBtn').click();
    await expect
      .poll(() => audioPlayer.evaluate((player: { isPlaying: boolean }) => player.isPlaying))
      .toBe(true);
    await reopenedAudioDialog.getByRole('button', { name: 'Інформація' }).click();
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toHaveCount(0);
    await expect(reopenedAudioDialog).toBeVisible();
  });
});

for (const width of [1280, 390]) {
  test(`#3064 positions share the message map and copied links use UUIDs at ${width}px @regression`, async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await page.setViewportSize({ width, height: 900 });
    const uuid = '019a4aa8-0000-7000-8000-000000000065';
    const sourceUuid = '019a4aa8-0000-7000-8000-000000000066';
    for (const host of ['analysis', 'duty'] as const) {
      await openMessageCardPreviewHost(page, host, {
        palitraEtalon: 'BRAVO',
        messageReferenceResponse: {
          message: [
            501,
            minimalInboxMessage({
              messageUuid: sourceUuid,
              text: 'Береза 3 підтверджена за координатами 37UCQ1111122222.',
              groupMasterKey: 'source-group',
              timestamp: 1720000000000,
            }),
          ],
        },
        messageOverrides: {
          messageUuid: uuid,
          text: 'BRAVO Береза 3',
          coords: '50.45044, 30.52355',
          textMarked: [
            { CNPointC: { begin: 0, end: 5, etalon: 'BRAVO', text: 'BRAVO', palitraIds: [1] } },
            { CNTextC: { text: ' ' } },
            {
              CNPositionC: {
                begin: 6,
                end: 14,
                etalon: 'береза 3',
                text: 'Береза 3',
                kind: 'position',
                callsign: null,
                mgrs: [],
                knownMgrs: '37UCQ1111122222',
                knownAt: 1720000000000,
                knownConflicting: false,
                coordinateSources: [
                  {
                    mgrs: '37UCQ1111122222',
                    messageUuid: sourceUuid,
                    groupName: 'Група джерела',
                    messageAt: 1720000000000,
                    evidence: 'Береза 3 на 37UCQ1111122222',
                    certainty: 'high',
                    coordinateText: '37UCQ1111122222',
                  },
                ],
              },
            },
          ],
        },
      });
      const card = page.locator('.message-card-root').first();
      const position = card.getByRole('button', {
        name: /Позиція «Береза 3».*Відкрити мапу повідомлення/,
      });
      await expect(position).toBeVisible();
      await expect(position).not.toHaveAttribute('title');
      await position.hover();
      const hoverPreview = page.locator('[data-coordinate-hover-preview]');
      await expect(hoverPreview).toBeVisible();
      await expect(hoverPreview).toContainText('Позиція «Береза 3»');
      await expect(hoverPreview.locator('.coordinate-hover-preview__map-region')).toHaveCount(2);
      await page.keyboard.press('Escape');
      await expect(hoverPreview).toHaveCount(0);
      for (const theme of ['light', 'dark']) {
        await page.evaluate(
          (value) => document.documentElement.setAttribute('data-bs-theme', value),
          theme,
        );
        const styles = await card.evaluate((element) => {
          const palette = getComputedStyle(element.querySelector('.content-token--point')!);
          const position = getComputedStyle(element.querySelector('.content-token--position')!);
          return {
            palette: [palette.backgroundColor, palette.boxShadow, palette.fontSize],
            position: [position.backgroundColor, position.boxShadow, position.fontSize],
          };
        });
        expect(styles.position).toEqual(styles.palette);
      }
      if (host === 'analysis') {
        await position.click();
      } else {
        await position.focus();
        await page.keyboard.press('Enter');
      }
      const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
      const map = dialog.locator('.coordinate-fullscreen-map');
      await expect(map).toHaveAttribute('data-coordinate-marker-count', '3');
      const targetLabel = map
        .locator('.coordinate-preview-mgrs-label')
        .filter({ hasText: /37U CQ/ });
      await expect(targetLabel).toHaveCount(1);
      const [mapBox, targetBox] = await Promise.all([map.boundingBox(), targetLabel.boundingBox()]);
      expect(
        Math.abs(targetBox!.x + targetBox!.width / 2 - (mapBox!.x + mapBox!.width / 2)),
      ).toBeLessThan(30);
      expect(
        Math.abs(targetBox!.y + targetBox!.height / 2 - (mapBox!.y + mapBox!.height / 2)),
      ).toBeLessThan(50);
      await page.mouse.click(mapBox!.x + mapBox!.width / 2, mapBox!.y + mapBox!.height / 2);
      const sourceChip = dialog.locator('[data-coordinate-position-sources] a.echo-chip');
      await expect(sourceChip).toHaveCount(1);
      await expect(sourceChip).toHaveAttribute('href', `/rer-analysis-neo?m=${sourceUuid}`);
      await expect(sourceChip).toContainText('Група джерела');
      const sourceRequest = page.waitForRequest('**/api/rer-importer/inbox-item-context');
      await sourceChip.hover();
      expect((await sourceRequest).postDataJSON()).toEqual({ message_uid: sourceUuid });
      const sourcePreview = page.getByTestId('message-summary-preview-501');
      await expect(sourcePreview).toBeVisible();
      await expect(sourcePreview).toContainText('Береза 3 підтверджена');
      await expect(sourcePreview).toContainText('Група джерела');
      await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
      const coordinates = card.getByRole('button', { name: /^(Розгорнути|Згорнути) координати:/ });
      if ((await coordinates.getAttribute('aria-expanded')) !== 'true') await coordinates.click();
      await card
        .locator('[data-coordinate-preview-tile]')
        .getByRole('button', { name: /Open .* on map/ })
        .click();
      await expect(map).toHaveAttribute('data-coordinate-marker-count', '3');
      await expect(map.locator('.coordinate-preview-mgrs-label')).toHaveCount(3);
      const overviewBox = await map.boundingBox();
      for (const label of await map.locator('.coordinate-preview-mgrs-label').all()) {
        const box = await label.boundingBox();
        expect(box!.x).toBeGreaterThanOrEqual(overviewBox!.x - 1);
        expect(box!.x + box!.width).toBeLessThanOrEqual(overviewBox!.x + overviewBox!.width + 1);
        expect(box!.y).toBeGreaterThanOrEqual(overviewBox!.y - 1);
        expect(box!.y + box!.height).toBeLessThanOrEqual(overviewBox!.y + overviewBox!.height + 1);
      }
      await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
      const copyButton = card.getByRole('button', { name: /^Копіювати/ });
      if (await copyButton.isVisible()) {
        await copyButton.click();
      } else {
        await card.getByRole('button', { name: 'Більше дій' }).click();
        await page.getByRole('menuitem', { name: /^Копіювати/ }).click();
      }
      await page.getByRole('menuitem', { name: 'Копіювати посилання на повідомлення' }).click();
      const link = new URL(await page.evaluate(() => navigator.clipboard.readText()));
      expect(link.searchParams.get('m')).toBe(uuid);
      expect(link.pathname).toBe(host === 'duty' ? '/rer-duty-neo' : '/rer-analysis-neo');
    }
  });
}

for (const host of ['analysis', 'duty'] as const) {
  test(`#3676 recognized document positions join the embedded ${host} message map @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: host === 'analysis' ? 1280 : 390, height: 900 });
    const position = {
      begin: 0,
      end: 10,
      etalon: 'северный 2',
      text: 'Северный 2',
      kind: 'position',
      callsign: null,
      mgrs: [],
      knownMgrs: '36TXT8727176222',
      knownAt: Date.UTC(2026, 7, 16, 16, 20),
      knownConflicting: true,
      coordinateSources: [],
    };
    await openMessageCardPreviewHost(page, host, {
      messageOverrides: {
        coords: null,
        text: 'Документи з розпізнаними позиціями',
        textMarked: [],
        media: [
          ...(buildMessageCardMediaPreviewInboxResponse().inbox_items[0][1].media ?? []),
          {
            id: 'e2e-coordinate-error',
            contentType: 'application/pdf',
            fileName: 'positions.pdf',
            sizeBytes: 128,
            href: '/test-assets/message-card-media-preview/e2e-preview.txt',
            transcription: null,
            ocr: null,
            summary: { state: 'completed', lastError: null, hasCoordinates: false },
            kmzConversionStatus: null,
            positions: [
              position,
              position,
              {
                ...position,
                text: 'Янсон 5',
                etalon: 'янсон 5',
                mgrs: ['37UCQ1111122222'],
                knownMgrs: null,
              },
            ],
          },
        ],
      },
    });
    const card = page.locator('.message-card-root').first();
    const coordinates = card.getByRole('button', { name: /^(Розгорнути|Згорнути) координати:/ });
    await expect(coordinates).toContainText('2');
    if ((await coordinates.getAttribute('aria-expanded')) !== 'true') await coordinates.click();
    await card
      .locator('[data-coordinate-preview-tile]')
      .getByRole('button', { name: /Open .* on map/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
    await expect(dialog.locator('.coordinate-fullscreen-map')).toHaveAttribute(
      'data-coordinate-marker-count',
      '2',
    );
    await expect(dialog).toContainText('Северный 2');
    await expect(dialog).toContainText('16.08.2026');
    await expect(dialog).toContainText('є розбіжності');
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  });
}

for (const host of ['analysis', 'duty'] as const) {
  test(`#3714 extracted OCR coordinates mount the ${host} map without a summary @regression`, async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, host, {
      coordinateLabel: 'Stored OCR',
      messageOverrides: {
        coords: null,
        coordsWithLocality: [],
        text: 'OCR attachment',
        textMarked: [],
        pointTokens: [],
        media: [
          ...(buildMessageCardMediaPreviewInboxResponse().inbox_items[0][1].media ?? []),
          {
            id: 'e2e-coordinate-error',
            contentType: 'application/pdf',
            fileName: 'scan.pdf',
            sizeBytes: 128,
            href: '/test-assets/message-card-media-preview/e2e-preview.txt',
            transcription: null,
            ocr: null,
            summary: null,
            kmzConversionStatus: null,
            positions: [],
            coordinateStatus: { revision: 'ocr-extracted', hasCoordinates: true },
          },
        ],
      },
    });
    const card = page.locator('.message-card-root').first();
    const coordinates = card.getByRole('button', { name: /^(Розгорнути|Згорнути) координати:/ });
    await expect(coordinates).toContainText('1');
    if ((await coordinates.getAttribute('aria-expanded')) !== 'true') await coordinates.click();
    await card
      .locator('[data-coordinate-preview-tile]')
      .getByRole('button', { name: /Open .* on map/ })
      .click();
    const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
    await expect(dialog.locator('.coordinate-fullscreen-map')).toHaveAttribute(
      'data-coordinate-marker-count',
      '1',
    );
    await expect(dialog).toContainText('Stored OCR');
  });
}
