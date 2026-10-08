import './device-audio-processing';
import './device-audio-text';
import { expect, test, type Page } from '@playwright/test';
import type { CustomAudioPlayer } from '@echoua/echo-audio-player';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  audioDetail,
  listAudio,
  localAudioBackend,
  post,
  receiveAudio,
  uploadAudio,
  wavBytes,
} from './device-audio-backend';
import type {
  DeviceAudio,
  FileSyncSessionRsp,
  ListDeviceFileRootsRsp,
  ListDeviceSyncSessionsRsp,
  JournalDeviceFilesRsp,
} from '../../src/Bindings';
import {
  audible,
  interruptedMediaProxy,
  nativeState,
  playing,
  ready,
  remember,
  selectAudio,
  toggleAudioFilter,
  expectAudioFilter,
  toneWav,
} from './device-audio-player';

test.use({ actionTimeout: 10_000 });

test('@regression device audio accepts real TUS independently of FileSync and renders local chronology', async ({
  browser,
}, testInfo) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  try {
    const device = await backend.createDevice();
    const empty = await backend.createDevice();
    const roots = () =>
      post<ListDeviceFileRootsRsp>(backend.reader, '/api/device/files/roots', {
        deviceId: device.id,
      });
    const sessions = () =>
      post<ListDeviceSyncSessionsRsp>(backend.reader, '/api/device/files/sessions/list', {
        deviceId: device.id,
        limit: 50,
        cursor: null,
      });
    expect((await roots()).roots).toEqual([]);
    expect((await sessions()).sessions).toEqual([]);
    const rows: DeviceAudio[] = [];
    for (let index = 0; index < 10; index++) {
      const start =
        index === 0
          ? '2026-10-03T23:59:30+03:00'
          : `2026-10-03T${String(10 + (index % 3)).padStart(2, '0')}:00:00+03:00`;
      rows.push(
        await receiveAudio(
          backend.source,
          device.id,
          `material-${index}`,
          start,
          wavBytes(index === 0 ? 90 : 1),
          index === 0,
        ),
      );
    }
    expect(rows[0].recordingEndedAt).toBe('2026-10-03T21:01:00.000000Z');
    const initial = await audioDetail(backend.reader, device.id, rows[0].id);
    expect(initial.transcription.text).toBe('');
    expect(initial.audio.processed).toBe(false);
    expect((await roots()).roots).toEqual([]);
    expect((await sessions()).sessions).toEqual([]);
    const req = {
      deviceId: device.id,
      unprocessedOnly: false,
      limit: 3,
      cursor: null as string | null,
    };
    const visited: DeviceAudio[] = [];
    do {
      const page = await listAudio(backend.reader, req);
      visited.push(...page.audio);
      req.cursor = page.nextCursor;
    } while (req.cursor);
    expect(new Set(visited.map((row) => row.id)).size).toBe(10);
    const expected = [...rows].sort(
      (a, b) =>
        b.recordingStartedAt.localeCompare(a.recordingStartedAt) || b.id.localeCompare(a.id),
    );
    expect(visited.map((row) => row.id)).toEqual(expected.map((row) => row.id));
    for (const timezoneId of ['Europe/Kyiv', 'America/New_York']) {
      const context = await browser.newContext({
        timezoneId,
        storageState: await backend.reader.storageState(),
        viewport: { width: 1280, height: 900 },
      });
      try {
        const page = await context.newPage();
        await page.goto(`/devices/${device.id}?sync_id=${randomUUID()}`);
        await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
        const panel = page.getByRole('tabpanel', { name: 'Аудіо', exact: true });
        const sidebar = page.getByTestId('device-audio-sidebar');
        await expect(sidebar).toBeVisible();
        const filters = sidebar.getByRole('button', { name: 'Фільтри аудіо', exact: true });
        await expect(filters).toBeVisible();
        await expect(page.getByRole('menu')).toHaveCount(0);
        await filters.click();
        await expect(
          page.getByRole('menuitemcheckbox', { name: 'Тільки необроблені' }),
        ).toHaveAttribute('aria-checked', 'false');
        await page.keyboard.press('Escape');
        await expect(filters).toBeFocused();
        await expect(panel.locator('[data-audio-id]')).toHaveCount(0);
        await expect(sidebar.locator('[data-audio-id]')).toHaveCount(10);
        expect(
          await sidebar
            .locator('[data-audio-id]')
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-audio-id'))),
        ).toEqual(expected.map((row) => row.id));
        for (const row of [rows[0], rows[1]]) {
          const expectedDates = await page.evaluate(
            (row) =>
              [row.recordingStartedAt, row.recordingEndedAt].map((value) =>
                new Date(value)
                  .toLocaleString('uk-UA', {
                    day: '2-digit',
                    month: '2-digit',
                    year: '2-digit',
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                    hourCycle: 'h23',
                  })
                  .replace(',', ''),
              ),
            row,
          );
          const entry = sidebar.locator(`[data-audio-id="${row.id}"]`);
          await expect(entry).toHaveText(expectedDates.join(' - '));
          await expect(entry.getByRole('img', { name: 'Необроблене', exact: true })).toBeVisible();
          expect(
            await entry.locator('time').evaluateAll((times) => {
              const [start, end] = times.map((time) => time.getBoundingClientRect());
              return (
                end.bottom - start.top <= parseFloat(getComputedStyle(times[0]).lineHeight) * 2 + 1
              );
            }),
          ).toBe(true);
        }
        await expect(sidebar).not.toContainText('material-');
        const selected = sidebar.locator('[data-audio-id]').first();
        await selected.click();
        await page.getByRole('button', { name: 'Згорнути праву панель' }).click();
        await expect(selected).toHaveAttribute('aria-pressed', 'true');
        await page.setViewportSize({ width: 390, height: 844 });
        await expect(panel).toBeVisible();
        await expect(sidebar).toBeHidden();
        await page.getByRole('button', { name: 'До аудіо', exact: true }).click();
        await expect(sidebar).toBeVisible();
        await expect(sidebar.locator('[data-audio-id]')).toHaveCount(10);
        for (const width of [390, 320]) {
          await page.setViewportSize({ width, height: 844 });
          expect(
            await sidebar.locator('[data-audio-id]').evaluateAll((entries) =>
              entries.every((entry) => {
                const bounds = entry.getBoundingClientRect();
                const times = [...entry.querySelectorAll('time')];
                return (
                  times.every((time) => time.getBoundingClientRect().right <= bounds.right) &&
                  times[1].getBoundingClientRect().bottom - times[0].getBoundingClientRect().top <=
                    parseFloat(getComputedStyle(times[0]).lineHeight) * 2 + 1
                );
              }),
            ),
          ).toBe(true);
        }
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
          true,
        );
        await page.screenshot({
          path: testInfo.outputPath(`audio-${timezoneId.replace('/', '-')}.png`),
        });
        await page.goto(`/devices/${empty.id}`);
        await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
        await expect(page.getByTestId('device-audio-sidebar')).toContainText(
          'Аудіоматеріалів немає.',
        );
      } finally {
        await context.close().catch(() => {});
      }
    }
    const withFiles = await backend.createDevice();
    const sync = await post<FileSyncSessionRsp>(backend.source, '/api/device/files/sync', {
      deviceId: withFiles.id,
      files: [
        {
          absolutePath: '/audio-fixture/existing.txt',
          mimeType: 'text/plain',
          extension: 'txt',
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
          sourceFileState: null,
        },
      ],
    });
    const beforeJournal = await post<JournalDeviceFilesRsp>(
      backend.reader,
      '/api/device/files/journal',
      { deviceId: withFiles.id, limit: 50 },
    );
    const beforeRoots = await post<ListDeviceFileRootsRsp>(
      backend.reader,
      '/api/device/files/roots',
      { deviceId: withFiles.id },
    );
    const dst = await receiveAudio(
      backend.source,
      withFiles.id,
      'independent.wav',
      '2026-10-25T03:59:30+03:00',
      wavBytes(90),
    );
    expect(dst.recordingStartedAt).toBe('2026-10-25T00:59:30.000000Z');
    expect(dst.recordingEndedAt).toBe('2026-10-25T01:01:00.000000Z');
    expect(
      (
        await post<ListDeviceFileRootsRsp>(backend.reader, '/api/device/files/roots', {
          deviceId: withFiles.id,
        })
      ).roots,
    ).toEqual(beforeRoots.roots);
    expect(
      await post<JournalDeviceFilesRsp>(backend.reader, '/api/device/files/journal', {
        deviceId: withFiles.id,
        limit: 50,
      }),
    ).toEqual(beforeJournal);
    const context = await browser.newContext({
      timezoneId: 'Europe/Kyiv',
      storageState: await backend.reader.storageState(),
    });
    try {
      const page = await context.newPage();
      await page.goto(`/devices/${withFiles.id}?sync_id=${sync.sync.syncId}`);
      await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      const selected = page.locator('[data-audio-id]');
      await expect(selected).toContainText('25.10.26 03:59:30');
      await expect(selected).toContainText('25.10.26 03:01:00');
      await selected.click();
      await page.getByRole('button', { name: /Усі сесії/ }).click();
      await expect(selected).toHaveAttribute('aria-pressed', 'true');
      await expect(page).toHaveURL(`/devices/${withFiles.id}`);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await backend.dispose();
  }
});

