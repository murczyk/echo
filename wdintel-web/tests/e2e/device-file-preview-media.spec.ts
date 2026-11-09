import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  localFilePreviewBackend,
  previewPost,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import { openDeviceFilePreview, type FilePreviewBackend } from './device-file-preview.ui';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';
import { readFile, readdir, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { DeviceDetails, ListLoginsRsp, Login, UpdateLoginReq } from '../../src/Bindings';
import { openMessageCardPreviewHost } from './message-card-media-preview.fixtures';
import { readMediaReferenceEvidence } from './device-file-preview-media-evidence';

type MediaHost = HTMLMediaElement & { audio?: HTMLAudioElement };

function readyState(host: MediaHost) {
  return (host.audio ?? host).readyState;
}
function currentTime(host: MediaHost) {
  return (host.audio ?? host).currentTime;
}
function play(host: MediaHost) {
  return (host.audio ?? host).play();
}
function seek(host: MediaHost) {
  const media = host.audio ?? host;
  media.pause();
  media.currentTime = 1.5;
}

async function selectMedia(page: Page, backend: FilePreviewBackend, id: string) {
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === id)!;
  const file = backend.fixtures.seeded.find((entry) => entry.fixtureId === id)!.file;
  await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(fixture.fileName);
  await page.getByRole('button', { name: 'Знайти', exact: true }).click();
  await page
    .locator(`[data-entry-id="${file.fileId}"]`)
    .getByRole('button', {
      name: fixture.fileName,
      exact: true,
    })
    .click();
  return page.getByTestId('device-file-content-pane');
}

async function expectRetired(media: Locator) {
  const retired = await media.evaluateHandle((host: MediaHost) => host.audio ?? host);
  if (!retired) throw new Error('Expected an actual native player before retirement');
  return async () => {
    expect(await retired.evaluate((host: MediaHost) => (host.audio ?? host).paused)).toBe(true);
    expect(
      await retired.evaluate((host: MediaHost) => (host.audio ?? host).getAttribute('src')),
    ).toBeNull();
  };
}

