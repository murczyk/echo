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

test.describe('image editor drawer integration #3448', () => {
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

  test('opens and dismisses shortcut help from mobile overflow #3448', async ({ page }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await page.setViewportSize({ width: 360, height: 800 });
    const more = editor.getByRole('button', { name: 'Ще' });
    await expect(more).toBeEnabled();
    await more.click();
    await page.getByRole('menuitem', { name: 'Гарячі клавіші' }).click();
    const help = page.getByRole('heading', { name: 'Гарячі клавіші' });
    await expect(help).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(help).toBeHidden();
    await expect(editor).toBeVisible();
  });

  test('finishes text editing on an empty-canvas click without creating a second label #3448', async ({
    page,
  }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Текст' }).click();
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.25, box!.y + box!.height * 0.25);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('Позначка');
    await page.mouse.click(box!.x + box!.width * 0.8, box!.y + box!.height * 0.8);
    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const deleteSelected = editor.getByRole('button', { name: 'Видалити вибране' }).first();
    await expect(deleteSelected).toBeEnabled();
    await page.keyboard.press('Delete');
    await expect(deleteSelected).toBeDisabled();
  });

  test('hands a text-frame drag from editing to Fabric movement #3448', async ({ page }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Текст' }).click();
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    const origin = { x: box!.x + box!.width * 0.3, y: box!.y + box!.height * 0.3 };
    await page.mouse.click(origin.x, origin.y);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('Рух');
    await page.mouse.move(origin.x - 4, origin.y + 8);
    await page.mouse.down();
    await page.mouse.move(origin.x + 36, origin.y + 28);
    await page.mouse.up();
    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(editor.getByRole('button', { name: 'Видалити вибране' }).first()).toBeEnabled();
  });
});