test('@regression device audio validates real media, exact names, scope and the full 100 MiB boundary', async () => {
  test.setTimeout(180_000);
  const backend = await localAudioBackend();
  try {
    const device = await backend.createDevice();
    const second = await backend.createDevice();
    const accepted = await receiveAudio(
      backend.source,
      device.id,
      'record.wav',
      '2026-03-29T02:59:30+02:00',
    );
    await receiveAudio(backend.source, device.id, 'Record.wav', '2026-03-29T03:59:30+03:00');
    await receiveAudio(backend.source, second.id, 'record.wav', '2026-03-29T02:59:30+02:00');
    const duplicate = await uploadAudio(backend.source, device.id, wavBytes(1));
    expect(
      (
        await backend.source.post('/api/device/audio/receive', {
          data: {
            device_id: device.id,
            name: 'record.wav',
            upload_url: duplicate,
            recording_started_at: '2026-03-29T02:59:30+02:00',
          },
        })
      ).status(),
    ).toBe(409);
    expect((await audioDetail(backend.reader, device.id, accepted.id)).audio).toEqual(accepted);
    const [one, two] = await Promise.all([
      uploadAudio(backend.source, device.id, wavBytes(1)),
      uploadAudio(backend.source, device.id, wavBytes(1)),
    ]);
    const statuses = await Promise.all(
      [one, two].map((upload_url) =>
        backend.source
          .post('/api/device/audio/receive', {
            data: {
              device_id: device.id,
              name: 'race.wav',
              upload_url,
              recording_started_at: '2026-10-03T10:00:00Z',
            },
          })
          .then((response) => response.status()),
      ),
    );
    expect(statuses.sort()).toEqual([201, 409]);
    const mp3 = execFileSync('ffmpeg', [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=440:duration=1',
      '-codec:a',
      'libmp3lame',
      '-f',
      'mp3',
      'pipe:1',
    ]);
    await receiveAudio(backend.source, device.id, 'real.mp3', '2026-10-03T10:00:00Z', mp3);
    const corrupt = await uploadAudio(backend.source, device.id, Buffer.from('not audio'));
    expect(
      (
        await backend.source.post('/api/device/audio/receive', {
          data: {
            device_id: device.id,
            name: 'corrupt.wav',
            upload_url: corrupt,
            recording_started_at: '2026-10-03T10:00:00Z',
          },
        })
      ).status(),
    ).toBe(422);
    const cap = 100 * 1024 * 1024;
    const oversized = await backend.source.post(`/api/device/audio/${device.id}/uploads`, {
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Length': String(cap + 1) },
    });
    expect(oversized.status()).toBe(413);
    const full = await receiveAudio(
      backend.source,
      device.id,
      'limit.wav',
      '2026-10-03T10:00:00Z',
      wavBytes(0, cap),
      true,
    );
    expect(full.durationSeconds).toBe((cap - 44) / 16000);
    const sourceRead = await backend.source.post('/api/device/audio/list', {
      data: { device_id: device.id },
    });
    expect(sourceRead.status()).toBe(403);
    const foreignReader = await backend.login('foreign-cyber');
    expect(
      (
        await foreignReader.post('/api/device/audio/detail', {
          data: { device_id: device.id, audio_id: accepted.id },
        })
      ).status(),
    ).toBe(404);
    const list = await listAudio(backend.reader, {
      deviceId: device.id,
      unprocessedOnly: false,
      limit: 200,
      cursor: null,
    });
    expect(list.audio).toHaveLength(5);
  } finally {
    await backend.dispose();
  }
});

