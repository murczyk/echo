import { expect, test, type Page } from '@playwright/test';
import {
  buildMessageCardMediaPreviewInboxResponse,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

test.use({ hasTouch: true });

async function openImage(
  page: Page,
  host: 'analysis' | 'duty',
  withCompletedOcrAndSummary = false,
) {
  await page.setViewportSize(
    host === 'duty' ? { width: 375, height: 812 } : { width: 1440, height: 900 },
  );
  await openMessageCardPreviewHost(page, host, { withCompletedOcrAndSummary });
  if (host === 'analysis') {
    await page.goto('/rer-analysis-neo?leftPanelOpen=false&filterPanelOpen=false');
    await page.setViewportSize({ width: 375, height: 812 });
  }
  const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
  if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  await page.getByRole('button', { name: 'Відкрити зображення' }).first().click();
  return { dialog: page.getByRole('dialog', { name: 'Перегляд зображення' }), viewport };
}

for (const host of ['analysis', 'duty'] as const) {
  test(`@regression #3340 ${host}: image chrome preserves a centered fit inside a full-height zoom stage`, async ({
    page,
  }, testInfo) => {
    const { dialog } = await openImage(page, host);
    const image = dialog.locator('[data-image-preview-image]');
    await expect(image).toHaveAttribute('data-image-preview-natural-width', /[1-9]/);
    const closeBounds = (await dialog
      .getByRole('button', { name: 'Закрити', exact: true })
      .boundingBox())!;
    const stageBounds = (await dialog
      .locator('[data-attachment-preview-swipe-content]')
      .boundingBox())!;
    expect(stageBounds.y).toBe(0);
    expect(stageBounds.height).toBe(812);
    const header = dialog.getByRole('heading', { name: 'e2e-image-1.png', exact: true });
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    const initialBounds = (await image.boundingBox())!;
    expect(initialBounds.y).toBeGreaterThanOrEqual(closeBounds.y + closeBounds.height);
    expect(Math.abs(initialBounds.y - (812 - initialBounds.y - initialBounds.height))).toBeLessThan(
      1,
    );
    const point = {
      x: initialBounds.x + initialBounds.width / 2,
      y: initialBounds.y + initialBounds.height / 2,
    };
    await page.touchscreen.tap(point.x, point.y);
    await expect(header).toBeHidden();
    await expect(island).toBeHidden();
    await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
    const hiddenStage = (await dialog
      .locator('[data-attachment-preview-swipe-content]')
      .boundingBox())!;
    expect(hiddenStage.y).toBe(0);
    expect(hiddenStage.height).toBe(812);
    expect(await image.boundingBox()).toEqual(initialBounds);
    await dialog.screenshot({
      path: testInfo.outputPath('image-hidden.png'),
      animations: 'disabled',
    });
    await page.touchscreen.tap(point.x + 40, point.y);
    await expect(header).toBeVisible();
    await expect(island).toBeVisible();
    await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
    expect(await image.boundingBox()).toEqual(initialBounds);
    await image.focus();
    await image.press('Enter');
    await expect(header).toBeHidden();
    await image.press('Space');
    await expect(header).toBeVisible();
    await page.touchscreen.tap(point.x, point.y);
    await page.setViewportSize({ width: 812, height: 375 });
    await expect(header).toBeHidden();
    const rotated = (await image.boundingBox())!;
    await page.touchscreen.tap(rotated.x + rotated.width / 2, rotated.y + rotated.height / 2);
    await expect(header).toBeVisible();
    const landscapeHeader = (await header.locator('xpath=../..').boundingBox())!;
    const visibleRotated = (await image.boundingBox())!;
    expect(visibleRotated.y).toBeCloseTo(landscapeHeader.y + landscapeHeader.height, 1);
    expect(visibleRotated).toEqual(rotated);
    await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
    await dialog.locator('[data-attachment-preview-nav="next"]:visible').click();
    await expect(
      dialog.getByRole('heading', { name: 'e2e-image-2.png', exact: true }),
    ).toBeVisible();
  });

  test(`@regression #3340 ${host}: image navigation floats above the gesture area without a footer`, async ({
    page,
  }, testInfo) => {
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 44, bottom: 34, left: 12, right: 16 },
    });
    const { dialog, viewport } = await openImage(page, host);
    const viewportMeta = page.locator('meta[name="viewport"]');
    await expect(viewportMeta).toHaveAttribute('content', /viewport-fit=cover/);
    const stage = dialog.locator('[data-attachment-preview-swipe-content]');
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    await expect(island).toBeVisible();
    const stageBounds = (await stage.boundingBox())!;
    expect(stageBounds.y + stageBounds.height).toBe(812);
    const islandBounds = (await island.boundingBox())!;
    expect(islandBounds.width).toBeLessThan(375 / 2);
    expect(Math.abs(islandBounds.x + islandBounds.width / 2 - 375 / 2)).toBeLessThan(1);
    expect(islandBounds.y + islandBounds.height).toBeLessThanOrEqual(812 - 34 - 16);
    const close = (await dialog
      .getByRole('button', { name: 'Закрити', exact: true })
      .boundingBox())!;
    const fittedImage = (await dialog.locator('[data-image-preview-image]').boundingBox())!;
    expect(fittedImage.y).toBeGreaterThanOrEqual(44 + 52);
    expect(Math.abs(fittedImage.y - (812 - fittedImage.y - fittedImage.height))).toBeLessThan(1);
    expect(close.y).toBeGreaterThanOrEqual(44);
    expect(close.x + close.width).toBeLessThanOrEqual(375 - 16);
    for (const theme of ['light', 'dark']) {
      await page.evaluate((value) => {
        document.documentElement.setAttribute('data-bs-theme', value);
        window.dispatchEvent(new Event('echo-theme-applied'));
      }, theme);
      const background = await stage.evaluate(
        (element) => getComputedStyle(element.parentElement!).backgroundColor,
      );
      const fill = await island.evaluate((element) => getComputedStyle(element).backgroundColor);
      const rgba = fill.match(/[\d.]+/g)!.map(Number);
      expect(rgba.slice(0, 3)).toEqual(background.match(/[\d.]+/g)!.map(Number));
      expect(rgba[3]).toBeGreaterThan(0);
      expect(rgba[3]).toBeLessThan(1);
      expect(
        await stage.evaluate((element) =>
          element.parentElement!.contains(document.elementFromPoint(180, window.innerHeight - 1)),
        ),
      ).toBe(true);
      await dialog.screenshot({
        path: testInfo.outputPath(`image-${theme}.png`),
        animations: 'disabled',
      });
    }
    await island.getByRole('button', { name: 'Наступне', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'e2e-image-2.png', exact: true }),
    ).toBeVisible();
    await page.setViewportSize({ width: 812, height: 375 });
    await expect(island).toBeHidden();
    await expect(viewportMeta).toHaveAttribute('content', /viewport-fit=cover/);
    const landscapeStage = (await stage.boundingBox())!;
    expect(landscapeStage.y + landscapeStage.height).toBe(375);
    await dialog.screenshot({
      path: testInfo.outputPath('image-landscape.png'),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(viewportMeta).toHaveAttribute('content', viewport!);
    await session.detach();
  });
}

