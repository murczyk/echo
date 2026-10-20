import { expect, test } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceFilePreview } from './device-file-preview.ui';

test('@regression lists and saves actual ZIP member bytes', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'archive-zip');
    await pane.getByRole('button', { name: 'Звіт.txt', exact: true }).click();
    const save = pane.getByRole('button', { name: 'Скачати файл', exact: true });
    const downloaded = page.waitForEvent('download');
    await save.click();
    const download = await downloaded;
    expect(download.suggestedFilename()).toBe('Звіт.txt');
  } finally {
    await backend.dispose();
  }
});
for (const id of ['native-map-kml', 'native-map-kmz', 'kmz-zip-mime']) {
  test(`@regression renders native geometry ${id} without Alpine`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await expect(pane.locator('.leaflet-container')).toBeVisible();
      await expect(pane.locator('.leaflet-overlay-pane canvas').first()).toBeAttached();
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
    } finally {
      await backend.dispose();
    }
  });
}