test('@regression device audio retries real list failures and traverses all 51 records', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  try {
    const device = await backend.createDevice();
    for (let index = 0; index < 51; index++)
      await receiveAudio(backend.source, device.id, `page-${index}`, '2026-10-03T10:00:00Z');
    const context = await browser.newContext({ storageState: await backend.reader.storageState() });
    try {
      const page = await context.newPage();
      let failFirst = true;
      let failMore = true;
      await page.route('**/api/device/audio/list', async (route) => {
        const body = route.request().postDataJSON();
        if (!body.cursor && failFirst) {
          return route.abort('connectionfailed');
        }
        if (body.cursor && failMore) {
          return route.abort('connectionfailed');
        }
        return route.continue();
      });
      await page.goto(`/devices/${device.id}`);
      await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      const panel = page.getByTestId('device-audio-sidebar');
      await expect(panel.getByRole('alert')).toContainText('Помилка завантаження аудіо');
      await expect(panel).not.toContainText('Аудіоматеріалів немає.');
      await page.getByRole('button', { name: 'Закрити сповіщення' }).click();
      failFirst = false;
      await panel.getByRole('button', { name: 'Спробувати ще раз' }).click();
      await expect(panel.locator('[data-audio-id]')).toHaveCount(50);
      const selected = panel.locator('[data-audio-id]').first();
      await selected.click();
      await panel.getByRole('button', { name: 'Завантажити ще' }).click();
      await expect(panel.getByRole('alert')).toContainText('Помилка завантаження аудіо');
      await expect(selected).toHaveAttribute('aria-pressed', 'true');
      await page.getByRole('button', { name: 'Закрити сповіщення' }).click();
      failMore = false;
      await panel.getByRole('button', { name: 'Повторити завантаження решти' }).click();
      await expect(panel.locator('[data-audio-id]')).toHaveCount(51);
      const ids = await panel
        .locator('[data-audio-id]')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-audio-id')));
      expect(new Set(ids).size).toBe(51);
      await toggleAudioFilter(page);
      await expectAudioFilter(page, true);
      await expect(panel.locator('[data-audio-id]')).toHaveCount(50);
      await panel.getByRole('button', { name: 'Завантажити ще' }).click();
      await expect(panel.locator('[data-audio-id]')).toHaveCount(51);
    } finally {
      await context.close().catch(() => {});
    }
  } finally {
    await backend.dispose();
  }
});

