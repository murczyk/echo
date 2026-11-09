import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { localFilePreviewBackend, previewPost } from './device-file-preview-backend';
import { loadDeviceFilePreviewFixture } from './device-file-preview.fixtures';
import { openDeviceArchiveFolder, openDeviceFilePreview } from './device-file-preview.ui';

async function fullscreenPreview(page: Page, pane: Locator) {
  await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
  const fullscreen = page
    .getByRole('dialog')
    .filter({ has: page.locator('#device-file-fullscreen-title') });
  await expect(fullscreen).toBeVisible();
  return fullscreen;
}

async function wheelZoomAndReset(page: Page, owner: Locator, metric: () => Promise<number>) {
  const stage = owner.locator('[data-document-preview-stage]');
  const badge = stage.locator('button').filter({ hasText: /^\d+%$/ });
  await expect(badge).toHaveText('100%');
  await expect(badge.locator('..')).toHaveCSS('opacity', '0');
  await expect(owner.getByRole('button', { name: 'Збільшити масштаб', exact: true })).toHaveCount(
    0,
  );
  const before = await metric();
  await owner.locator('[data-document-preview-content]').hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -150);
  await page.keyboard.up('Control');
  await expect.poll(metric).toBeGreaterThan(before);
  await expect(badge.locator('..')).toHaveCSS('opacity', '1');
  const [stageBox, badgeBox] = await Promise.all([stage.boundingBox(), badge.boundingBox()]);
  expect(stageBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(badgeBox!.x - stageBox!.x).toBeCloseTo(16, 0);
  expect(stageBox!.y + stageBox!.height - badgeBox!.y - badgeBox!.height).toBeCloseTo(16, 0);
  await badge.click();
  await expect.poll(metric).toBe(before);
  await expect(badge).toHaveText('100%');
  await expect(badge.locator('..')).toHaveCSS('opacity', '0');
}

async function zoomDocx(owner: Locator) {
  const iframe = owner.locator('iframe[title="DOCX preview"]');
  await expect(iframe).toHaveAttribute('sandbox', '');
  const document = owner.frameLocator('iframe[title="DOCX preview"]');
  await expect(document.getByText('Device DOCX content — тільки читання')).toBeVisible();
  const metric = () =>
    document
      .locator('.docx-preview-page')
      .evaluate((element) => Number(getComputedStyle(element).zoom));
  const controls = owner.getByRole('group', { name: 'Масштаб документа', exact: true });
  await expect(controls).toBeVisible();
  await expect(controls).toBeInViewport();
  const reset = controls.getByRole('button', { name: 'Скинути масштаб (100%)', exact: true });
  await expect(reset).toHaveText('100%');
  const before = await metric();
  await controls.getByRole('button', { name: 'Збільшити масштаб', exact: true }).click();
  await expect(reset).toHaveText('125%');
  await expect.poll(metric).toBeCloseTo(before * 1.25, 2);
  await controls.getByRole('button', { name: 'Зменшити масштаб', exact: true }).click();
  await expect.poll(metric).toBe(before);
  await controls.getByRole('button', { name: 'Збільшити масштаб', exact: true }).click();
  await expect.poll(metric).toBeGreaterThan(before);
  await reset.click();
  await expect.poll(metric).toBe(before);
  await expect(iframe).toHaveAttribute('sandbox', '');
}

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
});

// Regression: https://github.com/echoua/echo/issues/3930
test('@regression shared PDF gestures resize actual pages inline and fullscreen', async ({
  page,
}, testInfo) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'document-pdf');
    const checkPdf = async (owner: Locator) => {
      await expect(
        owner.locator('[data-pdf-page-number="1"] .react-pdf__Page__textContent'),
      ).toContainText('Device PDF content');
      const canvas = owner.locator('.react-pdf__Page__canvas').first();
      await expect(canvas).toBeVisible();
      const metric = () => canvas.evaluate((element: HTMLCanvasElement) => element.width);
      await expect.poll(metric).toBeGreaterThan(0);
      await wheelZoomAndReset(page, owner, metric);
    };
    await checkPdf(pane);
    const fullscreen = await fullscreenPreview(page, pane);
    await checkPdf(fullscreen);
    await fullscreen.screenshot({ path: testInfo.outputPath('pdf-fullscreen.png') });
    await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
    await expect(fullscreen).not.toBeVisible();
  } finally {
    await backend.dispose();
  }
});

