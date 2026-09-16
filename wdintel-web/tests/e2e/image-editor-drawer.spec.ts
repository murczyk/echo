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

function capturePageErrors(page: import('@playwright/test').Page) {
  const errors: Error[] = [];
  const onPageError = (error: Error) => errors.push(error);
  let active = true;
  page.on('pageerror', onPageError);
  const dispose = () => {
    if (!active) return;
    active = false;
    page.off('pageerror', onPageError);
  };
  return {
    assertNone: () => {
      dispose();
      expect(errors.map((error) => error.stack ?? error.message).join('\n\n')).toBe('');
    },
    dispose,
  };
}

type TextAnnotationState = {
  left: number;
  top: number;
  scaleX: number;
  scaleY: number;
  width: number;
  height: number;
  angle: number;
  text: string;
  bounds: { left: number; top: number; width: number; height: number };
  canvas: { width: number; height: number };
  selected: boolean;
};

async function selectedTextState(
  editor: import('@playwright/test').Locator,
): Promise<TextAnnotationState> {
  return editor.locator('canvas.lower-canvas').evaluate((element) => {
    const canvas = (
      element as HTMLCanvasElement & {
        __imageEditorTestCanvas?: {
          getActiveObject: () => {
            left?: number;
            top?: number;
            scaleX?: number;
            scaleY?: number;
            width?: number;
            height?: number;
            angle?: number;
            text?: string;
            getBoundingRect: () => { left: number; top: number; width: number; height: number };
          } | null;
          width: number;
          height: number;
        };
      }
    ).__imageEditorTestCanvas;
    const text = canvas?.getActiveObject();
    if (!canvas || !text) throw new Error('Selected text annotation is unavailable');
    return {
      left: text.left ?? 0,
      top: text.top ?? 0,
      scaleX: text.scaleX ?? 1,
      scaleY: text.scaleY ?? 1,
      width: text.width ?? 0,
      height: text.height ?? 0,
      angle: text.angle ?? 0,
      text: text.text ?? '',
      bounds: text.getBoundingRect(),
      canvas: { width: canvas.width, height: canvas.height },
      selected: true,
    };
  });
}

function documentPointToScreen(
  surface: { x: number; y: number; width: number; height: number },
  state: TextAnnotationState,
  point: { x: number; y: number },
) {
  return {
    x: surface.x + (point.x * surface.width) / state.canvas.width,
    y: surface.y + (point.y * surface.height) / state.canvas.height,
  };
}

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

async function openSecondPendingImageEditor(page: import('@playwright/test').Page) {
  await openCreateMessageDrawer(page, 'duty');
  await page.locator('input[type="file"]').setInputFiles(IMAGE_EDITOR_DRAWER_PNG);
  await page.getByRole('button', { name: `Переглянути ${IMAGE_EDITOR_DRAWER_PNG.name}` }).click();
  const preview = page.getByRole('dialog', { name: 'Перегляд зображення' });
  await preview.getByRole('button', { name: 'Редагувати зображення' }).click();
  return page.getByLabel('Редактор зображення');
}