test.describe('@regression native device audio playback', () => {
  let backend: Awaited<ReturnType<typeof localAudioBackend>>;
  let device: Awaited<ReturnType<typeof backend.createDevice>>;
  let otherDevice: typeof device;
  let wav: DeviceAudio;
  let mp3: DeviceAudio;
  let long: DeviceAudio;
  const contentUrl = (id: string) => `/api/device/audio/${device.id}/${id}/content`;

  test.beforeAll(async () => {
    test.setTimeout(120_000);
    backend = await localAudioBackend();
    device = await backend.createDevice();
    otherDevice = await backend.createDevice();
    wav = await receiveAudio(
      backend.source,
      device.id,
      'native-tone.wav',
      '2026-10-04T15:00:00+03:00',
      toneWav(12),
    );
    const mp3Bytes = (seconds: number) =>
      execFileSync(
        'ffmpeg',
        [
          '-v',
          'error',
          '-f',
          'lavfi',
          '-i',
          'sine=frequency=660:sample_rate=48000',
          '-t',
          String(seconds),
          '-codec:a',
          'libmp3lame',
          ...(seconds >= 120 ? ['-b:a', '128k'] : ['-q:a', '2']),
          '-f',
          'mp3',
          'pipe:1',
        ],
        { maxBuffer: 4 * 1024 * 1024 },
      );
    mp3 = await receiveAudio(
      backend.source,
      device.id,
      'native-tone.mp3',
      '2026-10-04T14:00:00+03:00',
      mp3Bytes(3),
    );
    long = await receiveAudio(
      backend.source,
      device.id,
      'native-long.mp3',
      '2026-10-04T13:00:00+03:00',
      mp3Bytes(120),
    );
    for (let index = 0; index < 8; index++)
      await receiveAudio(
        backend.source,
        device.id,
        `scroll-${index}.wav`,
        `2026-10-04T12:${String(index).padStart(2, '0')}:00+03:00`,
      );
  });
  test.afterAll(async () => {
    await backend?.dispose();
  });

  async function open(page: Page, origin = '') {
    await page.context().addCookies((await backend.reader.storageState()).cookies);
    await page.goto(`${origin}/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await expect(page.locator('[data-audio-id]')).toHaveCount(11);
  }

  test('WAV sounds at beginning and end; pause, switch, reopen, settings and scroll preserve native semantics', async ({
    page,
  }, testInfo) => {
    test.setTimeout(60_000);
    await open(page);
    let player = await selectAudio(page, wav.id);
    await ready(player);
    expect((await nativeState(player)).paused).toBe(true);
    expect((await nativeState(player)).autoplay).toBe(false);
    expect((await nativeState(player)).time).toBe(0);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await audible(player);
    await expect.poll(async () => (await nativeState(player)).time).toBeGreaterThan(0.6);
    await player.locator('#playPauseBtn').click();
    const paused = await nativeState(player);
    await expect.poll(async () => (await nativeState(player)).paused).toBe(true);
    await page.waitForTimeout(250);
    expect((await nativeState(player)).time).toBeCloseTo(paused.time, 1);
    await player.locator('#playPauseBtn').click();
    await expect
      .poll(async () => (await nativeState(player)).time)
      .toBeGreaterThan(paused.time + 0.2);
    await player.evaluate((element: CustomAudioPlayer) => {
      element.setVolume(0.7);
      element.setPlaybackRate(1.25);
      element.setEQBand(1000, 3);
      element.setFilter('highpass', true, 150, 0.7);
    });
    const beforeTheme = await remember(player);
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await expect(player).toHaveAttribute('theme', 'dark');
    expect(await beforeTheme.evaluate((element: CustomAudioPlayer) => element.isConnected)).toBe(
      true,
    );
    await page.locator('[data-audio-id]').last().scrollIntoViewIfNeeded();
    await page.setViewportSize({ width: 390, height: 844 });
    expect(await beforeTheme.evaluate((element: CustomAudioPlayer) => !element.audio.paused)).toBe(
      true,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await player.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath('device-player-mobile.png') });
    const previous = await remember(player);
    player = await selectAudio(page, mp3.id);
    await ready(player);
    expect(
      await previous.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    expect((await nativeState(player)).time).toBe(0);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await audible(player);
    player = await selectAudio(page, wav.id);
    await ready(player);
    expect((await nativeState(player)).time).toBe(0);
    expect((await nativeState(player)).paused).toBe(true);
    expect(
      await player.evaluate((element: CustomAudioPlayer) => [
        element.volume,
        element.playbackRate,
        element.eqBands['1000'],
        element.audioFilters.highpass.frequency,
      ]),
    ).toEqual([0.7, 1.25, 3, 150]);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await player.evaluate((element: CustomAudioPlayer) =>
      element.setCurrentTime(element.duration - 1.2),
    );
    await audible(player);
    await expect.poll(async () => (await nativeState(player)).paused).toBe(true);
    await expect(page.locator(`[data-audio-id="${wav.id}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const range = await backend.reader.get(contentUrl(wav.id), {
      headers: { Range: 'bytes=-128' },
    });
    expect(range.status()).toBe(206);
    expect((await range.body()).length).toBe(128);
    expect(range.headers()['content-type']).toBe('audio/mpeg');
    expect((await audioDetail(backend.reader, device.id, wav.id)).audio).toEqual(wav);
  });

  test('saved autoplay, loop and A–B repeat apply only to selected audio; real tab, device and page exits stop it', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page);
    let player = await selectAudio(page, wav.id);
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.setAutoplay(true));
    await ready(await selectAudio(page, mp3.id));
    player = await selectAudio(page, wav.id);
    await playing(player);
    await player.locator('#layoutToggleBtn').click();
    await player.locator('#loopToggle').click();
    await player.evaluate((element: CustomAudioPlayer) =>
      element.setCurrentTime(element.duration - 0.5),
    );
    await expect.poll(async () => (await nativeState(player)).time).toBeLessThan(2);
    expect((await nativeState(player)).paused).toBe(false);
    await player.locator('#loopToggle').click();
    await player.evaluate((element: CustomAudioPlayer) => {
      element.setCurrentTime(1);
      element.setABRepeatStart();
      element.setCurrentTime(2);
      element.setABRepeatEnd();
      element.setCurrentTime(1.9);
    });
    await expect.poll(async () => (await nativeState(player)).time).toBeLessThan(1.8);
    expect((await nativeState(player)).paused).toBe(false);
    await player.evaluate((element: CustomAudioPlayer) => element.clearABRepeat());
    const old = await remember(player);
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await expect(page.locator('[data-device-audio-player]')).toHaveCount(0);
    expect(
      await old.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    await old.evaluate((element: CustomAudioPlayer) => {
      element.retryCurrentSource();
      element.setSrc('/old');
      element.audio.dispatchEvent(new Event('canplay'));
      void element.play();
    });
    expect(
      await old.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    player = page.locator('[data-device-audio-player] custom-audio-player');
    await playing(player);
    const deviceOld = await remember(player);
    await page.evaluate((id) => {
      history.pushState({}, '', `/devices/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, otherDevice.id);
    await expect(page).toHaveURL(`/devices/${otherDevice.id}`);
    await expect(page.locator('[data-device-audio-player]')).toHaveCount(0);
    expect(
      await deviceOld.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    await page.evaluate((id) => {
      history.pushState({}, '', `/devices/${id}`);
      window.dispatchEvent(new PopStateEvent('popstate'));
    }, device.id);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    player = await selectAudio(page, wav.id);
    await playing(player);
    const pageOld = await remember(player);
    await page.getByRole('button', { name: 'До списку пристроїв', exact: true }).click();
    await expect(page).toHaveURL('/devices');
    await expect(page.locator('device-details-page')).toHaveCount(0);
    expect(
      await pageOld.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
  });

  test('slow real GET, failed GET with successful HEAD, zero-position retry and missing images expose native states', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(`**${contentUrl(long.id)}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      requested();
      await pending;
      await route.continue().catch(() => {});
    });
    let player = await selectAudio(page, long.id);
    await started;
    await expect(page.locator('[data-device-audio-player] [role="status"]')).toContainText(
      'Очікування',
    );
    expect((await nativeState(player)).paused).toBe(true);
    release();
    await ready(player);
    await page.unroute(`**${contentUrl(long.id)}`);
    await page.route(`**${contentUrl(wav.id)}`, (route) =>
      route.request().method() === 'GET' ? route.abort('failed') : route.continue(),
    );
    player = await selectAudio(page, wav.id);
    await expect(player.locator('#errorRetryBtn')).toBeVisible();
    await expect(page.locator('[data-device-audio-player] [role="alert"]')).toContainText(
      'Помилка відтворення',
    );
    expect((await backend.reader.head(contentUrl(wav.id))).status()).toBe(200);
    expect((await nativeState(player)).error).not.toBeNull();
    await page.unroute(`**${contentUrl(wav.id)}`);
    await player.locator('#errorRetryBtn').click();
    await ready(player);
    expect((await nativeState(player)).time).toBe(0);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await audible(player);
    await page.route('**/api/device/audio/*/*/wave', (route) => route.abort('failed'));
    await page.route('**/api/device/audio/*/*/spectrogram', (route) => route.abort('failed'));
    player = await selectAudio(page, mp3.id);
    await ready(player);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await audible(player);
    expect((await audioDetail(backend.reader, device.id, wav.id)).transcription.text).toBe('');
    expect((await audioDetail(backend.reader, device.id, wav.id)).audio.processed).toBe(false);
  });

  test('late loading and native callbacks cannot restart old audio after switch or exit', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    await open(page);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let requested!: () => void;
    const started = new Promise<void>((resolve) => {
      requested = resolve;
    });
    await page.route(`**${contentUrl(wav.id)}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      requested();
      await pending;
      await route.continue().catch(() => {});
    });
    let player = await selectAudio(page, wav.id);
    await started;
    const old = await remember(player);
    const oldNative = await player.evaluateHandle((element: CustomAudioPlayer) => element.audio);
    await player.evaluate((element: CustomAudioPlayer) => element.setAutoplay(true));
    const oldPlay = await player.evaluateHandle((element: CustomAudioPlayer) => ({
      result: element.play().then(
        () => 'resolved',
        () => 'rejected',
      ),
    }));
    player = await selectAudio(page, mp3.id);
    await ready(player);
    release();
    await old.evaluate((element: CustomAudioPlayer) => {
      element.retryCurrentSource();
      void element.play();
    });
    await oldNative.evaluate((audio: HTMLAudioElement) => {
      audio.dispatchEvent(new Event('canplay'));
      audio.dispatchEvent(new Event('error'));
    });
    expect(
      await old.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    expect((await nativeState(player)).source).toBe(contentUrl(mp3.id));
    await expect(page.locator('[data-device-audio-player] [role="alert"]')).toHaveCount(0);
    await page.unroute(`**${contentUrl(wav.id)}`);
    let releaseExit!: () => void;
    const exitPending = new Promise<void>((resolve) => {
      releaseExit = resolve;
    });
    let exitRequested!: () => void;
    const exitStarted = new Promise<void>((resolve) => {
      exitRequested = resolve;
    });
    await page.route(`**${contentUrl(wav.id)}`, async (route) => {
      if (route.request().method() !== 'GET') return route.continue();
      exitRequested();
      await exitPending;
      await route.continue().catch(() => {});
    });
    player = await selectAudio(page, wav.id);
    await exitStarted;
    const exitOld = await remember(player);
    const exitNative = await player.evaluateHandle((element: CustomAudioPlayer) => element.audio);
    const exitPlay = await player.evaluateHandle((element: CustomAudioPlayer) => ({
      result: element.play().then(
        () => 'resolved',
        () => 'rejected',
      ),
    }));
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    releaseExit();
    await exitOld.evaluate((element: CustomAudioPlayer) => {
      element.retryCurrentSource();
      void element.play();
    });
    await exitNative.evaluate((audio: HTMLAudioElement) => {
      audio.dispatchEvent(new Event('canplay'));
      audio.dispatchEvent(new Event('error'));
    });
    await oldPlay.evaluate(async (state) => await state.result);
    await exitPlay.evaluate(async (state) => await state.result);
    expect(
      await oldNative.evaluate(
        (audio: HTMLAudioElement) => audio.paused && !audio.getAttribute('src'),
      ),
    ).toBe(true);
    expect(
      await exitNative.evaluate(
        (audio: HTMLAudioElement) => audio.paused && !audio.getAttribute('src'),
      ),
    ).toBe(true);
    expect(
      await exitOld.evaluate(
        (element: CustomAudioPlayer) => element.audio.paused && !element.audio.getAttribute('src'),
      ),
    ).toBe(true);
    expect(
      await exitOld.evaluate(
        (element: CustomAudioPlayer) =>
          JSON.parse(localStorage.getItem(element.settingsStorageKey)!).autoplay,
      ),
    ).toBe(true);
  });

  test('direct access is authorized and expired browser identity stops the native instance and logs out', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    expect((await backend.source.get(contentUrl(wav.id))).status()).toBe(403);
    const foreign = await backend.login('foreign-cyber');
    expect((await foreign.get(contentUrl(wav.id))).status()).toBe(404);
    await open(page);
    await page.route(`**${contentUrl(wav.id)}`, (route) => route.continue());
    const player = await selectAudio(page, wav.id);
    await ready(player);
    await player.locator('#playPauseBtn').click();
    await playing(player);
    await player.evaluate((element: CustomAudioPlayer) => {
      window.addEventListener(
        'pagehide',
        () =>
          sessionStorage.setItem(
            'audio-before-logout',
            JSON.stringify({
              paused: element.audio.paused,
              source: element.audio.getAttribute('src'),
            }),
          ),
        { once: true },
      );
    });
    await page.context().clearCookies();
    await player.evaluate((element: CustomAudioPlayer) => element.retryCurrentSource());
    await expect(page).toHaveURL(/\/login/);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('audio-before-logout')!)),
    ).toEqual({ paused: true, source: null });
    expect((await page.request.get(contentUrl(wav.id))).status()).toBe(401);
  });

  test('real 403 and 404 after identity replacement stop and detach the native player', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    for (const actor of [backend.source, await backend.login('foreign-cyber')]) {
      await open(page);
      await page.route(`**${contentUrl(wav.id)}`, (route) => route.continue());
      const player = await selectAudio(page, wav.id);
      await ready(player);
      const old = await remember(player);
      await page.context().addCookies((await actor.storageState()).cookies);
      await player.evaluate((element: CustomAudioPlayer) => element.retryCurrentSource());
      await expect(page.locator('[data-device-audio-player] [role="alert"]')).toHaveText(
        'Аудіо недоступне.',
      );
      await expect(page.locator('[data-device-audio-player] custom-audio-player')).toHaveCount(0);
      expect(
        await old.evaluate(
          (element: CustomAudioPlayer) =>
            element.audio.paused && !element.audio.getAttribute('src'),
        ),
      ).toBe(true);
    }
  });

  test('a real transport interruption during MP3 playback raises native MediaError and retries from zero', async ({
    page,
  }) => {
    test.setTimeout(60_000);
    const original = await backend.reader.get(contentUrl(long.id));
    expect(original.status()).toBe(200);
    const bytes = await original.body();
    const proxy = await interruptedMediaProxy(backend.origin, contentUrl(long.id), 128 * 1024);
    try {
      await open(page, proxy.origin);
      const player = await selectAudio(page, long.id);
      await ready(player);
      await player.locator('#playPauseBtn').click();
      await playing(player);
      await audible(player);
      await expect(page.locator('[data-device-audio-player] [role="status"]')).toContainText(
        'Очікування',
        { timeout: 15_000 },
      );
      proxy.interrupt();
      await expect.poll(async () => (await nativeState(player)).error, { timeout: 15_000 }).toBe(2);
      await expect(page.locator('[data-device-audio-player] [role="alert"]')).toContainText(
        'Помилка відтворення',
      );
      proxy.recover();
      await player.locator('#errorRetryBtn').click();
      await ready(player);
      expect((await nativeState(player)).time).toBe(0);
      await player.locator('#playPauseBtn').click();
      await playing(player);
      const detail = await audioDetail(backend.reader, device.id, long.id);
      expect(detail.audio).toEqual(long);
      expect(detail.transcription.text).toBe('');
    } finally {
      await proxy.close();
    }
  });
});
