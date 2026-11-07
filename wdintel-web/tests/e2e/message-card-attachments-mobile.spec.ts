import { expect, test, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import {
  buildMessageCardMediaPreviewInboxResponse,
  buildValidWavAudioFixture,
  openMessageCardPreviewHost,
} from './message-card-media-preview.fixtures';

test.use({ hasTouch: true });

async function openAttachment(
  page: Page,
  host: 'analysis' | 'duty',
  fileName = 'e2e-preview.txt',
  longText = false,
  desktop = false,
) {
  await page.setViewportSize(
    host === 'duty' && !desktop ? { width: 375, height: 812 } : { width: 1440, height: 900 },
  );
  const options = { withLegacyOffice: true, withZip: true, withKmlPreviews: true };
  const media = buildMessageCardMediaPreviewInboxResponse(options).inbox_items[0][1].media ?? [];
  const extra = [
    ['pdf', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
    ['csv', 'text/csv'],
  ].map(([extension, contentType]) => ({
    id: `mobile-${extension}`,
    fileName: `mobile-document.${extension}`,
    contentType,
    href: `/test-assets/mobile-document.${extension}`,
    sizeBytes: 1024,
    transcription: null,
    ocr: null,
    summary: null,
    coordinateStatus: null,
    kmzConversionStatus: null,
    positions: [],
  }));
  await page.route('**/test-assets/mobile-document.*', async (route) => {
    const extension = new URL(route.request().url()).pathname.split('.').pop()!;
    const body = await readFile(
      new URL(`fixtures/device-file-preview/document.${extension}`, import.meta.url),
    );
    await route.fulfill({
      body: route.request().method() === 'HEAD' ? '' : body,
      contentType: extra.find((item) => item.id === `mobile-${extension}`)!.contentType,
      headers: { 'content-length': String(body.byteLength) },
    });
  });
  await openMessageCardPreviewHost(page, host, {
    ...options,
    messageOverrides: { media: [...media, ...extra] },
  });
  if (longText)
    await page.route('**/e2e-preview.txt', (route) =>
      route.fulfill({
        contentType: 'text/plain; charset=utf-8',
        body: Array.from({ length: 200 }, (_, i) => `Рядок ${i + 1}`).join('\n'),
      }),
    );
  if (longText)
    await page.route('**/test-assets/mobile-document.csv', (route) =>
      route.fulfill({
        contentType: 'text/csv',
        body: Array.from(
          { length: 400 },
          (_, index) => `Item ${index + 1},Value ${index + 1}`,
        ).join('\n'),
      }),
    );
  if (host === 'analysis' && !desktop) {
    await page.goto('/rer-analysis-neo?leftPanelOpen=false&filterPanelOpen=false');
    await page.setViewportSize({ width: 375, height: 812 });
  }
  const documents = page.getByRole('button', { name: /^(Розгорнути|Згорнути) документи:/ });
  if ((await documents.getAttribute('aria-expanded')) !== 'true') await documents.click();
  const viewport = await page.locator('meta[name="viewport"]').getAttribute('content');
  if (fileName === '@audio') {
    await page.route('**/e2e-audio.wav', (route) =>
      route.fulfill({
        contentType: 'audio/wav',
        body: buildValidWavAudioFixture(10),
      }),
    );
    const media = page.getByRole('button', { name: /^(Розгорнути|Згорнути) медіа:/ });
    if ((await media.getAttribute('aria-expanded')) !== 'true') await media.click();
    await page.getByRole('button', { name: 'Відкрити зображення' }).first().click();
    for (
      let index = 0;
      index < 25 &&
      (await page.getByRole('dialog').getAttribute('aria-label')) !== 'Перегляд аудіо';
      index++
    )
      await page.getByRole('dialog').getByRole('button', { name: 'Наступне', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Перегляд аудіо' })).toBeVisible();
  } else if (fileName === '@coordinate') {
    const coordinates = page.getByRole('button', { name: /^(Розгорнути|Згорнути) координати:/ });
    if ((await coordinates.getAttribute('aria-expanded')) !== 'true') await coordinates.click();
    await page
      .locator('[data-coordinate-preview-tile]')
      .first()
      .getByRole('button', { name: /Open .* on map/ })
      .click();
  } else await page.getByRole('button', { name: fileName, exact: true }).click();
  return { dialog: page.getByRole('dialog'), viewport };
}

for (const host of ['analysis', 'duty'] as const) {
  test(`@regression #3340 ${host}: documents share mobile chrome without changing text geometry`, async ({
    page,
  }, testInfo) => {
    const { dialog, viewport } = await openAttachment(page, host);
    const header = dialog.getByRole('heading', { name: 'e2e-preview.txt', exact: true });
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    await expect(island).toBeVisible();
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
      'content',
      /viewport-fit=cover/,
    );
    const stage = (await dialog.locator('[data-attachment-preview-swipe-content]').boundingBox())!;
    expect(stage.y).toBe(0);
    expect(stage.height).toBe(812);
    const content = dialog.getByText('E2E TXT preview line 1', { exact: false });
    await expect(content).toBeVisible();
    const bounds = (await content.boundingBox())!;
    const point = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
    await page.touchscreen.tap(point.x, point.y);
    await expect(header).toBeHidden();
    await expect(island).toBeHidden();
    expect(await content.boundingBox()).toEqual(bounds);
    await page.touchscreen.tap(point.x + 30, point.y);
    await expect(header).toBeVisible();
    await expect(island).toBeVisible();
    expect(await content.boundingBox()).toEqual(bounds);
    await dialog.screenshot({
      path: testInfo.outputPath('document-mobile.png'),
      animations: 'disabled',
    });
    await island.getByRole('button', { name: 'Наступне', exact: true }).click();
    await expect(
      dialog.getByRole('heading', { name: 'e2e-preview.md', exact: true }),
    ).toBeVisible();
    await expect(island).toBeVisible();
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(page.locator('meta[name="viewport"]')).toHaveAttribute('content', viewport!);
  });
}

for (const fileName of [
  'e2e-preview.md',
  'e2e-preview.doc',
  'e2e-preview.zip',
  'mobile-document.pdf',
]) {
  test(`@regression #3340 ${fileName}: mobile content and actions remain usable with floating navigation`, async ({
    page,
  }, testInfo) => {
    const { dialog } = await openAttachment(page, 'duty', fileName);
    const heading = dialog.getByRole('heading', { name: fileName, exact: true });
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    await expect(island).toBeVisible();
    if (fileName.endsWith('.pdf'))
      await expect(dialog.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    if (fileName.endsWith('.doc')) await expect(dialog.getByRole('article')).toBeVisible();
    if (fileName.endsWith('.zip'))
      await expect(dialog.getByText('nested/member.txt')).toBeVisible();
    const surface = dialog.getByRole('region', { name: 'Область перегляду вкладення' });
    await surface.focus();
    await surface.press('Enter');
    await expect(heading).toBeHidden();
    await expect(island).toBeHidden();
    await surface.press('Space');
    await expect(heading).toBeVisible();
    await expect(island).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath('attachment-mobile.png'),
      animations: 'disabled',
    });
    if (fileName.endsWith('.zip')) {
      const download = dialog.getByRole('button', {
        name: 'Скачати nested/member.txt',
        exact: true,
      });
      const [file] = await Promise.all([page.waitForEvent('download'), download.click()]);
      expect(file.suggestedFilename()).toBe('member.txt');
      await expect(heading).toBeVisible();
    }
    await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  });
}

for (const fileName of ['e2e-preview.xls', 'mobile-document.xlsx', 'mobile-document.csv']) {
  test(`@regression #3340 ${fileName}: mobile grid keeps cell interactions and visible column headings`, async ({
    page,
  }, testInfo) => {
    const { dialog } = await openAttachment(page, 'duty', fileName);
    const heading = dialog.getByRole('heading', { name: fileName, exact: true });
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    await expect(island).toBeVisible();
    const cell = dialog.locator('td').first();
    await expect(cell).toBeVisible();
    const close = (await dialog
      .getByRole('button', { name: 'Закрити', exact: true })
      .boundingBox())!;
    expect((await cell.boundingBox())!.y).toBeGreaterThan(close.y + close.height);
    await cell.tap();
    await expect(heading).toBeVisible();
    await expect(island).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath('grid-mobile.png'),
      animations: 'disabled',
    });
  });
}

