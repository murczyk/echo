import { expect, test, type Locator, type Page } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceFilePreview } from './device-file-preview.ui';

type PreviewKind = 'image' | 'video';

function previewStage(owner: Locator, kind: PreviewKind) {
  return kind === 'video'
    ? owner.getByLabel('Відеоперегляд', { exact: true })
    : owner.locator(`[data-${kind}-preview-stage]`);
}

async function previewScale(owner: Locator, kind: PreviewKind) {
  if (kind === 'image')
    return Number(
      await owner.locator('[data-image-preview-image]').getAttribute('data-image-preview-zoom'),
    );
  return owner
    .locator('video')
    .evaluate((video: HTMLVideoElement) =>
      Number(/scale\(([^)]+)\)/.exec(video.style.transform)?.[1]),
    );
}

async function waitForPreview(owner: Locator, kind: PreviewKind) {
  if (kind === 'image')
    await expect
      .poll(() =>
        owner
          .locator('[data-image-preview-image]')
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
  else
    await expect
      .poll(() => owner.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(1);
}

async function zoomAndReset(page: Page, owner: Locator, kind: PreviewKind, screenshot: string) {
  await waitForPreview(owner, kind);
  const stage = previewStage(owner, kind);
  const badge = stage.locator('button').filter({ hasText: /^\d+%$/ });
  const indicator = badge.locator('..');
  await expect(badge).toHaveText('100%');
  await expect(indicator).toHaveCSS('opacity', '0');
  await expect(
    owner.getByRole('button', { name: /^(Збільшити|Зменшити) (масштаб|зображення)$/ }),
  ).toHaveCount(0);
  const initialScale = await previewScale(owner, kind);
  await stage.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  await expect.poll(() => previewScale(owner, kind)).toBeGreaterThan(initialScale);
  await expect(indicator).toHaveCSS('opacity', '1');
  await expect(badge).not.toHaveText('100%');
  const [stageBox, badgeBox] = await Promise.all([stage.boundingBox(), badge.boundingBox()]);
  expect(stageBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(badgeBox!.x - stageBox!.x).toBeCloseTo(16, 0);
  expect(stageBox!.y + stageBox!.height - badgeBox!.y - badgeBox!.height).toBeCloseTo(16, 0);
  await owner.screenshot({ path: screenshot });
  await badge.click();
  await expect.poll(() => previewScale(owner, kind)).toBe(initialScale);
  await expect(badge).toHaveText('100%');
  await expect(indicator).toHaveCSS('opacity', '0');
}

// Regression: https://github.com/echoua/echo/issues/3930
for (const scenario of [
  { kind: 'image', fixture: 'image-png', width: 1440 },
  { kind: 'video', fixture: 'video-mp4', width: 1440 },
  { kind: 'image', fixture: 'image-png', width: 390 },
] as const) {
  test(`@regression device ${scenario.kind} zoom matches Messages inline and fullscreen at ${scenario.width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width: scenario.width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, scenario.fixture);
      await zoomAndReset(page, pane, scenario.kind, testInfo.outputPath('inline-zoom.png'));
      await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
      const fullscreen = page
        .getByRole('dialog')
        .filter({ has: page.locator('#device-file-fullscreen-title') });
      await zoomAndReset(
        page,
        fullscreen,
        scenario.kind,
        testInfo.outputPath('fullscreen-zoom.png'),
      );
      await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
      await expect(fullscreen).not.toBeVisible();
    } finally {
      await backend.dispose();
    }
  });
}
