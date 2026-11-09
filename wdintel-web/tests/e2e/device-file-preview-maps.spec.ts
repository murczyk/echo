import { expect, test } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceArchiveFolder, openDeviceFilePreview } from './device-file-preview.ui';

test('@regression lists and saves actual ZIP member bytes', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  try {
    const { folder } = await openDeviceArchiveFolder(page, backend, 'archive-zip');
    await folder.getByRole('button', { name: 'Відкрити файл Звіт.txt', exact: true }).click();
    const pane = page.getByTestId('device-file-content-pane');
    const save = pane.getByRole('button', { name: 'Скачати файл', exact: true });
    const downloaded = page.waitForEvent('download');
    await save.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('Звіт.txt');
  } finally {
    await backend.dispose();
  }
});
for (const id of [
  'native-map-kml',
  'native-map-kmz',
  'kmz-zip-mime',
  'converted-map-gpx',
  'converted-map-geojson',
]) {
  test(`@regression renders native geometry ${id} without Alpine`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const preparationRequests: string[] = [];
      page.on('request', (request) => {
        if (request.url().includes('/preview/geodata')) preparationRequests.push(request.url());
      });
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expect(pane.locator('.leaflet-container')).toBeVisible();
      await expect(pane.locator('.leaflet-overlay-pane canvas').first()).toBeAttached();
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
      if (id === 'converted-map-gpx' || id === 'converted-map-geojson') {
        const geometry = pane.locator('[data-map-preview-points]');
        await expect(geometry).toHaveAttribute('data-map-preview-points', '1');
        await expect(geometry).toHaveAttribute('data-map-preview-lines', '1');
        await expect(geometry).toHaveAttribute(
          'data-map-preview-polygons',
          id.endsWith('geojson') ? '1' : '0',
        );
      }
      expect(preparationRequests).toEqual([]);
    } finally {
      await backend.dispose();
    }
  });
}

test('#3930 @regression native GPX respects content access denial after metadata preflight', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === 'converted-map-gpx')!;
    await page.route(`**${entry.originalHref}`, async (route) => {
      if (route.request().method() === 'HEAD') return route.continue();
      await route.fulfill({
        status: 403,
        contentType: 'application/json',
        body: '{"error":"forbidden"}',
      });
    });
    const { pane } = await openDeviceFilePreview(page, backend, 'converted-map-gpx');
    await expect(pane.getByRole('alert')).toContainText('HTTP 403');
    await expect(pane.locator('.leaflet-container')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    await expect(pane.getByRole('button', { name: 'На весь екран', exact: true })).toBeDisabled();
  } finally {
    await backend.dispose();
  }
});
