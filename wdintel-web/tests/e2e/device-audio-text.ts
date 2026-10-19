import { expect, test, type Page } from '@playwright/test';
import {
  audioDetail,
  audioAsrFixture,
  audioFixtureSql,
  localAudioBackend,
  post,
  receiveAudio,
  removeAudioFixtureCache,
} from './device-audio-backend';
import {
  audible,
  nativeState,
  playing,
  ready,
  remember,
  rememberNativeAudio,
  selectAudio,
  toggleAudioFilter,
  expectAudioFilter,
  toneWav,
} from './device-audio-player';
import type {
  DeviceAudio,
  DeviceAudioPreparation,
  RetryDeviceAudioTranscriptionRsp,
  DeviceAudioTranscriptionStatusRsp,
  SaveDeviceAudioTranscriptionRsp,
} from '../../src/Bindings';

const savePath = '/api/device/audio/transcription/save';
const saveClicks = new WeakMap<Page, number>();
async function clickSave(page: Page) {
  const remaining = 400 - (Date.now() - (saveClicks.get(page) ?? 0));
  if (remaining > 0) await page.waitForTimeout(remaining);
  await page.getByRole('button', { name: 'Зберегти транскрипцію', exact: true }).click();
  saveClicks.set(page, Date.now());
}
const field = (page: Page) =>
  page.getByRole('textbox', { name: 'Ручна транскрипція', exact: true });
const leave = (page: Page) => page.getByRole('dialog', { name: 'Незбережена транскрипція' });
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function save(page: Page, text: string) {
  await field(page).fill(text);
  const response = page.waitForResponse((response) => response.url().endsWith(savePath));
  await clickSave(page);
  expect((await response).status()).toBe(200);
  await expect(page.locator('[data-device-audio-editor]')).toContainText('Актуальний текст');
}

