import { expect, test } from '@playwright/test';
import { createHash } from 'node:crypto';

import {
  IMAGE_EDITOR_DRAWER_PNG,
  createImageEditorNoisePng,
  openCreateMessageDrawer,
  openEditMessageDrawer,
  observeImageEditorSubmission,
  type ImageEditorDrawerHost,
} from './image-editor-drawer.fixtures';

async function openPendingImageEditor(
  page: import('@playwright/test').Page,
  host: ImageEditorDrawerHost,
  image = IMAGE_EDITOR_DRAWER_PNG,
) {
  await openCreateMessageDrawer(page, host);
  await page.locator('input[type="file"]').setInputFiles(image);
  await page.getByRole('button', { name: `Переглянути ${image.name}` }).click();
  const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
  await expect(preview).toBeVisible();
  await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
  const editor = page.getByLabel('Редактор зображення');
  await expect(editor).toBeVisible();
  return { editor, preview };
}

async function saveMinimalReplacement(
  page: import('@playwright/test').Page,
  editor: import('@playwright/test').Locator,
) {
  await editor.getByRole('button', { name: 'Текст' }).click();
  const box = await editor.locator('canvas[data-fabric="top"]').boundingBox();
  if (!box) throw new Error('Canvas редактора не має розмірів');
  await page.mouse.click(box.x + 30, box.y + 30);
  await page.keyboard.type('edited');
  await editor.locator('footer').getByRole('button', { name: 'Зберегти', exact: true }).click();
  const confirmation = page.getByRole('dialog', {
    name: 'Замінити поточне зображення?',
  });
  await expect(confirmation).toBeVisible();
  await confirmation.getByRole('button', { name: 'Замінити', exact: true }).click();
}

test.describe('image editor drawer integration #3099', () => {
  for (const host of ['duty', 'analysis'] as const satisfies ImageEditorDrawerHost[]) {
    test(`${host} opens from preview and saves one pending replacement`, async ({ page }) => {
      const submitted = await observeImageEditorSubmission(page);
      const { editor, preview } = await openPendingImageEditor(page, host);
      await saveMinimalReplacement(page, editor);
      await expect(editor).toHaveCount(0);
      await preview.getByRole('button', { name: 'Закрити' }).click();
      await expect(page.getByText('Вкладення (1)')).toBeVisible();
      expect(submitted.uploads).toHaveLength(0);
    });
  }

  test('cancelling an edit creates no replacement upload', async ({ page }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.locator('footer').getByRole('button', { name: 'Скасувати' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
  });

  test('submits one replacement and deletion for persisted media', async ({ page }) => {
    await openEditMessageDrawer(page);
    const submitted = await observeImageEditorSubmission(page);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await saveMinimalReplacement(page, editor);
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => submitted.submissions.length).toBe(1);
    expect(submitted.uploads).toHaveLength(1);
    expect(submitted.submissions[0]).toMatchObject({
      deleted_media_ids: ['existing-editor-image'],
      upload_urls: ['/api/sigint/file-upload/tus/editor-upload'],
    });
  });

  test('falls back to multipart when the TUS chunk is rejected', async ({ page }) => {
    await openEditMessageDrawer(page);
    const submitted = await observeImageEditorSubmission(page, { failTusChunks: true });
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await saveMinimalReplacement(page, editor);
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => submitted.submissions.length).toBe(1);
    expect(submitted.fallbackUploads).toHaveLength(1);
    expect(submitted.submissions[0]).toMatchObject({
      upload_urls: ['/api/sigint/file-upload/tus/fallback-upload'],
    });
  });

  test('@smoke browser Back cancels fallback without saving an edit after unmount', async ({
    page,
  }) => {
    await openEditMessageDrawer(page);
    const submitted = await observeImageEditorSubmission(page, { failTusChunks: true });
    let releaseFallback!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseFallback = resolve;
    });
    let fallbackStarted = false;
    let abortedUploads = 0;
    page.on('requestfailed', (request) => {
      if (request.url().endsWith('/api/sigint/file-upload/fallback')) abortedUploads += 1;
    });
    await page.route('**/api/sigint/file-upload/fallback', async (route) => {
      fallbackStarted = true;
      await release;
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify({ upload_url: '/api/sigint/file-upload/tus/cancelled-upload' }),
      });
    });
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.evaluate(() => {
      window.history.replaceState({}, '', '/admin');
      window.history.pushState({}, '', '/rer-duty-neo');
    });
    const documentStart = await page.evaluate(() => performance.timeOrigin);
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => fallbackStarted).toBe(true);
    await page.goBack();
    await expect(page).toHaveURL(/\/admin(?:\/directions-neo)?$/);
    await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toHaveCount(0);
    expect(await page.evaluate(() => performance.timeOrigin)).toBe(documentStart);
    try {
      await expect.poll(() => abortedUploads).toBe(1);
    } finally {
      releaseFallback();
    }
    await page.evaluate(() => new Promise(requestAnimationFrame));
    expect(submitted.submissions).toHaveLength(0);
  });

  test('keeps editor actions reachable at representative viewports', async ({ page }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 900 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Текст', exact: true })).toBeVisible();
      await expect(
        editor.locator('footer').getByRole('button', { name: 'Скасувати' }),
      ).toBeVisible();
      await expect(
        editor.locator('footer').getByRole('button', { name: 'Зберегти', exact: true }),
      ).toBeVisible();
    }
  });
});

