import { openDeviceSection } from './device-pages.ui';
import { expect, type Page } from '@playwright/test';
import {
  localFilePreviewBackend,
  previewOriginalHref,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import { readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';

export type FilePreviewBackend = Awaited<ReturnType<typeof localFilePreviewBackend>>;

// Chromium's native downloads bypass Playwright request/route events.
export async function observeNativeDownload(
  backend: FilePreviewBackend,
  path: string,
  hold = false,
) {
  const id = randomUUID();
  const control = join(backend.root, 'native-download-probe.json');
  await writeFile(control, JSON.stringify({ id, path, hold }), { mode: 0o600, flag: 'wx' });
  return {
    async requests(): Promise<{ method: string; url: string; status: number | null }[]> {
      const files = (await readdir(backend.root)).filter(
        (name) => name.startsWith(`native-download-${id}-`) && name.endsWith('.json'),
      );
      return Promise.all(
        files.map(async (name) => JSON.parse(await readFile(join(backend.root, name), 'utf8'))),
      );
    },
    async release() {
      await writeFile(`${control}.tmp`, JSON.stringify({ id, path, hold: false }), { mode: 0o600 });
      await rename(`${control}.tmp`, control);
    },
    dispose: () => rm(control, { force: true }),
  };
}

export async function openDeviceFilePreview(
  page: Page,
  backend: FilePreviewBackend,
  fixtureId: string,
) {
  const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === fixtureId);
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((fixture) => fixture.id === fixtureId);
  if (!entry || !fixture || !backend.fixtures.deviceId)
    throw new Error(`Missing seeded fixture: ${fixtureId}`);
  const pane = await openDeviceFilePreviewEntry(page, backend, entry.file.fileId, fixture.fileName);
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

export async function openDeviceFilePreviewEntry(
  page: Page,
  backend: FilePreviewBackend,
  fileId: string,
  fileName: string,
) {
  await openDeviceFilesRoot(page, backend);
  return selectDeviceFilePreviewEntry(page, fileId, fileName);
}

async function openDeviceFilesRoot(page: Page, backend: FilePreviewBackend) {
  const reader = await backend.login('reader');
  await page.context().addCookies((await reader.storageState()).cookies);
  await page.goto(`/devices/${backend.fixtures.deviceId}`, { waitUntil: 'domcontentloaded' });
  await openDeviceSection(page, 'Файли');
  await page
    .getByRole('region', { name: 'Вміст папки', exact: true })
    .getByRole('button', { name: /^Відкрити папку C:/ })
    .click();
}

async function clickDeviceFileEntry(page: Page, fileId: string, fileName: string) {
  const search = page.getByRole('textbox', { name: 'Пошук файлів за назвою', exact: true });
  await search.fill(fileName);
  await search.press('Enter');
  const row = page
    .getByRole('table', { name: 'Результати пошуку', exact: true })
    .locator(`[data-entry-id="${fileId}"]`);
  await row
    .getByRole('button', {
      name: fileName,
      exact: true,
    })
    .click();
}

export async function selectDeviceFilePreviewEntry(page: Page, fileId: string, fileName: string) {
  await clickDeviceFileEntry(page, fileId, fileName);
  const pane = page.getByTestId('device-file-content-pane');
  await expect(pane.locator('#device-file-content-title')).toContainText(fileName);
  return pane;
}

export async function openDeviceArchiveFolder(
  page: Page,
  backend: FilePreviewBackend,
  fixtureId: string,
) {
  const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === fixtureId);
  const fixture = DEVICE_FILE_PREVIEW_FIXTURES.find((fixture) => fixture.id === fixtureId);
  if (!entry || !fixture) throw new Error(`Missing seeded archive: ${fixtureId}`);
  await openDeviceFilesRoot(page, backend);
  await clickDeviceFileEntry(page, entry.file.fileId, fixture.fileName);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('directory'))
    .toBe(entry.file.fileId);
  await expect
    .poll(() => new URL(page.url()).searchParams.get('directory_revision'))
    .toBe(String(entry.file.revision));
  const folder = page.getByRole('region', { name: 'Вміст папки', exact: true });
  await expect(folder).toBeVisible();
  await expect(page.getByTestId('device-file-content-pane')).toHaveCount(0);
  return { folder, fixture, entry };
}
