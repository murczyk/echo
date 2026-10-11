import { expect, test } from '@playwright/test';
import { localFilePreviewBackend } from './device-file-preview-backend';
import { openDeviceFilePreview } from './device-file-preview.ui';

test('@regression renders Ukrainian Markdown from the actual FileSync revision', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'document-md');
    await expect(
      pane.getByRole('heading', { name: 'Контрольний документ Echo', exact: true }),
    ).toBeVisible();
    await expect(pane.locator('img')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression renders two XLSX sheets and switches the actual workbook', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'document-xlsx');
    await expect(pane.getByRole('button', { name: 'Міста', exact: true })).toBeVisible();
    await expect(pane.getByText('Київ', { exact: true })).toBeVisible();
    await pane.getByRole('button', { name: 'Підсумок', exact: true }).click();
    await expect(pane.getByText('Усього', { exact: true })).toBeVisible();
  } finally {
    await backend.dispose();
  }
});

for (const id of [
  'document-txt',
  'document-markdown',
  'document-pdf',
  'document-doc',
  'document-docx',
  'document-xls',
  'document-csv',
  'uppercase-pdf',
  'extension-only-docx',
  'mime-only-pdf',
  'docx-zip-mime',
  'xlsx-zip-mime',
]) {
  test(`@regression displays actual document ${id}`, async ({ page }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane, fixture } = await openDeviceFilePreview(page, backend, id);
      if (fixture.expectedViewer === 'pdf') {
        await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
        await expect
          .poll(() =>
            pane
              .locator('.react-pdf__Page__canvas')
              .first()
              .evaluate((canvas: HTMLCanvasElement) => canvas.width),
          )
          .toBeGreaterThan(0);
      } else if (fixture.expectedViewer === 'docx') {
        await expect(
          pane
            .frameLocator('iframe[title="DOCX preview"]')
            .getByText('Device DOCX content — тільки читання'),
        ).toBeVisible();
      } else if (fixture.expectedViewer === 'doc') {
        await expect(
          pane.getByText('Український абзац: Ґґ Єє Іі Її. Mixed Latin text 123.', { exact: true }),
        ).toBeVisible();
      } else if (fixture.expectedViewer === 'xlsx' || fixture.expectedViewer === 'csv') {
        await expect(pane.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
      } else if (fixture.expectedViewer === 'xls') {
        await expect(pane.getByRole('table')).toBeVisible();
      } else if (fixture.expectedViewer === 'md') {
        await expect(
          pane.getByRole('heading', { name: 'Контрольний документ Echo' }),
        ).toBeVisible();
      } else {
        await expect(pane.locator('pre')).toContainText('Контрольний файл Echo');
      }
      await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeEnabled();
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression fullscreen closes on Escape and restores focus', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'document-md');
    const trigger = pane.getByRole('button', { name: 'На весь екран', exact: true });
    await trigger.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(
      page
        .getByRole('dialog')
        .getByRole('heading', { name: 'Контрольний документ Echo', exact: true }),
    ).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(trigger).toBeFocused();
  } finally {
    await backend.dispose();
  }
});
