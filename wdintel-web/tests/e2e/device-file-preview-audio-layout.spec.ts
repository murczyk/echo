import { expect, test, type Locator, type Page } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceFilePreview } from './device-file-preview.ui';

type AudioPlayer = HTMLElement & { audio: HTMLAudioElement };

async function expectCenteredAudio(scope: Locator) {
  const content = scope.locator('[data-audio-preview-content]');
  const frame = scope.locator('[data-audio-preview-player]');
  const player = frame.locator('custom-audio-player');
  await expect(player).toHaveClass(/layout-compact/);
  await expect(frame).toHaveCSS('height', '40px');
  const [stageBox, frameBox] = await Promise.all([
    content.locator('..').boundingBox(),
    frame.boundingBox(),
  ]);
  expect(stageBox).not.toBeNull();
  expect(frameBox).not.toBeNull();
  expect(frameBox!.width).toBeCloseTo(Math.min(685, stageBox!.width - 32), 0);
  expect(frameBox!.x + frameBox!.width / 2).toBeCloseTo(stageBox!.x + stageBox!.width / 2, 0);
  expect(frameBox!.y + frameBox!.height / 2).toBeCloseTo(stageBox!.y + stageBox!.height / 2, 0);
  return player;
}

async function expectDurationInfo(page: Page, scope: Locator) {
  await scope.getByRole('button', { name: 'Інформація', exact: true }).click();
  const info = page.getByRole('dialog', { name: 'Інформація про вкладення', exact: true });
  await expect(info.getByText('Тривалість', { exact: true })).toBeVisible();
  await expect(info.getByText('00:03', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(info).not.toBeVisible();
}

// Regression: https://github.com/echoua/echo/issues/3930
for (const width of [1440, 390]) {
  test(`@regression device audio uses the centered Messages player at ${width}px`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.setViewportSize({ width, height: 900 });
    if (width === 1440) await page.emulateMedia({ colorScheme: 'dark' });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'audio-m4a');
      const player = await expectCenteredAudio(pane);
      await expect
        .poll(() => player.evaluate((host: AudioPlayer) => host.audio.duration))
        .toBeCloseTo(3, 1);
      expect(await player.evaluate((host: AudioPlayer) => host.audio.paused)).toBe(true);
      await expectDurationInfo(page, pane);
      await player.locator('#layoutToggleBtn').click();
      await expect(player).toHaveClass(/layout-extended/);
      await player.locator('#setABtn').scrollIntoViewIfNeeded();
      await expect(player.locator('#setABtn')).toBeVisible();
      await player.locator('#layoutToggleBtn').click();
      await expectCenteredAudio(pane);
      await player.evaluate((host: AudioPlayer) => host.audio.play());
      await expect
        .poll(() => player.evaluate((host: AudioPlayer) => host.audio.currentTime))
        .toBeGreaterThan(0.1);
      await player.evaluate((host: AudioPlayer) => host.audio.pause());
      await pane.screenshot({ path: testInfo.outputPath(`device-audio-${width}.png`) });

      await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
      const fullscreen = page.getByRole('dialog').filter({
        has: page.locator('#device-file-fullscreen-title'),
      });
      const fullscreenPlayer = await expectCenteredAudio(fullscreen);
      await expect
        .poll(() => fullscreenPlayer.evaluate((host: AudioPlayer) => host.audio.duration))
        .toBeCloseTo(3, 1);
      await expectDurationInfo(page, fullscreen);
      await fullscreen.screenshot({
        path: testInfo.outputPath(`device-audio-fullscreen-${width}.png`),
      });
      await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
      await expect(fullscreen).not.toBeVisible();
      await expectCenteredAudio(pane);
    } finally {
      await backend.dispose();
    }
  });
}

// Regression: https://github.com/echoua/echo/issues/3930
test('@regression MPEG audio without MIME uses the shared audio player after metadata', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'audio-mpeg');
    const player = await expectCenteredAudio(pane);
    await expect(pane.locator('video')).toHaveCount(0);
    await expect(pane.locator('[data-attachment-preview-video-controls]')).toHaveCount(0);
    await expect
      .poll(() => player.evaluate((host: AudioPlayer) => host.audio.duration))
      .toBeCloseTo(3, 1);
    expect(await player.evaluate((host: AudioPlayer) => host.audio.paused)).toBe(true);
    await player.evaluate((host: AudioPlayer) => host.audio.play());
    await expect
      .poll(() => player.evaluate((host: AudioPlayer) => host.audio.currentTime))
      .toBeGreaterThan(0.1);
    await expectDurationInfo(page, pane);
  } finally {
    await backend.dispose();
  }
});

// Regression: https://github.com/echoua/echo/issues/3930
test('@regression device video information shows native media duration', async ({ page }) => {
  test.setTimeout(90_000);
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
    const video = pane.locator('video');
    await expect
      .poll(() => video.evaluate((media: HTMLVideoElement) => media.duration))
      .toBeCloseTo(3, 1);
    await expectDurationInfo(page, pane);
  } finally {
    await backend.dispose();
  }
});
