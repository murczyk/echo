import { expect, test, type Page } from '@playwright/test';
import { zipSync, strToU8 } from 'fflate';
import {
  localFilePreviewBackend,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import {
  DEVICE_FILE_PREVIEW_FIXTURES,
  loadDeviceFilePreviewFixture,
} from './device-file-preview.fixtures';

async function openArchiveTree(page: Page, issue?: 'corrupt' | 'empty-path') {
  const backend = await localFilePreviewBackend();
  try {
    const fixture = {
      ...DEVICE_FILE_PREVIEW_FIXTURES.find((entry) => entry.id === 'archive-zip')!,
      id: 'archive-tree',
      fileName: 'echo-archive-tree.zip',
    };
    const image = await loadDeviceFilePreviewFixture('image-png');
    const pdf = await loadDeviceFilePreviewFixture('document-pdf');
    const audio = await loadDeviceFilePreviewFixture('audio-mp3');
    const video = await loadDeviceFilePreviewFixture('video-mp4');
    const bytes = Buffer.from(
      zipSync({
        './docs//readme.txt': strToU8('Файл усередині архіву Echo'),
        'docs/report.pdf': pdf.bytes,
        'images/picture.png': image.bytes,
        'sound.mp3': audio.bytes,
        'movie.mp4': video.bytes,
        'route.gpx': strToU8('<gpx version="1.1"/>'),
        ...(issue === 'empty-path' ? { '.': strToU8('invalid file name') } : {}),
        'nested.zip': zipSync({ 'inner.txt': strToU8('Вкладений ZIP Echo') }),
      }),
    );
    if (issue === 'corrupt') {
      const central = bytes.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
      bytes[central + 16] = bytes[central + 16]! ^ 1;
    }
    const api = await backend.login('source');
    const file = await syncPreviewFile(api, backend.fixtures.deviceId!, fixture);
    const receipt = await uploadPreviewContent(api, backend.fixtures.deviceId!, file, bytes);
    const reader = await backend.login('reader');
    await page.context().addCookies((await reader.storageState()).cookies);
    await page.goto(`/devices/${backend.fixtures.deviceId}`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('tab', { name: 'Файли', exact: true }).click();
    await page.getByRole('button', { name: 'Розгорнути каталог preview', exact: true }).click();
    await page
      .getByRole('button', { name: 'Розгорнути каталог archive-tree', exact: true })
      .click();
    return { backend, receipt, file };
  } catch (error) {
    await backend.dispose();
    throw error;
  }
}

test('@regression ZIP folders open archive members in the ordinary file preview', async ({
  page,
}) => {
  const { backend } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    const pane = page.getByTestId('device-file-content-pane');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    await expect(pane.locator('pre')).toContainText('Файл усередині архіву Echo');
    await expect(pane.locator('#device-file-content-title')).toContainText('echo-archive-tree.zip');
    const download = page.waitForEvent('download');
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    expect((await download).suggestedFilename()).toBe('readme.txt');
    await tree.getByRole('button', { name: 'report.pdf', exact: true }).click();
    await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    await tree.getByRole('button', { name: 'Розгорнути каталог images', exact: true }).click();
    await tree.getByRole('button', { name: 'picture.png', exact: true }).click();
    await expect
      .poll(() => pane.locator('img').evaluate((image: HTMLImageElement) => image.naturalWidth))
      .toBe(80);
    await tree.getByRole('button', { name: 'movie.mp4', exact: true }).click();
    await expect
      .poll(() => pane.locator('video').evaluate((video: HTMLVideoElement) => video.readyState))
      .toBeGreaterThanOrEqual(1);
    await tree.getByRole('button', { name: 'sound.mp3', exact: true }).click();
    await expect(pane.locator('[data-audio-player-host]')).toBeVisible();
    await tree.getByRole('button', { name: 'Розгорнути каталог nested.zip', exact: true }).click();
    await tree.getByRole('button', { name: 'inner.txt', exact: true }).click();
    await expect(pane.locator('pre')).toContainText('Вкладений ZIP Echo');
  } finally {
    await backend.dispose();
  }
});

test('@regression archive member access is rechecked after listing', async ({ page }) => {
  const { backend, receipt } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    await page.route(`**${receipt.originalHref}`, (route) =>
      route.fulfill({ status: 403, body: 'Access denied' }),
    );
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane.getByRole('alert')).toBeVisible();
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
    await expect(pane.locator('pre')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression archive maps address their member in the conversion queue', async ({ page }) => {
  const { backend } = await openArchiveTree(page);
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    const prepared = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        response.url().includes('/preview/geodata?archive_members='),
    );
    await tree.getByRole('button', { name: 'route.gpx', exact: true }).click();
    const response = await prepared;
    expect([200, 202, 503]).toContain(response.status());
    if (response.status() === 503) {
      expect((await response.json()).code).toBe('preview_unavailable');
      await expect(page.getByTestId('device-file-content-pane').getByRole('alert')).toBeVisible();
    }
  } finally {
    await backend.dispose();
  }
});

test('@regression a late archive extraction cannot replace the selected member', async ({
  page,
}) => {
  const { backend, receipt } = await openArchiveTree(page);
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    const tree = page.getByTestId('device-files-tree');
    const pane = page.getByTestId('device-file-content-pane');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    let intercepted!: () => void;
    const started = new Promise<void>((resolve) => {
      intercepted = resolve;
    });
    let first = true;
    await page.route(`**${receipt.originalHref}`, async (route) => {
      if (first && route.request().method() === 'GET') {
        first = false;
        const response = await route.fetch();
        intercepted();
        await held;
        await route.fulfill({ response }).catch(() => {});
      } else await route.continue();
    });
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    await started;
    await tree.getByRole('button', { name: 'report.pdf', exact: true }).click();
    await expect(pane.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    release();
    await expect(pane.locator('#device-file-content-title')).toContainText('report.pdf');
    await expect(pane.locator('pre')).toHaveCount(0);
  } finally {
    release();
    await backend.dispose();
  }
});

test('@regression an invalid member cannot download its parent ZIP under the member name', async ({
  page,
}) => {
  const { backend } = await openArchiveTree(page, 'corrupt');
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await tree.getByRole('button', { name: 'Розгорнути каталог docs', exact: true }).click();
    await tree.getByRole('button', { name: 'readme.txt', exact: true }).click();
    const pane = page.getByTestId('device-file-content-pane');
    await expect(pane.getByRole('alert')).toContainText('цілісності');
    await expect(pane.getByRole('button', { name: 'Скачати файл', exact: true })).toBeDisabled();
  } finally {
    await backend.dispose();
  }
});

test('@regression an empty normalized archive filename reports an error without crashing the tree', async ({
  page,
}) => {
  const { backend } = await openArchiveTree(page, 'empty-path');
  try {
    const tree = page.getByTestId('device-files-tree');
    await tree
      .getByRole('button', { name: 'Розгорнути каталог echo-archive-tree.zip', exact: true })
      .click();
    await expect(tree.getByRole('alert')).toContainText('некоректну назву');
    await expect(
      tree.getByRole('button', { name: 'Згорнути каталог echo-archive-tree.zip', exact: true }),
    ).toBeVisible();
  } finally {
    await backend.dispose();
  }
});