test('@regression #3340 mobile scrolling and text selection do not toggle chrome', async ({
  page,
}) => {
  const { dialog } = await openAttachment(page, 'duty', 'e2e-preview.txt', true);
  const heading = dialog.getByRole('heading', { name: 'e2e-preview.txt', exact: true });
  const content = dialog.locator('pre');
  await expect(content).toContainText('Рядок 200');
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: 180, y: 500 }],
  });
  for (let y = 450; y >= 200; y -= 50)
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 180, y }],
    });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(heading).toBeVisible();
  expect(await content.evaluate((element) => element.parentElement!.scrollTop)).toBeGreaterThan(0);
  await content.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await page.touchscreen.tap(180, 300);
  await expect(heading).toBeVisible();
  await session.detach();
});

test('@regression #3340 mobile audio playback stays independent of chrome taps', async ({
  page,
}, testInfo) => {
  const { dialog } = await openAttachment(page, 'duty', '@audio');
  const heading = dialog.getByRole('heading', { name: 'e2e-audio.wav', exact: true });
  const player = dialog.locator('custom-audio-player');
  await expect(player.locator('#playPauseBtn')).toBeVisible();
  const initialBounds = await player.boundingBox();
  await player.locator('#playPauseBtn').click();
  await expect
    .poll(() => player.evaluate((element: { isPlaying: boolean }) => element.isPlaying))
    .toBe(true);
  await expect(heading).toBeVisible();
  await page.touchscreen.tap(20, 150);
  await expect(heading).toBeHidden();
  expect(await player.boundingBox()).toEqual(initialBounds);
  await expect
    .poll(() => player.evaluate((element: { isPlaying: boolean }) => element.isPlaying))
    .toBe(true);
  await page.touchscreen.tap(20, 150);
  await expect(heading).toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath('audio-mobile.png'),
    animations: 'disabled',
  });
});

