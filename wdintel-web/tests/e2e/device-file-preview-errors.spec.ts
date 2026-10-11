import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { localFilePreviewBackend, previewPost } from './device-file-preview-backend';
import { ensureDeviceFilePreviewFixture, openDeviceFilePreview } from './device-file-preview.ui';
import type { Login, ListLoginsRsp, UpdateLoginReq } from '../../src/Bindings';

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
      else if (id.startsWith('oversized')) await expect(pane).toContainText(/ліміт|завелик/i);
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

test('@regression actual role revocation clears open image and blocks download', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  const admin = await backend.login('admin');
  let reader: Login | undefined;
  async function update(roles: string[]) {
    if (!reader?.organismId) throw new Error('Missing owned reader organism');
    return previewPost(admin, '/api/login/update', {
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
  }
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'image-png');
    await expect(pane.locator('[data-image-preview-image]')).toBeVisible();
    const users = await previewPost<ListLoginsRsp>(admin, '/api/logins', {
      sortBy: null,
      filterByRoles: null,
    });
    reader = users.users.find((user) => user.id === backend.fixtures.actors.reader.id);
    await update(['Api']);
    const denied = page.waitForResponse(
      (response) =>
        response.url().endsWith('/content') &&
        response.request().method() === 'GET' &&
        response.status() === 403,
    );
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    await denied;
    await expect(pane.locator('[data-image-preview-image]')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
  } finally {
    if (reader) await update(reader.roles);
    await backend.dispose();
  }
});
