import { expect, test, type Locator, type Page } from '@playwright/test';

import {
  createDeferredMediaResponse,
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