test('@regression #3340 coordinate markers keep their own actions in the mobile viewer', async ({
  page,
}, testInfo) => {
  const { dialog } = await openAttachment(page, 'duty', '@coordinate');
  const heading = dialog.getByRole('heading', { name: 'Координати', exact: true, level: 6 });
  const map = dialog.locator('.coordinate-fullscreen-map');
  await expect(map.locator('.coordinate-preview-mgrs-label')).toBeVisible();
  const bounds = (await map.boundingBox())!;
  await page.touchscreen.tap(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await expect(dialog.locator('[data-coordinate-panel]')).toBeVisible();
  await expect(heading).toBeVisible();
  const panelBounds = (await dialog.locator('[data-coordinate-panel]').boundingBox())!;
  const headerBounds = (await heading.locator('xpath=../..').boundingBox())!;
  expect(panelBounds.y).toBeGreaterThanOrEqual(headerBounds.y + headerBounds.height);
  await dialog.getByRole('button', { name: 'Закрити картку координати', exact: true }).tap();
  await page.touchscreen.tap(90, 500);
  await expect(heading).toBeHidden();
  await expect(dialog.locator('[data-attachment-preview-carousel-island]')).toBeHidden();
  await page.touchscreen.tap(40, 500);
  await expect(heading).toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath('coordinate-mobile.png'),
    animations: 'disabled',
  });
});