test.describe('@regression real device audio transcription', () => {
  let backend: Awaited<ReturnType<typeof localAudioBackend>>;
  let device: Awaited<ReturnType<typeof backend.createDevice>>;
  let otherDevice: typeof device;
  let first: DeviceAudio;
  let second: DeviceAudio;
  test.beforeAll(async () => {
    backend = await localAudioBackend();
  });
  test.afterAll(async () => {
    await backend?.dispose();
  });
  test.beforeEach(async () => {
    test.setTimeout(90_000);
    backend.reader = await backend.login('parent-cyber');
    device = await backend.createDevice();
    otherDevice = await backend.createDevice();
    first = await receiveAudio(
      backend.source,
      device.id,
      'text-first.wav',
      '2026-10-04T15:00:00+03:00',
      toneWav(20),
    );
    second = await receiveAudio(
      backend.source,
      device.id,
      'text-second.wav',
      '2026-10-04T14:00:00+03:00',
      toneWav(2),
    );
  });
  async function open(page: Page, id = first.id) {
    await page.context().addCookies((await backend.reader.storageState()).cookies);
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    const player = await selectAudio(page, id);
    await expect(field(page)).toBeVisible();
    return player;
  }
  async function serverSave(text: string) {
    const detail = await audioDetail(backend.reader, device.id, first.id);
    return post<SaveDeviceAudioTranscriptionRsp>(backend.reader, savePath, {
      deviceId: device.id,
      audioId: first.id,
      text,
      expectedTextVersion: detail.transcription.textVersion,
    });
  }
  test('#3645 automatic original leaves processing and manual draft save available', async ({
    page,
  }) => {
    await serverSave('Ручний текст');
    await audioFixtureSql(
      'files',
      `UPDATE device_audio SET automatic_transcription='Автоматичний оригінал', automatic_transcribed_at=now() WHERE id='${first.id}';`,
    );
    await open(page);
    await expectAudioFilter(page, false);
    await field(page).fill('Збережена ручна правка');
    await page.getByRole('button', { name: 'Автоматична', exact: true }).click();
    const original = page.getByRole('textbox', { name: 'Автоматична транскрипція', exact: true });
    await expect(original).toHaveAttribute('readonly', '');
    await expect(
      page.getByRole('button', { name: 'Зберегти транскрипцію', exact: true }),
    ).toBeDisabled();
    await page.getByRole('button', { name: 'Позначити обробленим', exact: true }).click();
    await expect(page.locator('[data-device-audio-processing]')).toContainText('Статус: Оброблене');
    await page.locator(`[data-audio-id="${second.id}"]`).click();
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(leave(page)).not.toBeVisible();
    await expect(field(page)).toHaveValue('');
    const saved = await audioDetail(backend.reader, device.id, first.id);
    expect(saved.transcription.text).toBe('Збережена ручна правка');
    expect(saved.automaticTranscription.text).toBe('Автоматичний оригінал');
    expect(saved.audio.processed).toBe(true);
  });
  test('#3645 mobile reopening the same audio defaults to manual after viewing the automatic original', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await serverSave('Ручний текст');
    await audioFixtureSql(
      'files',
      `UPDATE device_audio SET automatic_transcription='Автоматичний оригінал', automatic_transcribed_at=now() WHERE id='${first.id}';`,
    );
    await open(page);
    await page.getByRole('button', { name: 'Автоматична', exact: true }).click();
    await expect(
      page.getByRole('textbox', { name: 'Автоматична транскрипція', exact: true }),
    ).toHaveValue('Автоматичний оригінал');
    await page.getByRole('button', { name: 'До аудіо', exact: true }).click();
    await expect(page.locator('[data-device-audio-editor]')).not.toBeVisible();
    await selectAudio(page, first.id);
    await expect(field(page)).toHaveValue('Ручний текст');
    await expect(field(page)).not.toHaveAttribute('readonly', '');
    await expect(page.getByRole('button', { name: 'Ручна', exact: true })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.getByRole('button', { name: 'Автоматична', exact: true }).click();
    await page.getByRole('tab', { name: 'Аналітика', exact: true }).click();
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await expect(field(page)).toHaveValue('Ручний текст');
    expect(
      (await audioDetail(backend.reader, device.id, first.id)).automaticTranscription.text,
    ).toBe('Автоматичний оригінал');
  });
  test('literal Unicode, markup, whitespace, clear and long text persist across real logins without touching another audio', async ({
    page,
    browser,
  }) => {
    const before = await audioDetail(backend.reader, device.id, first.id);
    await open(page);
    const literal =
      '  Україна 🛰️\n<script>window.audioTextExecuted=true</script>\n**буквально** "лапки"  \n';
    await save(page, literal);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      literal,
    );
    expect(
      await page.evaluate(() => (window as unknown as Record<string, unknown>).audioTextExecuted),
    ).toBeUndefined();
    const secondContext = await browser.newContext({
      storageState: await (await backend.login('parent-cyberviewer')).storageState(),
    });
    const another = await secondContext.newPage();
    try {
      await another.goto(`/devices/${device.id}`);
      await another.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      await selectAudio(another, first.id);
      await expect(field(another)).toHaveValue(literal);
    } finally {
      await secondContext.close();
    }
    await save(page, ' \n');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(' \n');
    await save(page, '');
    const long = 'Ї'.repeat(512 * 1024);
    await field(page).fill(long, { timeout: 30_000 });
    expect((await field(page).boundingBox())!.height).toBeLessThan(600);
    await save(page, long);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(long);
    await page.reload();
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    const reread = page.waitForResponse((response) =>
      response.url().endsWith('/api/device/audio/detail'),
    );
    await page.locator(`[data-audio-id="${first.id}"]`).click();
    const detail = await reread;
    expect(detail.status()).toBe(200);
    await detail.finished();
    await expect(field(page)).toBeVisible({ timeout: 15_000 });
    expect((await field(page).inputValue()) === long).toBe(true);
    const after = await audioDetail(backend.reader, device.id, first.id);
    expect(after.audio).toEqual(before.audio);
    expect((await audioDetail(backend.reader, device.id, second.id)).transcription.text).toBe('');
  });
  test('typing and saving during actual playback preserve the native source, position and textarea hotkeys', async ({
    page,
  }) => {
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    await audible(player);
    const before = await nativeState(player);
    const old = await remember(player);
    await field(page).fill('Український текст');
    await field(page).press('Space');
    await field(page).press('Enter');
    await field(page).press('ArrowLeft');
    await field(page).press('ArrowRight');
    expect((await nativeState(player)).paused).toBe(false);
    await save(page, 'Український текст \n');
    expect((await nativeState(player)).time).toBeGreaterThanOrEqual(before.time);
    expect(await old.evaluate((element) => element.isConnected)).toBe(true);
    expect((await nativeState(player)).source).toBe(before.source);
  });
  test('two real editors reconcile repeated conflicts only through explicit actions', async ({
    page,
    browser,
  }) => {
    await serverSave('base');
    await open(page);
    const otherContext = await browser.newContext({
      storageState: await (await backend.login('parent-admin')).storageState(),
    });
    const other = await otherContext.newPage();
    try {
      await other.goto(`/devices/${device.id}`);
      await other.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      await selectAudio(other, first.id);
      await expect(field(other)).toHaveValue('base');
      await save(other, 'server-two');
      await field(page).fill('mine');
      const conflict = page.waitForResponse(
        (response) => response.url().endsWith(savePath) && response.status() === 409,
      );
      await clickSave(page);
      await conflict;
      await expect(
        page.getByRole('textbox', { name: 'Актуальний текст', exact: true }),
      ).toHaveValue('server-two');
      await expect(page.getByRole('textbox', { name: 'Моя чернетка', exact: true })).toHaveValue(
        'mine',
      );
      await page.getByRole('button', { name: 'Залишити мою чернетку', exact: true }).click();
      await save(other, 'server-three');
      const repeated = page.waitForResponse(
        (response) => response.url().endsWith(savePath) && response.status() === 409,
      );
      await clickSave(page);
      await repeated;
      await expect(
        page.getByRole('textbox', { name: 'Актуальний текст', exact: true }),
      ).toHaveValue('server-three');
      await page.getByRole('button', { name: 'Використати актуальний текст', exact: true }).click();
      await expect(field(page)).toHaveValue('server-three');
      expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
        'server-three',
      );
    } finally {
      await otherContext.close();
    }
  });
  test('long conflicting texts remain literal in bounded comparison fields', async ({ page }) => {
    const current = 'Ї'.repeat(16_000);
    await serverSave(current);
    await open(page);
    const draft = `${current} моя чернетка`;
    await field(page).fill(draft);
    await serverSave(`${current} інший редактор`);
    const conflict = page.waitForResponse(
      (response) => response.url().endsWith(savePath) && response.status() === 409,
    );
    await clickSave(page);
    await conflict;
    const theirs = page.getByRole('textbox', { name: 'Актуальний текст', exact: true });
    const mine = page.getByRole('textbox', { name: 'Моя чернетка', exact: true });
    await expect(mine).toHaveValue(draft);
    await expect(theirs).toHaveValue(`${current} інший редактор`);
    expect((await mine.boundingBox())!.height).toBeLessThan(600);
    expect((await theirs.boundingBox())!.height).toBeLessThan(600);
  });
  test('initial read error is not empty text; byte outage still permits text editing', async ({
    page,
  }) => {
    await serverSave('saved');
    await page.route('**/api/device/audio/detail', (route) =>
      route.fulfill({ status: 503, body: 'unavailable' }),
    );
    await page.route(`**/${first.id}/content`, (route) =>
      route.fulfill({ status: 503, body: 'unavailable' }),
    );
    await page.context().addCookies((await backend.reader.storageState()).cookies);
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await page.locator(`[data-audio-id="${first.id}"]`).click();
    await expect(page.locator('[data-device-audio-editor]')).toContainText('Помилка читання');
    await expect(field(page)).toHaveCount(0);
    await page.unroute('**/api/device/audio/detail');
    await page.getByRole('button', { name: 'Перечитати транскрипцію', exact: true }).click();
    await expect(field(page)).toHaveValue('saved');
    await save(page, 'text despite media outage');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'text despite media outage',
    );
  });
  test('lost committed response rereads actual state and preserves a newer draft without authorizing navigation', async ({
    page,
  }) => {
    await open(page);
    await field(page).fill('submitted');
    const committed = deferred();
    const release = deferred();
    await page.route(`**${savePath}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      committed.resolve();
      await release.promise;
      await route.abort('failed');
    });
    await clickSave(page);
    await committed.promise;
    await field(page).fill('newer draft');
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await expect(leave(page).getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
    release.resolve();
    await expect(leave(page)).toBeVisible();
    await expect(leave(page)).toContainText('Результат попереднього запиту невідомий');
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(field(page)).toHaveValue('newer draft');
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'submitted',
    );
    await page.unroute(`**${savePath}`);
    await save(page, 'newer draft');
  });
  test('record and tab decisions preserve playback on Cancel, discard local edits and wait for Save', async ({
    page,
  }) => {
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    const old = await remember(player);
    await field(page).fill('discard me');
    await page.locator(`[data-audio-id="${second.id}"]`).click();
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    expect(await old.evaluate((element) => element.isConnected)).toBe(true);
    expect((await nativeState(player)).paused).toBe(false);
    await expect(field(page)).toHaveValue('discard me');
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    expect((await nativeState(player)).paused).toBe(false);
    await page.waitForTimeout(410);
    await page.locator(`[data-audio-id="${second.id}"]`).click();
    await leave(page).getByRole('button', { name: 'Відкинути', exact: true }).click();
    await expect(page.locator(`[data-audio-id="${second.id}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      await old.evaluate((element) => element.audio.paused && !element.audio.getAttribute('src')),
    ).toBe(true);
    await field(page).fill('saved second');
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Файли', exact: true })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect((await audioDetail(backend.reader, device.id, second.id)).transcription.text).toBe(
      'saved second',
    );
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe('');
  });
  test('filter Cancel preserves context; failed filter read keeps the old list and bound draft', async ({
    page,
  }) => {
    await open(page);
    await field(page).fill('keep filter');
    await toggleAudioFilter(page);
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expectAudioFilter(page, false);
    await expect(field(page)).toHaveValue('keep filter');
    await page.route('**/api/device/audio/list', (route) =>
      route.fulfill({ status: 503, body: 'filter down' }),
    );
    await toggleAudioFilter(page);
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(page.locator('[data-testid="device-audio-list"]')).toContainText(
      'Помилка завантаження',
    );
    await expectAudioFilter(page, false);
    await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'keep filter',
    );
    await page.unroute('**/api/device/audio/list');
    await field(page).fill('later filter draft');
    const retry = page
      .locator('[data-testid="device-audio-list"]')
      .getByRole('button', { name: 'Спробувати ще раз', exact: true });
    await retry.click();
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expectAudioFilter(page, false);
    await expect(field(page)).toHaveValue('later filter draft');
    await page.waitForTimeout(410);
    await retry.click();
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expectAudioFilter(page, true);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'later filter draft',
    );
  });
  for (const fallback of [false, true])
    test(`cancelled_navigation_does_not_destroy_existing_map with ${fallback ? 'indexed fallback' : 'native Navigation API'} Back/Forward and navbar`, async ({
      page,
    }) => {
      if (fallback)
        await page.addInitScript(() =>
          Object.defineProperty(window, 'navigation', { value: undefined, configurable: true }),
        );
      await open(page);
      await page.evaluate(async (other) => {
        const { requestNavigation } = await import('/src/ts/browser/navigation-guard.ts');
        await requestNavigation(`/devices/${other}`);
      }, otherDevice.id);
      await expect(page.locator('device-details-page')).toHaveAttribute(
        'device-id',
        otherDevice.id,
      );
      await page.evaluate(async (id) => {
        const { requestNavigation } = await import('/src/ts/browser/navigation-guard.ts');
        await requestNavigation(`/devices/${id}`);
      }, device.id);
      await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      await selectAudio(page, first.id);
      await field(page).fill('navigation draft');
      await page.evaluate(async () => {
        const container = document.createElement('div');
        container.id = 'map-container-guard-proof';
        container.style.cssText =
          'position:fixed;width:150px;height:150px;bottom:0;left:0;z-index:1';
        document.body.appendChild(container);
        const { setupMap } = await import('/src/ts/maps/maps.ts');
        await setupMap(
          { containerId: 'guard-proof', points: [{ lat: 49, lng: 32, id: 1, body: 'map' }] },
          () => {},
        );
      });
      await expect(page.locator('#map-container-guard-proof .leaflet-map-pane')).toHaveCount(1);
      const original = page.url();
      await page.evaluate(() => history.back());
      await expect(leave(page)).toBeVisible();
      expect(page.url()).toBe(original);
      await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
      await expect(page.locator('#map-container-guard-proof .leaflet-map-pane')).toHaveCount(1);
      await expect(field(page)).toHaveValue('navigation draft');
      await page.evaluate(() => history.back());
      await expect(leave(page)).toBeVisible();
      await leave(page).getByRole('button', { name: 'Відкинути', exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/devices/${otherDevice.id}$`));
      await expect(page.locator('#map-container-guard-proof .leaflet-map-pane')).toHaveCount(0);
      await page.evaluate(() => history.forward());
      await expect(page).toHaveURL(original);
      await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
      await selectAudio(page, first.id);
      await field(page).fill('navbar draft');
      await page.getByRole('button', { name: /parent-cyber/ }).click();
      await page.getByRole('link', { name: /Налаштування/ }).click();
      await expect(leave(page)).toBeVisible();
      await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
      expect(page.url()).toBe(original);
      await page.waitForTimeout(410);
      await page.getByRole('button', { name: /parent-cyber/ }).click();
      await page.getByRole('link', { name: /Налаштування/ }).click();
      await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
      await expect(page).toHaveURL(/\/settings-neo\?section=my-groups$/);
      expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
        'navbar draft',
      );
    });
  test('browser refresh Cancel preserves memory; confirmed refresh restores only saved text', async ({
    page,
  }) => {
    await serverSave('last saved');
    await open(page);
    await field(page).fill('unsaved');
    const dialog = page.waitForEvent('dialog');
    const reload = page.reload({ timeout: 5000 }).catch(() => {});
    const prompt = await dialog;
    expect(prompt.type()).toBe('beforeunload');
    await prompt.dismiss();
    await reload;
    await expect(field(page)).toHaveValue('unsaved');
    const confirmed = page.waitForEvent('dialog');
    const leaving = page.reload();
    await (await confirmed).accept();
    await leaving;
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(page, first.id);
    await expect(field(page)).toHaveValue('last saved');
  });
  test('actual app link and card Back preserve context until the explicit decision', async ({
    page,
  }) => {
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    await field(page).fill('saved before Back');
    const original = page.url();
    await page.locator('a.app-navbar-logo[href="/"]').click();
    await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
    expect(page.url()).toBe(original);
    expect((await nativeState(player)).paused).toBe(false);
    await expect(field(page)).toHaveValue('saved before Back');
    await page.getByRole('button', { name: 'До списку пристроїв', exact: true }).click();
    await leave(page).getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(page).toHaveURL(/\/devices$/);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'saved before Back',
    );
    await open(page);
    await field(page).fill('discard on app link');
    await page.locator('a.app-navbar-logo[href="/"]').click();
    await leave(page).getByRole('button', { name: 'Відкинути', exact: true }).click();
    await expect(page).toHaveURL(`${backend.origin}/`);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'saved before Back',
    );
  });
  for (const context of ['record', 'tab', 'device', 'filter'] as const)
    test(`Save, Discard and Cancel guard the ${context} context`, async ({ page }) => {
      for (const decision of ['Скасувати', 'Відкинути', 'Зберегти']) {
        await serverSave('confirmed');
        const player = await open(page);
        await ready(player);
        await player.evaluate((element) => element.play());
        await playing(player);
        const old = await remember(player);
        const original = page.url();
        const draft = `${context}:${decision}`;
        await field(page).fill(draft);
        if (context === 'record') await page.locator(`[data-audio-id="${second.id}"]`).click();
        if (context === 'tab') await page.getByRole('tab', { name: 'Файли', exact: true }).click();
        if (context === 'filter') await toggleAudioFilter(page);
        if (context === 'device') {
          await page.evaluate((id) => {
            const link = document.createElement('a');
            link.href = `/devices/${id}`;
            link.textContent = 'Guard device link';
            document.body.appendChild(link);
          }, otherDevice.id);
          await page.getByRole('link', { name: 'Guard device link', exact: true }).click();
        }
        await expect(leave(page)).toBeVisible();
        expect(page.url()).toBe(original);
        await leave(page).getByRole('button', { name: decision, exact: true }).click();
        await expect(leave(page)).toHaveCount(0);
        expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
          decision === 'Зберегти' ? draft : 'confirmed',
        );
        if (decision === 'Скасувати') {
          expect(page.url()).toBe(original);
          await expect(field(page)).toHaveValue(draft);
          expect(
            await old.evaluate((element) => element.isConnected && !element.audio.paused),
          ).toBe(true);
          await expect(page.locator(`[data-audio-id="${first.id}"]`)).toHaveAttribute(
            'aria-pressed',
            'true',
          );
          await expect(page.getByRole('tab', { name: 'Аудіо', exact: true })).toHaveAttribute(
            'aria-selected',
            'true',
          );
          await expectAudioFilter(page, false);
          await field(page).fill('confirmed');
        } else {
          if (context === 'record')
            await expect(page.locator(`[data-audio-id="${second.id}"]`)).toHaveAttribute(
              'aria-pressed',
              'true',
            );
          if (context === 'tab')
            await expect(page.getByRole('tab', { name: 'Файли', exact: true })).toHaveAttribute(
              'aria-selected',
              'true',
            );
          if (context === 'device')
            await expect(page).toHaveURL(new RegExp(`/devices/${otherDevice.id}$`));
          if (context === 'filter') await expectAudioFilter(page, true);
          else
            expect(
              await old.evaluate(
                (element) => element.audio.paused && !element.audio.getAttribute('src'),
              ),
            ).toBe(true);
        }
        await old.dispose();
      }
    });
  test('browser close warns and reopening restores only the saved transcription', async ({
    browser,
  }) => {
    await serverSave('saved before close');
    const context = await browser.newContext({ storageState: await backend.reader.storageState() });
    const page = await context.newPage();
    try {
      await open(page);
      await field(page).fill('local only');
      const cancelled = page.waitForEvent('dialog');
      await page.close({ runBeforeUnload: true });
      const prompt = await cancelled;
      expect(prompt.type()).toBe('beforeunload');
      await prompt.dismiss();
      expect(page.isClosed()).toBe(false);
      await expect(field(page)).toHaveValue('local only');
      const approved = page.waitForEvent('dialog');
      const closed = page.waitForEvent('close');
      await page.close({ runBeforeUnload: true });
      await (await approved).accept();
      await closed;
      const reopened = await context.newPage();
      await open(reopened);
      await expect(field(reopened)).toHaveValue('saved before close');
    } finally {
      await context.close();
    }
  });
  test('real role revocation retains a read-only draft and detaches native playback', async ({
    page,
  }) => {
    await serverSave('before revocation');
    const identity = await backend.reader.get('/api/user');
    expect(identity.status()).toBe(200);
    const actor = (await identity.json()) as { id: string; roles: string[] };
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    const old = await remember(player);
    await field(page).fill('retained after revocation');
    try {
      const denied = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/device/audio/detail') && response.status() === 403,
      );
      await audioFixtureSql('main', `UPDATE login SET roles='[]'::jsonb WHERE id='${actor.id}';`);
      await page.getByRole('button', { name: 'Перечитати транскрипцію', exact: true }).click();
      await denied;
      await expect(field(page)).toHaveValue('retained after revocation');
      await expect(field(page)).toHaveAttribute('readonly', '');
      await expect(page.locator('[data-device-audio-player] custom-audio-player')).toHaveCount(0);
      expect(
        await old.evaluate((element) => element.audio.paused && !element.audio.getAttribute('src')),
      ).toBe(true);
    } finally {
      await audioFixtureSql(
        'main',
        `UPDATE login SET roles='${JSON.stringify(actor.roles).replaceAll("'", "''")}'::jsonb WHERE id='${actor.id}';`,
      );
      await old.dispose();
    }
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'before revocation',
    );
  });
  test('Elm SignOut bypasses a pending decision and clears the native source before unload', async ({
    page,
  }) => {
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    await player.evaluate((element) =>
      window.addEventListener(
        'pagehide',
        () =>
          sessionStorage.setItem(
            'audio-elm-logout',
            JSON.stringify({
              paused: element.audio.paused,
              source: element.audio.getAttribute('src'),
            }),
          ),
        { once: true },
      ),
    );
    await field(page).fill('local logout draft');
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await expect(leave(page)).toBeVisible();
    let unloads = 0;
    page.on('dialog', async (dialog) => {
      unloads++;
      await dialog.dismiss();
    });
    await page
      .locator('button')
      .filter({ hasText: /parent-cyber/ })
      .evaluate((element) => element.click());
    await page.locator('a').filter({ hasText: 'Вийти' }).dispatchEvent('click');
    await expect(page).toHaveURL(/\/login/);
    expect(unloads).toBe(0);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('audio-elm-logout')!)),
    ).toEqual({ paused: true, source: null });
    expect(
      (await audioDetail(await backend.login('parent-cyber'), device.id, first.id)).transcription
        .text,
    ).toBe('');
  });
  for (const mode of ['GotUser', 'polling'] as const)
    test(`real Elm ${mode} 401 bypasses the draft warning and stops native playback`, async ({
      page,
    }) => {
      if (mode === 'GotUser')
        await page.route('**/.elm-land/server/main.js*', async (route) => {
          const response = await route.fetch();
          const source = await response.text();
          const ready = 'Interop.onReady({ app, env })';
          expect(source).toContain(ready);
          await route.fulfill({
            response,
            body: source.replace(
              ready,
              `${ready}; window.__deviceAudioLocationPort = app.ports.shared_getLocationRes`,
            ),
          });
        });
      const player = await open(page);
      const retained = mode === 'GotUser' ? await remember(player) : null;
      await ready(player);
      await player.evaluate((element) => element.play());
      await playing(player);
      await player.evaluate((element) =>
        window.addEventListener(
          'pagehide',
          () =>
            sessionStorage.setItem(
              'audio-elm-401',
              JSON.stringify({
                paused: element.audio.paused,
                source: element.audio.getAttribute('src'),
              }),
            ),
          { once: true },
        ),
      );
      await field(page).fill('expired Elm session draft');
      let unloads = 0;
      page.on('dialog', async (dialog) => {
        unloads++;
        await dialog.dismiss();
      });
      const unauthorized = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname ===
            (mode === 'GotUser' ? '/api/user' : '/api/event-stream/long-poll') &&
          response.status() === 401,
        { timeout: 75_000 },
      );
      if (mode === 'polling') {
        // Exercise the Elm 401 path before ASR polling can redirect the page.
        await page.route('**/api/device/audio/transcription/status', (route) => route.abort());
        await page.route('**/api/event-stream/long-poll', async (route) => {
          const response = await route.fetch({
            headers: { ...route.request().headers(), cookie: '' },
          });
          expect(response.status()).toBe(401);
          await route.fulfill({ response });
        });
      }
      await page.context().clearCookies();
      if (mode === 'GotUser')
        await page.evaluate(() => {
          const loc = window.location;
          (
            window as unknown as { __deviceAudioLocationPort: { send: (value: unknown) => void } }
          ).__deviceAudioLocationPort.send({
            host: loc.host,
            hostname: loc.hostname,
            href: loc.href,
            origin: loc.origin,
            pathname: loc.pathname,
            port_: loc.port,
            protocol: loc.protocol,
            search: loc.search,
            hash: loc.hash,
          });
        });
      await unauthorized;
      await expect(page).toHaveURL(/\/login/);
      expect(unloads).toBe(0);
      if (retained) {
        expect(
          await retained.evaluate((element) => ({
            paused: element.audio.paused,
            source: element.audio.getAttribute('src'),
          })),
        ).toEqual({ paused: true, source: null });
        await retained.dispose();
      } else {
        await expect
          .poll(() =>
            page
              .evaluate(() => JSON.parse(sessionStorage.getItem('audio-elm-401')!))
              .catch(() => null),
          )
          .toEqual({ paused: true, source: null });
      }
      expect(
        (await audioDetail(await backend.login('parent-cyber'), device.id, first.id)).transcription
          .text,
      ).toBe('');
    });
  test('processed text stays editable; archive rejects the write and retains a read-only draft', async ({
    page,
  }) => {
    await audioFixtureSql(
      'files',
      `UPDATE device_audio SET processed=true WHERE id='${first.id}';`,
    );
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    await save(page, 'processed edit');
    expect((await audioDetail(backend.reader, device.id, first.id)).audio.processed).toBe(true);
    await field(page).fill('retain after archive');
    await audioFixtureSql(
      'main',
      `UPDATE device SET archived=true, archived_at=now() WHERE id='${device.id}';`,
    );
    const denied = page.waitForResponse(
      (response) => response.url().endsWith(savePath) && response.status() === 403,
    );
    await clickSave(page);
    await denied;
    await expect(field(page)).toHaveValue('retain after archive');
    await expect(field(page)).toHaveAttribute('readonly', '');
    expect((await nativeState(player)).paused).toBe(false);
    expect((await nativeState(player)).source).toContain(first.id);
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe(
      'processed edit',
    );
  });
  test('mandatory real 401 bypasses the dirty dialog and stops playback before leaving', async ({
    page,
  }) => {
    const player = await open(page);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    await field(page).fill('unsaved session');
    await player.evaluate((element) =>
      window.addEventListener(
        'pagehide',
        () =>
          sessionStorage.setItem(
            'audio-react-401',
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
    await clickSave(page);
    await expect(page).toHaveURL(/\/login/);
    expect(unloads).toBe(0);
    expect(
      await page.evaluate(() => JSON.parse(sessionStorage.getItem('audio-react-401')!)),
    ).toEqual({ paused: true, source: null });
    expect((await audioDetail(backend.reader, device.id, first.id)).transcription.text).toBe('');
  });
});

test('@regression device ASR completes before opening and preserves manual fallback and viewer rights', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    backend.reader = await backend.login('parent-cyber');
    const device = await backend.createDevice();
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    const old = await receiveAudio(
      backend.source,
      device.id,
      'old-empty.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await audioFixtureSql(
      'files',
      `UPDATE device_audio SET automatic_transcription_pending=NULL WHERE id='${old.id}';`,
    );
    const before = await audioAsrFixture();
    await audioAsrFixture({ mode: 'delayed', delay_seconds: 1 });
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=true WHERE deleted=false;',
    );
    const fresh = await receiveAudio(
      backend.source,
      device.id,
      'fresh-auto.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    const initial = await audioDetail(backend.reader, device.id, fresh.id);
    const competing = await Promise.all(
      ['second.wav', 'third.wav'].map((name) =>
        receiveAudio(backend.source, device.id, name, '2020-01-01T00:00:00Z', toneWav(1)),
      ),
    );
    for (const audio of competing)
      await expect
        .poll(
          async () =>
            (await audioDetail(backend.reader, device.id, audio.id)).automaticTranscription.state,
          { timeout: 30_000 },
        )
        .toBe('succeeded');
    await expect
      .poll(
        async () =>
          (await audioDetail(backend.reader, device.id, fresh.id)).automaticTranscription.text,
        { timeout: 30_000 },
      )
      .toBe('Автоматична транскрипція');
    const completed = await audioDetail(backend.reader, device.id, fresh.id);
    expect(completed.transcription).toEqual(initial.transcription);
    expect(completed.audio.processingVersion).toBe(initial.audio.processingVersion);
    const unchanged = await post<DeviceAudioTranscriptionStatusRsp>(
      backend.reader,
      '/api/device/audio/transcription/status',
      {
        deviceId: device.id,
        audioId: fresh.id,
        knownVersion: completed.automaticTranscription.version,
      },
    );
    expect(unchanged.snapshot).toBeNull();
    expect(unchanged.availability.canEditManual).toBe(true);
    const after = await audioAsrFixture();
    expect(after.inferences - before.inferences).toBe(3);
    expect(after.max_active).toBe(1);
    await removeAudioFixtureCache();
    expect((await audioDetail(backend.reader, device.id, fresh.id)).automaticTranscription).toEqual(
      completed.automaticTranscription,
    );
    expect(
      (await audioDetail(backend.reader, device.id, old.id)).automaticTranscription.state,
    ).toBe('not_requested');
    const context = await browser.newContext({ storageState: await backend.reader.storageState() });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(page, fresh.id);
    await expect(field(page)).toHaveValue('Автоматична транскрипція');
    await expect(
      page.getByRole('button', { name: 'Зберегти транскрипцію', exact: true }),
    ).toBeDisabled();
    await save(page, 'Виправлений текст');
    await field(page).fill('Незбережена правка');
    await page.getByRole('button', { name: 'Автоматична', exact: true }).click();
    const auto = page.getByRole('textbox', { name: 'Автоматична транскрипція', exact: true });
    await expect(auto).toHaveValue('Автоматична транскрипція');
    await expect(auto).toHaveAttribute('readonly', '');
    await page.getByRole('button', { name: 'Ручна', exact: true }).click();
    await expect(field(page)).toHaveValue('Незбережена правка');
    await page.getByRole('button', { name: 'Автоматична', exact: true }).click();
    const manual = (await audioDetail(backend.reader, device.id, fresh.id)).transcription;
    await post<SaveDeviceAudioTranscriptionRsp>(backend.reader, savePath, {
      deviceId: device.id,
      audioId: fresh.id,
      text: '',
      expectedTextVersion: manual.textVersion,
    });
    await page.getByRole('button', { name: 'Перечитати транскрипцію', exact: true }).click();
    await page
      .getByRole('dialog', { name: 'Транскрипцію змінено' })
      .getByRole('button', { name: 'Залишити мою чернетку', exact: true })
      .click();
    await expect(field(page)).toHaveValue('Незбережена правка');
    await expect(field(page)).not.toHaveAttribute('readonly', '');
    await clickSave(page);
    await expect(page.locator('[data-device-audio-editor]')).toContainText('Актуальний текст');
    expect(
      (await audioDetail(backend.reader, device.id, fresh.id)).automaticTranscription.text,
    ).toBe('Автоматична транскрипція');
    await field(page).fill('');
    await clickSave(page);
    await expect(field(page)).toHaveValue('Автоматична транскрипція');
    expect((await audioDetail(backend.reader, device.id, fresh.id)).transcription.text).toBe('');
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    await selectAudio(page, old.id);
    await expect(field(page)).toHaveValue('');
    await save(page, 'Лише ручна');
    expect(
      (await audioDetail(backend.reader, device.id, old.id)).automaticTranscription.text,
    ).toBeNull();
    const viewer = await backend.login('parent-cyberviewer');
    expect((await audioDetail(viewer, device.id, fresh.id)).canEdit).toBe(false);
    const viewerContext = await browser.newContext({ storageState: await viewer.storageState() });
    contexts.push(viewerContext);
    const viewerPage = await viewerContext.newPage();
    await viewerPage.goto(`/devices/${device.id}`);
    await viewerPage.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(viewerPage, fresh.id);
    await expect(field(viewerPage)).toHaveAttribute('readonly', '');
    expect(
      (await audioDetail(backend.reader, device.id, fresh.id)).automaticTranscription.text,
    ).toBe('Автоматична транскрипція');
  } finally {
    await audioAsrFixture({ mode: 'success' });
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    for (const context of contexts) await context.close();
    await backend.dispose();
  }
});

