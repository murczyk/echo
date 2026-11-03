import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import {
  localFilePreviewBackend,
  previewPost,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import { DEVICE_FILE_PREVIEW_FIXTURES } from './device-file-preview.fixtures';
import { transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import { zipSync, strToU8 } from 'fflate';
import {
  ensureDeviceFilePreviewFixture,
  openDeviceFilePreview,
  observeNativeDownload,
  type FilePreviewBackend,
} from './device-file-preview.ui';
import type { ListLoginsRsp, UpdateLoginReq, DeviceArchiveStatus } from '../../src/Bindings';

test('@regression metadata-only source never requests bytes and disables download', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    await ensureDeviceFilePreviewFixture(backend, 'missing-content');
    const byteRequests: string[] = [];
    page.on('request', (request) => {
      if (/\/content$|\/preview\//.test(new URL(request.url()).pathname)) {
        byteRequests.push(request.url());
      }
    });
    const { pane } = await openDeviceFilePreview(page, backend, 'missing-content');
    await expect(pane).toContainText('Вміст цього файлу ще не завантажено в Echo.');
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    expect(byteRequests).toEqual([]);
  } finally {
    await backend.dispose();
  }
});

for (const id of [
  'empty-text',
  'unsupported-binary',
  'corrupt-pdf',
  'oversized-text',
  'oversized-document',
  'oversized-zip',
  'password-zip',
]) {
  test(`@regression readable original remains available for ${id}`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      await ensureDeviceFilePreviewFixture(backend, id);
      if (id === 'oversized-text' || id === 'oversized-document') {
        // PR #3830: probe the 1 GB boundary with bounded original bytes.
        const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === id)!;
        await page.route(`**${entry.originalHref}`, async (route) => {
          if (route.request().method() !== 'HEAD') return route.continue();
          const response = await route.fetch();
          await route.fulfill({
            response,
            headers: { ...response.headers(), 'content-length': '1000000001' },
            body: '',
          });
        });
      }
      const { pane, entry } = await openDeviceFilePreview(page, backend, id);
      if (id === 'empty-text')
        await expect(
          pane.getByRole('heading', { name: 'Файл порожній', exact: true }),
        ).toBeVisible();
      else if (id === 'unsupported-binary')
        await expect(
          pane.getByRole('heading', { name: 'Перегляд формату BIN не підтримується', exact: true }),
        ).toBeVisible();
      else if (id === 'password-zip') await expect(pane).toContainText(/парол|зашифров/i);
      else if (id === 'oversized-text' || id === 'oversized-document')
        await expect(pane).toContainText('Максимум: 1 ГБ.');
      else if (id === 'oversized-zip') await expect(pane).toContainText(/ліміт|завелик/i);
      else await expect(pane.getByRole('alert').first()).toBeVisible();
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

async function readerAccess(backend: FilePreviewBackend) {
  const admin = await backend.login('admin');
  const users = await previewPost<ListLoginsRsp>(admin, '/api/logins', {
    sortBy: null,
    filterByRoles: null,
  });
  const found = users.users.find((user) => user.id === backend.fixtures.actors.reader.id);
  if (!found?.organismId) throw new Error('Missing owned reader organism');
  const reader = found;
  const organismId = reader.organismId!;
  async function update(roles: string[]) {
    return previewPost(admin, '/api/login/update', {
      id: reader.id,
      login: reader.login,
      roles,
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
  }
  return { update, restore: () => update(reader.roles) };
}

test('#3778 @regression actual role revocation clears open image and blocks download', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  let accessControl: Awaited<ReturnType<typeof readerAccess>> | undefined;
  try {
    accessControl = await readerAccess(backend);
    const { pane } = await openDeviceFilePreview(page, backend, 'image-png');
    await expect(pane.locator('[data-image-preview-image]')).toBeVisible();
    const access = await backend.login('reader');
    const archiveFile = backend.fixtures.seeded.find(
      (entry) => entry.fixtureId === 'archive-zip',
    )!.file;
    const archiveUrl = `/api/device/files/${backend.fixtures.deviceId}/${archiveFile.fileId}/revisions/${archiveFile.revision}/archive`;
    expect((await access.get(archiveUrl)).status()).toBe(200);
    const image = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'image-png')!.file;
    expect(
      (
        await access.get(
          `/api/device/files/${backend.fixtures.deviceId}/${image.fileId}/revisions/${image.revision}/archive`,
        )
      ).status(),
    ).toBe(415);
    await accessControl.update(['Api']);
    expect((await access.get(archiveUrl)).status()).toBe(403);
    expect((await access.post(archiveUrl)).status()).toBe(403);
    expect(
      (
        await access.post('/api/device/files/browse', {
          data: { device_id: backend.fixtures.deviceId, parent_entry_id: archiveFile.fileId },
        })
      ).status(),
    ).toBe(403);
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/content') &&
        response.request().method() === 'HEAD' &&
        response.status() === 403,
    );
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    await denied;
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: /доступ|заборон|forbidden|403/i })
        .last(),
    ).toBeVisible();
    await expect(pane.locator('[data-image-preview-image]')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
  } finally {
    await accessControl?.restore();
    await backend.dispose();
  }
});