for (const width of [1440, 390]) {
  test(`@regression shared DOCX controls resize the sandboxed document at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, 'document-docx');
      await zoomDocx(pane);
      await pane.screenshot({ path: testInfo.outputPath('docx-inline.png') });
      const fullscreen = await fullscreenPreview(page, pane);
      await zoomDocx(fullscreen);
      await fullscreen.screenshot({ path: testInfo.outputPath('docx-fullscreen.png') });
      await fullscreen.getByRole('button', { name: 'Закрити перегляд', exact: true }).click();
      await expect(fullscreen).not.toBeVisible();
    } finally {
      await backend.dispose();
    }
  });
}

for (const kind of ['xlsx', 'csv']) {
  test(`@regression shared ${kind.toUpperCase()} grid zooms actual cells and retains content`, async ({
    page,
  }) => {
    const backend = await localFilePreviewBackend();
    try {
      const { pane } = await openDeviceFilePreview(page, backend, `document-${kind}`);
      const city = pane.getByRole('cell', { name: 'Київ', exact: true });
      await expect(city).toBeVisible();
      await wheelZoomAndReset(page, pane, () =>
        city.evaluate((element) => parseFloat(getComputedStyle(element).fontSize)),
      );
      if (kind === 'xlsx') {
        await pane.getByRole('button', { name: 'Підсумок', exact: true }).click();
        await expect(pane.getByRole('cell', { name: 'Усього', exact: true })).toBeVisible();
        await pane.getByRole('button', { name: 'Міста', exact: true }).click();
        await expect(city).toBeVisible();
      }
    } finally {
      await backend.dispose();
    }
  });
}

test('@regression shared TXT and Markdown retain readable content without document zoom controls', async ({
  page,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    for (const kind of ['txt', 'md']) {
      const { pane } = await openDeviceFilePreview(page, backend, `document-${kind}`);
      if (kind === 'txt') await expect(pane.locator('pre')).toContainText('Контрольний файл Echo');
      else {
        await expect(
          pane.getByRole('heading', { name: 'Контрольний документ Echo', exact: true }),
        ).toBeVisible();
        await expect(pane.locator('[data-document-preview-content] script, img')).toHaveCount(0);
      }
      const stage = pane.locator('[data-document-preview-stage]');
      await expect(stage).toBeVisible();
      await expect(stage.locator('button').filter({ hasText: /^\d+%$/ })).toHaveCount(0);
      await expect(stage.getByRole('group', { name: 'Масштаб документа' })).toHaveCount(0);
    }
  } finally {
    await backend.dispose();
  }
});

test('@regression shared KML map renders geometry and responds to map zoom', async ({ page }) => {
  const backend = await localFilePreviewBackend();
  try {
    const { pane } = await openDeviceFilePreview(page, backend, 'native-map-kml');
    const geometry = pane.locator('[data-map-preview-points]');
    await expect(geometry).toHaveAttribute('data-map-preview-points', '1');
    await expect(geometry).toHaveAttribute('data-map-preview-lines', '1');
    await expect(geometry).toHaveAttribute('data-map-preview-polygons', '1');
    const map = pane.locator('.leaflet-container');
    const canvas = pane.locator('.leaflet-overlay-pane canvas').first();
    await expect(canvas).toBeAttached();
    const before = await canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL());
    await map.hover();
    await page.mouse.wheel(0, -300);
    await expect
      .poll(() => canvas.evaluate((element: HTMLCanvasElement) => element.toDataURL()))
      .not.toBe(before);
    await expect(pane.locator('[data-document-preview-stage]')).toHaveCount(0);
  } finally {
    await backend.dispose();
  }
});

test('@regression ZIP uses folder grid and table to open and download a linked nested member', async ({
  page,
}, testInfo) => {
  const backend = await localFilePreviewBackend();
  let originalFavorite: { entryId: string; favorite: boolean } | undefined;
  try {
    const { folder, entry } = await openDeviceArchiveFolder(page, backend, 'archive-zip');
    const pane = page.getByTestId('device-file-content-pane');
    const legacyUrl = new URL(page.url());
    legacyUrl.searchParams.delete('directory');
    legacyUrl.searchParams.delete('directory_revision');
    legacyUrl.searchParams.set('file', entry.file.fileId);
    legacyUrl.searchParams.set('revision', String(entry.file.revision));
    await page.goto(legacyUrl.toString());
    await expect
      .poll(() => new URL(page.url()).searchParams.get('directory'))
      .toBe(entry.file.fileId);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('directory_revision'))
      .toBe(String(entry.file.revision));
    expect(new URL(page.url()).searchParams.has('file')).toBe(false);
    await expect(pane).toHaveCount(0);
    await expect(page.getByRole('textbox', { name: 'Пошук файлів за назвою' })).toBeVisible();
    await page.getByRole('button', { name: 'Плитка', exact: true }).click();
    const cards = folder.getByRole('list', { name: 'Файли та папки', exact: true });
    await expect(
      cards.getByRole('button', { name: 'Відкрити файл Звіт.txt', exact: true }),
    ).toBeVisible();
    await expect(
      cards.getByRole('button', { name: 'Відкрити папку nested', exact: true }),
    ).toBeVisible();
    const favoriteName = /^(Додати в обране|Прибрати з обраного): Звіт\.txt$/;
    const favorite = cards.getByRole('button', { name: favoriteName });
    originalFavorite = {
      entryId: await favorite.evaluate((button) => button.closest('li')!.dataset.entryId!),
      favorite: (await favorite.getAttribute('aria-pressed')) === 'true',
    };
    await favorite.click();
    await expect(favorite).toHaveAttribute('aria-pressed', String(!originalFavorite.favorite));
    await page.screenshot({ path: testInfo.outputPath('zip-grid.png'), animations: 'disabled' });
    await page.getByRole('button', { name: 'Список', exact: true }).click();
    const table = folder.getByRole('table', { name: 'Файли та папки', exact: true });
    for (const name of [
      'Назва',
      'Перегляд',
      'Обране',
      'Дата завантаження',
      'Дата створення',
      'Дата зміни',
      'Розмір',
      'Тип',
      'Теги',
    ]) {
      await expect(table.getByRole('columnheader', { name, exact: true })).toBeVisible();
    }
    await expect(
      table.getByRole('button', { name: 'Відкрити файл Звіт.txt', exact: true }),
    ).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath('zip-table.png'), animations: 'disabled' });
    const archiveUrl = page.url();
    await table.getByRole('button', { name: 'Відкрити папку nested', exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('directory_revision'))
      .toBe(String(entry.file.revision));
    await expect(folder.getByRole('table', { name: 'Файли та папки', exact: true })).toBeVisible();
    await expect(
      folder.getByRole('button', { name: 'Відкрити файл Дані.csv', exact: true }),
    ).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(archiveUrl);
    await expect(pane).toHaveCount(0);
    await table.getByRole('button', { name: 'Відкрити папку nested', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await folder.getByRole('button', { name: 'Відкрити файл Дані.csv', exact: true }).click();
    await expect(pane.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
    await expect(page).not.toHaveURL(archiveUrl);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(pane.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
    const pending = page.waitForEvent('download');
    await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe('Дані.csv');
    expect(await readFile((await download.path())!)).toEqual(
      (await loadDeviceFilePreviewFixture('document-csv')).bytes,
    );
    await page
      .getByRole('navigation', { name: 'Навігаційний шлях пристрою', exact: true })
      .getByRole('link', { name: entry.file.name, exact: true })
      .click();
    await expect(page).toHaveURL(archiveUrl);
    await expect(pane).toHaveCount(0);
    await expect(folder.getByRole('button', { name: favoriteName })).toHaveAttribute(
      'aria-pressed',
      String(!originalFavorite.favorite),
    );
  } finally {
    try {
      if (originalFavorite)
        await previewPost(await backend.login('reader'), '/api/device/files/favorite', {
          deviceId: backend.fixtures.deviceId,
          ...originalFavorite,
        });
    } finally {
      await backend.dispose();
    }
  }
});