test('@regression device ASR interactive cached historical admission coalesces ten opens and updates a playing dirty editor', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    backend.reader = await backend.login('parent-cyber');
    const device = await backend.createDevice();
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    const old = await receiveAudio(
      backend.source,
      device.id,
      'historical-cached.wav',
      '2020-01-01T00:00:00Z',
      toneWav(30),
    );
    const clean = await receiveAudio(
      backend.source,
      device.id,
      'historical-clean.wav',
      '2020-01-02T00:00:00Z',
      toneWav(25),
    );
    for (const audio of [old, clean]) {
      await expect
        .poll(
          async () =>
            (
              await post<DeviceAudioPreparation>(
                backend.reader,
                '/api/device/audio/playback/prepare',
                { deviceId: device.id, audioId: audio.id, retry: false },
              )
            ).spectrogram,
        )
        .toBe('ready');
      await audioFixtureSql(
        'files',
        `UPDATE device_audio SET automatic_transcription_pending=NULL WHERE id='${audio.id}';`,
      );
    }
    const initial = await audioDetail(backend.reader, device.id, old.id);
    const before = await audioAsrFixture();
    await audioAsrFixture({ mode: 'delayed', delay_seconds: 10 });
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=true WHERE deleted=false;',
    );
    await Promise.all(
      Array.from({ length: 10 }, () =>
        post(backend.reader, '/api/device/audio/playback/prepare', {
          deviceId: device.id,
          audioId: old.id,
          retry: false,
        }),
      ),
    );
    const context = await browser.newContext({
      storageState: await backend.reader.storageState(),
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    const player = await selectAudio(page, old.id);
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    const retained = await remember(player);
    const native = await rememberNativeAudio(player);
    const position = (await nativeState(player)).time;
    await field(page).fill('Моя незбережена чернетка');
    await expect(page.getByText('Автоматична транскрипція доступна', { exact: true })).toBeVisible({
      timeout: 20_000,
    });
    const renderedAt = Date.now();
    const writtenAt = Number(
      await audioFixtureSql(
        'files',
        `SELECT floor(extract(epoch FROM automatic_transcribed_at)*1000) FROM device_audio WHERE id='${old.id}';`,
      ),
    );
    const delayBound = renderedAt - writtenAt;
    expect(delayBound).toBeGreaterThanOrEqual(0);
    expect(delayBound).toBeLessThanOrEqual(5000);
    await expect(field(page)).toHaveValue('Моя незбережена чернетка');
    expect(await retained.evaluate((element) => element.isConnected)).toBe(true);
    expect(await player.evaluate((element, previous) => element.audio === previous, native)).toBe(
      true,
    );
    expect((await nativeState(player)).paused).toBe(false);
    expect((await nativeState(player)).time).toBeGreaterThan(position);
    const current = await audioDetail(backend.reader, device.id, old.id);
    expect(current.transcription).toEqual(initial.transcription);
    expect(current.audio.processingVersion).toBe(initial.audio.processingVersion);
    expect((await audioAsrFixture()).inferences - before.inferences).toBe(1);
    console.log(
      JSON.stringify({
        scenario: 'historical-cached-ten-open',
        dispatches: 1,
        maxActive: (await audioAsrFixture()).max_active,
        databaseWriteToRenderUpperBoundMs: delayBound,
      }),
    );
    await save(page, 'Виправлено вручну');
    await audioAsrFixture({ mode: 'delayed', delay_seconds: 3 });
    await selectAudio(page, clean.id);
    await expect(field(page)).toHaveValue('Автоматична транскрипція', { timeout: 15_000 });
    expect((await audioDetail(backend.reader, device.id, clean.id)).transcription.text).toBe('');
    expect((await audioAsrFixture()).inferences - before.inferences).toBe(2);
    let statusRequests = 0;
    page.on('request', (request) => {
      if (request.url().endsWith('/api/device/audio/transcription/status')) statusRequests += 1;
    });
    await page.getByRole('button', { name: 'Позначити обробленим', exact: true }).click();
    await expect(page.locator('[data-device-audio-processing]')).toContainText('Статус: Оброблене');
    await toggleAudioFilter(page);
    await expect(page.locator('[data-device-audio-player] custom-audio-player')).toHaveCount(0);
    const stoppedAt = statusRequests;
    await page.waitForTimeout(2200);
    expect(statusRequests).toBe(stoppedAt);
  } finally {
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    await audioAsrFixture({ mode: 'success' });
    for (const context of contexts) await context.close();
    await backend.dispose();
  }
});