test('@regression #3340 DOCX taps toggle chrome without resizing content or enabling scripts', async ({
  page,
}, testInfo) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { top: 44, bottom: 34 } });
  const { dialog } = await openAttachment(page, 'duty', 'mobile-document.docx');
  const frame = dialog.locator('iframe');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', 'allow-same-origin');
  await expect(dialog.locator('[data-attachment-preview-carousel-island]')).toBeVisible();
  await expect(page.locator('meta[name="viewport"]')).toHaveAttribute(
    'content',
    /viewport-fit=cover/,
  );
  const body = dialog.frameLocator('iframe').locator('body');
  const heading = dialog.getByRole('heading', { name: 'mobile-document.docx', exact: true });
  const island = dialog.locator('[data-attachment-preview-carousel-island]');
  await expect(body).not.toBeEmpty();
  await expect
    .poll(() => body.evaluate((element) => parseFloat(getComputedStyle(element).paddingTop)))
    .toBe(96);
  await expect
    .poll(() => body.evaluate((element) => parseFloat(getComputedStyle(element).paddingBottom)))
    .toBe(96);
  const initialBounds = await body.boundingBox();
  const frameBounds = await frame.boundingBox();
  await body.tap({ position: { x: 25, y: 180 } });
  await expect(heading).toBeHidden();
  await expect(island).toBeHidden();
  expect(await body.boundingBox()).toEqual(initialBounds);
  expect(await frame.boundingBox()).toEqual(frameBounds);
  await body.tap({ position: { x: 25, y: 180 } });
  await expect(heading).toBeVisible();
  await body.evaluate((element) => {
    const script = element.ownerDocument.createElement('script');
    script.textContent = 'document.body.dataset.scriptExecuted = "yes"';
    element.append(script);
  });
  await expect(body).not.toHaveAttribute('data-script-executed', 'yes');
  await body.evaluate((element) => {
    const selection = element.ownerDocument.getSelection()!;
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(
      Array.from(element.querySelectorAll('p')).find((paragraph) => paragraph.textContent?.trim())!,
    );
    selection.removeAllRanges();
    selection.addRange(range);
  });
  expect(
    await body.evaluate((element) => element.ownerDocument.getSelection()?.toString()),
  ).toBeTruthy();
  await body.dispatchEvent('pointerdown', {
    isPrimary: true,
    button: 0,
    pointerId: 1,
    clientX: 25,
    clientY: 180,
  });
  await body.dispatchEvent('pointerup', {
    isPrimary: true,
    button: 0,
    pointerId: 1,
    clientX: 25,
    clientY: 180,
  });
  await body.dispatchEvent('click');
  await expect(heading).toBeVisible();
  await body.evaluate((element) => element.ownerDocument.getSelection()?.removeAllRanges());
  await body.dispatchEvent('pointerdown', {
    isPrimary: true,
    button: 0,
    pointerId: 1,
    clientX: 25,
    clientY: 180,
  });
  await body.dispatchEvent('pointermove', { pointerId: 1, clientX: 25, clientY: 100 });
  await body.dispatchEvent('pointerup', { pointerId: 1, clientX: 25, clientY: 100 });
  await body.dispatchEvent('click');
  await expect(heading).toBeVisible();
  await dialog.screenshot({
    path: testInfo.outputPath('docx-portrait.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 812, height: 375 });
  await expect.poll(async () => (await frame.boundingBox())?.height).toBe(375);
  await expect(island).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Наступне', exact: true })).toHaveCount(1);
  await expect
    .poll(() => body.evaluate((element) => parseFloat(getComputedStyle(element).paddingTop)))
    .toBeGreaterThan(0);
  await dialog.screenshot({ path: testInfo.outputPath('docx-mobile.png'), animations: 'disabled' });
});

test('@regression #3340 mobile document safe areas and landscape preserve the shared layout', async ({
  page,
}) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setSafeAreaInsetsOverride', {
    insets: { top: 44, bottom: 34, left: 12, right: 16 },
  });
  const { dialog } = await openAttachment(page, 'duty');
  const close = (await dialog.getByRole('button', { name: 'Закрити', exact: true }).boundingBox())!;
  expect(close.y).toBeGreaterThanOrEqual(44);
  expect(close.x + close.width).toBeLessThanOrEqual(375 - 16);
  const island = dialog.locator('[data-attachment-preview-carousel-island]');
  const bounds = (await island.boundingBox())!;
  expect(bounds.y + bounds.height).toBeLessThanOrEqual(812 - 34 - 16);
  await page.setViewportSize({ width: 812, height: 375 });
  await expect(island).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Наступне', exact: true })).toHaveCount(1);
  const stage = (await dialog.locator('[data-attachment-preview-swipe-content]').boundingBox())!;
  expect(stage.y).toBe(0);
  expect(stage.height).toBe(375);
  await session.detach();
});

test('@regression #3340 desktop document layout and clicks remain unchanged', async ({ page }) => {
  const { dialog } = await openAttachment(page, 'duty', 'e2e-preview.txt', false, true);
  await expect(dialog.locator('[data-attachment-preview-carousel-island]')).toHaveCount(0);
  const stage = (await dialog.locator('[data-attachment-preview-swipe-content]').boundingBox())!;
  expect(stage.y).toBe(52);
  await dialog.locator('pre').click();
  await expect(dialog.getByRole('heading', { name: 'e2e-preview.txt', exact: true })).toBeVisible();
});

test('@regression #3340 virtual mobile grid reaches its last row above the gesture area', async ({
  page,
}, testInfo) => {
  const session = await page.context().newCDPSession(page);
  await session.send('Emulation.setSafeAreaInsetsOverride', { insets: { bottom: 34 } });
  const { dialog } = await openAttachment(page, 'duty', 'mobile-document.csv', true);
  await expect(dialog.getByText('Item 1', { exact: true })).toBeVisible();
  const scroller = dialog.locator('[data-virtuoso-scroller]').first();
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  const last = dialog.getByText('Item 400', { exact: true });
  await expect(last).toBeVisible();
  const lastBounds = (await last.boundingBox())!;
  const island = (await dialog.locator('[data-attachment-preview-carousel-island]').boundingBox())!;
  expect(lastBounds.y + lastBounds.height).toBeLessThanOrEqual(island.y);
  const column = (await dialog.locator('thead th').nth(1).boundingBox())!;
  expect(column.y).toBeGreaterThanOrEqual(52);
  await dialog.screenshot({
    path: testInfo.outputPath('grid-last-row.png'),
    animations: 'disabled',
  });
  await session.detach();
});

