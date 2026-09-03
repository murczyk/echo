import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

function resolveFixtureUrl(page: Page, pathname: string) {
  return new URL(pathname, page.url()).href;
}

async function openImagePreview(page: Page) {
  await page.getByRole('button', { name: 'Відкрити зображення' }).first().click();
  return page.getByRole('dialog', { name: 'Перегляд зображення' });
}

async function openVideoPreview(page: Page) {
  await page.getByRole('button', { name: 'Відкрити відео' }).first().click();
  return page.getByRole('dialog', { name: 'Перегляд відео' });
}

async function openTextPreview(page: Page) {
  await page
    .getByRole('button', { name: MESSAGE_CARD_MEDIA_PREVIEW_ATTACHMENT_NAMES.text })
    .click();
  return page.getByRole('dialog', { name: 'Перегляд документа' });
}

async function openMarkdownPreview(page: Page) {
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
});

test.describe('message card media preview contract', () => {
  test('ECHO-3324 keeps Media, Coordinates, and Audio controls independent', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty', {
      revealAudio: true,
      revealCoordinates: true,
    });

    const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
    const coordinates = page.getByRole('button', {
      name: /^(Розгорнути|Згорнути) координати:/,
    });
    const audio = page.getByRole('button', { name: /^(Розгорнути|Згорнути) аудіо:/ });
    await expect(media).toHaveAttribute('aria-expanded', 'true');
    await expect(coordinates).toHaveAttribute('aria-expanded', 'true');
    await expect(audio).toHaveAttribute('aria-expanded', 'true');

    await media.click();
    await expect(media).toHaveAttribute('aria-expanded', 'false');
    await expect(coordinates).toHaveAttribute('aria-expanded', 'true');
    await expect(audio).toHaveAttribute('aria-expanded', 'true');

    await media.click();
    await expect(media).toHaveAttribute('aria-expanded', 'true');
  });

  test('ECHO-3324 aligns coordinate tiles with media tiles at wide and narrow card widths', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty', {
      revealCoordinates: true,
      withPartialCoordinateError: true,
    });
    const card = page.locator('.message-card-root').first();

    for (const cardWidth of [920, 330]) {
      await card.evaluate((element, width) => {
        const item = element.closest<HTMLElement>('.message-card-item');
        if (item) item.style.width = `${width}px`;
      }, cardWidth);

      const coordinateHost = card.locator('[data-coordinate-preview-root]');
      const coordinateTile = card.locator('[data-coordinate-preview-tile]');
      const retryOverlay = card.locator('[data-coordinate-preview-retry-overlay]');
      const imageTile = card.locator('[data-picture-thumb-layout]').first();
      await expect(coordinateHost).toBeVisible();
      await expect(coordinateTile).toBeVisible();
      await expect(retryOverlay).toBeVisible();
      const [hostBox, coordinateBox, imageBox] = await Promise.all([
        coordinateHost.boundingBox(),
        coordinateTile.boundingBox(),
        imageTile.boundingBox(),
      ]);
      expect(hostBox?.width).toBe(hostBox?.height);
      expect(coordinateBox?.width).toBe(coordinateBox?.height);
      expect(coordinateBox?.width).toBe(hostBox?.width);
      expect(coordinateBox?.width).toBe(imageBox?.width);
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

  test('image previews preserve carousel order, info, and download', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    let imageDialog = await openImagePreview(page);
    await expectPreviewCounter(imageDialog, '1 / 6');

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
    await expectPreviewCounter(imageDialog, '2 / 6');

    await page.keyboard.press('ArrowLeft');
    await expectPreviewCounter(imageDialog, '1 / 6');

    await verifyEscapeClose(page, imageDialog, () => openImagePreview(page));
  });

  test('video previews preserve carousel controls, info, and download', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const videoDialog = await openVideoPreview(page);
    await expectPreviewCounter(videoDialog, '3 / 6');
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
    await expectPreviewCounter(videoDialog, '4 / 6');

    await page.keyboard.press('ArrowLeft');
    await expectPreviewCounter(videoDialog, '3 / 6');

    await verifyEscapeClose(page, videoDialog, () => openVideoPreview(page));
  });

  test('txt and markdown previews preserve source text, mixed carousel order, and normal escape close', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const textDialog = await openTextPreview(page);
    await expectPreviewCounter(textDialog, '5 / 6');
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
    await expectPreviewCounter(markdownDialog, '6 / 6');
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

    await page.keyboard.press('Escape');
    await expect(markdownDialog).toHaveCount(0);
  });
});
