import { expect, test, type Locator, type Page } from '@playwright/test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  buildMessageCardMediaPreviewInboxResponse,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

test.use({ hasTouch: true });

let portraitDirectory: string;
let portraitBytes: Buffer;
test.beforeAll(async () => {
  portraitDirectory = await mkdtemp(resolve(tmpdir(), 'echo-3340-portrait-'));
  const target = resolve(portraitDirectory, 'portrait.mp4');
  execFileSync('ffmpeg', [
    '-v',
    'error',
    '-i',
    resolve('tests/e2e/fixtures/device-file-preview/video.mp4'),
    '-vf',
    'transpose=1',
    '-c:v',
    'libx264',
    '-c:a',
    'copy',
    target,
  ]);
  portraitBytes = await readFile(target);
});
test.afterAll(async () => {
  if (portraitDirectory) await rm(portraitDirectory, { recursive: true, force: true });
});

async function openVideo(
  page: Page,
  host: 'analysis' | 'duty',
  { startPlayback = true, portrait = false, viewport = { width: 375, height: 812 } } = {},
) {
  await page.setViewportSize(host === 'duty' ? viewport : { width: 1440, height: 900 });
  await openMessageCardPreviewHost(page, host);
  if (host === 'analysis') {
    await page.goto('/rer-analysis-neo?leftPanelOpen=false&filterPanelOpen=false');
    const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
    if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
    await page.setViewportSize(viewport);
  }
  const dismiss = page.getByRole('button', { name: 'Закрити сповіщення' });
  if (await dismiss.isVisible()) await dismiss.click();
  const bytes = portrait
    ? portraitBytes
    : await readFile('tests/e2e/fixtures/device-file-preview/video.mp4');
  await page.route('**/test-assets/message-card-media-preview/e2e-video-*.mp4', (route) => {
    const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
    const start = range ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/mp4',
      headers: {
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
      },
      body: bytes.subarray(start, end + 1),
    });
  });
  await page.getByRole('button', { name: 'Відкрити відео' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Перегляд відео' });
  const video = dialog.locator('video');
  await expect
    .poll(() => video.evaluate((element) => element.readyState))
    .toBeGreaterThanOrEqual(2);
  if (startPlayback)
    await video.evaluate(async (element) => {
      element.muted = true;
      element.loop = true;
      await element.play();
    });
  return { dialog, video };
}

async function swipe(page: Page, from: { x: number; y: number }, to: { x: number; y: number }) {
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] });
  for (let step = 1; step <= 5; step++) {
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [
        { x: from.x + ((to.x - from.x) * step) / 5, y: from.y + ((to.y - from.y) * step) / 5 },
      ],
    });
  }
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
}

test('@regression #3340 paused taps toggle the header and controls without playing', async ({
  page,
}) => {
  const { dialog, video } = await openVideo(page, 'duty');
  await video.evaluate((element) => element.pause());
  const controls = dialog.locator('[data-mobile-video-controls]');
  await expect(controls).toHaveAttribute('data-visible', 'true');
  await page.touchscreen.tap(180, 300);
  await expect(controls).toHaveAttribute('data-visible', 'false');
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeHidden();
  await expect(video).toHaveJSProperty('paused', true);
  await page.touchscreen.tap(180, 300);
  await expect(controls).toHaveAttribute('data-visible', 'true');
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
  await expect(video).toHaveJSProperty('paused', true);
});