for (const status of [401, 403, 413]) {
  test(`terminal TUS ${status} never falls back or saves an edit`, async ({ page }) => {
    await openEditMessageDrawer(page);
    const sent = await observeImageEditorSubmission(page);
    let denied = 0;
    await page.route('**/api/sigint/file-upload/tus', async (route) => {
      denied += 1;
      await route.fulfill({ status });
    });
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => denied).toBe(1);
    if (status === 401) {
      await expect(page).toHaveURL(/\/login\?redirect=/);
    } else {
      await expect(page.getByRole('button', { name: 'Зберегти', exact: true })).toBeEnabled();
    }
    expect(sent.fallbackUploads).toHaveLength(0);
    expect(sent.submissions).toHaveLength(0);
    if (status !== 401)
      await expect(page.getByRole('heading', { name: 'Редагувати повідомлення' })).toBeVisible();
  });
}

test('TUS preserves a busy upload while resuming after a lost accepted chunk response', async ({
  page,
}, info) => {
  await openEditMessageDrawer(page);
  const sent = await observeImageEditorSubmission(page);
  const source = Buffer.alloc(10 * 1024 * 1024 + 1, 0x5a);
  const accepted: Buffer[] = [];
  let offset = 0;
  let creates = 0;
  let heads = 0;
  let lost = false;
  const location = '/api/sigint/file-upload/tus/audit-resumed';
  await page.route('**/api/sigint/file-upload/tus', async (route) => {
    creates += 1;
    await route.fulfill({ status: 201, headers: { Location: location, 'Tus-Resumable': '1.0.0' } });
  });
  await page.route('**' + location, async (route) => {
    const request = route.request();
    if (request.method() === 'HEAD') {
      heads += 1;
      if (heads <= 2) {
        return route.fulfill({
          status: 423,
          headers: { 'Tus-Resumable': '1.0.0', 'Retry-After': '1', 'Cache-Control': 'no-store' },
        });
      }
      return route.fulfill({
        status: 204,
        headers: {
          'Tus-Resumable': '1.0.0',
          'Upload-Offset': String(offset),
          'Upload-Length': String(source.length),
        },
      });
    }
    expect(request.method()).toBe('POST');
    expect(request.headers()['x-http-method-override']).toBe('PATCH');
    expect(Number(request.headers()['upload-offset'])).toBe(offset);
    const bytes = request.postDataBuffer()!;
    accepted.push(bytes);
    offset += bytes.length;
    if (accepted.length === 2 && !lost) {
      lost = true;
      return route.abort('failed');
    }
    return route.fulfill({
      status: 204,
      headers: { 'Tus-Resumable': '1.0.0', 'Upload-Offset': String(offset) },
    });
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'audit-resume.bin',
    mimeType: 'application/octet-stream',
    buffer: source,
  });
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => sent.submissions.length, { timeout: 15000 }).toBe(1);
  expect(creates).toBe(1);
  expect(heads).toBe(3);
  expect(lost).toBe(true);
  expect(sent.fallbackUploads).toHaveLength(0);
  expect(offset).toBe(source.length);
  expect(Buffer.concat(accepted)).toEqual(source);
  expect(sent.submissions[0]).toMatchObject({ upload_urls: [location] });
  await info.attach('resume-metrics', {
    body: JSON.stringify({
      source_bytes: source.length,
      accepted_chunk_bytes: accepted.map((x) => x.length),
      head_requests: heads,
      busy_head_responses: 2,
      creation_requests: creates,
      full_byte_equality: true,
      sha256: createHash('sha256').update(source).digest('hex'),
    }),
    contentType: 'application/json',
  });
});

test('large single-IDAT PNG remains editable within image source limits #3294', async ({
  page,
}, info) => {
  const image = createImageEditorNoisePng();
  expect(image.buffer.length).toBeGreaterThan(1024 * 1024);
  const { editor } = await openPendingImageEditor(page, 'duty', image);
  await expect(editor.getByRole('button', { name: 'Текст', exact: true })).toBeEnabled();
  await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
  await info.attach('large-png-metrics', {
    body: JSON.stringify({
      source_bytes: image.buffer.length,
      width: 1024,
      height: 1024,
      single_idat: true,
      editor_ready: true,
    }),
    contentType: 'application/json',
  });
});