test('@regression #3340 a single image fills the mobile stage without navigation', async ({
  page,
}) => {
  const { dialog } = await openImage(page, 'duty');
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  const inbox = buildMessageCardMediaPreviewInboxResponse();
  const message = inbox.inbox_items[0][1];
  message.media = message.media?.filter((media) => media.id === 'e2e-image-1');
  message.images = message.images.slice(0, 1);
  await page.route('**/api/rer-importer/get-inbox', (route) => route.fulfill({ json: inbox }));
  await page.reload();
  const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
  if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
  await page.getByRole('button', { name: 'Відкрити зображення' }).click();
  await expect(dialog.locator('[data-attachment-preview-carousel-island]')).toHaveCount(0);
  await expect(dialog.locator('[data-attachment-preview-nav]:visible')).toHaveCount(0);
  const stage = (await dialog.locator('[data-attachment-preview-swipe-content]').boundingBox())!;
  expect(stage.y + stage.height).toBe(812);
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /viewport-fit=cover/,
  );
});

test('@regression #3340 the image island stays clear of the OCR pane', async ({
  page,
}, testInfo) => {
  const { dialog } = await openImage(page, 'duty', true);
  await dialog.getByRole('button', { name: 'Переглянути OCR', exact: true }).click();
  const source = (await dialog.locator('[data-image-preview-stage]').boundingBox())!;
  const island = (await dialog.locator('[data-attachment-preview-carousel-island]').boundingBox())!;
  expect(island.y + island.height).toBeLessThanOrEqual(source.y + source.height);
  const point = { x: source.x + source.width / 2, y: source.y + source.height / 2 };
  await page.touchscreen.tap(point.x, point.y);
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeHidden();
  const hiddenSource = (await dialog.locator('[data-image-preview-stage]').boundingBox())!;
  expect(hiddenSource.y).toBe(0);
  expect(hiddenSource.height).toBeGreaterThan(source.height);
  await page.touchscreen.tap(point.x + 40, point.y);
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
  expect(await dialog.locator('[data-image-preview-stage]').boundingBox()).toEqual(source);
  await dialog.screenshot({ path: testInfo.outputPath('image-ocr.png'), animations: 'disabled' });
});

