import { expect, test, type Page } from '@playwright/test';
import type { CustomAudioPlayer } from '@echoua/echo-audio-player';
import type { DeviceAudio, SetDeviceAudioProcessingRsp, User } from '../../src/Bindings';
import {
  audioDetail,
  audioFixtureSql,
  listAudio,
  localAudioBackend,
  post,
  receiveAudio,
} from './device-audio-backend';
import {
  audible,
  nativeState,
  playing,
  ready,
  remember,
  selectAudio,
  toggleAudioFilter,
  expectAudioFilter,
  toneWav,
} from './device-audio-player';

const statusPath = '/api/device/audio/processing/set';
const savePath = '/api/device/audio/transcription/save';
const field = (page: Page) =>
  page.getByRole('textbox', { name: 'Ручна транскрипція', exact: true });
const leave = (page: Page) => page.getByRole('dialog', { name: 'Незбережена транскрипція' });
const panel = (page: Page) => page.locator('[data-device-audio-processing]');
const clicks = new WeakMap<Page, Map<string, number>>();
async function click(page: Page, name: string) {
  const times = clicks.get(page) ?? new Map<string, number>();
  clicks.set(page, times);
  const remaining = 400 - (Date.now() - (times.get(name) ?? 0));
  if (remaining > 0) await page.waitForTimeout(remaining);
  await page.getByRole('button', { name, exact: true }).click();
  times.set(name, Date.now());
}
async function mark(page: Page, target: boolean) {
  const response = page.waitForResponse((response) => response.url().endsWith(statusPath));
  await click(page, target ? 'Позначити обробленим' : 'Позначити необробленим');
  expect((await response).status()).toBe(200);
  await expect(panel(page)).toContainText(target ? 'Статус: Оброблене' : 'Статус: Необроблене');
}
async function save(page: Page, text: string) {
  await field(page).fill(text);
  const response = page.waitForResponse((response) => response.url().endsWith(savePath));
  await click(page, 'Зберегти транскрипцію');
  expect((await response).status()).toBe(200);
  await expect(page.locator('[data-device-audio-editor]')).toContainText('Актуальний текст');
}
async function allVisible(page: Page) {
  await expect(page.getByRole('progressbar', { name: 'Завантаження аудіо' })).toHaveCount(0);
  while (await page.getByRole('button', { name: 'Завантажити ще', exact: true }).count()) {
    const previous = await page
      .locator('[data-audio-id]')
      .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-audio-id')));
    const response = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/list'),
    );
    await click(page, 'Завантажити ще');
    const received = await response;
    expect(received.status()).toBe(200);
    const current = await received.json();
    await received.finished();
    await expect
      .poll(() =>
        page
          .locator('[data-audio-id]')
          .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-audio-id'))),
      )
      .toEqual([
        ...new Set([...previous, ...current.audio.map((audio: { id: string }) => audio.id)]),
      ]);
    await expect(page.getByRole('button', { name: 'Завантаження…', exact: true })).toHaveCount(0);
  }
  return page
    .locator('[data-audio-id]')
    .evaluateAll((rows) => rows.map((row) => row.getAttribute('data-audio-id')));
}
async function filter(page: Page, checked: boolean) {
  await toggleAudioFilter(page);
  await expectAudioFilter(page, checked);
  await expect(page.getByRole('progressbar', { name: 'Завантаження аудіо' })).toHaveCount(0);
}
async function stopped(handle: Awaited<ReturnType<typeof remember>>) {
  await expect
    .poll(() =>
      handle.evaluate((element: CustomAudioPlayer) => ({
        paused: element.audio.paused,
        source: element.audio.getAttribute('src'),
      })),
    )
    .toEqual({ paused: true, source: null });
}
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function directStatus(
  backend: Awaited<ReturnType<typeof localAudioBackend>>,
  deviceId: string,
  audioId: string,
  target: boolean,
) {
  const current = await audioDetail(backend.reader, deviceId, audioId);
  return post<SetDeviceAudioProcessingRsp>(backend.source, statusPath, {
    deviceId,
    audioId,
    processed: target,
    expectedProcessingVersion: current.audio.processingVersion,
  });
}