test('@regression #3340 mobile PDF pinch keeps panels stable and uses the full-height stage', async ({
  page,
}) => {
  const { dialog } = await openAttachment(page, 'duty', 'mobile-document.pdf');
  await expect(dialog.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  const heading = dialog.getByRole('heading', { name: 'mobile-document.pdf', exact: true });
  const session = await page.context().newCDPSession(page);
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: 140, y: 300, id: 1 },
      { x: 220, y: 400, id: 2 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: 100, y: 260, id: 1 },
      { x: 260, y: 440, id: 2 },
    ],
  });
  await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect(heading).toBeVisible();
  const stage = (await dialog.locator('[data-attachment-preview-swipe-content]').boundingBox())!;
  expect(stage.y).toBe(0);
  expect(stage.height).toBe(812);
  await expect(dialog.getByText(/^[1-4]\d\d%$/)).toBeVisible();
  await session.detach();
});

test('@regression #3340 mobile document load errors remain below the header', async ({ page }) => {
  const { dialog } = await openAttachment(page, 'duty');
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await page.route('**/test-assets/mobile-document.pdf', (route) =>
    route.fulfill({
      status: 500,
      contentType: 'text/plain',
      body: 'Unavailable',
    }),
  );
  await page.getByRole('button', { name: 'mobile-document.pdf', exact: true }).click();
  const error = dialog.getByRole('heading', { name: 'Помилка перегляду', exact: true });
  await expect(error).toBeVisible();
  const title = dialog.getByRole('heading', { name: 'mobile-document.pdf', exact: true });
  const headerBounds = (await title.locator('xpath=../..').boundingBox())!;
  expect((await error.boundingBox())!.y).toBeGreaterThanOrEqual(
    headerBounds.y + headerBounds.height,
  );
});

test('@regression #3340 mobile spreadsheet zoom badge stays level with its carousel island', async ({
  page,
}) => {
  const { dialog } = await openAttachment(page, 'duty', 'mobile-document.xlsx');
  const cell = dialog.locator('td').first();
  await expect(cell).toBeVisible();
  const point = (await cell.boundingBox())!;
  await page.mouse.move(point.x + point.width / 2, point.y + point.height / 2);
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -400);
  await page.keyboard.up('Control');
  const badge = dialog.getByText(/^[1-4]\d\d%$/).locator('..');
  await expect(badge).toBeVisible();
  const badgeBounds = (await badge.boundingBox())!;
  const island = (await dialog.locator('[data-attachment-preview-carousel-island]').boundingBox())!;
  expect(
    Math.abs(badgeBounds.y + badgeBounds.height / 2 - island.y - island.height / 2),
  ).toBeLessThan(1);
});

for (const fileName of ['e2e-route.kml', 'e2e-route.kmz']) {
  test(`@regression #3340 ${fileName}: map gestures and layers stay independent of mobile chrome`, async ({
    page,
  }, testInfo) => {
    const { dialog } = await openAttachment(page, 'duty', fileName);
    const map = dialog.locator('[data-kmz-preview-map="true"]');
    await expect(map).toBeVisible();
    await expect(map.locator('.leaflet-map-pane')).toBeAttached();
    const heading = dialog.getByRole('heading', { name: fileName, exact: true });
    const island = dialog.locator('[data-attachment-preview-carousel-island]');
    await expect(island).toBeVisible();
    const layer = dialog.getByRole('button', { name: 'OpenStreetMap', exact: true });
    const layerBounds = (await layer.boundingBox())!;
    const islandBounds = (await island.boundingBox())!;
    expect(islandBounds.y + islandBounds.height).toBeLessThan(layerBounds.y);
    await layer.tap();
    await expect(heading).toBeVisible();
    const session = await page.context().newCDPSession(page);
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchStart',
      touchPoints: [{ x: 100, y: 300 }],
    });
    await session.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ x: 180, y: 340 }],
    });
    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(heading).toBeVisible();
    await page.touchscreen.tap(90, 500);
    await expect(heading).toBeHidden();
    await expect(island).toBeHidden();
    await expect(layer).toBeHidden();
    await page.touchscreen.tap(40, 500);
    await expect(heading).toBeVisible();
    await expect(layer).toBeVisible();
    await dialog.screenshot({
      path: testInfo.outputPath('map-mobile.png'),
      animations: 'disabled',
    });
    await session.detach();
  });
}

test('@regression #3340 desktop DOCX retains its opaque sandbox', async ({ page }) => {
  const { dialog } = await openAttachment(page, 'duty', 'mobile-document.docx', false, true);
  const frame = dialog.locator('iframe');
  await expect(frame).toBeVisible();
  await expect(frame).toHaveAttribute('sandbox', '');
  await expect(
    dialog.getByRole('heading', { name: 'mobile-document.docx', exact: true }),
  ).toBeVisible();
});
