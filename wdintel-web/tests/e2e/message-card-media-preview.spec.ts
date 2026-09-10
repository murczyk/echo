import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  createDeferredMediaResponse,
  MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

function resolveFixtureUrl(page: Page, pathname: string) {
  return new URL(pathname, page.url()).href;
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

async function expectPopupAndClose(page: Page, link: Locator, expectedUrl: string) {
  const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await expect(popup).toHaveURL(expectedUrl);
  await popup.close();
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

test.describe('@smoke', () => {
  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} message card preview smoke covers the shared contract`, async ({ page }) => {
      await openMessageCardPreviewHost(page, host);

      await expect(
        page.getByRole('link', {
          name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.image1}`,
        }),
      ).toBeVisible();
      await expect(
        page.getByRole('link', {
          name: `Завантажити вкладення: ${MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.video1}`,
        }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: /Відкрити аудіо:/ })).toHaveCount(0);

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
    });
  }

  test('duty message card preview stays open and closes on mobile widths', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await openMessageCardPreviewHost(page, 'duty');

    let imageDialog = await openImagePreview(page);
    await expect(imageDialog).toBeVisible();
    await imageDialog.getByRole('button', { name: 'Закрити' }).click();
    await expect(imageDialog).toHaveCount(0);
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
  test('ECHO-3368 centres every primary image-click zoom', async ({ page }) => {
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

  test('ECHO-3368 zooms image clicks and dismisses only exposed image-stage background', async ({
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

  test('ECHO-3368 preserves content interactions for non-image previews', async ({ page }) => {
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

  test('ECHO-3368 keeps audio content protected and dismisses its outer stage background', async ({
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

  test('ECHO-3368 protects completed OCR and summary panels', async ({ page }) => {
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

  test.describe('ECHO-3368 touch gestures', () => {
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

  test('ECHO-3324 keeps exactly one collapsed attachment section open', async ({ page }) => {
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

  test('ECHO-3324 aligns coordinate tiles with media tiles at wide and narrow card widths', async ({
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

  test('ECHO-3324 keeps complete coordinate failures square and retries into a map', async ({
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

  test('ECHO-3324 renders numeric coordinate counts inside shared Duty and Analysis tiles', async ({
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

        await mediaControl.click();
        const [imageBox, videoBox] = await Promise.all([
          card.locator('[data-picture-thumb-layout]').first().boundingBox(),
          card.locator('[data-video-thumb-state]').first().boundingBox(),
        ]);
        await coordinateControl.click();
        await expect(coordinateTile).toBeVisible();
        await expect(count).toHaveText('9');
        expect(await coordinateTile.textContent()).toBe('9');
        expect(await coordinateTile.textContent()).not.toContain(coordinateLabel);
        expect(await coordinateTile.textContent()).not.toContain('50.45044, 30.52355');
        expect(await coordinateTile.textContent()).not.toMatch(/точка|точки|точок|…|\.\.\./i);
        const [tileBox, countBox, countMetrics] = await Promise.all([
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
      }

      await coordinateButton.click();
      const dialog = page.getByRole('dialog', { name: 'Перегляд координат' });
      await expect(dialog).toBeVisible();
      await dialog.getByRole('button', { name: 'Закрити' }).click();
    }
  });

  test('ECHO-3380 keeps the coordinate hover preview tile-driven, side by side, and non-scrollable', async ({
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
        await expect(tile.locator('.leaflet-tooltip')).toHaveCount(0);
        const preview = page.locator('[data-coordinate-hover-preview]');
        await expect(preview).toHaveCount(1);
        await expect(
          page.locator('.MuiTooltip-tooltip', { hasText: 'Відкрити на мапі' }),
        ).toHaveCount(0);
        const mapRegions = preview.locator('.coordinate-hover-preview__map-region');
        await expect(mapRegions).toHaveCount(2);
        await expect(preview.locator('.leaflet-interactive')).toHaveCount(0);
        await expect(preview.locator('.leaflet-tooltip')).toHaveCount(0);
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
        await expect(page.getByRole('dialog', { name: 'Перегляд координат' })).toBeVisible();
        await page.getByRole('button', { name: 'Закрити', exact: true }).click();
      }
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

    await expectPopupAndClose(
      page,
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

  test('video previews preserve carousel controls, info, and download', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const videoDialog = await openVideoPreview(page);
    await expectPreviewCounter(videoDialog, '3 / 7');
    await expect(videoDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
    await expectPopupAndClose(
      page,
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

  test('txt and markdown previews preserve source text, mixed carousel order, and normal escape close', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const textDialog = await openTextPreview(page);
    await expectPreviewCounter(textDialog, '5 / 7');
    await expect(page.getByText('E2E TXT preview line 1')).toBeVisible();
    await expect(textDialog.getByRole('button', { name: 'Інформація' })).toBeVisible();
    await expectPopupAndClose(
      page,
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
    await expectPopupAndClose(
      page,
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

  test('ECHO-3405 matches the audio content layout at the reference viewport', async ({
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

  test('audio preview preserves paused autoplay and settings through mixed-carousel navigation', async ({
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
    await audioDialog.getByRole('button', { name: 'Інформація' }).click();
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toHaveCount(0);
    await expect(audioDialog).toBeVisible();
  });
});