test('#3778 @regression actual native download preserves name and bytes with one GET and no saved-success claim', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const backend = await localFilePreviewBackend();
  let observation: Awaited<ReturnType<typeof observeNativeDownload>> | undefined;
  try {
    await ensureDeviceFilePreviewFixture(backend, 'unsupported-binary');
    const { pane, entry, fixture } = await openDeviceFilePreview(
      page,
      backend,
      'unsupported-binary',
    );
    observation = await observeNativeDownload(backend, entry.originalHref);
    const checked = page.waitForResponse(
      (response) =>
        response.url().endsWith(entry.originalHref) && response.request().method() === 'HEAD',
    );
    const saved = page.waitForEvent('download');
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    expect((await checked).status()).toBe(200);
    const download = await saved;
    expect(download.suggestedFilename()).toBe(fixture.fileName);
    expect(
      createHash('sha256')
        .update(await readFile((await download.path())!))
        .digest('hex'),
    ).toBe(entry.sha256);
    const requests = await observation.requests();
    expect(requests).toEqual([
      {
        method: 'GET',
        url: new URL(download.url()).pathname + new URL(download.url()).search,
        status: 200,
      },
    ]);
    expect(new URL(download.url()).pathname).toBe(entry.originalHref);
    expect(new URL(download.url()).search).toBe('');
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
    await expect(page.getByRole('status').filter({ hasText: /збережено|успішно/i })).toHaveCount(0);
  } finally {
    await observation?.dispose();
    await backend.dispose();
  }
});

test('#3778 @regression actual native GET rechecks access revoked after HEAD', async ({ page }) => {
  test.setTimeout(120_000);
  const backend = await localFilePreviewBackend();
  let accessControl: Awaited<ReturnType<typeof readerAccess>> | undefined;
  let observation: Awaited<ReturnType<typeof observeNativeDownload>> | undefined;
  try {
    accessControl = await readerAccess(backend);
    const { pane, entry } = await openDeviceFilePreview(page, backend, 'image-png');
    await expect(pane.locator('[data-image-preview-image]')).toBeVisible();
    observation = await observeNativeDownload(backend, entry.originalHref, true);
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    await expect
      .poll(async () => (await observation!.requests()).length, { timeout: 120_000 })
      .toBe(1);
    await accessControl.update(['Api']);
    await observation.release();
    await expect
      .poll(async () => (await observation!.requests()).map((entry) => entry.status))
      .toEqual([403]);
    await expect(page.getByRole('status').filter({ hasText: /збережено|успішно/i })).toHaveCount(0);
    expect(await observation.requests()).toHaveLength(1);
  } finally {
    await observation?.dispose();
    await accessControl?.restore();
    await backend.dispose();
  }
});