test('@regression #3340 double tap zoom and dragging do not restore hidden image controls', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { dialog } = await openImage(page, 'duty');
  const image = dialog.locator('[data-image-preview-image]');
  await expect(image).toHaveAttribute('data-image-preview-natural-width', /[1-9]/);
  const bounds = (await image.boundingBox())!;
  const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.touchscreen.tap(point.x, point.y);
  await page.touchscreen.tap(point.x, point.y);
  await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
  const zoomStage = (await dialog.locator('[data-image-preview-stage]').boundingBox())!;
  const zoomedImage = (await image.boundingBox())!;
  expect(zoomStage.y).toBe(0);
  expect(zoomStage.height).toBe(812);
  expect(zoomedImage.y).toBeLessThan(0);
  expect(zoomedImage.y + zoomedImage.height).toBeGreaterThan(812);
  const close = dialog.getByRole('button', { name: 'Закрити', exact: true });
  await expect(close).toBeHidden();
  await dialog.screenshot({
    path: testInfo.outputPath('image-zoomed.png'),
    animations: 'disabled',
  });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: point.x + 60, y: point.y + 40 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(image).not.toHaveAttribute('data-image-preview-pan-x', '0');
  await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
  await expect(close).toBeHidden();
  await page.touchscreen.tap(point.x - 40, point.y);
  await expect(close).toBeVisible();
  await expect(image).toHaveAttribute('data-image-preview-zoom', '200');
  const fingers = [
    { x: point.x - 40, y: point.y - 40, id: 0 },
    { x: point.x + 40, y: point.y + 40, id: 1 },
  ];
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: fingers });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: point.x - 70, y: point.y - 70, id: 0 },
      { x: point.x + 70, y: point.y + 70, id: 1 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchEnd',
    touchPoints: [{ x: point.x + 70, y: point.y + 70, id: 1 }],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(close).toBeVisible();
  await expect
    .poll(async () => Number(await image.getAttribute('data-image-preview-zoom')))
    .toBeGreaterThan(200);
  await session.detach();
});

test('@regression #3340 landscape OCR expand and collapse stay reachable below the header', async ({
  page,
}) => {
  const { dialog } = await openImage(page, 'duty', true);
  await page.setViewportSize({ width: 812, height: 375 });
  await dialog.getByRole('button', { name: 'Переглянути OCR', exact: true }).click();
  await dialog.getByRole('button', { name: 'Розгорнути OCR', exact: true }).click();
  await dialog.getByRole('button', { name: 'Повернути розділений перегляд', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Закрити OCR', exact: true })).toBeVisible();
});
