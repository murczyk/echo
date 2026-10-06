import { expect, test, type Page } from '@playwright/test';
import {
  audioDetail,
  audioFixtureSql,
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
import type { DeviceAudio, SaveDeviceAudioTranscriptionRsp } from '../../src/Bindings';

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
    backend.reader = await backend.login('parent-cyberviewer');
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
      storageState: await (await backend.login('parent-cyber')).storageState(),
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
      storageState: await backend.reader.storageState(),
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
      await page.getByRole('button', { name: /parent-cyberviewer/ }).click();
      await page.getByRole('link', { name: /Налаштування/ }).click();
      await expect(leave(page)).toBeVisible();
      await leave(page).getByRole('button', { name: 'Скасувати', exact: true }).click();
      expect(page.url()).toBe(original);
      await page.waitForTimeout(410);
      await page.getByRole('button', { name: /parent-cyberviewer/ }).click();
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
    await page.getByRole('link', { name: 'Echo Flying Skull' }).click();
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
    await page.getByRole('link', { name: 'Echo Flying Skull' }).click();
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
      await audioFixtureSql('main', `UPDATE login SET roles='[]'::jsonb WHERE id='${actor.id}';`);
      const denied = page.waitForResponse(
        (response) => response.url().endsWith(savePath) && response.status() === 403,
      );
      await clickSave(page);
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
      .filter({ hasText: /parent-cyberviewer/ })
      .evaluate((element) => element.click());
    await page
      .locator('a')
      .filter({ hasText: 'Вийти' })
      .evaluate((element) => element.click());
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
      const player = await open(page);
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
      if (mode === 'polling')
        await page.route('**/api/event-stream/long-poll', async (route) => {
          const response = await route.fetch({
            headers: { ...route.request().headers(), cookie: '' },
          });
          expect(response.status()).toBe(401);
          await route.fulfill({ response });
        });
      await page.context().clearCookies();
      if (mode === 'GotUser')
        await page.evaluate(async () => {
          const { requestNavigation } = await import('/src/ts/browser/navigation-guard.ts');
          await requestNavigation(`${location.pathname}?reauth=1`);
        });
      await unauthorized;
      await expect(page).toHaveURL(/\/login/);
      expect(unloads).toBe(0);
      expect(
        await page.evaluate(() => JSON.parse(sessionStorage.getItem('audio-elm-401')!)),
      ).toEqual({ paused: true, source: null });
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
