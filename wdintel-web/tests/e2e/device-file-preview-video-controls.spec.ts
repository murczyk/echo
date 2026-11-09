import { expect, test, type Locator, type Page } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceFilePreview } from './device-file-preview.ui';

for (const width of [1440, 390]) {
  test(`@regression #3930 fullscreen preserves video seek and playback in both directions at ${width}px`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
      const fullscreen = page
        .getByRole('dialog')
        .filter({ has: page.locator('#device-file-fullscreen-title') });
      const setState = async (owner: Locator, paused: boolean) => {
        const video = owner.locator('video');
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.readyState))
          .toBeGreaterThanOrEqual(1);
        await video.evaluate((element: HTMLVideoElement) => {
          element.pause();
          element.currentTime = 1.25;
          element.volume = 0.35;
          element.muted = true;
          element.playbackRate = 0.5;
        });
        if (!paused)
          await owner
            .locator('[data-attachment-preview-video-controls]')
            .getByRole('button', { name: 'Відтворення', exact: true })
            .click();
        await expect(video).toHaveJSProperty('paused', paused);
      };
      const expectState = async (owner: Locator, paused: boolean) => {
        const video = owner.locator('video');
        await expect(video).toHaveJSProperty('paused', paused);
        await expect(video).toHaveJSProperty('volume', 0.35);
        await expect(video).toHaveJSProperty('muted', true);
        await expect(video).toHaveJSProperty('playbackRate', 0.5);
        await expect
          .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
          .toBeGreaterThanOrEqual(1.2);
        if (paused)
          await expect
            .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
            .toBeCloseTo(1.25, 1);
      };
      for (const paused of [true, false]) {
        await setState(pane, paused);
        await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
        await expectState(fullscreen, paused);
        await setState(fullscreen, paused);
        await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
        await expectState(pane, paused);
      }
    } finally {
      await backend.dispose();
    }
  });
}

async function exerciseVideoControls(page: Page, owner: Locator, width: number) {
  const video = owner.locator('video');
  const controls = owner.locator('[data-attachment-preview-video-controls]');
  await expect.poll(() => video.evaluate((element: HTMLVideoElement) => element.duration)).toBe(3);
  await expect(video).toHaveJSProperty('controls', false);
  await expect(controls).toBeVisible();
  await expect(controls).toContainText('/ 00:03');

  const [stageBox, controlsBox] = await Promise.all([
    owner.getByLabel('Відеоперегляд', { exact: true }).boundingBox(),
    controls.boundingBox(),
  ]);
  expect(stageBox).not.toBeNull();
  expect(controlsBox).not.toBeNull();
  expect(controlsBox!.x).toBeCloseTo(stageBox!.x, 0);
  expect(controlsBox!.width).toBeCloseTo(stageBox!.width, 0);
  expect(controlsBox!.y).toBeCloseTo(stageBox!.y + stageBox!.height, 0);

  await video.evaluate((element: HTMLVideoElement) => {
    element.loop = true;
  });
  await controls.getByRole('button', { name: 'Відтворення', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', false);
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeGreaterThan(0.1);
  await page.mouse.move(0, 0);
  await expect(controls).toHaveCSS('opacity', '0');
  await owner.getByLabel('Відеоперегляд', { exact: true }).hover();
  await expect(controls).toHaveCSS('opacity', '1');
  await controls.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);

  const timeline = controls.getByRole('slider').first();
  await timeline.press('Home');
  await timeline.press('ArrowRight');
  await expect
    .poll(() => video.evaluate((element: HTMLVideoElement) => element.currentTime))
    .toBeCloseTo(1, 1);
  await expect(controls).toContainText('00:01 / 00:03');

  await controls.getByRole('button', { name: 'Вимкнути звук', exact: true }).click();
  await expect(video).toHaveJSProperty('muted', true);
  await controls.getByRole('button', { name: 'Увімкнути звук', exact: true }).click();
  await expect(video).toHaveJSProperty('muted', false);
  await expect(controls.getByRole('button', { name: 'Вимкнути звук', exact: true })).toBeVisible();
  if (width >= 600) {
    const volume = controls.getByRole('slider').nth(1);
    await volume.press('Home');
    await expect(video).toHaveJSProperty('volume', 0);
    await expect(volume).toHaveAttribute('aria-valuenow', '0');
    for (let step = 1; step <= 8; step++) {
      await volume.press('ArrowRight');
      await expect
        .poll(async () => Number(await volume.getAttribute('aria-valuenow')))
        .toBeCloseTo(step / 20, 2);
      await expect
        .poll(() => video.evaluate((element: HTMLVideoElement) => element.volume))
        .toBeCloseTo(step * 0.05, 2);
    }
  }

  await controls.getByRole('combobox').click();
  await page.getByRole('option', { name: '1.5x', exact: true }).click();
  await expect(video).toHaveJSProperty('playbackRate', 1.5);
  await expect(controls.getByRole('combobox')).toHaveText('1.5x');

  await owner.getByRole('button', { name: 'Інформація', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Інформація про вкладення', exact: true });
  await expect(info.getByText('Тривалість', { exact: true })).toBeVisible();
  await expect(info.getByText('00:03', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).not.toBeVisible();
  await expect(video).toHaveJSProperty('paused', true);

  const stage = owner.getByLabel('Відеоперегляд', { exact: true });
  await stage.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  const resetZoom = stage.getByRole('button', { name: 'Скинути масштаб (100%)', exact: true });
  await expect(resetZoom).toBeVisible();
  await video.click();
  await expect(video).toHaveJSProperty('paused', false);
  await controls.getByRole('button', { name: 'Пауза', exact: true }).click();
  await expect(video).toHaveJSProperty('paused', true);
  await resetZoom.click();
  await expect(
    stage
      .locator('button')
      .filter({ hasText: /^100%$/ })
      .locator('..'),
  ).toHaveCSS('opacity', '0');
}

// Regression: https://github.com/echoua/echo/issues/3930
for (const width of [1440, 390]) {
  test(`@regression device video uses Messages playback controls at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme: 'dark' });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
      await exerciseVideoControls(page, pane, width);
      await pane.screenshot({ path: testInfo.outputPath('inline-video.png') });

      await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
      const fullscreen = page.getByRole('dialog').filter({
        has: page.locator('#device-file-fullscreen-title'),
      });
      await exerciseVideoControls(page, fullscreen, width);
      await fullscreen.screenshot({ path: testInfo.outputPath('fullscreen-video.png') });
      await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
      await expect(fullscreen).not.toBeVisible();
      await expect(pane.locator('[data-attachment-preview-video-controls]')).toBeVisible();
      await expect(pane.locator('video')).toHaveJSProperty('paused', true);
    } finally {
      await backend.dispose();
    }
  });
}
