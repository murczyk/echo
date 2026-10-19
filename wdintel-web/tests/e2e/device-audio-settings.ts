import { expect, test, type Page } from '@playwright/test';
import type { DeviceAudioAsrSettingsRsp } from '../../src/Bindings';
import {
  audioAsrFixture,
  audioDetail,
  audioFixtureSql,
  localAudioBackend,
  post,
  receiveAudio,
} from './device-audio-backend';
import { selectAudio, toneWav } from './device-audio-player';

const settingsPath = '/api/device/audio/settings';
const checkbox = (page: Page) =>
  page.getByRole('menuitemcheckbox', { name: /Автотранскрибація аудіо/ });
async function openSettings(page: Page, deviceId: string) {
  await page.goto(`/devices/${deviceId}`);
  await page.getByRole('tab', { name: 'Аудіо', exact: true }).click();
  await page.getByRole('button', { name: 'Налаштування списку аудіо', exact: true }).click();
  await expect(checkbox(page)).toBeVisible();
  await expect(checkbox(page)).not.toContainText('Завантаження');
}
async function globalEnabled(enabled: boolean) {
  await audioFixtureSql(
    'main',
    `UPDATE system_settings SET enable_audio_transcription=${enabled} WHERE deleted=false;`,
  );
}

for (const mobile of [false, true]) {
  test(`@regression device ASR settings ${mobile ? 'mobile' : 'desktop'} checkbox persists across sessions and isolates devices`, async ({
    browser,
  }) => {
    const backend = await localAudioBackend();
    const context = await browser.newContext({
      storageState: await (await backend.login('parent-cyber')).storageState(),
      viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    });
    const second = await browser.newContext({
      storageState: await (await backend.login('parent-admin')).storageState(),
    });
    try {
      await globalEnabled(false);
      const device = await backend.createDevice();
      const other = await backend.createDevice();
      const page = await context.newPage();
      await openSettings(page, device.id);
      await expect(checkbox(page)).toHaveAttribute('aria-checked', 'true');
      await expect(checkbox(page)).toContainText('Сервіс транскрибації вимкнено');
      await expect(checkbox(page)).toBeEnabled();
      const filenameBefore = await page.evaluate(() =>
        localStorage.getItem('device-audio.show-recording-start'),
      );
      await checkbox(page).click();
      await expect(checkbox(page)).toHaveAttribute('aria-checked', 'false');
      expect(
        await page.evaluate(() => localStorage.getItem('device-audio.show-recording-start')),
      ).toBe(filenameBefore);
      await page
        .getByRole('menuitemcheckbox', { name: 'Показувати дату й час початку', exact: true })
        .click();
      expect(
        await page.evaluate(() => localStorage.getItem('device-audio.show-recording-start')),
      ).toBe('true');
      const another = await second.newPage();
      await openSettings(another, device.id);
      await expect(checkbox(another)).toHaveAttribute('aria-checked', 'false');
      await checkbox(another).click();
      await expect(checkbox(another)).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
      await expect(checkbox(page)).toBeHidden();
      await page.getByRole('button', { name: 'Налаштування списку аудіо', exact: true }).click();
      await expect(checkbox(page)).toHaveAttribute('aria-checked', 'true');
      await expect(
        page.getByRole('menuitemcheckbox', { name: 'Показувати дату й час початку', exact: true }),
      ).toHaveAttribute('aria-checked', 'true');
      expect(
        (
          await post<DeviceAudioAsrSettingsRsp>(backend.reader, settingsPath, {
            deviceId: other.id,
          })
        ).enabled,
      ).toBe(true);
    } finally {
      await context.close();
      await second.close();
      await backend.dispose();
    }
  });
}

test('@regression device ASR settings reconciles lost acknowledgement and enforces viewer archive access', async ({
  browser,
}) => {
  const backend = await localAudioBackend();
  const editor = await backend.login('parent-cyber');
  const context = await browser.newContext({ storageState: await editor.storageState() });
  const readerContext = await browser.newContext({
    storageState: await backend.reader.storageState(),
  });
  try {
    await globalEnabled(false);
    const device = await backend.createDevice();
    const page = await context.newPage();
    await openSettings(page, device.id);
    await page.route(`**${settingsPath}/set`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await route.abort();
    });
    await checkbox(page).click();
    await expect(checkbox(page)).toHaveAttribute('aria-checked', 'false');
    await expect(checkbox(page)).toBeEnabled();
    await expect(page.getByText(/Помилка налаштувань аудіо/)).toBeVisible();
    expect(
      (await post<DeviceAudioAsrSettingsRsp>(editor, settingsPath, { deviceId: device.id }))
        .enabled,
    ).toBe(false);
    const viewer = await readerContext.newPage();
    await openSettings(viewer, device.id);
    await expect(checkbox(viewer)).toBeDisabled();
    await expect(checkbox(viewer)).toContainText('Недостатньо прав');
    expect(
      (
        await backend.reader.post(`${settingsPath}/set`, {
          data: { device_id: device.id, enabled: true },
        })
      ).status(),
    ).toBe(403);
    await audioFixtureSql(
      'main',
      `UPDATE device SET archived=true, archived_at=now() WHERE id='${device.id}';`,
    );
    await page.unroute(`**${settingsPath}/set`);
    await openSettings(page, device.id);
    await expect(checkbox(page)).toBeDisabled();
    await expect(checkbox(page)).toContainText('Пристрій архівовано');
    expect(
      (
        await editor.post(`${settingsPath}/set`, { data: { device_id: device.id, enabled: true } })
      ).status(),
    ).toBe(403);
  } finally {
    await context.close();
    await readerContext.close();
    await backend.dispose();
  }
});