test('@regression #3340 rotation fits the viewport without requesting fullscreen', async ({
  page,
}) => {
  const { dialog, video } = await openVideo(page, 'duty');
  await expect(dialog.getByRole('button', { name: 'На весь екран', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  const original = await video.elementHandle();
  await page.setViewportSize({ width: 812, height: 375 });
  await expect
    .poll(() =>
      video.evaluate((element) => {
        const { width, height } = element.getBoundingClientRect();
        return { width: Math.round(width), height: Math.round(height) };
      }),
    )
    .toEqual({ width: 812, height: 375 });
  expect(await video.evaluate((element, previous) => element === previous, original)).toBe(true);
  await expect(video).toHaveJSProperty('paused', false);
});

for (const host of ['analysis', 'duty'] as const) {
  test(`@regression #3340 ${host}: portrait video fills the stage and survives rotation`, async ({
    page,
  }, testInfo) => {
    const { dialog, video } = await openVideo(page, host);
    const original = await video.elementHandle();
    await video.evaluate((element) => element.pause());
    const info = dialog.getByRole('button', { name: 'Інформація', exact: true });
    await expect(info).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Скачати', exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('link', { name: 'Відкрити в новій вкладці', exact: true }),
    ).toBeVisible();
    const close = dialog.getByRole('button', { name: 'Закрити', exact: true });
    expect((await close.boundingBox())!.x).toBeGreaterThan((await info.boundingBox())!.x);
    await dialog.screenshot({
      path: testInfo.outputPath(`${host}-portrait.png`),
      animations: 'disabled',
    });
    await video.evaluate((element) => element.play());
    await expect
      .poll(() => video.evaluate((element) => element.getBoundingClientRect().width))
      .toBeGreaterThan(300);
    for (const viewport of [
      { width: 812, height: 375 },
      { width: 320, height: 640 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(video).toBeVisible();
      if (viewport.width >= 480) {
        await video.evaluate((element) => element.pause());
        const panel = dialog.locator('[data-mobile-video-playback-panel]');
        expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(64);
        await expect(panel.getByRole('button', { name: 'Відтворення', exact: true })).toBeVisible();
        await expect(dialog.getByRole('button', { name: 'Інформація', exact: true })).toBeVisible();
        await dialog.screenshot({
          path: testInfo.outputPath(`${host}-landscape.png`),
          animations: 'disabled',
        });
        await video.evaluate((element) => element.play());
      }
      expect(await video.evaluate((element, previous) => element === previous, original)).toBe(
        true,
      );
      const bounds = await dialog.boundingBox();
      expect(bounds?.width).toBe(viewport.width);
      expect(bounds?.height).toBe(viewport.height);
      await expect(video).toHaveJSProperty('paused', false);
    }
  });

  test(`@regression #3340 ${host}: taps reveal controls and keep playback running`, async ({
    page,
  }) => {
    const { dialog, video } = await openVideo(page, host);
    const controls = dialog.locator('[data-mobile-video-controls]');
    await expect(controls).toHaveAttribute('data-visible', 'false', { timeout: 6000 });
    await page.touchscreen.tap(180, 300);
    await expect(controls).toHaveAttribute('data-visible', 'true');
    await expect(video).toHaveJSProperty('paused', false);
    await dialog.getByRole('button', { name: 'Пауза', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', true);
    await page.waitForTimeout(2200);
    await expect(controls).toHaveAttribute('data-visible', 'true');
    await page.setViewportSize({ width: 320, height: 640 });
    for (const button of await controls
      .getByRole('button', {
        name: /^(Пауза|Відтворення|Увімкнути звук|Вимкнути звук|На весь екран|Вийти з повноекранного режиму)$/,
      })
      .all()) {
      const bounds = await button.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44);
      expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Додаткові дії' }).click();
    await expect(page.getByRole('menuitem', { name: 'Швидкість 1×', exact: true })).toBeVisible();
    await page.waitForTimeout(2200);
    await expect(page.getByRole('menuitem', { name: 'Швидкість 1×', exact: true })).toBeVisible();
  });

  test(`@regression #3340 ${host}: rotation preserves playback and tap behavior`, async ({
    page,
  }, testInfo) => {
    const { dialog, video } = await openVideo(page, host);
    const original = await video.elementHandle();
    await dialog.getByRole('button', { name: 'Додаткові дії' }).click();
    await page.getByRole('menuitem', { name: 'Швидкість 1.5×', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await video.evaluate((element) => {
      element.pause();
      element.currentTime = 1;
    });
    await expect(video).toHaveJSProperty('seeking', false);
    for (const viewport of [
      { width: 812, height: 375 },
      { width: 375, height: 812 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(dialog.getByRole('button', { name: 'Інформація', exact: true })).toBeVisible();
      await page.touchscreen.tap(180, 200);
      await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
        'data-visible',
        'false',
      );
      await expect(video).toHaveJSProperty('paused', true);
      await expect(video).toHaveJSProperty('playbackRate', 1.5);
      await expect(video).toHaveJSProperty('currentTime', 1);
      expect(await video.evaluate((element, previous) => element === previous, original)).toBe(
        true,
      );
      await dialog.screenshot({
        path: testInfo.outputPath(`${host}-hidden-${viewport.width}.png`),
      });
      await page.touchscreen.tap(180, 200);
      await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
        'data-visible',
        'true',
      );
    }
    await dialog.getByRole('button', { name: 'Відтворення', exact: true }).click();
    await expect(video).toHaveJSProperty('paused', false);
  });

  test(`@regression #3340 ${host}: swipe and seek do not toggle playback or close the viewer`, async ({
    page,
  }) => {
    const { dialog, video } = await openVideo(page, host);
    await dialog.getByRole('button', { name: 'Пауза', exact: true }).click();
    const slider = dialog.getByRole('slider', { name: 'Позиція відтворення' });
    const bounds = await dialog.locator('[data-mobile-video-timeline]').boundingBox();
    if (!bounds) throw new Error('Timeline not visible');
    await swipe(
      page,
      { x: bounds.x + 8, y: bounds.y + bounds.height / 2 },
      { x: bounds.x + bounds.width * 0.7, y: bounds.y + bounds.height / 2 },
    );
    await expect.poll(() => video.evaluate((element) => element.currentTime)).toBeGreaterThan(1);
    await expect(video).toHaveJSProperty('paused', true);
    await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('3 / 7');
    const next = dialog.locator('[data-attachment-preview-nav="next"]:visible');
    await expect(next).toHaveCount(1);
    await expect(
      dialog.locator('[data-mobile-video-controls] [data-attachment-preview-counter]:visible'),
    ).toHaveCount(1);
    await next.click();
    await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('4 / 7');
    await dialog.locator('[data-attachment-preview-nav="prev"]:visible').click();
    await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('3 / 7');
    await swipe(page, { x: 280, y: 300 }, { x: 80, y: 300 });
    await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('4 / 7');
    await expect(dialog).toBeVisible();
  });
}

test('@regression #3340 overlays leave the entire mobile viewport for video', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    const { dialog, video } = await openVideo(page, 'duty', { viewport });
    await video.evaluate((element) => element.pause());
    await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /^(На весь екран|Вийти з повноекранного режиму)$/ }),
    ).toHaveCount(1);
    const panel = dialog.locator('[data-mobile-video-playback-panel]');
    if (viewport.width >= 480) {
      expect((await panel.boundingBox())!.height).toBeLessThanOrEqual(64);
      const time = (await panel.locator('[data-video-playback-time]').boundingBox())!;
      const thumb = (await dialog
        .getByRole('slider', { name: 'Позиція відтворення' })
        .boundingBox())!;
      expect(thumb.x - time.x - time.width).toBeGreaterThanOrEqual(4);
    }
    await expect
      .poll(() =>
        video.evaluate((element) => {
          const { width, height } = element.getBoundingClientRect();
          return { width: Math.round(width), height: Math.round(height) };
        }),
      )
      .toEqual(viewport);
    await dialog.screenshot({
      path: testInfo.outputPath(`signal-${viewport.width}.png`),
      animations: 'disabled',
    });
    await page.touchscreen.tap(180, 200);
    await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
      'data-visible',
      'false',
    );
    await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveCount(0);
    await dialog.screenshot({
      path: testInfo.outputPath(`signal-hidden-${viewport.width}.png`),
      animations: 'disabled',
    });
    await page.touchscreen.tap(180, 200);
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  }
});

test('@regression #3340 browser Back dismisses the menu and fullscreen before closing the viewer', async ({
  page,
}) => {
  const { dialog } = await openVideo(page, 'duty', { viewport: { width: 812, height: 375 } });
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
    .toBe(true);
  await dialog.getByRole('button', { name: 'Додаткові дії' }).click();
  await expect(page.getByRole('menu')).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
    .toBe(true);
  await page.goBack();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(dialog).toBeVisible();
  await page.goBack();
  await expect(dialog).toHaveCount(0);
});

test('@regression #3340 shared carousel and header match images and video', async ({ page }) => {
  const { dialog } = await openVideo(page, 'duty');
  const headerSpacing = (preview: Locator) =>
    preview.evaluate((element) => {
      const controls = ['Скачати', 'Відкрити в новій вкладці', 'Закрити'].map((label) =>
        element.querySelector(`[aria-label="${label}"]`)!.getBoundingClientRect(),
      );
      return {
        widths: controls.map(({ width }) => width),
        gaps: controls.slice(1).map((control, index) => control.left - controls[index].right),
      };
    });
  const spacing = await headerSpacing(dialog);
  await dialog.locator('[data-attachment-preview-nav="prev"]:visible').click();
  const image = page.getByRole('dialog', { name: 'Перегляд зображення' });
  expect(spacing).toEqual(await headerSpacing(image));
  await expect(image.locator('[data-attachment-preview-counter]:visible')).toHaveText('2 / 7');
  await image.locator('[data-attachment-preview-nav="next"]:visible').click();
  await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('3 / 7');
  await dialog.getByRole('button', { name: 'Інформація', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toBeVisible();
  await page.keyboard.press('Escape');
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('@regression #3340 rotation works without browser or WebKit fullscreen APIs', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => {
      throw new Error('Must not request fullscreen on rotation');
    };
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', {
      configurable: true,
      value: () => {
        throw new Error('Must keep our controls');
      },
    });
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const { dialog, video } = await openVideo(page, 'duty');
  await page.setViewportSize({ width: 812, height: 375 });
  await expect(video).not.toHaveAttribute('controls', '');
  await expect
    .poll(() => video.evaluate((element) => Math.round(element.getBoundingClientRect().height)))
    .toBe(375);
  await expect(video).toHaveJSProperty('paused', false);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('@regression #3340 landscape media errors keep retry and close available', async ({
  page,
}) => {
  const { dialog, video } = await openVideo(page, 'duty', {
    viewport: { width: 812, height: 375 },
  });
  await video.evaluate((element) => element.dispatchEvent(new Event('error')));
  await expect(dialog.getByRole('button', { name: 'Повторити завантаження' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('@regression #3340 blocked autoplay leaves tap-to-play and close reachable', async ({
  page,
}) => {
  await page.addInitScript(() => {
    HTMLMediaElement.prototype.play = () =>
      Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
  });
  const { dialog } = await openVideo(page, 'duty', { startPlayback: false });
  await expect(dialog.getByRole('button', { name: 'Торкніться, щоб відтворити' })).toBeVisible();
  await page.waitForTimeout(2200);
  await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
    'data-visible',
    'true',
  );
  await dialog.getByRole('button', { name: 'Торкніться, щоб відтворити' }).click({ timeout: 3000 });
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('@regression #3340 portrait footage fits and matches other attachments in both themes', async ({
  page,
}, testInfo) => {
  const { dialog, video } = await openVideo(page, 'duty', { portrait: true });
  await video.evaluate((element) => element.pause());
  const dimensions = await video.evaluate((element) => ({
    width: element.videoWidth,
    height: element.videoHeight,
    fit: getComputedStyle(element).objectFit,
  }));
  expect(dimensions).toEqual({ width: 64, height: 96, fit: 'contain' });
  const background = (preview: Locator) =>
    preview
      .locator('[data-attachment-preview-swipe-content]')
      .evaluate((element) => getComputedStyle(element.parentElement!).backgroundColor);
  const assertImageBackground = async () => {
    const videoBackground = await background(dialog);
    await dialog.locator('[data-attachment-preview-nav="prev"]:visible').click();
    const image = page.getByRole('dialog', { name: 'Перегляд зображення' });
    expect(videoBackground).toBe(await background(image));
    await image.locator('[data-attachment-preview-nav="next"]:visible').click();
    await expect
      .poll(() => video.evaluate((element) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    await video.evaluate((element) => element.pause());
    return videoBackground;
  };
  const assertThemedPanels = async (surface: string) => {
    const surfaceRgb = surface
      .match(/[\d.]+/g)!
      .slice(0, 3)
      .map(Number);
    const foreground = await dialog
      .getByRole('heading', { name: 'e2e-video-1.mp4', exact: true })
      .evaluate((element) => getComputedStyle(element).color);
    for (const selector of ['[data-mobile-video-playback-panel]', '[data-video-carousel]']) {
      const panel = dialog.locator(selector);
      const fill = await panel.evaluate((element) => getComputedStyle(element).backgroundColor);
      const rgba = fill.match(/[\d.]+/g)!.map(Number);
      expect(rgba.slice(0, 3)).toEqual(surfaceRgb);
      expect(rgba[3]).toBeGreaterThan(0);
      expect(rgba[3]).toBeLessThan(1);
    }
    for (const selector of [
      '[data-video-playback-time]',
      '[data-mobile-video-timeline]',
      '[data-video-carousel] [data-attachment-preview-counter]',
      '[data-video-carousel] [data-attachment-preview-nav="prev"]',
    ]) {
      await expect(dialog.locator(selector)).toHaveCSS('color', foreground);
    }
  };
  const lightBackground = await assertImageBackground();
  await assertThemedPanels(lightBackground);
  await dialog.screenshot({
    path: testInfo.outputPath('portrait-footage-light.png'),
    animations: 'disabled',
  });
  await page.evaluate(() => {
    document.documentElement.setAttribute('data-bs-theme', 'dark');
    window.dispatchEvent(new Event('echo-theme-applied'));
  });
  await expect(dialog.getByRole('button', { name: 'Закрити', exact: true })).toBeVisible();
  await expect.poll(() => background(dialog)).not.toBe(lightBackground);
  const darkBackground = await assertImageBackground();
  await assertThemedPanels(darkBackground);
  await dialog.screenshot({
    path: testInfo.outputPath('portrait-footage-dark.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
    .toBe(true);
  expect(await background(dialog)).toBe(darkBackground);
  await assertThemedPanels(darkBackground);
  await dialog.screenshot({
    path: testInfo.outputPath('portrait-footage-dark-fullscreen.png'),
    animations: 'disabled',
  });
  await dialog.getByRole('button', { name: 'Вийти з повноекранного режиму', exact: true }).click();
});

test('@regression #3340 keyboard focus keeps controls available until focus leaves', async ({
  page,
}) => {
  const { dialog } = await openVideo(page, 'duty');
  const controls = dialog.locator('[data-mobile-video-controls]');
  const mute = dialog.getByRole('button', { name: 'Увімкнути звук', exact: true });
  await mute.focus();
  await page.waitForTimeout(2200);
  await expect(controls).toHaveAttribute('data-visible', 'true');
  await mute.blur();
  await expect(controls).toHaveAttribute('data-visible', 'false', { timeout: 6000 });
});

test('@regression #3340 pinch zoom does not navigate or toggle playback', async ({ page }) => {
  const { dialog, video } = await openVideo(page, 'duty');
  await dialog.getByRole('button', { name: 'Пауза', exact: true }).click();
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 140, y: 320, id: 0 },
      { x: 230, y: 410, id: 1 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 100, y: 280, id: 0 },
      { x: 270, y: 450, id: 1 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await session.detach();
  await expect
    .poll(() =>
      video.evaluate((element) => Number(/scale\(([^)]+)\)/.exec(element.style.transform)?.[1])),
    )
    .toBeGreaterThan(1);
  await expect(video).toHaveJSProperty('paused', true);
  await expect(dialog.locator('[data-attachment-preview-counter]:visible')).toHaveText('3 / 7');
});

test('@regression #3340 report draft remains editable through taps and rotation', async ({
  page,
}) => {
  const opened = await openVideo(page, 'duty');
  await opened.dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await page.route('**/api/1.1/messages/copy', (route) =>
    route.fulfill({
      json: { payloads: [{ full_body: 'Report source', parent_signal_message_ids: [42] }] },
    }),
  );
  await page.getByRole('button', { name: 'Створити розвіддонесення', exact: true }).first().click();
  const editor = page.locator('[data-manage-message-presentation]');
  await editor.getByRole('textbox', { name: 'Текст розвіддонесення' }).fill('Mobile report draft');
  await editor
    .locator('input[type="file"]')
    .setInputFiles('tests/e2e/fixtures/device-file-preview/video.mp4');
  await editor.getByRole('button', { name: 'Переглянути video.mp4', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Перегляд відео' });
  const draft = dialog.getByRole('textbox', { name: 'Текст розвіддонесення' });
  await expect(draft).toHaveValue('Mobile report draft');
  await draft.fill('Edited in video preview');
  const video = dialog.locator('video');
  await video.evaluate(async (element) => {
    element.muted = true;
    element.loop = true;
    await element.play();
  });
  await page.touchscreen.tap(180, 280);
  await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
    'data-visible',
    'false',
  );
  await page.touchscreen.tap(180, 280);
  await page.setViewportSize({ width: 812, height: 375 });
  await expect(draft).toHaveValue('Edited in video preview');
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(editor.getByRole('textbox', { name: 'Текст розвіддонесення' })).toHaveValue(
    'Edited in video preview',
  );
});

test('@regression #3340 desktop keeps its existing video controls', async ({ page }, testInfo) => {
  await openVideo(page, 'duty', { viewport: { width: 1440, height: 900 } });
  const desktop = page.getByRole('dialog', { name: 'Перегляд відео' });
  await expect(desktop.locator('[data-mobile-video-controls]')).toHaveCount(0);
  await expect(page.locator('meta[name="viewport"]')).not.toHaveAttribute(
    'content',
    /viewport-fit=cover/,
  );
  await expect(desktop.getByRole('button', { name: 'Інформація', exact: true })).toBeVisible();
  await desktop.locator('video').evaluate((element) => element.pause());
  await desktop.screenshot({
    path: testInfo.outputPath('desktop-video.png'),
    animations: 'disabled',
  });
});

test('@regression #3340 desktop clicks toggle chrome without playing or zooming', async ({
  page,
}) => {
  const { dialog, video } = await openVideo(page, 'duty', {
    viewport: { width: 1440, height: 900 },
  });
  await video.evaluate((element) => element.pause());
  const close = dialog.getByRole('button', { name: 'Закрити', exact: true });
  await expect(close).toBeVisible();
  await video.click();
  await expect(close).toBeHidden();
  await expect(video).toHaveJSProperty('paused', true);
  await video.click();
  await expect(close).toBeVisible();
  await expect(video).toHaveJSProperty('paused', true);
  await video.dblclick();
  await expect(video).toHaveJSProperty('paused', true);
  await expect(video).toHaveCSS('transform', 'matrix(1, 0, 0, 1, 0, 0)');
});

test('@regression #3340 keyboard can reveal auto-hidden video controls', async ({ page }) => {
  const { dialog, video } = await openVideo(page, 'duty', {
    viewport: { width: 1440, height: 900 },
  });
  const header = dialog.locator('[data-video-header]');
  await expect(header).toBeHidden({ timeout: 6000 });
  await page.keyboard.press('Tab');
  await expect(video).toBeFocused();
  await video.press('Enter');
  await expect(header).toBeVisible();
  await expect(video).toHaveJSProperty('paused', false);
  await video.press('Space');
  await expect(header).toBeHidden();
  await expect(video).toHaveJSProperty('paused', false);
  await video.press('Enter');
  const pause = dialog.getByRole('button', { name: 'Пауза', exact: true });
  await pause.focus();
  await pause.press('Enter');
  await expect(video).toHaveJSProperty('paused', true);
});

test('@regression #3340 mobile carousel island sits above controls without shifting single-file playback', async ({
  page,
}, testInfo) => {
  for (const viewport of [
    { width: 320, height: 640 },
    { width: 375, height: 812 },
    { width: 560, height: 375 },
  ]) {
    const { dialog, video } = await openVideo(page, 'duty', { viewport });
    await video.evaluate((element) => element.pause());
    const panel = dialog.locator('[data-mobile-video-playback-panel]');
    const panelBounds = (await panel.boundingBox())!;
    const island = dialog.locator('[data-video-carousel]');
    await expect(island).toBeVisible();
    const islandBounds = (await island.boundingBox())!;
    expect(islandBounds.y + islandBounds.height).toBeLessThanOrEqual(panelBounds.y - 8);
    expect(Math.abs(islandBounds.x + islandBounds.width / 2 - viewport.width / 2)).toBeLessThan(1);
    expect(islandBounds.width).toBeLessThan(viewport.width / 2);
    expect(panelBounds.y + panelBounds.height).toBe(viewport.height);
    await expect(island).toHaveCSS(
      'background-color',
      await panel.evaluate((element) => getComputedStyle(element).backgroundColor),
    );
    await dialog.screenshot({
      path: testInfo.outputPath(`island-${viewport.width}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    const inbox = buildMessageCardMediaPreviewInboxResponse();
    const message = inbox.inbox_items[0][1];
    message.media = message.media?.filter((media) => media.id === 'e2e-video-1');
    message.images = [];
    await page.route('**/api/rer-importer/get-inbox', (route) => route.fulfill({ json: inbox }));
    await page.reload();
    const expand = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
    if ((await expand.getAttribute('aria-expanded')) !== 'true') await expand.click();
    await page.getByRole('button', { name: 'Відкрити відео' }).click();
    await expect
      .poll(() => dialog.locator('video').evaluate((element) => element.readyState))
      .toBeGreaterThanOrEqual(2);
    await dialog.locator('video').evaluate((element) => element.pause());
    await expect(dialog.getByRole('button', { name: 'Відтворення', exact: true })).toBeVisible();
    await expect(dialog.locator('[data-video-carousel]')).toHaveCount(0);
    expect(await panel.boundingBox()).toEqual(panelBounds);
    await dialog.screenshot({
      path: testInfo.outputPath(`single-${viewport.width}.png`),
      animations: 'disabled',
    });
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  }
});

for (const host of ['analysis', 'duty'] as const) {
  test(`@regression #3340 ${host}: fullscreen button expands our player and restores playback state`, async ({
    page,
  }, testInfo) => {
    const { dialog, video } = await openVideo(page, host);
    const original = await video.elementHandle();
    await video.evaluate((element) => {
      element.pause();
      element.currentTime = 1;
      element.playbackRate = 1.5;
    });
    await expect(video).toHaveJSProperty('seeking', false);
    await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
      .toBe(true);
    await expect(video).not.toHaveAttribute('controls', '');
    await expect(
      dialog.getByRole('button', { name: 'Вийти з повноекранного режиму', exact: true }),
    ).toBeVisible();
    await page.touchscreen.tap(180, 300);
    await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
      'data-visible',
      'false',
    );
    await expect(video).toHaveJSProperty('paused', true);
    await page.touchscreen.tap(180, 300);
    await expect(dialog.locator('[data-mobile-video-controls]')).toHaveAttribute(
      'data-visible',
      'true',
    );
    await dialog.getByRole('button', { name: 'Додаткові дії' }).click();
    await expect(page.getByRole('menuitem', { name: 'Швидкість 1.5×', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Швидкість 1.5×', exact: true }).click();
    await expect(page.getByRole('menu')).toHaveCount(0);
    await dialog.screenshot({
      path: testInfo.outputPath(`${host}-fullscreen-button.png`),
      animations: 'disabled',
    });
    await dialog
      .getByRole('button', { name: 'Вийти з повноекранного режиму', exact: true })
      .click();
    await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
    expect(await video.evaluate((element, previous) => element === previous, original)).toBe(true);
    await expect(video).toHaveJSProperty('currentTime', 1);
    await expect(video).toHaveJSProperty('playbackRate', 1.5);
    await expect(video).toHaveJSProperty('muted', true);
    await expect(video).toHaveJSProperty('paused', true);
  });
}

test('@regression #3340 iPhone fullscreen uses native video controls and restores our controls on exit', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitEnterFullscreen', {
      configurable: true,
      value: function (this: HTMLVideoElement) {
        if (!this.controls) throw new Error('Native controls must be enabled before entering');
        Object.defineProperty(this, 'webkitDisplayingFullscreen', {
          configurable: true,
          value: true,
        });
        this.dispatchEvent(new Event('webkitbeginfullscreen'));
      },
    });
    Object.defineProperty(HTMLVideoElement.prototype, 'webkitExitFullscreen', {
      configurable: true,
      value: function (this: HTMLVideoElement) {
        Object.defineProperty(this, 'webkitDisplayingFullscreen', {
          configurable: true,
          value: false,
        });
        this.dispatchEvent(new Event('webkitendfullscreen'));
      },
    });
  });
  const { dialog, video } = await openVideo(page, 'duty');
  const original = await video.elementHandle();
  await video.evaluate((element) => element.pause());
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect(video).toHaveJSProperty('controls', true);
  await video.evaluate((element) => {
    element.currentTime = 1;
    element.dispatchEvent(new Event('webkitendfullscreen'));
  });
  await expect(video).toHaveJSProperty('controls', false);
  await expect(dialog.getByRole('button', { name: 'На весь екран', exact: true })).toBeVisible();
  await expect(video).toHaveJSProperty('currentTime', 1);
  await expect(video).toHaveJSProperty('paused', true);
  expect(await video.evaluate((element, previous) => element === previous, original)).toBe(true);
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeVisible();
  await expect(video).toHaveJSProperty('controls', false);
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(
    await original!.evaluate(
      (element) =>
        (element as HTMLVideoElement & { webkitDisplayingFullscreen: boolean })
          .webkitDisplayingFullscreen,
    ),
  ).toBe(false);
});

test('@regression #3340 rejected fullscreen keeps our player usable and reports the error', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () => Promise.reject(new TypeError('Denied'));
  });
  const { dialog, video } = await openVideo(page, 'duty');
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect(
    page.getByText('Не вдалося відкрити відео на весь екран', { exact: true }),
  ).toBeVisible();
  await expect(video).toHaveJSProperty('controls', false);
  await expect(video).toHaveJSProperty('paused', false);
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
});

test('@regression #3340 closing a fullscreen video releases the browser fullscreen', async ({
  page,
}) => {
  const { dialog } = await openVideo(page, 'duty');
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
    .toBe(true);
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('@regression #3340 Escape exits browser fullscreen while keeping the viewer open', async ({
  page,
}) => {
  const { dialog } = await openVideo(page, 'duty');
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
    .toBe(true);
  await page.keyboard.press('Escape');
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'На весь екран', exact: true })).toBeVisible();
});

test('@regression #3340 late fullscreen entry after closing is released', async ({ page }) => {
  await page.addInitScript(() => {
    Element.prototype.requestFullscreen = () =>
      new Promise((resolve) => {
        (window as unknown as { finishFullscreen: () => void }).finishFullscreen = () => {
          Object.defineProperty(document, 'fullscreenElement', {
            configurable: true,
            value: document.documentElement,
          });
          resolve();
        };
      });
    document.exitFullscreen = () => {
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      return Promise.resolve();
    };
  });
  const { dialog } = await openVideo(page, 'duty');
  await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() =>
    (window as unknown as { finishFullscreen: () => void }).finishFullscreen(),
  );
  await expect.poll(() => page.evaluate(() => document.fullscreenElement)).toBeNull();
});

test('@regression #3340 portrait fullscreen header keeps clear of screen edges and cutouts', async ({
  page,
}, testInfo) => {
  const session = await page.context().newCDPSession(page);
  for (const viewport of [
    { width: 375, height: 812 },
    { width: 812, height: 375 },
  ]) {
    const portrait = viewport.height > viewport.width;
    const { dialog, video } = await openVideo(page, 'duty', { viewport });
    await video.evaluate((element) => element.pause());
    const close = dialog.getByRole('button', { name: 'Закрити', exact: true });
    const viewportMeta = page.locator('meta[name="viewport"]');
    await expect(viewportMeta).toHaveAttribute('content', /viewport-fit=cover/);
    await expect(viewportMeta).toHaveAttribute('content', /width=device-width/);
    await expect(viewportMeta).toHaveAttribute('content', /initial-scale=1/);
    const initialClose = (await close.boundingBox())!;
    await dialog.getByRole('button', { name: 'На весь екран', exact: true }).click();
    await expect
      .poll(() => page.evaluate(() => document.fullscreenElement === document.documentElement))
      .toBe(true);
    if (portrait) {
      await expect.poll(async () => (await close.boundingBox())!.y).toBeGreaterThanOrEqual(18);
      expect((await close.boundingBox())!.x + initialClose.width).toBeLessThanOrEqual(
        viewport.width - 24,
      );
    } else expect((await close.boundingBox())!.y).toBe(initialClose.y);
    await dialog.screenshot({
      path: testInfo.outputPath(`safe-area-zero-${viewport.width}.png`),
      animations: 'disabled',
    });
    const insets = portrait
      ? { top: 44, left: 12, right: 16, bottom: 34 }
      : { top: 0, left: 44, right: 12, bottom: 16 };
    await session.send('Emulation.setSafeAreaInsetsOverride', { insets });
    await expect
      .poll(async () => (await close.boundingBox())!.y)
      .toBeGreaterThanOrEqual(insets.top + (portrait ? 18 : initialClose.y));
    const closeBounds = (await close.boundingBox())!;
    expect(closeBounds.x + closeBounds.width).toBeLessThanOrEqual(
      viewport.width - insets.right - (portrait ? 24 : 16),
    );
    const file = (await dialog
      .getByRole('heading', { name: 'e2e-video-1.mp4', exact: true })
      .boundingBox())!;
    expect(file.x).toBeGreaterThanOrEqual(insets.left + (portrait ? 24 : 16));
    const panel = dialog.locator('[data-mobile-video-playback-panel]');
    const panelBounds = (await panel.boundingBox())!;
    expect(panelBounds.y + panelBounds.height).toBe(viewport.height);
    for (const button of await panel.getByRole('button').all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.y + bounds.height).toBeLessThanOrEqual(viewport.height - insets.bottom);
    }
    expect(
      await panel.evaluate((element) =>
        element.contains(document.elementFromPoint(window.innerWidth / 2, window.innerHeight - 1)),
      ),
    ).toBe(true);
    await expect(video).toHaveJSProperty('paused', true);
    await dialog.screenshot({
      path: testInfo.outputPath(`safe-area-cutout-${viewport.width}.png`),
      animations: 'disabled',
    });
    await session.send('Emulation.setSafeAreaInsetsOverride', {
      insets: { top: 0, left: 0, right: 0, bottom: 0 },
    });
    await dialog
      .getByRole('button', { name: 'Вийти з повноекранного режиму', exact: true })
      .click();
    await expect(dialog.getByRole('button', { name: 'На весь екран', exact: true })).toBeVisible();
    expect(await close.boundingBox()).toEqual(initialClose);
    await dialog
      .getByRole('button', { name: 'Попереднє', exact: true })
      .filter({ visible: true })
      .click();
    await expect(viewportMeta).not.toHaveAttribute('content', /viewport-fit=cover/);
    await page
      .getByRole('button', { name: 'Наступне', exact: true })
      .filter({ visible: true })
      .click();
    await expect(viewportMeta).toHaveAttribute('content', /viewport-fit=cover/);
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(viewportMeta).not.toHaveAttribute('content', /viewport-fit=cover/);
  }
  await session.detach();
});