function archiveFailureBytes(kind: string) {
  const bytes = Buffer.from(
    zipSync(
      kind === 'unsafe'
        ? { '../unsafe.txt': strToU8('unsafe') }
        : kind === 'limit'
          ? { 'bounded.txt': new Uint8Array(2 * 1024 * 1024) }
          : { 'public.txt': strToU8('public'), 'secret.txt': strToU8('secret') },
    ),
  );
  let central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  while (bytes.readUInt32LE(central) === 0x02014b50) {
    const nameLength = bytes.readUInt16LE(central + 28);
    const name = bytes.subarray(central + 46, central + 46 + nameLength).toString();
    const local = bytes.readUInt32LE(central + 42);
    if (name === 'secret.txt') {
      if (kind === 'password') {
        bytes.writeUInt16LE(bytes.readUInt16LE(central + 8) | 1, central + 8);
        bytes.writeUInt16LE(bytes.readUInt16LE(local + 6) | 1, local + 6);
      } else if (kind === 'unsupported') {
        bytes.writeUInt16LE(99, central + 10);
        bytes.writeUInt16LE(99, local + 8);
      } else if (kind === 'corrupt') {
        bytes[central + 16] ^= 1;
        bytes[local + 14] ^= 1;
      }
    }
    central +=
      46 + nameLength + bytes.readUInt16LE(central + 30) + bytes.readUInt16LE(central + 32);
  }
  return bytes;
}

async function archiveFailureFixture(page: Page, kind: string, upload = true) {
  const backend = await localFilePreviewBackend();
  try {
    const fixture = {
      ...DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === 'archive-zip')!,
      id: `archive-failure-${kind}-${randomUUID()}`,
      fileName: `echo-${kind}.zip`,
    };
    const source = await backend.login('source');
    const file = await syncPreviewFile(source, backend.fixtures.deviceId!, fixture);
    const bytes = archiveFailureBytes(kind);
    if (upload) await uploadPreviewContent(source, backend.fixtures.deviceId!, file, bytes);
    const reader = await backend.login('reader');
    const url = `/api/device/files/${backend.fixtures.deviceId}/${file.fileId}/revisions/${file.revision}/archive`;
    const status = async () => {
      const response = await reader.get(url);
      expect(response.status()).toBe(200);
      return transformSnakeToCamel<DeviceArchiveStatus>(await response.json());
    };
    const open = async () => {
      await page.context().addCookies((await reader.storageState()).cookies);
      await page.goto(`/devices/${backend.fixtures.deviceId}`, { waitUntil: 'domcontentloaded' });
      await openDeviceSection(page, 'Файли');
      await page.getByRole('button', { name: 'Розгорнути каталог preview', exact: true }).click();
      await page
        .getByRole('button', { name: `Розгорнути каталог ${fixture.id}`, exact: true })
        .click();
      const row = page
        .getByTestId('device-files-tree')
        .getByRole('button', { name: fixture.fileName, exact: true });
      await row.focus();
      await page.keyboard.press('Enter');
      return page.getByTestId('device-file-content-pane');
    };
    return { backend, source, reader, file, fixture, bytes, url, status, open };
  } catch (error) {
    await backend.dispose();
    throw error;
  }
}