test('@regression device ASR settings disable prevents new admission while accepted work finishes while archive cancels publication', async ({
  browser,
}) => {
  test.setTimeout(120_000);
  const backend = await localAudioBackend();
  const editor = await backend.login('parent-cyber');
  const context = await browser.newContext({ storageState: await editor.storageState() });
  try {
    await globalEnabled(false);
    const device = await backend.createDevice();
    const archivedDevice = await backend.createDevice();
    const old = await receiveAudio(
      backend.source,
      device.id,
      'historical.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await audioFixtureSql(
      'files',
      `UPDATE device_audio SET automatic_transcription_pending=NULL WHERE id='${old.id}';`,
    );
    const page = await context.newPage();
    await openSettings(page, device.id);
    await audioAsrFixture({ mode: 'delayed', delay_seconds: 10 });
    const before = await audioAsrFixture();
    await globalEnabled(true);
    const running = await receiveAudio(
      backend.source,
      device.id,
      'running.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await expect.poll(async () => (await audioAsrFixture()).active, { timeout: 15_000 }).toBe(1);
    const original = await audioDetail(editor, device.id, running.id);
    const queued = await receiveAudio(
      backend.source,
      device.id,
      'queued.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await expect(checkbox(page)).toBeEnabled();
    await checkbox(page).click();
    await expect(checkbox(page)).toHaveAttribute('aria-checked', 'false');
    await checkbox(page).press('Escape');
    await expect(checkbox(page)).toBeHidden();
    const disabled = await receiveAudio(
      backend.source,
      device.id,
      'disabled.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await selectAudio(page, old.id);
    await expect
      .poll(
        async () => (await audioDetail(editor, device.id, running.id)).automaticTranscription.state,
        { timeout: 20_000 },
      )
      .toBe('succeeded');
    const finished = await audioDetail(editor, device.id, running.id);
    expect(finished.transcription).toEqual(original.transcription);
    expect(finished.audio.processingVersion).toBe(original.audio.processingVersion);
    await expect(page.locator('[data-device-audio-editor]')).toContainText(
      'Автотранскрибацію пристрою вимкнено',
    );
    await page.waitForTimeout(2500);
    await expect
      .poll(
        async () => (await audioDetail(editor, device.id, queued.id)).automaticTranscription.state,
        { timeout: 20_000 },
      )
      .toBe('succeeded');
    expect((await audioAsrFixture()).inferences - before.inferences).toBe(2);
    for (const audio of [old, disabled])
      expect(
        (await audioDetail(editor, device.id, audio.id)).automaticTranscription.text,
      ).toBeNull();
    const willArchive = await receiveAudio(
      backend.source,
      archivedDevice.id,
      'archive-running.wav',
      '2020-01-01T00:00:00Z',
      toneWav(1),
    );
    await expect.poll(async () => (await audioAsrFixture()).active, { timeout: 15_000 }).toBe(1);
    await audioFixtureSql(
      'main',
      `UPDATE device SET archived=true, archived_at=now() WHERE id='${archivedDevice.id}';`,
    );
    await expect
      .poll(
        async () =>
          (await audioDetail(editor, archivedDevice.id, willArchive.id)).automaticTranscription
            .state,
        { timeout: 20_000 },
      )
      .toBe('cancelled');
    expect(
      (await audioDetail(editor, archivedDevice.id, willArchive.id)).automaticTranscription.text,
    ).toBeNull();
    const after = await audioAsrFixture();
    expect(after.inferences - before.inferences).toBe(3);
    console.log(
      JSON.stringify({
        scenario: 'settings-disable-and-archive',
        disabledAdditionalDispatches: 0,
        runningResultSaved: true,
        archivedPublications: 0,
        maxActive: after.max_active,
      }),
    );
  } finally {
    await globalEnabled(false);
    await context.close();
    await backend.dispose();
  }
});
