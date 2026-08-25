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
      await openCreateMessageDrawer(page, host);
      await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
      await expect(page.getByText('Вкладення (1)')).toBeVisible();

      await page
        .getByRole('button', { name: `Більше дій для ${IMAGE_EDITOR_DRAWER_PNG.name}` })
        .click();
      await page.getByRole('menuitem', { name: 'Редагувати' }).click();
      const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
      await expect(preview).toBeVisible();

      const editor = page.getByLabel('Редактор зображення');
      await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
      await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(editor.getByRole('button', { name: 'Перемістити полотно' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(editor.getByRole('button', { name: 'Видалити вибране' })).toBeDisabled();
      await expect(editor.getByRole('button', { name: 'Видалити вибране' })).not.toHaveAttribute(
        'aria-pressed',
      );
      await expect(editor.getByRole('button', { name: 'Вмістити у вікно' })).not.toHaveAttribute(
        'aria-pressed',
      );
      const workspace = editor.locator('[data-image-editor-workspace]');
      const documentShell = editor.locator('[data-image-editor-document]');
      const workspaceBox = await workspace.boundingBox();
      const documentBox = await documentShell.boundingBox();
      if (!workspaceBox || !documentBox)
        throw new Error('Робоча область редактора не має розмірів');
      expect(documentBox.x + documentBox.width / 2).toBeCloseTo(
        workspaceBox.x + workspaceBox.width / 2,
        0,
      );
      expect(documentBox.y + documentBox.height / 2).toBeCloseTo(
        workspaceBox.y + workspaceBox.height / 2,
        0,
      );
      await editor.getByRole('button', { name: 'Перемістити полотно' }).click();
      await page.mouse.move(workspaceBox.x + 8, workspaceBox.y + 8);
      await page.mouse.down();
      await page.mouse.move(workspaceBox.x + 28, workspaceBox.y + 18);
      await page.mouse.up();
      await expect
        .poll(async () => (await documentShell.boundingBox())?.x)
        .toBeGreaterThan(documentBox.x + 10);
      await page.mouse.move(workspaceBox.x + 8, workspaceBox.y + 8);
      await page.mouse.wheel(0, -120);
      await expect(editor.getByText('110%', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Вмістити у вікно' }).click();
      await expect(editor.getByText('100%', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Збільшити масштаб' }).click();
      await expect(editor.getByText('110%', { exact: true })).toBeVisible();
      await editor.getByRole('button', { name: 'Центрувати' }).click();
      await expect
        .poll(async () => {
          const box = await documentShell.boundingBox();
          return box ? box.x + box.width / 2 : undefined;
        })
        .toBeCloseTo(workspaceBox.x + workspaceBox.width / 2, 0);
      await editor.getByRole('button', { name: '1:1' }).click();
      await expect(editor.getByText('100%', { exact: true })).toBeVisible();
      const canvas = editor.locator('canvas[data-fabric="top"]');
      const box = await canvas.boundingBox();
      if (!box) throw new Error('Canvas редактора не має розмірів');
      await editor.getByRole('button', { name: 'Текст' }).click();
      await page.mouse.click(box.x + 40, box.y + 40);
      await page.keyboard.type('контекст');
      await editor.getByRole('button', { name: 'Вибрати об’єкт' }).click();
      await expect(editor.getByLabel('Колір')).toBeVisible();
      await expect(editor.getByLabel('Розмір тексту')).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Напівжирний текст' })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
      await expect(editor.getByLabel('Пунктир')).toHaveCount(0);
      await editor.getByRole('button', { name: 'Прямокутник' }).click();
      await page.mouse.move(box.x + 60, box.y + 60);
      await page.mouse.down();
      await page.mouse.move(box.x + 100, box.y + 100);
      await page.mouse.up();
      await editor.getByRole('button', { name: 'Вибрати об’єкт' }).click();
      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      await page.mouse.click(box.x + 60, box.y + 60);
      await expect(editor.getByLabel('Колір контуру')).toBeVisible();
      await expect(editor.getByLabel('Колір заливки')).toBeVisible();
      await expect(editor.getByLabel('Товщина контуру')).toBeVisible();
      await expect(editor.getByLabel('Пунктир')).toBeVisible();
      await editor.getByRole('button', { name: 'Стрілка' }).click();
      await page.mouse.move(box.x + 130, box.y + 130);
      await page.mouse.down();
      await page.mouse.move(box.x + 200, box.y + 130);
      await page.mouse.up();
      await expect(
        editor.getByLabel('Інструменти редактора').getByRole('button', { name: 'Скасувати' }),
      ).toBeEnabled();
      await editor.getByRole('button', { name: 'Вибрати об’єкт' }).click();
      await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      const arrowPosition = await documentShell.boundingBox();
      if (!arrowPosition) throw new Error('Полотно редактора не має розмірів');
      await page.mouse.click(arrowPosition.x + 125, arrowPosition.y + 105);
      await expect(editor.getByLabel('Товщина контуру')).toHaveValue('4');
      await editor.getByLabel('Товщина контуру').press('ArrowRight');
      await editor.getByLabel('Товщина контуру').press('ArrowRight');
      await editor.getByLabel('Товщина контуру').press('ArrowRight');
      await expect(editor.getByLabel('Товщина контуру')).toHaveValue('7');
      await editor.getByLabel('Колір контуру').fill('#00ff00');
      await expect(editor.getByLabel('Колір контуру')).toHaveValue('#00ff00');
      await editor
        .getByLabel('Інструменти редактора')
        .getByRole('button', { name: 'Скасувати' })
        .click();
      await expect(
        editor.getByLabel('Інструменти редактора').getByRole('button', { name: 'Повторити' }),
      ).toBeEnabled();
      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      await page.mouse.click(arrowPosition.x + 125, arrowPosition.y + 105);
      await expect(editor.getByLabel('Товщина контуру')).toHaveValue('4');
      await expect(editor.getByLabel('Колір контуру')).toHaveValue('#ef4444');
      await editor
        .getByLabel('Інструменти редактора')
        .getByRole('button', { name: 'Повторити' })
        .click();
      await expect(
        editor.getByLabel('Інструменти редактора').getByRole('button', { name: 'Повторити' }),
      ).toBeDisabled();
      await page.mouse.click(box.x + box.width - 4, box.y + box.height - 4);
      await page.mouse.click(arrowPosition.x + 125, arrowPosition.y + 105);
      await expect(editor.getByLabel('Товщина контуру')).toHaveValue('7');
      await expect(editor.getByLabel('Колір контуру')).toHaveValue('#00ff00');
      await editor.getByRole('button', { name: 'Застосувати' }).click();

      await expect(editor).toHaveCount(0);
      await expect(preview).toBeVisible();
      await expect(preview.locator('[data-attachment-preview-counter]')).toHaveText('1 / 1');
      await preview.getByRole('button', { name: 'Закрити' }).click();
      await expect(page.getByText('Вкладення (1)')).toBeVisible();
      await expect(
        page.getByRole('button', { name: `Видалити ${IMAGE_EDITOR_DRAWER_PNG.name}` }),
      ).toHaveCount(1);
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
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    expect(uploadRequests).toBe(0);
  });

  test('keeps a loaded editor available after an export failure', async ({ page }) => {
    await openCreateMessageDrawer(page, 'duty');
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    await page.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
    await page.evaluate(() => {
      HTMLCanvasElement.prototype.toBlob = function (callback) {
        callback(null);
      };
    });
    await editor.getByRole('button', { name: 'Застосувати' }).click();
    await expect(editor.getByText('Не вдалося експортувати зображення')).toHaveCount(1);
    await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Застосувати' })).toBeEnabled();
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

  test('editor keeps canvas, toolbar, and footer actions reachable across target viewports', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openCreateMessageDrawer(page, 'duty');
    await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
    await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
    await page.getByRole('button', { name: 'Редагувати зображення' }).click();
    const editor = page.getByLabel('Редактор зображення');
    for (const viewport of [
      { width: 1440, height: 900 },
      { width: 768, height: 900 },
      { width: 360, height: 800 },
    ]) {
      await page.setViewportSize(viewport);
      await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
      await expect(editor.getByRole('button', { name: 'Текст', exact: true })).toBeVisible();
      const textTool = await editor
        .getByRole('button', { name: 'Текст', exact: true })
        .boundingBox();
      if (!textTool || textTool.x < 0 || textTool.x + textTool.width > viewport.width)
        throw new Error('Текстовий інструмент недосяжний у поточній ширині');
      const workspace = editor.locator('[data-image-editor-workspace]');
      const documentShell = editor.locator('[data-image-editor-document]');
      const workspaceBox = await workspace.boundingBox();
      const documentBox = await documentShell.boundingBox();
      if (!workspaceBox || !documentBox)
        throw new Error('Робоча область редактора не має розмірів');
      expect(documentBox.x + documentBox.width / 2).toBeCloseTo(
        workspaceBox.x + workspaceBox.width / 2,
        0,
      );
      await expect(
        editor.locator('footer').getByRole('button', { name: 'Скасувати' }),
      ).toBeVisible();
      await expect(
        editor.locator('footer').getByRole('button', { name: 'Застосувати' }),
      ).toBeVisible();
      await expect.poll(async () => (await workspace.boundingBox())?.height).toBeGreaterThan(0);
      await expect(editor.locator('[data-image-editor-contextual-row]')).toBeVisible();
      const workspaceHeightWithContext = (await workspace.boundingBox())?.height;
      if (!workspaceHeightWithContext) throw new Error('Робоча область редактора не має розмірів');
      await editor.getByRole('button', { name: 'Перемістити полотно' }).click();
      await expect(editor.locator('[data-image-editor-contextual-row]')).toHaveCount(0);
      await expect
        .poll(async () => (await workspace.boundingBox())?.height)
        .toBeGreaterThan(workspaceHeightWithContext);
      await editor.getByRole('button', { name: 'Текст', exact: true }).click();
      await expect(editor.locator('[data-image-editor-contextual-row]')).toBeVisible();
      if (viewport.width < 1280) {
        await expect(editor.getByRole('button', { name: 'Більше' })).toBeVisible();
        await editor.getByRole('button', { name: 'Приховати дані' }).click();
        await expect(editor.getByLabel('Приховування')).toBeVisible();
        await editor.getByRole('button', { name: 'Лупа' }).click();
        await expect(editor.getByLabel('Збільшення лупи')).toBeVisible();
        await editor.getByRole('button', { name: 'Більше' }).click();
        await expect(page.getByRole('menu', { name: 'Більше' })).toBeVisible();
        await expect(page.getByRole('menuitem', { name: 'Обрізати' })).toBeFocused();
        await page.keyboard.press('ArrowDown');
        await expect(page.getByRole('menuitem', { name: 'Прямокутник' })).toBeFocused();
        await expect(page.getByRole('menuitem', { name: 'Вмістити у вікно' })).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(editor.getByRole('button', { name: 'Більше' })).toBeFocused();
      }
    }
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
