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

// @test-scope regression: https://github.com/echoua/echo/pull/3268
test.describe('@smoke', () => {
  for (const host of ['duty', 'analysis'] as const) {
    // @test-scope regression: https://github.com/echoua/echo/issues/3405
    test(`${host} message card preview smoke covers the shared contract`, async ({ page }) => {
      await openMessageCardPreviewHost(page, host);

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
});

test.describe('message card media preview contract', () => {
  // @test-scope safeguard: preserves operators' ability to inspect the correct image attachment and safely leave its fullscreen preview
  test('image previews preserve carousel order, info, download, and fullscreen escape', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');

    const imageDialog = await openImagePreview(page);
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

  // @test-scope safeguard: preserves operators' ability to inspect, download, and close video attachments without losing carousel position
  test('video previews preserve carousel controls, info, download, and fullscreen escape', async ({
    page,
  }) => {
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

  // @test-scope safeguard: preserves source-text and audio inspection plus predictable mixed-carousel ordering and escape behavior
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3405
  test('audio preview matches the reference layout and remains usable at narrow widths', async ({
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3405
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
    await reopenedAudioDialog.getByRole('button', { name: 'Інформація' }).click();
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Інформація про вкладення' })).toHaveCount(0);
    await expect(reopenedAudioDialog).toBeVisible();
  });
});
