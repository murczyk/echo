import { expect, test } from '@playwright/test';

import {
  IMAGE_EDITOR_DRAWER_PNG,
  openEditReportDrawer,
  openCreateReportDrawer,
  openEditMessageDrawer,
  openCreateMessageDrawer,
  observeImageEditorSubmission,
  type ImageEditorDrawerHost,
} from './image-editor-drawer.fixtures';

async function selectEditorGroup(page: import('@playwright/test').Page) {
  await page.getByLabel('Група').click();
  await page.getByRole('option', { name: 'editor-e2e-group' }).click();
}

test.describe('image editor in editable message drawers #3099', () => {
  for (const host of ['duty', 'analysis'] as const satisfies ImageEditorDrawerHost[]) {
    test(`${host} create-message drawer edits a pending image without duplicating it`, async ({
      page,
    }) => {
      const browserErrors: string[] = [];
      page.on('pageerror', (error) => browserErrors.push(`pageerror: ${error.message}`));
      page.on('console', (message) => {
        if (message.type() === 'error') browserErrors.push(`console: ${message.text()}`);
      });
      await openCreateMessageDrawer(page, host);
      await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
      await expect(page.getByText('Вкладення (1)')).toBeVisible();

      await page
        .getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` })
        .click();
      const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
      await expect(preview.getByRole('button', { name: 'Редагувати зображення' })).toBeVisible();
      await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
      await page.waitForTimeout(250);
      expect(browserErrors).toEqual([]);

      const editor = page.getByLabel('Редактор зображення');
      await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
      await editor.getByRole('button', { name: 'Приховати дані' }).click();
      await editor.getByLabel('Приховування').click();
      await page.getByRole('option', { name: 'Розмиття' }).click();
      const canvas = editor.locator('canvas[data-fabric="top"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Canvas редактора не має розмірів');
      await page.mouse.move(box.x + 2, box.y + 2);
      await page.mouse.down();
      await page.mouse.move(
        box.x + Math.min(24, box.width - 2),
        box.y + Math.min(24, box.height - 2),
      );
      await page.mouse.up();
      await editor.getByRole('button', { name: 'Застосувати' }).click();

      await expect(editor).toHaveCount(0);
      await expect(preview).toBeVisible();
    });
  }

  for (const host of ['duty', 'analysis'] as const satisfies ImageEditorDrawerHost[]) {
    test(`${host} submits one edited pending attachment through Tus`, async ({ page }) => {
      await openCreateMessageDrawer(page, host);
      const submitted = await observeImageEditorSubmission(page);
      await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
      await page
        .getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` })
        .click();
      const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
      await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
      const editor = page.getByLabel('Редактор зображення');
      await editor.getByRole('button', { name: 'Текст' }).click();
      const canvas = editor.locator('canvas[data-fabric="top"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Canvas редактора не має розмірів');
      await page.mouse.click(box.x + 30, box.y + 30);
      await page.keyboard.type('edited');
      await editor.getByRole('button', { name: 'Застосувати' }).click();
      await preview.getByRole('button', { name: 'Закрити' }).click();
      await selectEditorGroup(page);
      await page.getByRole('button', { name: 'Створити' }).click();
      await expect.poll(() => submitted.submissions.length).toBe(1);
      expect(submitted.uploads).toHaveLength(1);
      expect(submitted.uploads[0]?.bytes.equals(IMAGE_EDITOR_DRAWER_PNG.buffer)).toBe(false);
      expect(submitted.uploads[0]?.bytes.length).toBeGreaterThan(0);
      expect(submitted.uploads[0]?.metadata).toMatchObject({
        filename: IMAGE_EDITOR_DRAWER_PNG.name,
        filetype: IMAGE_EDITOR_DRAWER_PNG.mimeType,
      });
      expect(submitted.submissions[0]).toMatchObject({
        upload_urls: ['/api/sigint/file-upload/tus/editor-upload'],
      });
    });
  }

  test('cancelling an unsaved edit uploads no replacement', async ({ page }) => {
    let uploadRequests = 0;
    page.on('request', (request) => {
      if (request.url().includes('/api/sigint/file-upload/tus')) uploadRequests += 1;
    });
    await openCreateMessageDrawer(page, 'duty');
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();

    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Текст' }).click();
    const canvas = editor.locator('canvas[data-fabric="top"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas редактора не має розмірів');
    await page.mouse.click(box.x + 1, box.y + 1);
    await page.keyboard.type('E2E');
    await editor.locator('footer').getByRole('button', { name: 'Скасувати' }).click();
    await expect(editor.getByText('Є незастосовані зміни.')).toBeVisible();
    await editor.getByRole('button', { name: 'Відкинути' }).click();

    await expect(editor).toHaveCount(0);
    await expect(page.locator('.MuiDrawer-paper')).toHaveCount(0);
    expect(uploadRequests).toBe(0);
  });

  test('cancelling the parent drawer after an applied replacement uploads nothing', async ({
    page,
  }) => {
    await openEditMessageDrawer(page);
    const submitted = await observeImageEditorSubmission(page);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await editor.getByRole('button', { name: 'Текст' }).click();
    const canvas = editor.locator('canvas[data-fabric="top"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas редактора не має розмірів');
    await page.mouse.click(box.x + 30, box.y + 30);
    await page.keyboard.type('edited');
    await editor.getByRole('button', { name: 'Застосувати' }).click();
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page.getByRole('button', { name: 'Скасувати' }).click();
    await expect(page.locator('.MuiDrawer-paper')).toHaveCount(0);
    expect(submitted.uploads).toHaveLength(0);
    expect(submitted.submissions).toHaveLength(0);
  });

  test('mobile editor keeps canvas, toolbar, and footer actions reachable', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 800 });
    await openCreateMessageDrawer(page, 'duty');
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    await page.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Текст' })).toBeVisible();
    await expect(editor.locator('footer').getByRole('button', { name: 'Скасувати' })).toBeVisible();
    await expect(
      editor.locator('footer').getByRole('button', { name: 'Застосувати' }),
    ).toBeVisible();
    await editor.locator('footer').getByRole('button', { name: 'Скасувати' }).click();
    await expect(editor).toHaveCount(0);
  });

  test('edit-message drawer replaces one existing image through the real edit action', async ({
    page,
  }) => {
    await openEditMessageDrawer(page);
    const submitted = await observeImageEditorSubmission(page);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Текст' }).click();
    const canvas = editor.locator('canvas[data-fabric="top"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas редактора не має розмірів');
    await page.mouse.click(box.x + 30, box.y + 30);
    await page.keyboard.type('edited');
    await editor.getByRole('button', { name: 'Застосувати' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    expect(submitted.uploads).toHaveLength(0);
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page.getByRole('button', { name: 'Зберегти' }).click();
    await expect.poll(() => submitted.submissions.length).toBe(1);
    expect(submitted.uploads).toHaveLength(1);
    expect(submitted.uploads[0]?.bytes.equals(IMAGE_EDITOR_DRAWER_PNG.buffer)).toBe(false);
    expect(submitted.uploads[0]?.metadata).toMatchObject({
      filename: IMAGE_EDITOR_DRAWER_PNG.name,
      filetype: IMAGE_EDITOR_DRAWER_PNG.mimeType,
    });
    expect(submitted.submissions[0]).toMatchObject({
      deleted_media_ids: ['existing-editor-image'],
      upload_urls: ['/api/sigint/file-upload/tus/editor-upload'],
    });
  });

  test('create-report drawer edits its retained image through the real card action', async ({
    page,
  }) => {
    await openCreateReportDrawer(page);
    const submitted = await observeImageEditorSubmission(page);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Текст' }).click();
    const canvas = editor.locator('canvas[data-fabric="top"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas редактора не має розмірів');
    await page.mouse.click(box.x + 30, box.y + 30);
    await page.keyboard.type('edited');
    await editor.getByRole('button', { name: 'Застосувати' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page
      .getByRole('textbox', { name: 'Текст розвіддонесення' })
      .fill('E2E intelligence report');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Створити' })).toBeEnabled();
    await page.getByRole('button', { name: 'Створити' }).click();
    await expect.poll(() => submitted.submissions.length).toBe(1);
    expect(submitted.uploads).toHaveLength(1);
    expect(submitted.uploads[0]?.bytes.equals(IMAGE_EDITOR_DRAWER_PNG.buffer)).toBe(false);
    expect(submitted.uploads[0]?.metadata).toMatchObject({
      filename: IMAGE_EDITOR_DRAWER_PNG.name,
      filetype: IMAGE_EDITOR_DRAWER_PNG.mimeType,
    });
    expect(submitted.submissions[0]).toMatchObject({
      upload_urls: ['/api/sigint/file-upload/tus/editor-upload'],
    });
  });

  test('edit-report drawer edits an existing image through the real report action', async ({
    page,
  }) => {
    await openEditReportDrawer(page);
    const submitted = await observeImageEditorSubmission(page);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
    await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
    await editor.getByRole('button', { name: 'Текст' }).click();
    const canvas = editor.locator('canvas[data-fabric="top"]');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('Canvas редактора не має розмірів');
    await page.mouse.click(box.x + 30, box.y + 30);
    await page.keyboard.type('edited');
    await editor.getByRole('button', { name: 'Застосувати' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    await preview.getByRole('button', { name: 'Закрити' }).click();
    await page
      .getByRole('textbox', { name: 'Текст розвіддонесення' })
      .fill('E2E intelligence report');
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: 'Зберегти' })).toBeEnabled();
    await page.getByRole('button', { name: 'Зберегти' }).click();
    await expect.poll(() => submitted.submissions.length).toBe(1);
    expect(submitted.uploads).toHaveLength(1);
    expect(submitted.uploads[0]?.bytes.equals(IMAGE_EDITOR_DRAWER_PNG.buffer)).toBe(false);
    expect(submitted.uploads[0]?.metadata).toMatchObject({
      filename: IMAGE_EDITOR_DRAWER_PNG.name,
      filetype: IMAGE_EDITOR_DRAWER_PNG.mimeType,
    });
    expect(submitted.submissions[0]).toMatchObject({
      deleted_media_ids: ['existing-editor-image'],
      upload_urls: ['/api/sigint/file-upload/tus/editor-upload'],
    });
  });
});
