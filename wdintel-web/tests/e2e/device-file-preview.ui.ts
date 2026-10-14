import { expect, type Page } from '@playwright/test';
import {
  localFilePreviewBackend,
  previewOriginalHref,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import { writeFile } from 'node:fs/promises';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';

export type FilePreviewBackend = Awaited<ReturnType<typeof localFilePreviewBackend>>;

export async function openDeviceFilePreview(
  page: Page,
  backend: FilePreviewBackend,
  fixtureId: string,
) {
  const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === fixtureId);
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((fixture) => fixture.id === fixtureId);
  if (!entry || !fixture || !backend.fixtures.deviceId)
    throw new Error(`Missing seeded fixture: ${fixtureId}`);
  const reader = await backend.login('reader');
  await page.context().addCookies((await reader.storageState()).cookies);
  await page.goto(`/devices/${backend.fixtures.deviceId}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('tab', { name: 'Файли', exact: true }).click();
  await page
    .getByRole('button', { name: /Вибрати каталог C:/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Показати пошук файлів', exact: true }).click();
  await page.getByRole('textbox', { name: 'Назва містить', exact: true }).fill(fixture.fileName);
  await page.getByRole('button', { name: 'Знайти', exact: true }).click();
  const row = page
    .getByRole('region', { name: 'Результати пошуку файлів' })
    .locator(`[data-entry-id="${entry.file.fileId}"]`);
  await row.getByRole('button', { name: fixture.fileName, exact: true }).click();
  const pane = page.getByTestId('device-file-content-pane');
  await expect(pane.locator('#device-file-content-title')).toContainText(fixture.fileName);
  return { pane, fixture, entry };
}

export async function ensureDeviceFilePreviewFixture(
  backend: FilePreviewBackend,
  fixtureId: string,
) {
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((fixture) => fixture.id === fixtureId);
  if (!fixture || !backend.fixtures.deviceId) throw new Error(`Unavailable fixture ${fixtureId}`);
  const index = backend.fixtures.seeded.findIndex((entry) => entry.fixtureId === fixtureId);
  if (index >= 0 && backend.fixtures.seeded[index].sha256 === fixture.sha256) return;
  const source = await backend.login('source');
  const file = await syncPreviewFile(source, backend.fixtures.deviceId, fixture);
  const receipt =
    fixture.expectedViewer === 'missing' && fixture.availability === 'absent'
      ? {
          originalHref: previewOriginalHref(backend.fixtures.deviceId, file.fileId, file.revision),
          sha256: null,
        }
      : await uploadPreviewContent(
          source,
          backend.fixtures.deviceId,
          file,
          (await loadDeviceFilePreviewFixture(fixtureId)).bytes,
        );
  const entry = { fixtureId, file, ...receipt };
  if (index >= 0) backend.fixtures.seeded[index] = entry;
  else backend.fixtures.seeded.push(entry);
  await writeFile(backend.fixturePath, `${JSON.stringify(backend.fixtures, null, 2)}\n`, {
    mode: 0o600,
  });
}