test('@regression device ASR interactive viewer retry observes cross-session terminal changes without media restart', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  const contexts: Awaited<ReturnType<typeof browser.newContext>>[] = [];
  try {
    const device = await backend.createDevice();
    await audioAsrFixture({ mode: 'no_speech' });
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=true WHERE deleted=false;',
    );
    const audio = await receiveAudio(
      backend.source,
      device.id,
      'no-speech-retry.wav',
      '2020-01-01T00:00:00Z',
      toneWav(30),
    );
    await expect
      .poll(
        async () =>
          (await audioDetail(backend.reader, device.id, audio.id)).automaticTranscription.state,
        { timeout: 30_000 },
      )
      .toBe('no_speech');
    const before = await audioAsrFixture();
    const firstGeneration = await audioFixtureSql(
      'main',
      `SELECT queue.reprocess_count FROM echo_gpu_transcription_queue queue JOIN transcription_source source ON source.id=queue.source_id WHERE source.source_key='${(await audioFixtureSql('files', `SELECT storage_key FROM device_audio WHERE id='${audio.id}';`)).trim()}';`,
    );
    const otherSession = await backend.login('parent-admin');
    const otherContext = await browser.newContext({
      storageState: await otherSession.storageState(),
    });
    contexts.push(otherContext);
    const otherPage = await otherContext.newPage();
    await otherPage.goto(`/devices/${device.id}`);
    await otherPage.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(otherPage, audio.id);
    await expect(otherPage.locator('[data-device-audio-asr-status]')).toHaveText(
      'Мовлення не виявлено',
    );
    const context = await browser.newContext({
      storageState: await backend.reader.storageState(),
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    const player = await selectAudio(page, audio.id);
    await expect(page.locator('[data-device-audio-asr-status]')).toHaveText('Мовлення не виявлено');
    await expect(field(page)).toHaveAttribute('readonly', '');
    await ready(player);
    await player.evaluate((element) => element.play());
    await playing(player);
    const retained = await remember(player);
    const native = await rememberNativeAudio(player);
    await post(backend.reader, '/api/device/audio/playback/prepare', {
      deviceId: device.id,
      audioId: audio.id,
      retry: true,
    });
    expect(
      await audioFixtureSql(
        'main',
        `SELECT queue.reprocess_count FROM echo_gpu_transcription_queue queue JOIN transcription_source source ON source.id=queue.source_id WHERE source.source_key='${(await audioFixtureSql('files', `SELECT storage_key FROM device_audio WHERE id='${audio.id}';`)).trim()}';`,
      ),
    ).toBe(firstGeneration);
    expect((await audioAsrFixture()).inferences).toBe(before.inferences);
    await audioAsrFixture({ mode: 'delayed', delay_seconds: 3 });
    await page.getByRole('button', { name: 'Повторити транскрибацію', exact: true }).click();
    const simultaneous = await Promise.all(
      Array.from({ length: 10 }, () =>
        post<RetryDeviceAudioTranscriptionRsp>(
          backend.reader,
          '/api/device/audio/transcription/retry',
          {
            deviceId: device.id,
            audioId: audio.id,
          },
        ),
      ),
    );
    expect(
      simultaneous.every((response) =>
        ['already_active', 'already_completed'].includes(response.disposition),
      ),
    ).toBe(true);
    await expect(field(page)).toHaveValue('Автоматична транскрипція', { timeout: 15_000 });
    expect(await retained.evaluate((element) => element.isConnected)).toBe(true);
    expect(await player.evaluate((element, previous) => element.audio === previous, native)).toBe(
      true,
    );
    expect((await nativeState(player)).paused).toBe(false);
    expect((await audioAsrFixture()).inferences - before.inferences).toBe(1);
    await otherPage.reload();
    await otherPage.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(otherPage, audio.id);
    await expect(field(otherPage)).toHaveValue('Автоматична транскрипція');
    console.log(
      JSON.stringify({
        scenario: 'viewer-no-speech-explicit-retry',
        dispatches: 1,
        concurrentRetries: 10,
        maxActive: (await audioAsrFixture()).max_active,
      }),
    );
  } finally {
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    await audioAsrFixture({ mode: 'success' });
    for (const context of contexts) await context.close();
    await backend.dispose();
  }
});