for (const [kind, reason, message] of [
  ['password', 'password_protected', 'Архів захищений паролем'],
  ['corrupt', 'integrity_mismatch', 'цілісності'],
  ['unsupported', 'unsupported_format', 'не підтримується'],
  ['unsafe', 'unsafe_path', 'небезпечний шлях'],
  ['limit', 'safety_limit', 'Розпакування зупинено: перевищено ліміти безпеки архіву'],
]) {
  test(`#3778 @regression terminal archive ${kind} keeps the original and never restarts`, async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const fixture = await archiveFailureFixture(page, kind);
    try {
      await expect
        .poll(async () => (await fixture.status()).archive.state, {
          timeout: 60_000,
          intervals: [1000],
        })
        .toBe('failed');
      const terminal = await fixture.status();
      expect(terminal.archive.reason).toBe(reason);
      const pane = await fixture.open();
      await expect(pane).toContainText(message);
      if (kind === 'limit') {
        expect(terminal.archive.limitName).toBe('member_ratio');
        await expect(pane).toContainText('member_ratio');
      }
      await expect(pane.getByRole('button', { name: /Повторити/ })).toHaveCount(0);
      await expect(pane.getByRole('button', { name: 'public.txt', exact: true })).toHaveCount(0);
      expect(
        (
          await fixture.reader.post('/api/device/files/browse', {
            data: {
              device_id: fixture.backend.fixtures.deviceId,
              parent_entry_id: fixture.file.fileId,
              archive_revision: fixture.file.revision,
            },
          })
        ).status(),
      ).toBe(409);
      expect((await fixture.reader.post(fixture.url, { data: {} })).status()).toBe(400);
      for (let repeat = 0; repeat < 2; repeat++) {
        const response = await fixture.reader.post(fixture.url);
        expect(response.status()).toBe(200);
        expect(transformSnakeToCamel<DeviceArchiveStatus>(await response.json())).toEqual(terminal);
      }
      const saved = page.waitForEvent('download');
      await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
      expect(await readFile((await (await saved).path())!)).toEqual(fixture.bytes);
      await fixture.open();
      await expect(page.getByTestId('device-file-content-pane')).toContainText(message);
      expect(await fixture.status()).toEqual(terminal);
    } finally {
      await fixture.backend.dispose();
    }
  });
}

test('#3778 @regression metadata-only ZIP becomes ready after uploading the same revision', async ({
  page,
}) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await archiveFailureFixture(page, 'missing', false);
  try {
    expect((await fixture.status()).archive).toMatchObject({
      state: 'missing_content',
      archiveId: null,
    });
    expect((await fixture.reader.post(fixture.url)).status()).toBe(409);
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes(`/${fixture.file.fileId}/revisions/`))
        requests.push(`${request.method()} ${request.url()}`);
    });
    const pane = await fixture.open();
    await expect(pane).toContainText('Контент файлу відсутній');
    await expect(pane).not.toContainText('Каталог порожній');
    expect(
      requests.some((request) => /\/content$/.test(request) || request.startsWith('POST ')),
    ).toBe(false);
    await uploadPreviewContent(
      fixture.source,
      fixture.backend.fixtures.deviceId!,
      fixture.file,
      fixture.bytes,
    );
    await expect
      .poll(async () => (await fixture.status()).archive.state, {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe('ready');
    await expect(pane.getByRole('button', { name: 'public.txt', exact: true })).toBeVisible({
      timeout: 15_000,
    });
    await expect(pane).not.toContainText('Контент файлу відсутній');
  } finally {
    await fixture.backend.dispose();
  }
});

test('#3778 @regression unavailable status keeps the last known archive and shows a toast', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const fixture = await archiveFailureFixture(page, 'unavailable');
  try {
    await expect
      .poll(async () => (await fixture.status()).archive.state, {
        timeout: 60_000,
        intervals: [1000],
      })
      .toBe('ready');
    await page.route(`**${fixture.url}`, (route) =>
      route.fulfill({
        status: 503,
        headers: { 'Retry-After': '8', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: 'archive_unavailable',
          message: 'Підготовка архівів тимчасово недоступна',
        }),
      }),
    );
    const pane = await fixture.open();
    await expect(pane.getByRole('button', { name: 'public.txt', exact: true })).toBeVisible();
    await expect(page.locator('.MuiSnackbar-root').first()).toContainText('Помилка');
    await page.unroute(`**${fixture.url}`);
    await pane.getByRole('button', { name: 'Повторити читання', exact: true }).click();
    await expect(pane.getByRole('alert')).toHaveCount(0, { timeout: 15_000 });
    expect((await fixture.status()).archive.state).toBe('ready');
  } finally {
    await fixture.backend.dispose();
  }
});
