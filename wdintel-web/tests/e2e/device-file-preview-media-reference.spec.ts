import { expect, test, type Locator } from '@playwright/test';
import { createHash } from 'node:crypto';
import {
  writeMediaReferenceEvidence,
  type MediaReferenceOutcome,
} from './device-file-preview-media-evidence';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

type NativeHost = HTMLMediaElement & { audio?: HTMLAudioElement };
test.describe.configure({ mode: 'default' });

async function controls(player: Locator) {
  await player.evaluate(async (host: NativeHost) => {
    const media = host.audio ?? host;
    media.volume = 0.4;
    await media.play();
  });
  await expect
    .poll(() => player.evaluate((host: NativeHost) => (host.audio ?? host).currentTime))
    .toBeGreaterThan(0.1);
  await player.evaluate((host: NativeHost) => {
    const media = host.audio ?? host;
    media.pause();
    media.currentTime = 1.5;
  });
  await expect
    .poll(() =>
      player.evaluate((host: NativeHost) => {
        const media = host.audio ?? host;
        return !media.seeking && media.readyState >= 2 && media.currentTime >= 1.4;
      }),
    )
    .toBe(true);
  expect(await player.evaluate((host: NativeHost) => (host.audio ?? host).volume)).toBeCloseTo(0.4);
  expect(await player.evaluate((host: NativeHost) => (host.audio ?? host).paused)).toBe(true);
}

for (const fixture of DEVICE_FILE_PREVIEW_FIXTURES.filter(
  (fixture) =>
    fixture.scenario === 'format' &&
    fixture.availability === 'present' &&
    ['audio', 'video'].includes(fixture.category),
)) {
  test(`@regression same-byte reference media controls and native outcome ${fixture.id}`, async ({
    page,
  }, info) => {
    test.setTimeout(150_000);
    const { bytes } = await loadDeviceFilePreviewFixture(fixture.id);
    const outcomes: MediaReferenceOutcome[] = [];
    for (const host of ['duty', 'analysis'] as const) {
      const href = `/test-assets/media-corpus/${fixture.id}/${fixture.fileName}`;
      const inbox = buildMessageCardMediaPreviewInboxResponse();
      const attachment = inbox.inbox_items[0][1].media!.find(
        (entry) => entry.id === (fixture.category === 'audio' ? 'e2e-audio' : 'e2e-video-1'),
      )!;
      Object.assign(attachment, {
        href,
        file_name: fixture.fileName,
        content_type: fixture.mimeType,
        size_bytes: bytes.length,
      });
      await page.route(`**${href}`, async (route) => {
        const range = /^bytes=(\d+)-(\d*)$/.exec(route.request().headers().range ?? '');
        const start = range ? Number(range[1]) : 0;
        const end = range?.[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        await route.fulfill({
          status: range ? 206 : 200,
          headers: {
            'Content-Type':
              fixture.mimeType ?? (fixture.category === 'audio' ? 'audio/wav' : 'video/mp4'),
            'Content-Length': String(end - start + 1),
            'Accept-Ranges': 'bytes',
            ...(range ? { 'Content-Range': `bytes ${start}-${end}/${bytes.length}` } : {}),
          },
          body: bytes.subarray(start, end + 1),
        });
      });
      const extensionOnlyMpeg = fixture.id === 'audio-mpeg';
      await openMessageCardPreviewHost(
        page,
        host,
        extensionOnlyMpeg
          ? {}
          : {
              messageOverrides: { media: inbox.inbox_items[0][1].media },
            },
      );
      if (extensionOnlyMpeg) {
        const endpoint = '**/api/rer-importer/get-inbox';
        await page.route(endpoint, (route) => route.fulfill({ json: inbox }));
        await page.reload();
        const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
        if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
        await expect(page.getByRole('button', { name: 'Відкрити відео' })).toHaveCount(3);
      }
      const video = fixture.category === 'video' || extensionOnlyMpeg;
      if (video)
        await page
          .getByRole('button', { name: 'Відкрити відео' })
          .nth(extensionOnlyMpeg ? 2 : 0)
          .click();
      else {
        await page.getByRole('button', { name: 'Відкрити зображення' }).first().click();
        for (let index = 0; index < 6; index++)
          await page.getByRole('button', { name: 'Наступне', exact: true }).click();
      }
      const dialog = page.getByRole('dialog', {
        name: video ? 'Перегляд відео' : 'Перегляд аудіо',
      });
      await expect(
        dialog.getByRole('heading', { name: fixture.fileName, exact: true }),
      ).toBeVisible();
      if (extensionOnlyMpeg) {
        await expect(
          dialog.locator('[data-audio-preview-content] custom-audio-player'),
        ).toBeVisible();
        await expect(dialog.locator('video')).toHaveCount(0);
        await expect(dialog.locator('[data-attachment-preview-video-controls]')).toHaveCount(0);
      }
      const player = dialog.locator('video, custom-audio-player');
      await expect
        .poll(
          async () =>
            player.evaluate((host: NativeHost) => {
              const media = host.audio ?? host;
              return media.readyState >= 2 ? 'playable' : media.error ? 'refused' : 'pending';
            }),
          { timeout: 40_000 },
        )
        .not.toBe('pending');
      const native = await player.evaluate((host: NativeHost) => {
        const media = host.audio ?? host;
        return {
          playable: media.readyState >= 2,
          nativeError: media.error?.code ?? null,
          duration: media.duration,
          videoWidth: media instanceof HTMLVideoElement ? media.videoWidth : undefined,
          videoHeight: media instanceof HTMLVideoElement ? media.videoHeight : undefined,
        };
      });
      const outcome: MediaReferenceOutcome = {
        fixture: fixture.id,
        host,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        ...native,
      };
      if (native.playable) {
        await controls(player);
        outcome.duration = await player.evaluate(
          (host: NativeHost) => (host.audio ?? host).duration,
        );
        if (fixture.category === 'video' && (native.videoWidth ?? 0) > 0) {
          const frame = await player.evaluate((video: HTMLVideoElement) => {
            const canvas = document.createElement('canvas');
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            const context = canvas.getContext('2d')!;
            context.drawImage(video, 0, 0);
            return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
          });
          outcome.frameSha256 = createHash('sha256').update(Buffer.from(frame)).digest('hex');
        }
      }
      outcomes.push(outcome);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    }
    expect(outcomes[0].playable).toBe(outcomes[1].playable);
    if (outcomes[0].playable) {
      expect(outcomes[0].duration).toBeCloseTo(outcomes[1].duration!, 3);
      if (fixture.category === 'video') {
        expect(outcomes[0].videoWidth).toBe(outcomes[1].videoWidth);
        expect(outcomes[0].videoHeight).toBe(outcomes[1].videoHeight);
        expect(outcomes[0].frameSha256).toBe(outcomes[1].frameSha256);
      }
    }
    await writeMediaReferenceEvidence(outcomes);
    await info.attach('same-byte-reference-outcomes', {
      body: JSON.stringify(outcomes),
      contentType: 'application/json',
    });
  });
}