test('@regression device ASR lost response recovers through the native queue without operator recovery', async ({
  browser,
}) => {
  test.setTimeout(90_000);
  const backend = await localAudioBackend();
  const context = await browser.newContext({ storageState: await backend.reader.storageState() });
  try {
    const device = await backend.createDevice();
    await audioAsrFixture({ mode: 'lost_response', delay_seconds: 1 });
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=true WHERE deleted=false;',
    );
    const audio = await receiveAudio(
      backend.source,
      device.id,
      'lost.wav',
      '2020-01-01T00:00:00Z',
      toneWav(15),
    );
    await expect
      .poll(
        async () =>
          (await audioDetail(backend.reader, device.id, audio.id)).automaticTranscription.state,
        { timeout: 20_000 },
      )
      .toBe('retry_wait');
    const page = await context.newPage();
    await page.goto(`/devices/${device.id}`);
    await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
    await selectAudio(page, audio.id);
    await expect(
      page.getByRole('button', { name: 'Повторити транскрибацію', exact: true }),
    ).toHaveCount(0);
    await audioAsrFixture({ mode: 'success' });
    await expect(field(page)).toHaveValue('Автоматична транскрипція', { timeout: 30_000 });
    expect(
      (await audioDetail(backend.reader, device.id, audio.id)).automaticTranscription.state,
    ).toBe('succeeded');
  } finally {
    await audioFixtureSql(
      'main',
      'UPDATE system_settings SET enable_audio_transcription=false WHERE deleted=false;',
    );
    await audioAsrFixture({ mode: 'success' });
    await context.close();
    await backend.dispose();
  }
});