test.describe('@regression real device audio processing reader matrix', () => {
  test.setTimeout(240_000);
  let backend: Awaited<ReturnType<typeof localAudioBackend>>;
  let device: Awaited<ReturnType<typeof backend.createDevice>>;
  const rows: DeviceAudio[] = [];
  test.beforeAll(async () => {
    test.setTimeout(240_000);
    backend = await localAudioBackend();
    device = await backend.createDevice();
    const bytes = toneWav(3);
    for (let index = 0; index < 100; index++) {
      const audio = await receiveAudio(
        backend.source,
        device.id,
        `processing-${index}`,
        new Date(Date.UTC(2026, 9, 5, 0, 0, index)).toISOString(),
        bytes,
      );
      rows.push(audio);
      if (index < 40) await directStatus(backend, device.id, audio.id, true);
    }
  });
  test.afterAll(async () => {
    await backend?.dispose();
  });
  for (const role of ['parent-cyber', 'parent-cyberviewer', 'parent-admin']) {
    test(`${role} ${role === 'parent-cyberviewer' ? 'reads every page but cannot edit text or processing' : 'completes real 100/40 workflow and 60→59→60 across every page and relogin'}`, async ({
      page,
      context,
      browser,
    }) => {
      const reader = await backend.login(role);
      await context.addCookies((await reader.storageState()).cookies);
      await page.goto(`/devices/${device.id}`);
      await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      await expect(page.locator('[data-audio-id]')).toHaveCount(50);
      const expected = [...rows].reverse().map((row) => row.id);
      expect(await allVisible(page)).toEqual(expected);
      await filter(page, true);
      expect(await allVisible(page)).toEqual(expected.slice(0, 60));
      const player = await selectAudio(page, rows[99].id);
      await ready(player);
      await player.evaluate((element: CustomAudioPlayer) => element.play());
      await playing(player);
      await audible(player);
      expect((await audioDetail(reader, device.id, rows[99].id)).audio.processed).toBe(false);
      if (role === 'parent-cyberviewer') {
        const before = await audioDetail(reader, device.id, rows[99].id);
        await expect(field(page)).toHaveAttribute('readonly', '');
        await expect(
          page.getByRole('button', { name: 'Зберегти транскрипцію', exact: true }),
        ).toBeDisabled();
        await expect(
          page.getByRole('button', { name: 'Позначити обробленим', exact: true }),
        ).toBeDisabled();
        expect(
          (
            await reader.post(savePath, {
              data: {
                device_id: device.id,
                audio_id: rows[99].id,
                text: 'denied',
                expected_text_version: before.transcription.textVersion,
              },
            })
          ).status(),
        ).toBe(403);
        expect(
          (
            await reader.post(statusPath, {
              data: {
                device_id: device.id,
                audio_id: rows[99].id,
                processed: true,
                expected_processing_version: before.audio.processingVersion,
              },
            })
          ).status(),
        ).toBe(403);
        expect(await audioDetail(reader, device.id, rows[99].id)).toEqual(before);
        return;
      }
      await save(page, `workflow ${role}`);
      expect((await audioDetail(reader, device.id, rows[99].id)).audio.processed).toBe(false);
      await mark(page, true);
      await expect(page.locator(`[data-audio-id="${rows[99].id}"]`)).toHaveCount(0);
      expect(await allVisible(page)).toEqual(expected.slice(1, 60));
      await expect(field(page)).toHaveValue(`workflow ${role}`);
      await filter(page, false);
      expect(await allVisible(page)).toEqual(expected);
      await expect(page.locator(`[data-audio-id="${rows[99].id}"]`)).toHaveCount(1);
      await mark(page, false);
      await filter(page, true);
      expect(await allVisible(page)).toEqual(expected.slice(0, 60));
      await filter(page, false);
      expect(await allVisible(page)).toEqual(expected);
      const again = await browser.newContext({
        storageState: await (await backend.login(role)).storageState(),
      });
      try {
        const fresh = await again.newPage();
        await fresh.goto(`/devices/${device.id}`);
        await fresh.getByRole('tab', { name: 'Аудіо', exact: true }).click();
        await selectAudio(fresh, rows[99].id);
        await expect(field(fresh)).toHaveValue(`workflow ${role}`);
        await expect(panel(fresh)).toContainText('Статус: Необроблене');
      } finally {
        await again.close();
      }
      expect(
        (
          await listAudio(reader, {
            deviceId: device.id,
            unprocessedOnly: false,
            limit: 200,
            cursor: null,
          })
        ).audio,
      ).toHaveLength(100);
    });
  }
  test('tail selection and native player survive an unprocessed ABA with unchanged membership', async ({
    page,
    context,
  }) => {
    const reader = await backend.login('parent-cyber');
    await context.addCookies((await reader.storageState()).cookies);
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await filter(page, true);
    expect(await allVisible(page)).toHaveLength(60);
    const selected = rows[45];
    const player = await selectAudio(page, selected.id);
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const held = await remember(player);
    await directStatus(backend, device.id, selected.id, true);
    await directStatus(backend, device.id, selected.id, false);
    const reread = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/detail'),
    );
    await click(page, 'Перечитати транскрипцію');
    expect((await reread).status()).toBe(200);
    await (await reread).finished();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expect(page.getByRole('progressbar', { name: 'Завантаження аудіо' })).toHaveCount(0);
    await expect(page.locator(`[data-audio-id="${selected.id}"]`)).toHaveCount(1);
    await expect(page.locator('[data-audio-id]')).toHaveCount(60);
    expect(await player.evaluate((element, previous) => element === previous, held)).toBe(true);
    await playing(player);
    await expect(panel(page)).toContainText('Статус: Необроблене');
  });
  test('another record membership change retains the selected tail and playing native instance', async ({
    page,
    context,
  }) => {
    const reader = await backend.login('parent-cyber');
    await context.addCookies((await reader.storageState()).cookies);
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await allVisible(page);
    await selectAudio(page, rows[39].id);
    await filter(page, true);
    expect(await allVisible(page)).toHaveLength(60);
    const committed = gate();
    const release = gate();
    await page.route(`**${statusPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await click(page, 'Позначити необробленим');
    await committed.promise;
    const selected = rows[45];
    const player = await selectAudio(page, selected.id);
    await ready(player);
    const held = await remember(player);
    await player.evaluate((element: CustomAudioPlayer) => {
      element.audio.loop = true;
      return element.play();
    });
    await playing(player);
    release.resolve();
    await expect(page.getByRole('progressbar', { name: 'Завантаження аудіо' })).toHaveCount(0);
    await expect(page.locator('[data-audio-id]')).toHaveCount(61);
    await expect(page.locator(`[data-audio-id="${selected.id}"]`)).toHaveCount(1);
    expect(await player.evaluate((element, previous) => element === previous, held)).toBe(true);
    await playing(player);
    await directStatus(backend, device.id, rows[39].id, true);
  });
});

test.describe('@regression real device audio processing races', () => {
  test.setTimeout(120_000);
  let backend: Awaited<ReturnType<typeof localAudioBackend>>;
  let device: Awaited<ReturnType<typeof backend.createDevice>>;
  let first: DeviceAudio;
  let second: DeviceAudio;
  test.beforeAll(async () => {
    backend = await localAudioBackend();
  });
  test.afterAll(async () => {
    await backend?.dispose();
  });
  test.beforeEach(async ({ page, context }) => {
    backend.reader = await backend.login('parent-cyber');
    device = await backend.createDevice();
    first = await receiveAudio(
      backend.source,
      device.id,
      'first',
      '2026-10-05T10:00:00Z',
      toneWav(20),
    );
    second = await receiveAudio(
      backend.source,
      device.id,
      'second',
      '2026-10-05T09:00:00Z',
      toneWav(20),
    );
    await context.addCookies((await backend.reader.storageState()).cookies);
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(page, first.id);
    await expect(field(page)).toHaveValue('');
  });
  test('status/text are independent, rejected status keeps saved text and the same playing instance', async ({
    page,
  }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    await audible(player);
    const handle = await remember(player);
    const before = await nativeState(player);
    await save(page, 'literal saved text');
    await mark(page, true);
    await mark(page, false);
    expect(await player.evaluate((element, held) => element === held, handle)).toBe(true);
    expect((await nativeState(player)).time).toBeGreaterThan(before.time);
    await page.route(`**${statusPath}`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'confirmed test denial' }),
      }),
    );
    await click(page, 'Позначити обробленим');
    await expect(panel(page)).toContainText('Помилка зміни статусу');
    await playing(player);
    await expect(field(page)).toHaveValue('literal saved text');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'literal saved text',
    );
    expect((await audioDetail(backend.reader, device.id, second.id)).transcription.text).toBe('');
    expect((await audioDetail(backend.reader, device.id, first.id)).audio.processed).toBe(false);
  });
  for (const choice of ['Скасувати', 'Відкинути', 'Зберегти']) {
    test(`own filtered removal ${choice} preserves draft/player until the chosen decision`, async ({
      page,
    }) => {
      await filter(page, true);
      const player = page.locator('[data-device-audio-player] custom-audio-player');
      await ready(player);
      await player.evaluate((element: CustomAudioPlayer) => element.play());
      await playing(player);
      const handle = await remember(player);
      await field(page).fill(`draft ${choice}`);
      let writes = 0;
      page.on('request', (request) => {
        if (request.url().endsWith(statusPath)) ++writes;
      });
      await click(page, 'Позначити обробленим');
      await expect(leave(page)).toBeVisible();
      expect(writes).toBe(0);
      await playing(player);
      await leave(page).getByRole('button', { name: choice, exact: true }).click();
      if (choice === 'Скасувати') {
        await expect(leave(page)).toHaveCount(0);
        expect(writes).toBe(0);
        await playing(player);
        await expect(field(page)).toHaveValue(`draft ${choice}`);
      } else {
        await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(0);
        await stopped(handle);
        await expect(field(page)).toHaveValue(choice === 'Зберегти' ? `draft ${choice}` : '');
        expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
          choice === 'Зберегти' ? `draft ${choice}` : '',
        );
        await expectAudioFilter(page, true);
      }
    });
  }
  test('new draft typed during a committed status request survives removal and can still be saved', async ({
    page,
  }) => {
    await filter(page, true);
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const handle = await remember(player);
    const committed = gate();
    const release = gate();
    let writes = 0;
    await page.route(`**${statusPath}`, async (route) => {
      ++writes;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await click(page, 'Позначити обробленим');
    await committed.promise;
    await expect(
      page.getByRole('button', { name: 'Позначити необробленим', exact: true }),
    ).toBeDisabled();
    await field(page).fill('newer pending draft');
    expect(writes).toBe(1);
    release.resolve();
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(0);
    await stopped(handle);
    await expect(field(page)).toHaveValue('newer pending draft');
    await expect(
      page.getByText('Аудіо більше не входить до поточного списку.', { exact: false }),
    ).toBeVisible();
    await save(page, 'newer pending draft');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'newer pending draft',
    );
  });
  test('genuine lost status acknowledgment reconciles without blind retry and retains a newer draft', async ({
    page,
  }) => {
    await filter(page, true);
    const held = await remember(page.locator('[data-device-audio-player] custom-audio-player'));
    const committed = gate();
    const release = gate();
    let writes = 0;
    await page.route(`**${statusPath}`, async (route) => {
      ++writes;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.abort('failed');
    });
    await click(page, 'Позначити обробленим');
    await committed.promise;
    await field(page).fill('retained after lost ack');
    release.resolve();
    await expect(panel(page)).toContainText('Актуальний статус перечитано');
    await stopped(held);
    await expect(field(page)).toHaveValue('retained after lost ack');
    expect(writes).toBe(1);
    expect((await audioDetail(backend.reader, device.id, first.id)).audio.processed).toBe(true);
  });
  test('repeated real ABA conflict needs explicit same-target retry with each current token', async ({
    page,
  }) => {
    await field(page).fill('keep draft');
    await directStatus(backend, device.id, first.id, true);
    await directStatus(backend, device.id, first.id, false);
    await click(page, 'Позначити обробленим');
    await expect(panel(page)).toContainText('Статус уже змінено');
    await directStatus(backend, device.id, first.id, true);
    await directStatus(backend, device.id, first.id, false);
    await click(page, 'Повторити позначення обробленим');
    await expect(panel(page)).toContainText('Статус уже змінено');
    const targets: boolean[] = [];
    page.on('request', (request) => {
      if (request.url().endsWith(statusPath)) targets.push(request.postDataJSON().processed);
    });
    await click(page, 'Повторити позначення обробленим');
    await expect(panel(page)).toContainText('Статус: Оброблене');
    expect(targets).toEqual([true]);
    await expect(field(page)).toHaveValue('keep draft');
  });
  test('fresh foreign processing removal retains the bound editor and stops actual native playback', async ({
    page,
  }) => {
    await filter(page, true);
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const handle = await remember(player);
    await field(page).fill('foreign removal draft');
    await directStatus(backend, device.id, first.id, true);
    const response = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/detail'),
    );
    await click(page, 'Перечитати транскрипцію');
    expect((await response).status()).toBe(200);
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(0);
    await stopped(handle);
    await expect(field(page)).toHaveValue('foreign removal draft');
    await save(page, 'foreign removal draft');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'foreign removal draft',
    );
  });
  test('two real users save independent text and status concurrently', async ({ page }) => {
    const another = await backend.login('parent-cyber');
    await field(page).fill('concurrent two-user text');
    const response = page.waitForResponse((response) => response.url().endsWith(savePath));
    const [status] = await Promise.all([
      post<SetDeviceAudioProcessingRsp>(another, statusPath, {
        deviceId: device.id,
        audioId: first.id,
        processed: true,
        expectedProcessingVersion: first.processingVersion,
      }),
      click(page, 'Зберегти транскрипцію'),
    ]);
    expect((await response).status()).toBe(200);
    expect(status.processed).toBe(true);
    const current = await audioDetail(backend.reader, device.id, first.id);
    expect(current.transcription.text).toBe('concurrent two-user text');
    expect(current.audio.processed).toBe(true);
    await click(page, 'Перечитати транскрипцію');
    await expect(panel(page)).toContainText('Статус: Оброблене');
    await expect(field(page)).toHaveValue('concurrent two-user text');
  });
  test('unknown offline status requires an authorized reread before any explicit retry', async ({
    page,
  }) => {
    await filter(page, true);
    const committed = gate();
    const release = gate();
    let writes = 0;
    await page.route(`**${statusPath}`, async (route) => {
      ++writes;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.abort('failed');
    });
    await page.route('**/api/device/audio/detail', (route) => route.abort('failed'));
    await click(page, 'Позначити обробленим');
    await committed.promise;
    await field(page).fill('offline draft');
    release.resolve();
    await expect(panel(page)).toContainText('Не вдалося звірити статус');
    await expect(panel(page)).toContainText('Статус: Необроблене');
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(1);
    await expect(
      page.getByRole('button', { name: 'Позначити обробленим', exact: true }),
    ).toBeDisabled();
    expect(writes).toBe(1);
    await page.unroute('**/api/device/audio/detail');
    await click(page, 'Перечитати статус');
    await expect(panel(page)).toContainText('Статус: Оброблене');
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(0);
    await expect(field(page)).toHaveValue('offline draft');
    expect(writes).toBe(1);
  });
  test('old independent detail cannot revert a confirmed processing response or newer draft', async ({
    page,
  }) => {
    const obtained = gate();
    const release = gate();
    await page.route('**/api/device/audio/detail', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      obtained.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await field(page).fill('draft before old detail');
    await click(page, 'Перечитати транскрипцію');
    await obtained.promise;
    await mark(page, true);
    release.resolve();
    await expect(field(page)).toHaveValue('draft before old detail');
    await expect(panel(page)).toContainText('Статус: Оброблене');
    await page.unroute('**/api/device/audio/detail');
    await save(page, 'draft before old detail');
    expect((await audioDetail(backend.reader, device.id, first.id)).audio.processed).toBe(true);
  });
  test('failed guarded text save never sends the anticipated removal status request', async ({
    page,
  }) => {
    await filter(page, true);
    await field(page).fill('unsaved protected draft');
    let writes = 0;
    page.on('request', (request) => {
      if (request.url().endsWith(statusPath)) ++writes;
    });
    await page.route(`**${savePath}`, (route) =>
      route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'confirmed save denial' }),
      }),
    );
    await click(page, 'Позначити обробленим');
    await expect(leave(page)).toBeVisible();
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(page.locator('[data-device-audio-editor]')).toContainText('Помилка збереження');
    expect(writes).toBe(0);
    await expect(leave(page)).toBeVisible();
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(1);
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(field(page)).toHaveValue('unsaved protected draft');
  });
  test('real revoked reader cannot mutate status and retained native playback is cleared', async ({
    page,
  }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const held = await remember(player);
    await field(page).fill('retained revoked draft');
    const identity = await backend.reader.get('/api/user');
    expect(identity.status()).toBe(200);
    const actor = (await identity.json()) as Pick<User, 'id' | 'roles'>;
    const roles = JSON.stringify(actor.roles).replaceAll("'", "''");
    const before = await audioDetail(backend.reader, device.id, first.id);
    try {
      await audioFixtureSql('main', `UPDATE login SET roles='[]'::jsonb WHERE id='${actor.id}';`);
      const response = page.waitForResponse((response) => response.url().endsWith(statusPath));
      await click(page, 'Позначити обробленим');
      expect((await response).status()).toBe(403);
      await expect(panel(page)).toContainText('Не вдалося звірити доступ');
      await stopped(held);
      await expect(field(page)).toHaveValue('retained revoked draft');
      await expect(field(page)).toHaveAttribute('readonly', '');
    } finally {
      await audioFixtureSql(
        'main',
        `UPDATE login SET roles='${roles}'::jsonb WHERE id='${actor.id}';`,
      );
    }
    expect((await audioDetail(backend.reader, device.id, first.id)).audio).toEqual(before.audio);
  });
  test('delayed own status acknowledgment preserves a newer foreign authorized status', async ({
    page,
  }) => {
    const committed = gate();
    const release = gate();
    await page.route(`**${statusPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    await click(page, 'Позначити обробленим');
    await committed.promise;
    const foreign = await backend.login('parent-cyber');
    const previous = await audioDetail(foreign, device.id, first.id);
    const newer = await post<SetDeviceAudioProcessingRsp>(foreign, statusPath, {
      deviceId: device.id,
      audioId: first.id,
      processed: false,
      expectedProcessingVersion: previous.audio.processingVersion,
    });
    const read = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/detail'),
    );
    await click(page, 'Перечитати транскрипцію');
    expect((await (await read).json()).audio.processing_version).toBe(newer.processingVersion);
    await (await read).finished();
    await page.evaluate(
      () =>
        new Promise<void>((done) =>
          requestAnimationFrame(() => requestAnimationFrame(() => done())),
        ),
    );
    await expect(panel(page)).toContainText('Статус: Необроблене');
    release.resolve();
    await expect(panel(page)).toContainText('Статус уже змінено');
    await expect(panel(page)).toContainText('Статус: Необроблене');
    expect((await audioDetail(backend.reader, device.id, first.id)).audio.processingVersion).toBe(
      newer.processingVersion,
    );
  });
  test('processing acknowledgment preserves a pending user filter intent', async ({ page }) => {
    const statusCommitted = gate();
    const statusRelease = gate();
    const filterCaptured = gate();
    const filterRelease = gate();
    let filteredRequests = 0;
    await page.route(`**${statusPath}`, async (route) => {
      const response = await route.fetch();
      statusCommitted.resolve();
      await statusRelease.promise;
      await route.fulfill({ response });
    });
    await page.route('**/api/device/audio/list', async (route) => {
      if (route.request().postDataJSON().unprocessed_only && ++filteredRequests === 1) {
        const response = await route.fetch();
        filterCaptured.resolve();
        await filterRelease.promise;
        await route.fulfill({ response });
      } else await route.continue();
    });
    try {
      await click(page, 'Позначити обробленим');
      await statusCommitted.promise;
      await toggleAudioFilter(page);
      await filterCaptured.promise;
      statusRelease.resolve();
      await expectAudioFilter(page, true);
      await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-audio-id="${second.id}"]`)).toHaveCount(1);
      expect(filteredRequests).toBe(2);
    } finally {
      statusRelease.resolve();
      filterRelease.resolve();
    }
  });
  test('fresh authorized reread resolves opaque versions when the delayed request becomes a newer no-op', async ({
    page,
  }) => {
    const captured = gate();
    const release = gate();
    await page.route(`**${statusPath}`, async (route) => {
      captured.resolve();
      await release.promise;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.fulfill({ response });
    });
    try {
      await click(page, 'Позначити обробленим');
      await captured.promise;
      await directStatus(backend, device.id, first.id, true);
      await directStatus(backend, device.id, first.id, false);
      const read = page.waitForResponse((response) =>
        response.url().endsWith('/api/device/audio/detail'),
      );
      await click(page, 'Перечитати транскрипцію');
      await (await read).finished();
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await directStatus(backend, device.id, first.id, true);
      const latest = await audioDetail(backend.reader, device.id, first.id);
      release.resolve();
      await expect(panel(page)).toContainText(
        'Актуальний статус перечитано після паралельної зміни',
      );
      await expect(panel(page)).toContainText('Статус: Оброблене');
      expect((await audioDetail(backend.reader, device.id, first.id)).audio.processingVersion).toBe(
        latest.audio.processingVersion,
      );
    } finally {
      release.resolve();
    }
  });
  test('authorized status reconciliation restores native playback after temporary denial', async ({
    page,
  }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const held = await remember(player);
    const committed = gate();
    const release = gate();
    await page.route(`**${statusPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.abort('failed');
    });
    const identity = await backend.reader.get('/api/user');
    expect(identity.status()).toBe(200);
    const actor = (await identity.json()) as Pick<User, 'id' | 'roles'>;
    const roles = JSON.stringify(actor.roles).replaceAll("'", "''");
    await click(page, 'Позначити обробленим');
    await committed.promise;
    await field(page).fill('recovery draft');
    try {
      const deniedTranscription = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/device/audio/transcription/status') &&
          response.status() === 403,
      );
      await audioFixtureSql('main', `UPDATE login SET roles='[]'::jsonb WHERE id='${actor.id}';`);
      await (await deniedTranscription).finished();
      await expect(field(page)).toHaveAttribute('readonly', '');
      release.resolve();
      await expect(panel(page)).toContainText('Не вдалося звірити статус');
      await stopped(held);
    } finally {
      await audioFixtureSql(
        'main',
        `UPDATE login SET roles='${roles}'::jsonb WHERE id='${actor.id}';`,
      );
      release.resolve();
    }
    const rereadCaptured = gate();
    const rereadRelease = gate();
    let reads = 0;
    await page.route('**/api/device/audio/detail', async (route) => {
      reads++;
      const response = await route.fetch();
      rereadCaptured.resolve();
      await rereadRelease.promise;
      await route.fulfill({ response });
    });
    await click(page, 'Перечитати статус');
    await rereadCaptured.promise;
    await expect(
      page.getByRole('button', { name: 'Перечитати статус', exact: true }),
    ).toBeDisabled();
    await expect(panel(page)).toContainText('Звіряємо статус…');
    expect(reads).toBe(1);
    rereadRelease.resolve();
    await expect(panel(page)).toContainText('Статус: Оброблене');
    await expect(field(page)).toHaveValue('recovery draft');
    const restored = page.locator('[data-device-audio-player] custom-audio-player');
    await expect(restored).toHaveCount(1);
    await ready(restored);
    await restored.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(restored);
    await audible(restored);
  });
  test('archive denies status changes without metadata mutation', async ({ page }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    await audioFixtureSql(
      'main',
      `UPDATE device SET archived=true,archived_at=now() WHERE id='${device.id}';`,
    );
    const before = await audioDetail(backend.reader, device.id, first.id);
    const response = await backend.reader.post(statusPath, {
      data: {
        device_id: device.id,
        audio_id: first.id,
        processed: true,
        expected_processing_version: before.audio.processingVersion,
      },
    });
    expect(response.status()).toBe(403);
    expect((await audioDetail(backend.reader, device.id, first.id)).audio).toEqual(before.audio);
    await click(page, 'Позначити обробленим');
    await expect(panel(page)).toContainText('Помилка зміни статусу');
    await expect(
      page.getByRole('button', { name: 'Позначити необробленим', exact: true }),
    ).toBeDisabled();
    await expect(field(page)).toHaveAttribute('readonly', '');
    await playing(player);
  });
  test('real processing 401 stops native playback and bypasses a retained dirty draft warning', async ({
    page,
  }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    await field(page).fill('expired status session draft');
    const before = await audioDetail(backend.reader, device.id, first.id);
    await player.evaluate((element: CustomAudioPlayer) =>
      window.addEventListener(
        'pagehide',
        () =>
          sessionStorage.setItem(
            'audio-processing-401',
            JSON.stringify({
              paused: element.audio.paused,
              source: element.audio.getAttribute('src'),
            }),
          ),
        { once: true },
      ),
    );
    let unloads = 0;
    page.on('dialog', async (dialog) => {
      unloads++;
      await dialog.dismiss();
    });
    await page.context().clearCookies();
    const denied = page.waitForResponse((response) => response.url().endsWith(statusPath));
    await click(page, 'Позначити обробленим');
    expect((await denied).status()).toBe(401);
    await expect(page).toHaveURL(/\/login/);
    expect(unloads).toBe(0);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('audio-processing-401')!)),
    ).toEqual({ paused: true, source: null });
    expect(await audioDetail(backend.reader, device.id, first.id)).toEqual(before);
  });
  test('ordinary authorized editor reread restores player and editing after confirmed processing denial', async ({
    page,
  }) => {
    const player = page.locator('[data-device-audio-player] custom-audio-player');
    await ready(player);
    await player.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(player);
    const held = await remember(player);
    await field(page).fill('retained confirmed denial draft');
    const identity = await backend.reader.get('/api/user');
    expect(identity.status()).toBe(200);
    const actor = (await identity.json()) as Pick<User, 'id' | 'roles'>;
    const roles = JSON.stringify(actor.roles).replaceAll("'", "''");
    try {
      await audioFixtureSql('main', `UPDATE login SET roles='[]'::jsonb WHERE id='${actor.id}';`);
      await click(page, 'Позначити обробленим');
      await expect(panel(page)).toContainText('Не вдалося звірити доступ');
      await stopped(held);
    } finally {
      await audioFixtureSql(
        'main',
        `UPDATE login SET roles='${roles}'::jsonb WHERE id='${actor.id}';`,
      );
    }
    const read = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/detail'),
    );
    await page.getByRole('button', { name: 'Перечитати транскрипцію', exact: true }).focus();
    await page.getByRole('button', { name: 'Перечитати транскрипцію', exact: true }).press('Enter');
    expect((await read).status()).toBe(200);
    await expect(field(page)).not.toHaveAttribute('readonly', '');
    await expect(field(page)).toHaveValue('retained confirmed denial draft');
    await expect(
      page.getByRole('button', { name: 'Позначити обробленим', exact: true }),
    ).toBeEnabled();
    const restored = page.locator('[data-device-audio-player] custom-audio-player');
    await expect(restored).toHaveCount(1);
    await ready(restored);
    await restored.evaluate((element: CustomAudioPlayer) => element.play());
    await playing(restored);
    await audible(restored);
  });
  test('filter summary replacement cannot hide a current archived permission confirmation', async ({
    page,
  }) => {
    await audioFixtureSql(
      'main',
      `UPDATE device SET archived=true,archived_at=now() WHERE id='${device.id}';`,
    );
    const captured = gate();
    const release = gate();
    await page.route('**/api/device/audio/detail', async (route) => {
      const response = await route.fetch();
      expect((await response.json()).can_edit).toBe(false);
      captured.resolve();
      await release.promise;
      await route.fulfill({ response });
    });
    try {
      await click(page, 'Позначити обробленим');
      await captured.promise;
      await filter(page, true);
      const read = page.waitForResponse((response) =>
        response.url().endsWith('/api/device/audio/detail'),
      );
      release.resolve();
      await (await read).finished();
      await page.evaluate(
        () =>
          new Promise<void>((done) =>
            requestAnimationFrame(() => requestAnimationFrame(() => done())),
          ),
      );
      await expect(field(page)).toHaveAttribute('readonly', '');
      await expect(
        page.getByRole('button', { name: 'Позначити необробленим', exact: true }),
      ).toBeDisabled();
    } finally {
      release.resolve();
    }
  });
  test('another record acknowledgment cannot suppress a current independent detail', async ({
    page,
  }) => {
    const committed = gate();
    const releaseStatus = gate();
    const captured = gate();
    const releaseDetail = gate();
    await selectAudio(page, second.id);
    await expect(field(page)).toHaveValue('');
    await page.route(`**${statusPath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await releaseStatus.promise;
      await route.fulfill({ response });
    });
    try {
      await click(page, 'Позначити обробленим');
      await committed.promise;
      await directStatus(backend, device.id, first.id, true);
      await page.route('**/api/device/audio/detail', async (route) => {
        const response = await route.fetch();
        expect((await response.json()).audio.processed).toBe(true);
        captured.resolve();
        await releaseDetail.promise;
        await route.fulfill({ response });
      });
      const player = await selectAudio(page, first.id);
      await captured.promise;
      const held = await remember(player);
      await ready(player);
      await player.evaluate((element: CustomAudioPlayer) => element.play());
      await playing(player);
      releaseStatus.resolve();
      await expect(
        page
          .locator(`[data-audio-id="${second.id}"]`)
          .getByRole('img', { name: 'Оброблене', exact: true }),
      ).toHaveCount(1);
      releaseDetail.resolve();
      await expect(panel(page)).toContainText('Статус: Оброблене');
      expect(await player.evaluate((element, previous) => element === previous, held)).toBe(true);
      await playing(player);
      await expect(field(page)).toHaveValue('');
    } finally {
      releaseStatus.resolve();
      releaseDetail.resolve();
    }
  });
});