test.describe('image editor drawer integration #3448', () => {
  for (const host of ['duty', 'analysis'] as const satisfies ImageEditorDrawerHost[]) {
    // @test-scope regression: https://github.com/echoua/echo/issues/3448
    test(`${host} opens from preview and saves one pending replacement @regression`, async ({
      page,
    }) => {
      const pageErrors = capturePageErrors(page);
      const submitted = await observeImageEditorSubmission(page);
      const { editor, preview } = await openPendingImageEditor(page, host);
      await saveMinimalReplacement(page, editor);
      await expect(editor).toHaveCount(0);
      await preview.getByRole('button', { name: 'Закрити' }).click();
      await expect(page.getByText('Вкладення (1)')).toBeVisible();
      expect(submitted.uploads).toHaveLength(0);
      pageErrors.assertNone();
      pageErrors.dispose();
    });
  }

  // @test-scope safeguard: prevents a cancelled pending edit from creating replacement uploads.
  test('cancelling an edit creates no replacement upload', async ({ page }) => {
    const pageErrors = capturePageErrors(page);
    const submitted = await observeImageEditorSubmission(page);
    const { editor } = await openPendingImageEditor(page, 'duty');
    await expect(editor.getByRole('button', { name: 'Текст' })).toBeEnabled();
    await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
    await editor.locator('footer').getByRole('button', { name: 'Скасувати' }).click();
    await expect(editor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    const secondEditor = await openSecondPendingImageEditor(page);
    await expect(secondEditor.getByRole('button', { name: 'Текст' })).toBeEnabled();
    await expect(secondEditor.locator('canvas[data-fabric="top"]')).toBeVisible();
    await secondEditor.locator('footer').getByRole('button', { name: 'Скасувати' }).click();
    await expect(secondEditor).toHaveCount(0);
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    expect(submitted.uploads).toHaveLength(0);
    expect(submitted.submissions).toHaveLength(0);
    pageErrors.assertNone();
  });

  // @test-scope safeguard: preserves persisted-media replacement and deletion identity.
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

  // @test-scope safeguard: retains a rejected TUS upload through the multipart fallback.
  test('falls back to multipart when the TUS chunk is rejected', async ({ page }) => {
    const pageErrors = capturePageErrors(page);
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
    pageErrors.assertNone();
    pageErrors.dispose();
  });

  // @test-scope safeguard: aborts an in-flight fallback upload after route teardown.
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3448
  test('finishes text editing on an empty-canvas click without creating a second label #3448 @regression', async ({
    page,
  }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Текст', exact: true }).click();
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

  // @test-scope regression: https://github.com/echoua/echo/issues/3448
  test('selects the clicked annotation after ending another text edit #3448 @regression', async ({
    page,
  }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await editor.getByRole('button', { name: 'Текст', exact: true }).click();
    await page.mouse.click(box!.x + box!.width * 0.25, box!.y + box!.height * 0.25);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('П1');
    await page.mouse.click(box!.x + box!.width * 0.8, box!.y + box!.height * 0.8);
    const first = await selectedTextState(editor);

    await editor.getByRole('button', { name: 'Текст', exact: true }).click();
    await page.mouse.click(box!.x + box!.width * 0.65, box!.y + box!.height * 0.65);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('П2');
    const firstCenter = documentPointToScreen(box!, first, {
      x: first.bounds.left + first.bounds.width / 2,
      y: first.bounds.top + first.bounds.height / 2,
    });
    await page.mouse.click(firstCenter.x, firstCenter.y);

    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(editor.locator('textarea')).toHaveCount(0);
    await expect.poll(() => selectedTextState(editor).then((state) => state.text)).toBe(first.text);
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3448
  test('moves text frames without changing their transforms at non-default zoom #3448 @regression', async ({
    page,
  }) => {
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Збільшити масштаб' }).click();
    await expect(editor.getByText('110%', { exact: true })).toBeVisible();
    await editor.getByRole('button', { name: 'Текст' }).click();
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    const origin = { x: box!.x + box!.width * 0.3, y: box!.y + box!.height * 0.3 };
    await page.mouse.click(origin.x, origin.y);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('Рух');
    const before = await selectedTextState(editor);
    const frameStart = documentPointToScreen(box!, before, {
      x: before.bounds.left + before.bounds.width / 2,
      y: before.bounds.top,
    });
    const documentDelta = { x: 24, y: 18 };
    const screenDelta = {
      x: (documentDelta.x * box!.width) / before.canvas.width,
      y: (documentDelta.y * box!.height) / before.canvas.height,
    };
    await page.mouse.move(frameStart.x, frameStart.y);
    await page.mouse.down();
    await page.mouse.move(frameStart.x + screenDelta.x, frameStart.y + screenDelta.y);
    await page.mouse.up();
    const afterOuterFrameDrag = await selectedTextState(editor);
    expect(afterOuterFrameDrag.left).toBeCloseTo(before.left + documentDelta.x, 0);
    expect(afterOuterFrameDrag.top).toBeCloseTo(before.top + documentDelta.y, 0);
    expect(afterOuterFrameDrag.scaleX).toBe(before.scaleX);
    expect(afterOuterFrameDrag.scaleY).toBe(before.scaleY);
    expect(afterOuterFrameDrag.width).toBe(before.width);
    expect(afterOuterFrameDrag.height).toBe(before.height);
    expect(afterOuterFrameDrag.angle).toBe(before.angle);
    expect(afterOuterFrameDrag.text).toBe(before.text);
    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    const center = documentPointToScreen(box!, afterOuterFrameDrag, {
      x: afterOuterFrameDrag.bounds.left + afterOuterFrameDrag.bounds.width / 2,
      y: afterOuterFrameDrag.bounds.top + afterOuterFrameDrag.bounds.height / 2,
    });
    await page.mouse.dblclick(center.x, center.y);
    await expect(editor.locator('textarea')).toBeFocused();
    const beforeEdgeDrag = await selectedTextState(editor);
    const edgeStart = documentPointToScreen(box!, beforeEdgeDrag, {
      x: beforeEdgeDrag.bounds.left,
      y: beforeEdgeDrag.bounds.top + beforeEdgeDrag.bounds.height / 2,
    });
    await page.mouse.move(edgeStart.x, edgeStart.y);
    await page.mouse.down();
    await page.mouse.move(edgeStart.x + screenDelta.x, edgeStart.y + screenDelta.y);
    await page.mouse.up();
    const afterEdgeDrag = await selectedTextState(editor);
    expect(afterEdgeDrag.left).toBeCloseTo(beforeEdgeDrag.left + documentDelta.x, 0);
    expect(afterEdgeDrag.top).toBeCloseTo(beforeEdgeDrag.top + documentDelta.y, 0);
    expect(afterEdgeDrag.scaleX).toBe(beforeEdgeDrag.scaleX);
    expect(afterEdgeDrag.scaleY).toBe(beforeEdgeDrag.scaleY);
    expect(afterEdgeDrag.width).toBe(beforeEdgeDrag.width);
    expect(afterEdgeDrag.height).toBe(beforeEdgeDrag.height);
    expect(afterEdgeDrag.angle).toBe(beforeEdgeDrag.angle);
    expect(afterEdgeDrag.text).toBe(beforeEdgeDrag.text);
    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3448
  test('cancels an active text-frame move without committing it #3448 @regression', async ({
    page,
  }) => {
    const pageErrors = capturePageErrors(page);
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Текст' }).click();
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('Скасований рух');
    const before = await selectedTextState(editor);
    const frameStart = documentPointToScreen(box!, before, {
      x: before.bounds.left + before.bounds.width / 2,
      y: before.bounds.top,
    });
    await page.mouse.move(frameStart.x, frameStart.y);
    await page.mouse.down();
    await page.mouse.move(frameStart.x + 70, frameStart.y + 50);
    await page.keyboard.press('Escape');
    await page.mouse.move(frameStart.x + 120, frameStart.y + 90);
    await page.mouse.up();
    const after = await selectedTextState(editor);
    expect(after.left).toBe(before.left);
    expect(after.top).toBe(before.top);
    expect(after.scaleX).toBe(before.scaleX);
    expect(after.scaleY).toBe(before.scaleY);
    expect(after.width).toBe(before.width);
    expect(after.height).toBe(before.height);
    expect(after.angle).toBe(before.angle);
    expect(after.text).toBe(before.text);
    await expect(editor.getByRole('button', { name: 'Вибрати об’єкт' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(editor.locator('textarea')).toHaveCount(0);
    pageErrors.assertNone();
  });

  // @test-scope regression: https://github.com/echoua/echo/issues/3448
  test('tears down an editor with an active text-frame pointer gesture #3448 @regression', async ({
    page,
  }) => {
    const pageErrors = capturePageErrors(page);
    const { editor } = await openPendingImageEditor(page, 'duty');
    await editor.getByRole('button', { name: 'Текст' }).click();
    const surface = editor.locator('canvas').last();
    const box = await surface.boundingBox();
    expect(box).not.toBeNull();
    await page.mouse.click(box!.x + box!.width * 0.3, box!.y + box!.height * 0.3);
    await expect(editor.locator('textarea')).toBeFocused();
    await page.keyboard.type('Активний рух');
    const state = await selectedTextState(editor);
    const frameStart = documentPointToScreen(box!, state, {
      x: state.bounds.left + state.bounds.width / 2,
      y: state.bounds.top,
    });
    await page.mouse.move(frameStart.x, frameStart.y);
    await page.mouse.down();
    await page.mouse.move(frameStart.x + 70, frameStart.y + 50);
    await editor
      .locator('footer')
      .getByRole('button', { name: 'Скасувати' })
      .dispatchEvent('click');
    const discard = page.getByRole('dialog', { name: 'Відкинути зміни зображення?' });
    await expect(discard).toBeVisible();
    await discard.getByRole('button', { name: 'Відкинути зміни' }).dispatchEvent('click');
    await expect(editor).toHaveCount(0);
    await page.mouse.move(frameStart.x + 120, frameStart.y + 90);
    await page.mouse.up();
    await expect(page.getByText('Вкладення (1)')).toBeVisible();
    const reopenedEditor = await openSecondPendingImageEditor(page);
    await expect(reopenedEditor.locator('canvas[data-fabric="top"]')).toBeVisible();
    pageErrors.assertNone();
  });
});

for (const status of [401, 403, 413]) {
  // @test-scope safeguard: prevents terminal TUS failures from producing fallback or saved media.
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

// @test-scope safeguard: resumes an accepted chunk without duplicate upload creation or byte loss.
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

// @test-scope regression: https://github.com/echoua/echo/issues/3448
test('keeps editor actions reachable at representative viewports @regression', async ({ page }) => {
  const { editor } = await openPendingImageEditor(page, 'duty');
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 768, height: 900 },
    { width: 360, height: 800 },
  ]) {
    await page.setViewportSize(viewport);
    await expect(editor.locator('canvas[data-fabric="top"]')).toBeVisible();
    await expect(editor.getByRole('button', { name: 'Текст', exact: true })).toBeVisible();
    await expect(editor.locator('footer').getByRole('button', { name: 'Скасувати' })).toBeVisible();
    await expect(
      editor.locator('footer').getByRole('button', { name: 'Зберегти', exact: true }),
    ).toBeVisible();
  }
});

// @test-scope regression: https://github.com/echoua/echo/issues/3448
test('presents shortcut help across desktop and mobile controls #3448 @regression', async ({
  page,
}) => {
  const { editor } = await openPendingImageEditor(page, 'duty');
  await page.setViewportSize({ width: 360, height: 800 });
  await editor.getByRole('button', { name: 'Ще' }).click();
  await page.getByRole('menuitem', { name: 'Гарячі клавіші' }).click();
  const help = page.getByRole('heading', { name: 'Гарячі клавіші' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toBeHidden();
  await expect(editor).toBeVisible();
});

// @test-scope regression: https://github.com/echoua/echo/issues/3448
test('keeps standalone-arrow toolbar styles combined after each edit #3448 @regression', async ({
  page,
}) => {
  const { editor } = await openPendingImageEditor(page, 'duty');
  await editor.getByRole('button', { name: 'Стрілка' }).click();
  const surface = editor.locator('canvas').last();
  const box = await surface.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box!.x + 40, box!.y + 50);
  await page.mouse.down();
  await page.mouse.move(box!.x + 180, box!.y + 100);
  await page.mouse.up();
  await editor.getByRole('button', { name: 'Вибрати об’єкт' }).click();
  await page.mouse.click(box!.x + 110, box!.y + 75);
  const width = editor.getByRole('slider', { name: 'Товщина' });
  await expect(width).toHaveValue('4');
  const color = editor.getByLabel('Контур');
  await color.evaluate((input: HTMLInputElement) => {
    input.value = '#22c55e';
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await expect(width).toHaveValue('4');
  const dash = editor.getByRole('button', { name: 'Пунктир' });
  await dash.click();
  await expect(dash).toHaveAttribute('aria-pressed', 'true');
  await width.press('ArrowRight');
  await expect(width).toHaveValue('5');
  await expect(dash).toHaveAttribute('aria-pressed', 'true');
});

// @test-scope regression: https://github.com/echoua/echo/issues/3294
test('large single-IDAT PNG remains editable within image source limits #3294 @regression', async ({
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