for (const status of [401, 403, 404]) {
  test(`@regression opaque native error after allowed HEAD rechecks ${status} and retires media`, async ({
    page,
  }) => {
    const backend = await localFilePreviewBackend();
    const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'video-mp4')!;
    let heads = 0;
    let release!: () => void;
    const failure = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**${entry.originalHref}`, async (route) => {
      if (route.request().method() === 'HEAD' && ++heads > 1)
        await route.fulfill({ status, json: { msg: 'Доступ до файлу відхилено' } });
      else await route.continue();
    });
    await page.route(
      `**${entry.originalHref.replace(/content$/, 'preview/media')}`,
      async (route) => {
        if (route.request().headers().range === 'bytes=0-0') await route.continue();
        else {
          await failure;
          await route.abort('failed');
        }
      },
    );
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
      const media = pane.locator('video');
      await expect(media).toBeAttached();
      const retired = await expectRetired(media);
      release();
      if (status === 401) await expect(page).toHaveURL(/\/login\?redirect=/);
      else {
        await expect(pane.locator('video')).toHaveCount(0);
        await expect(
          pane.getByRole('button', { name: 'Скачати файл', exact: true }),
        ).toBeDisabled();
        await expect(pane.getByRole('button', { name: 'Повторити', exact: true })).toHaveCount(0);
        await retired();
      }
      expect(heads).toBeGreaterThanOrEqual(2);
    } finally {
      release();
      await backend.dispose();
    }
  });
}

for (const response of [
  { label: 'full 200', status: 200, range: 'bytes 0-0/10', length: '1', body: 'x' },
  { label: 'wrong range', status: 206, range: 'bytes 1-1/10', length: '1', body: 'x' },
  { label: 'two bytes', status: 206, range: 'bytes 0-0/10', length: '2', body: 'xx' },
  { label: 'empty body', status: 206, range: 'bytes 0-0/10', length: '0', body: '' },
]) {
  test(`@regression checked media preflight rejects ${response.label} without native src`, async ({
    page,
  }) => {
    const backend = await localFilePreviewBackend();
    const requests: string[] = [];
    await page.route('**/preview/media', async (route) => {
      requests.push(route.request().headers().range ?? '');
      await route.fulfill({
        status: response.status,
        headers: {
          'Content-Range': response.range,
          'Content-Length': response.length,
          'Content-Type': 'video/mp4',
        },
        body: response.body,
      });
    });
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
      await expect(pane.getByRole('alert').first()).toBeVisible();
      await expect(pane.locator('video, custom-audio-player')).toHaveCount(0);
      await expect(pane.getByRole('button', { name: 'Повторити', exact: true })).toBeEnabled();
      expect(requests).toEqual(['bytes=0-0']);
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression interrupted media preflight offers Retry and actual native playback recovers', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  let failed = false;
  await page.route('**/preview/media', async (route) => {
    if (!failed && route.request().headers().range === 'bytes=0-0') {
      failed = true;
      await route.abort('connectionclosed');
    } else await route.continue();
  });
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
    await expect(pane.getByRole('alert').first()).toBeVisible();
    await expect(pane.getByRole('alert').first()).not.toContainText('кодек');
    await pane.getByRole('button', { name: 'Повторити', exact: true }).click();
    const video = pane.locator('video');
    await expect.poll(() => video.evaluate(readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(0.1);
    await video.evaluate(seek);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThanOrEqual(1.4);
    expect(await video.evaluate((video: HTMLVideoElement) => video.paused)).toBe(true);
    await expect(pane.getByRole('alert')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression zero-byte published audio opens empty without media GET', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  const source = await backend.login('source');
  const { fixture } = await loadDeviceFilePreviewFixture('audio-wav');
  const empty = {
    ...fixture,
    id: 'browser-empty-audio',
    fileName: `empty-${backend.fixtures.run}.wav`,
  };
  const file = await syncPreviewFile(source, backend.fixtures.deviceId!, empty);
  await uploadPreviewContent(source, backend.fixtures.deviceId!, file, Buffer.alloc(0));
  const requests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes(file.fileId) && request.method() === 'GET')
      requests.push(request.url());
  });
  try {
    await openDeviceFilePreview(page, backend, 'audio-wav');
    await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(empty.fileName);
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await page
      .locator(`[data-entry-id="${file.fileId}"]`)
      .getByRole('button', { name: empty.fileName, exact: true })
      .click();
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane).toContainText('Файл порожній');
    await expect(pane.locator('video, custom-audio-player')).toHaveCount(0);
    expect(requests).toEqual([]);
  } finally {
    await backend.dispose();
  }
});

test('@regression delayed A-B-A preflight is aborted and old native errors cannot replace fresh A', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  const a = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'video-mp4')!;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  await page.route(`**${a.originalHref.replace(/content$/, 'preview/media')}`, async (route) => {
    if (first) {
      first = false;
      await pending;
      await route.fulfill({ status: 403, json: { msg: 'Old denied result' } }).catch(() => {});
    } else await route.continue();
  });
  try {
    const requested = page.waitForRequest((request) =>
      request.url().endsWith(a.originalHref.replace(/content$/, 'preview/media')),
    );
    await openDeviceFilePreview(page, backend, 'video-mp4');
    const old = await requested;
    const cancelled = page.waitForEvent('requestfailed', (request) => request === old);
    let pane = await selectMedia(page, backend, 'audio-wav');
    await cancelled;
    const player = pane.locator('custom-audio-player');
    await expect.poll(() => player.evaluate(readyState)).toBeGreaterThanOrEqual(2);
    await player.evaluate(play);
    await expect.poll(() => player.evaluate(currentTime)).toBeGreaterThan(0.1);
    const retired = await expectRetired(player);
    const handle = await player.evaluateHandle((host: MediaHost) => host.audio ?? host);
    pane = await selectMedia(page, backend, 'video-mp4');
    release();
    await retired();
    await handle!.evaluate((host: MediaHost) => {
      (host.audio ?? host).dispatchEvent(new Event('error'));
      (host.audio ?? host).dispatchEvent(new Event('canplay'));
    });
    const video = pane.locator('video');
    await expect.poll(() => video.evaluate(readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(0.1);
    await expect(pane.getByRole('alert')).toHaveCount(0);
  } finally {
    release();
    await backend.dispose();
  }
});

for (const id of ['audio-wav', 'video-mp4']) {
  test(`@regression playing ${id} stops on actual reader role revocation`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    const admin = await backend.login('admin');
    let reader: Login | undefined;
    const update = async (roles: string[]) => {
      if (!reader?.organismId) throw new Error('Missing owned reader');
      await previewPost(admin, '/api/login/update', {
        id: reader.id,
        login: reader.login,
        roles,
        organismId: reader.organismId,
        sigintZoneId: reader.sigintZoneId,
        deleted: false,
        password: null,
        deltaLogin: reader.deltaLogin,
        deactivationReason: null,
        description: reader.description,
        passwordAuthEnabled: reader.passwordAuthEnabled,
        clearTotp: false,
      } satisfies UpdateLoginReq);
    };
    try {
      const { pane, entry } = await openDeviceFilePreview(page, backend, id);
      const media = pane.locator('video, custom-audio-player');
      await expect.poll(() => media.evaluate(readyState)).toBeGreaterThanOrEqual(2);
      await media.evaluate(play);
      await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(0.1);
      const retired = await expectRetired(media);
      reader = (
        await previewPost<ListLoginsRsp>(admin, '/api/logins', {
          sortBy: null,
          filterByRoles: null,
        })
      ).users.find((user) => user.id === backend.fixtures.actors.reader.id);
      await update(['Api']);
      const denied = page.waitForResponse(
        (response) =>
          response.url().endsWith(entry.originalHref) &&
          response.request().method() === 'GET' &&
          response.status() === 403,
      );
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      await denied;
      await retired();
      await expect(page.locator('video, custom-audio-player')).toHaveCount(0);
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    } finally {
      if (reader) await update(reader.roles);
      await backend.dispose();
    }
  });
}

test('@regression actual expired browser identity is checked after playback and logs out with retired source', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  await page.addInitScript(() => {
    window.addEventListener('echo:api-unauthorized', () => {
      const video = (window as Window & { retiringMedia?: HTMLVideoElement }).retiringMedia;
      sessionStorage.setItem(
        'media-unauthorized-retirement',
        JSON.stringify({
          paused: video?.paused,
          src: video?.getAttribute('src'),
        }),
      );
    });
  });
  try {
    const { pane, entry } = await openDeviceFilePreview(page, backend, 'video-mp4');
    const video = pane.locator('video');
    await expect.poll(() => video.evaluate(readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(0.1);
    await video.evaluate((video: HTMLVideoElement) => {
      (window as Window & { retiringMedia?: HTMLVideoElement }).retiringMedia = video;
    });
    await page.context().clearCookies();
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith(entry.originalHref) &&
        response.request().method() === 'HEAD' &&
        response.status() === 401,
    );
    await video.evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event('error')));
    await denied;
    await expect(page).toHaveURL(/\/login\?redirect=/);
    expect(
      await page.evaluate(() =>
        JSON.parse(sessionStorage.getItem('media-unauthorized-retirement')!),
      ),
    ).toEqual({ paused: true, src: null });
  } finally {
    await backend.dispose();
  }
});

test('@regression actual reader scope loss returns checked 404 and stops playing media', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  const admin = await backend.login('admin');
  let reader: Login | undefined;
  const update = async (organismId: number) => {
    if (!reader) throw new Error('Missing owned reader');
    await previewPost(admin, '/api/login/update', {
      id: reader.id,
      login: reader.login,
      roles: reader.roles,
      organismId,
      sigintZoneId: reader.sigintZoneId,
      deleted: false,
      password: null,
      deltaLogin: reader.deltaLogin,
      deactivationReason: null,
      description: reader.description,
      passwordAuthEnabled: reader.passwordAuthEnabled,
      clearTotp: false,
    } satisfies UpdateLoginReq);
  };
  try {
    const { pane, entry } = await openDeviceFilePreview(page, backend, 'video-mp4');
    const video = pane.locator('video');
    await expect.poll(() => video.evaluate(readyState)).toBeGreaterThanOrEqual(2);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(0.1);
    const retired = await expectRetired(video);
    const users = (
      await previewPost<ListLoginsRsp>(admin, '/api/logins', { sortBy: null, filterByRoles: null })
    ).users;
    reader = users.find((user) => user.id === backend.fixtures.actors.reader.id);
    const foreign = users.find((user) => user.id === backend.fixtures.actors['denied-scope'].id)!;
    await update(foreign.organismId!);
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith(entry.originalHref) &&
        response.request().method() === 'HEAD' &&
        response.status() === 404,
    );
    await video.evaluate((video: HTMLVideoElement) => video.dispatchEvent(new Event('error')));
    await denied;
    await retired();
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    await expect(pane.locator('video, custom-audio-player')).toHaveCount(0);
  } finally {
    if (reader) await update(reader.organismId!);
    await backend.dispose();
  }
});

for (const id of ['audio-wav', 'video-mp4']) {
  test(`@regression playing ${id} is retired when the actual selected device changes`, async ({
    page,
  }) => {
    const backend = await localFilePreviewBackend();
    const source = await backend.login('source');
    const device = await previewPost<DeviceDetails>(source, '/api/device/create', {
      name: `media-switch-${id}-${backend.fixtures.run}`,
    });
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      const media = pane.locator('video, custom-audio-player');
      await expect.poll(() => media.evaluate(readyState)).toBeGreaterThanOrEqual(2);
      await media.evaluate(play);
      await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(0.1);
      const retired = await expectRetired(media);
      await page.evaluate((deviceId) => {
        history.pushState({}, '', `/devices/${deviceId}`);
        window.dispatchEvent(new PopStateEvent('popstate'));
      }, device.id);
      await expect(page).toHaveURL(new RegExp(`/devices/${device.id}$`));
      await expect(page.getByText(device.name, { exact: true }).first()).toBeVisible();
      await retired();
      await expect(page.locator('video, custom-audio-player')).toHaveCount(0);
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression native Devices video still loads after 35 seconds of actual network delay', async ({
  page,
}, info) => {
  const backend = await localFilePreviewBackend();
  let delayed = false;
  await page.route('**/preview/media', async (route) => {
    if (route.request().headers().range !== 'bytes=0-0' && !delayed) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 35_000));
    }
    await route.continue();
  });
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'video-mp4');
    const video = pane.locator('video');
    const start = Date.now();
    await expect
      .poll(() => video.evaluate(readyState), { timeout: 75_000 })
      .toBeGreaterThanOrEqual(2);
    const elapsedMs = Date.now() - start;
    expect(elapsedMs).toBeGreaterThan(30_000);
    await expect(pane.getByRole('alert')).toHaveCount(0);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(0.1);
    await info.attach('slow-native-load', {
      body: JSON.stringify({ elapsedMs }),
      contentType: 'application/json',
    });
  } finally {
    await backend.dispose();
  }
});

test('@regression actual unbuffered native seek survives a 35-second Range response', async ({
  page,
}, info) => {
  const backend = await localFilePreviewBackend();
  const path = resolve(backend.root, 'long-seek.mp4');
  execFileSync('ffmpeg', [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=640x360:rate=25',
    '-t',
    '120',
    '-an',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '20',
    '-g',
    '25',
    '-movflags',
    '+faststart',
    path,
  ]);
  const bytes = await readFile(path);
  const fixture = {
    ...(await loadDeviceFilePreviewFixture('video-mp4')).fixture,
    id: 'browser-slow-seek',
    fileName: `slow-seek-${backend.fixtures.run}.mp4`,
  };
  const source = await backend.login('source');
  const file = await syncPreviewFile(source, backend.fixtures.deviceId!, fixture);
  const receipt = await uploadPreviewContent(source, backend.fixtures.deviceId!, file, bytes);
  const mediaHref = receipt.originalHref.replace(/content$/, 'preview/media');
  let seeking = false;
  let delayed = false;
  const traces: object[] = [];
  await page.route(`**${mediaHref}`, async (route) => {
    const range = route.request().headers().range;
    if (range === 'bytes=0-0') {
      await route.continue();
      return;
    }
    const start = Number(/^bytes=(\d+)-/.exec(range ?? '')?.[1] ?? 0);
    const end = Math.min(bytes.length - 1, start + 256 * 1024 - 1);
    const slow = seeking && !delayed && start > bytes.length / 2;
    if (slow) {
      delayed = true;
      await new Promise((resolve) => setTimeout(resolve, 35_000));
    }
    traces.push({ range, start, end, slow, timestampMs: Date.now() });
    await route.fulfill({
      status: 206,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'private, no-store',
        'Content-Range': `bytes ${start}-${end}/${bytes.length}`,
        'Content-Length': String(end - start + 1),
      },
      body: bytes.subarray(start, end + 1),
    });
  });
  try {
    await openDeviceFilePreview(page, backend, 'video-mp4');
    await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(fixture.fileName);
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await page
      .locator(`[data-entry-id="${file.fileId}"]`)
      .getByRole('button', { name: fixture.fileName, exact: true })
      .click();
    const pane = page.getByTestId('device-file-content-pane');
    const video = pane.locator('video');
    await expect
      .poll(() => video.evaluate(readyState), { timeout: 75_000 })
      .toBeGreaterThanOrEqual(2);
    expect(
      await video.evaluate(
        (video: HTMLVideoElement) =>
          video.buffered.length && video.buffered.end(video.buffered.length - 1),
      ),
    ).toBeLessThan(90);
    seeking = true;
    const started = Date.now();
    await video.evaluate((video: HTMLVideoElement) => {
      video.currentTime = 90;
    });
    await expect
      .poll(
        () => video.evaluate((video: HTMLVideoElement) => !video.seeking && video.readyState >= 2),
        { timeout: 75_000 },
      )
      .toBe(true);
    const elapsedMs = Date.now() - started;
    expect(delayed).toBe(true);
    expect(elapsedMs).toBeGreaterThan(30_000);
    await expect(pane.getByRole('alert')).toHaveCount(0);
    await video.evaluate(play);
    await expect.poll(() => video.evaluate(currentTime)).toBeGreaterThan(90.1);
    await info.attach('slow-native-seek', {
      body: JSON.stringify({ elapsedMs, fixtureBytes: bytes.length, traces }),
      contentType: 'application/json',
    });
  } finally {
    await backend.dispose();
  }
});

for (const id of ['audio-wav', 'video-mp4']) {
  test(`@regression ${id} seek starts a fresh 75-second watchdog after 80 seconds ready idle`, async ({
    page,
  }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      const media = pane.locator('video, custom-audio-player');
      await expect.poll(() => media.evaluate(readyState)).toBeGreaterThanOrEqual(2);
      await page.clock.install();
      await page.clock.fastForward(80_000);
      await media.evaluate((host: MediaHost) =>
        (host.audio ?? host).dispatchEvent(new Event('seeking')),
      );
      await page.clock.fastForward(35_000);
      await expect(pane.getByRole('alert')).toHaveCount(0);
      await expect(media).toBeAttached();
      await page.clock.fastForward(40_001);
      await expect(pane.getByRole('alert').first()).toContainText(/надто довго|очікування/);
      await expect(media).toHaveCount(0);
      await expect(pane.getByRole('button', { name: 'Повторити', exact: true })).toBeEnabled();
    } finally {
      await backend.dispose();
    }
  });
}

test.setTimeout(110_000);

test('@regression MessageCard retains its 30-second native loading timeout', async ({ page }) => {
  await openMessageCardPreviewHost(page, 'duty');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/test-assets/message-card-media-preview/e2e-video-1.mp4', async (route) => {
    await pending;
    await route.abort().catch(() => {});
  });
  try {
    await page.clock.install();
    await page.getByRole('button', { name: 'Відкрити відео' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'Перегляд відео' });
    await expect(dialog.locator('video')).toBeAttached();
    await page.clock.fastForward(29_000);
    await expect(dialog.getByText(/надто довго/)).toHaveCount(0);
    await page.clock.fastForward(1_001);
    await expect(dialog).toContainText('Завантаження відео триває надто довго');
    await expect(
      dialog.getByRole('button', { name: 'Повторити завантаження', exact: true }),
    ).toBeEnabled();
  } finally {
    release();
  }
});

test('@regression checked preflight A and native playback B use separate cold caches', async ({
  page,
}, info) => {
  const backend = await localFilePreviewBackend();
  const { bytes: sourceBytes, fixture: wav } = await loadDeviceFilePreviewFixture('audio-wav');
  const fixture = {
    ...wav,
    id: 'browser-cold-encrypted-audio',
    fileName: `cold-encrypted-${backend.fixtures.run}.wav`,
  };
  const source = await backend.login('source');
  const file = await syncPreviewFile(source, backend.fixtures.deviceId!, fixture);
  const receipt = await uploadPreviewContent(source, backend.fixtures.deviceId!, file, sourceBytes);
  const metadata = JSON.parse(
    execFileSync(
      'python3',
      [
        resolve(process.cwd(), '../scripts/devices/file_preview_media_resources.py'),
        '--root',
        backend.root,
        '--inspect-media',
        file.fileId,
        '--revision',
        String(file.revision),
      ],
      { encoding: 'utf8' },
    ),
  );
  expect(metadata).toEqual({
    fileId: file.fileId,
    revision: file.revision,
    sourceSizeBytes: sourceBytes.length,
    isEncrypted: true,
  });
  const mediaHref = receipt.originalHref.replace(/content$/, 'preview/media');
  backend.route('a', 'a', 'b');
  const ranges: string[] = [];
  const trace: object[] = [];
  const bytes = async (role: 'a' | 'b') => {
    const root = resolve(backend.root, `cache-${role}`);
    const files = await readdir(root, { recursive: true });
    const sizes = await Promise.all(
      files.map(async (path) => {
        const entry = await stat(resolve(root, path));
        return entry.isFile() ? entry.size : 0;
      }),
    );
    return sizes.reduce((total, size) => total + size, 0);
  };
  const before = { a: await bytes('a'), b: await bytes('b') };
  page.on('request', (request) => {
    if (request.url().endsWith(mediaHref)) ranges.push(request.headers().range ?? '');
  });
  page.on('response', (response) => {
    if (response.url().endsWith(mediaHref))
      trace.push({
        range: response.request().headers().range,
        status: response.status(),
        contentRange: response.headers()['content-range'],
        length: response.headers()['content-length'],
      });
  });
  try {
    await openDeviceFilePreview(page, backend, 'video-mp4');
    await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(fixture.fileName);
    await page.getByRole('button', { name: 'Знайти', exact: true }).click();
    await page
      .locator(`[data-entry-id="${file.fileId}"]`)
      .getByRole('button', { name: fixture.fileName, exact: true })
      .click();
    const pane = page.getByTestId('device-file-content-pane');
    const media = pane.locator('custom-audio-player');
    await expect
      .poll(() => media.evaluate(readyState), {
        timeout: 80_000,
      })
      .toBeGreaterThanOrEqual(2);
    await media.evaluate(play);
    await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(0.1);
    await media.evaluate((host: MediaHost) => {
      (host.audio ?? host).volume = 0.4;
    });
    await media.evaluate(seek);
    await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThanOrEqual(1.4);
    expect(await media.evaluate((host: MediaHost) => (host.audio ?? host).paused)).toBe(true);
    expect(await media.evaluate((host: MediaHost) => (host.audio ?? host).volume)).toBeCloseTo(0.4);
    expect(ranges).toContain('bytes=0-0');
    expect(ranges.some((range) => range !== 'bytes=0-0')).toBe(true);
    const after = { a: await bytes('a'), b: await bytes('b') };
    expect(after.a - before.a).toBe(sourceBytes.length);
    expect(after.b - before.b).toBe(sourceBytes.length);
    await info.attach('cold-process-range-trace', {
      body: JSON.stringify({ freshSource: metadata, sha256: receipt.sha256, before, after, trace }),
      contentType: 'application/json',
    });
    await media.evaluate(play);
    await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(1.6);
    const retired = await expectRetired(media);
    await openDeviceSection(page, 'Журнал');
    await retired();
  } finally {
    backend.route('a', 'a', 'a');
    await backend.dispose();
  }
});

for (const id of [
  'video-mp4',
  'video-webm',
  'audio-wav',
  'audio-mp3',
  'mime-only-video',
  'mime-only-audio',
]) {
  test(`@regression native playback and seek of actual ${id}`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    const ranges: string[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith('/preview/media')) ranges.push(request.headers().range ?? '');
    });
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      const media = pane.locator('video, custom-audio-player').first();
      await expect(media).toBeAttached();
      await expect
        .poll(() => media.evaluate(readyState), {
          timeout: 80_000,
        })
        .toBeGreaterThanOrEqual(2);
      await media.evaluate(async (host: MediaHost) => {
        const media = host.audio ?? host;
        media.volume = 0.4;
        await media.play();
      });
      await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(0.1);
      await media.evaluate(seek);
      await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThanOrEqual(1.4);
      expect(await media.evaluate((host: MediaHost) => (host.audio ?? host).volume)).toBeCloseTo(
        0.4,
      );
      expect(ranges).toContain('bytes=0-0');
      await expect(
        pane.locator('custom-audio-player[wave-src], custom-audio-player[spectrum-src]'),
      ).toHaveCount(0);
    } finally {
      await backend.dispose();
    }
  });
}

for (const fixture of DEVICE_FILE_PREVIEW_FIXTURES.filter(
  (fixture) =>
    fixture.scenario === 'format' &&
    fixture.availability === 'present' &&
    (fixture.category === 'audio' || fixture.category === 'video'),
)) {
  test(`@regression actual ${fixture.id} plays or explains codec failure`, async ({
    page,
  }, info) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane, entry } = await openDeviceFilePreview(page, backend, fixture.id);
      await expect
        .poll(
          async () => {
            const media = pane.locator('video, custom-audio-player').first();
            if (await media.count()) {
              const ready = await media.evaluate(readyState);
              if (ready >= 2) return 'playable';
            }
            return (await pane.getByRole('alert').count()) ? 'explained' : 'loading';
          },
          { timeout: 80_000 },
        )
        .not.toBe('loading');
      const media = pane.locator('video, custom-audio-player').first();
      const playable = (await media.count()) && (await media.evaluate(readyState)) >= 2;
      const reference = await readMediaReferenceEvidence(
        backend.root,
        backend.fixtures.run,
        backend.origin,
      );
      const matching = reference.filter((outcome) => outcome.fixture === fixture.id);
      expect(matching.map((outcome) => outcome.host).sort()).toEqual(['analysis', 'duty']);
      for (const outcome of matching) {
        expect(outcome.sha256).toBe(entry.sha256);
        expect(outcome.playable).toBe(Boolean(playable));
      }
      let frameSha256: string | undefined;
      if (playable) {
        expect(await media.evaluate((host) => host.tagName)).toBe(
          matching[0].videoWidth === undefined ? 'CUSTOM-AUDIO-PLAYER' : 'VIDEO',
        );
        await media.evaluate((host: MediaHost) => {
          (host.audio ?? host).volume = 0.4;
        });
        await media.evaluate(play);
        await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThan(0.1);
        await media.evaluate(seek);
        await expect.poll(() => media.evaluate(currentTime)).toBeGreaterThanOrEqual(1.4);
        await expect
          .poll(() => media.evaluate((host: MediaHost) => !(host.audio ?? host).seeking))
          .toBe(true);
        expect(await media.evaluate((host: MediaHost) => (host.audio ?? host).paused)).toBe(true);
        expect(await media.evaluate((host: MediaHost) => (host.audio ?? host).volume)).toBeCloseTo(
          0.4,
        );
        const duration = await media.evaluate((host: MediaHost) => (host.audio ?? host).duration);
        for (const outcome of matching) expect(duration).toBeCloseTo(outcome.duration!, 3);
        if (matching[0].videoWidth !== undefined) {
          const dimensions = await media.evaluate((video: HTMLVideoElement) => ({
            width: video.videoWidth,
            height: video.videoHeight,
          }));
          for (const outcome of matching) {
            expect(dimensions.width).toBe(outcome.videoWidth);
            expect(dimensions.height).toBe(outcome.videoHeight);
          }
          if (dimensions.width > 0) {
            const frame = await media.evaluate((video: HTMLVideoElement) => {
              const canvas = document.createElement('canvas');
              canvas.width = video.videoWidth;
              canvas.height = video.videoHeight;
              const context = canvas.getContext('2d')!;
              context.drawImage(video, 0, 0);
              return Array.from(context.getImageData(0, 0, canvas.width, canvas.height).data);
            });
            frameSha256 = createHash('sha256').update(Buffer.from(frame)).digest('hex');
            for (const outcome of matching) expect(frameSha256).toBe(outcome.frameSha256);
          }
        }
      } else {
        await expect(pane.getByRole('alert').first()).toContainText(/кодек|формат|відтвор/i);
      }
      await info.attach('codec-outcome', {
        body: JSON.stringify({
          fixture: fixture.id,
          codec: fixture.codec,
          playable: Boolean(playable),
          reference: matching,
          frameSha256,
        }),
        contentType: 'application/json',
      });
      const saved = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      const download = await saved;
      expect(
        createHash('sha256')
          .update(await readFile((await download.path())!))
          .digest('hex'),
      ).toBe(entry.sha256);
    } finally {
      await backend.dispose();
    }
  });
}
