import { expect, test } from '@playwright/test';

import {
  IMAGE_EDITOR_DRAWER_PNG,
  openCreateMessageDrawer,
  openEditMessageDrawer,
  observeImageEditorSubmission,
  type ImageEditorDrawerHost,
} from './image-editor-drawer.fixtures';

async function openPendingImageEditor(
  page: import('@playwright/test').Page,
  host: ImageEditorDrawerHost,
) {
  await openCreateMessageDrawer(page, host);
  await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
  await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
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

// @test-scope regression: https://github.com/echoua/echo/issues/3099
test.describe('image editor drawer integration @regression', () => {
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
