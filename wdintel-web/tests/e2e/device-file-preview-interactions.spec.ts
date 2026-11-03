import { openDeviceSection } from './device-pages.ui';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { buildMessageCardMediaPreviewInboxResponse } from './message-card-media-preview.fixtures';
import {
  localFilePreviewBackend,
  syncPreviewFile,
  uploadPreviewContent,
} from './device-file-preview-backend';
import {
  loadDeviceFilePreviewFixture,
  type DeviceFilePreviewFixture,
} from './device-file-preview.fixtures';
import { openDeviceFilePreview, type FilePreviewBackend } from './device-file-preview.ui';

type Source = { fixture: DeviceFilePreviewFixture; bytes: Buffer };

test.beforeEach(() => {
  test.setTimeout(test.info().title.includes('keyboard-only') ? 90_000 : 180_000);
});

async function tabTo(page: Page, target: Locator) {
  for (let count = 0; count < 120; count += 1) {
    if (await target.evaluate((element) => element === document.activeElement)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error(
    `Keyboard cannot reach ${(await target.getAttribute('aria-label')) ?? (await target.textContent())}`,
  );
}

async function originalByKeyboard(page: Page, owner: Locator, source: Source) {
  const download = owner.getByRole('button', { name: 'Скачати файл', exact: true });
  await expect(download).toBeEnabled();
  await tabTo(page, download);
  const pending = page.waitForEvent('download');
  await page.keyboard.press('Enter');
  const saved = await pending;
  expect(saved.suggestedFilename()).toBe(source.fixture.fileName);
  expect(await readFile((await saved.path())!)).toEqual(source.bytes);
}

async function escapeDialogByKeyboard(page: Page, dialog: Locator) {
  await tabTo(page, dialog.getByRole('button', { name: 'Закрити перегляд', exact: true }));
  const beforeEscape = await page.evaluate(() => {
    const events: { capture: boolean; target: string; prevented: boolean }[] = [];
    (window as unknown as { acceptanceEscapes: typeof events }).acceptanceEscapes = events;
    for (const capture of [true, false])
      window.addEventListener(
        'keydown',
        (event) => {
          if (event.key === 'Escape')
            events.push({
              capture,
              target: (event.target as Element).tagName,
              prevented: event.defaultPrevented,
            });
        },
        { capture },
      );
    return {
      active: document.activeElement?.outerHTML,
      fullscreen: document.fullscreenElement?.outerHTML ?? null,
      hasFocus: document.hasFocus(),
    };
  });
  await page.keyboard.press('Escape');
  const escapeEvidence = test.info().outputPath('keyboard-escape.json');
  await writeFile(
    escapeEvidence,
    JSON.stringify({
      beforeEscape,
      events: await page.evaluate(
        () => (window as unknown as { acceptanceEscapes: unknown }).acceptanceEscapes,
      ),
    }),
  );
  await test.info().attach('keyboard-escape', {
    path: escapeEvidence,
    contentType: 'application/json',
  });
  await expect(dialog).toHaveCount(0);
}

async function openReferenceHost(
  page: Page,
  host: 'duty' | 'analysis',
  source: Source,
  beforeOpen?: (section: Locator) => Promise<void>,
  contentHref?: string,
) {
  page.on('pageerror', (error) => console.log('REFERENCE PAGEERROR', error.message));

  const started = Date.now();
  const href = contentHref ?? `/test-assets/device-reference/${source.fixture.id}`;
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse();
  const message = inboxResponse.inbox_items[0][1];
  message.media = [
    {
      id: `reference-${source.fixture.id}`,
      contentType: source.fixture.mimeType ?? 'application/octet-stream',
      fileName: source.fixture.fileName,
      sizeBytes: source.bytes.length,
      href,
      transcription: null,
      ocr: null,
      summary: null,
      kmzConversionStatus: null,
      positions: [],
    },
  ];
  message.images = source.fixture.category === 'image' ? [href] : [];
  message.coords = null;
  if (host === 'analysis') await installAnalysisNeoApiMocks(page, { inboxResponse });
  else await installRerDutyShortStateMocks(page, { inboxResponse });
  await page.route(`**${href}`, (route) =>
    contentHref
      ? route.continue()
      : route.fulfill({
          contentType: source.fixture.mimeType ?? 'application/octet-stream',
          headers: { 'Content-Length': String(source.bytes.length) },
          body: source.bytes,
        }),
  );
  await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo', {
    waitUntil: 'domcontentloaded',
  });
  const section = page.getByRole('button', {
    name:
      source.fixture.category === 'image'
        ? /^(Розгорнути|Згорнути) медіа:/
        : /^(Розгорнути|Згорнути) документи:/,
  });
  await expect(section).toBeVisible();
  await beforeOpen?.(section);
  if ((await section.getAttribute('aria-expanded')) !== 'true') await section.click();
  if (source.fixture.category === 'image')
    await page.getByRole('button', { name: 'Відкрити зображення', exact: true }).click();
  else await page.getByRole('button', { name: source.fixture.fileName, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  const evidence = test.info().outputPath(`reference-${host}-${source.fixture.id}.json`);
  await writeFile(
    evidence,
    JSON.stringify({
      host,
      fixture: source.fixture.id,
      sha256: source.fixture.sha256,
      openDurationMs: Date.now() - started,
    }),
  );
  await test.info().attach(`reference-${host}-${source.fixture.id}`, {
    path: evidence,
    contentType: 'application/json',
  });
  return dialog;
}

for (const host of ['duty', 'analysis'] as const) {
  test(`@regression ${host} collapsed reference documents defer original bytes and parser mounts`, async ({
    page,
  }) => {
    const source = await loadDeviceFilePreviewFixture('document-pdf');
    const originals: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/test-assets/device-reference/document-pdf'))
        originals.push(request.method());
    });
    const dialog = await openReferenceHost(page, host, source, async (section) => {
      await expect(section).toHaveAttribute('aria-expanded', 'false');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(
        page.locator('.react-pdf__Page__canvas, iframe[title="DOCX preview"]'),
      ).toHaveCount(0);
      expect(originals).toEqual([]);
    });
    await expect(dialog.locator('.react-pdf__Page__canvas').first()).toBeVisible();
    expect(originals).toContain('GET');
  });
}

async function documentObservation(owner: Locator, id: string) {
  if (id.endsWith('pdf')) {
    const canvas = owner.locator('.react-pdf__Page__canvas').first();
    await expect(canvas).toBeVisible();
    await expect(
      owner.locator('[data-pdf-page-number="1"] .react-pdf__Page__textContent'),
    ).toContainText('Device PDF content');
    return owner.locator('[data-pdf-page-number="1"] .react-pdf__Page__textContent').innerText();
  }
  if (/xlsx|xls|csv/.test(id)) {
    await expect(owner.getByRole('table')).toBeVisible();
    if (id.endsWith('xls'))
      await expect(owner.getByRole('cell', { name: '$1,234.50', exact: true })).toBeVisible();
    else await expect(owner.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
    return owner.getByRole('table').innerText();
  }
  if (id.endsWith('docx')) {
    const frame = owner.frameLocator('iframe[title="DOCX preview"]');
    await expect(frame.getByText('Device DOCX content — тільки читання')).toBeVisible();
    return frame.locator('body').innerText();
  }
  if (id.endsWith('doc')) {
    await expect(
      owner.getByText('Український абзац: Ґґ Єє Іі Її. Mixed Latin text 123.', { exact: true }),
    ).toBeVisible();
    return owner.locator('[data-document-preview-content]').innerText();
  }
  if (id.endsWith('txt')) {
    await expect(owner.locator('pre')).toContainText('Контрольний файл Echo');
    return owner.locator('pre').innerText();
  }
  await expect(owner.getByRole('heading', { name: 'Контрольний документ Echo' })).toBeVisible();
  await expect(owner.locator('script, img')).toHaveCount(0);
  return owner.locator('[data-document-preview-content]').innerText();
}

async function zoomDocument(owner: Locator, id: string, page: Page) {
  if (/txt|md|markdown/.test(id)) return;
  const metric = async () => {
    if (id.endsWith('pdf'))
      return owner
        .locator('.react-pdf__Page__canvas')
        .first()
        .evaluate((node: HTMLCanvasElement) => node.width);
    if (id.endsWith('docx'))
      return owner
        .frameLocator('iframe[title="DOCX preview"]')
        .locator('.docx-preview-page')
        .evaluate((node) => Number(getComputedStyle(node).zoom));
    if (id.endsWith('doc'))
      return owner
        .getByRole('article')
        .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
    return owner
      .getByRole('cell')
      .first()
      .evaluate((node) => parseFloat(getComputedStyle(node).fontSize));
  };
  const before = await metric();
  const button = owner.getByRole('button', { name: 'Збільшити масштаб', exact: true });
  if (await button.count()) await button.press('Enter');
  else {
    await owner.locator('[data-document-preview-content]').hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
  }
  await expect.poll(metric).toBeGreaterThan(before);
}

for (const id of [
  'document-txt',
  'document-md',
  'document-markdown',
  'document-pdf',
  'document-doc',
  'document-docx',
  'document-xls',
  'document-xlsx',
  'document-csv',
  'uppercase-pdf',
  'extension-only-docx',
  'mime-only-pdf',
  'docx-zip-mime',
  'xlsx-zip-mime',
]) {
  test(`@regression same-byte reference-host document parity ${id}`, async ({ page, context }) => {
    const backend = await localFilePreviewBackend();
    try {
      const source = await loadDeviceFilePreviewFixture(id);
      const { pane, entry } = await openDeviceFilePreview(page, backend, id);
      const referenceSource = {
        ...source,
        fixture: { ...source.fixture, mimeType: entry.file.mimeType },
      };
      const kind = `document-${source.fixture.expectedViewer}`;
      const deviceText = await documentObservation(pane, kind);
      await zoomDocument(pane, kind, page);
      for (const host of ['duty', 'analysis'] as const) {
        const referencePage = await context
          .browser()!
          .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
        try {
          const reference = await openReferenceHost(referencePage, host, referenceSource);
          expect(await documentObservation(reference, kind)).toBe(deviceText);
          if (!kind.endsWith('docx')) await zoomDocument(reference, kind, referencePage);
          if (id === 'document-xlsx') {
            await reference.getByRole('button', { name: 'Підсумок', exact: true }).press('Enter');
            await expect(
              reference.getByRole('cell', { name: 'Усього', exact: true }),
            ).toBeVisible();
          }
        } finally {
          await referencePage.close();
        }
      }
      if (id === 'document-xlsx') {
        await pane.getByRole('button', { name: 'Підсумок', exact: true }).press('Enter');
        await expect(pane.getByRole('cell', { name: 'Усього', exact: true })).toBeVisible();
        await pane.getByRole('button', { name: 'Міста', exact: true }).press('Enter');
        await expect(pane.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
      }
    } finally {
      await backend.dispose();
    }
  });
}

async function imageReady(owner: Locator) {
  const image = owner.locator('[data-image-preview-image]');
  await expect(image).toBeVisible();
  await expect
    .poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth))
    .toBeGreaterThan(0);
  return image;
}

async function imagePixels(owner: Locator) {
  const image = await imageReady(owner);
  return image.evaluate((node: HTMLImageElement) => {
    const canvas = document.createElement('canvas');
    canvas.width = node.naturalWidth;
    canvas.height = node.naturalHeight;
    const context = canvas.getContext('2d')!;
    context.drawImage(node, 0, 0);
    const pixels = [...context.getImageData(0, 0, canvas.width, canvas.height).data];
    return {
      width: canvas.width,
      height: canvas.height,
      pixels,
      transparent: pixels.filter((_, index) => index % 4 === 3 && pixels[index] === 0).length,
    };
  });
}

for (const extension of [
  'jpg',
  'jpeg',
  'png',
  'gif',
  'webp',
  'bmp',
  'svg',
  'mime-only-image',
  'conflicting-image-name',
  'image-video-suffix',
  'image-audio-suffix',
]) {
  test(`@regression same-byte reference-host decoded pixels and alpha ${extension}`, async ({
    page,
    context,
  }) => {
    const backend = await localFilePreviewBackend();
    try {
      const source = await loadDeviceFilePreviewFixture(
        extension.includes('-') ? extension : `image-${extension}`,
      );
      const { pane } = await openDeviceFilePreview(page, backend, source.fixture.id);
      const pixels = await imagePixels(pane);
      expect([pixels.width, pixels.height]).toEqual([80, 64]);
      if (extension === 'image-video-suffix' || extension === 'image-audio-suffix') {
        const pending = page.waitForEvent('download');
        await pane.getByRole('button', { name: 'Скачати файл', exact: true }).click();
        const saved = await pending;
        expect(saved.suggestedFilename()).toBe(source.fixture.fileName);
        expect(await readFile((await saved.path())!)).toEqual(source.bytes);
      }
      if (
        ['png', 'gif', 'webp', 'svg', 'mime-only-image', 'conflicting-image-name'].includes(
          extension,
        )
      )
        expect(pixels.transparent).toBeGreaterThan(0);
      for (const host of ['duty', 'analysis'] as const) {
        const referencePage = await context
          .browser()!
          .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
        try {
          const contentHref =
            extension === 'image-video-suffix' || extension === 'image-audio-suffix'
              ? backend.fixtures.seeded.find((entry) => entry.fixtureId === source.fixture.id)!
                  .originalHref
              : undefined;
          if (contentHref) await referencePage.context().addCookies(await page.context().cookies());
          const reference = await openReferenceHost(
            referencePage,
            host,
            source,
            undefined,
            contentHref,
          );
          expect(await imagePixels(reference)).toEqual(pixels);
          if (extension === 'image-video-suffix' || extension === 'image-audio-suffix') {
            const download = reference.getByRole('link', { name: 'Скачати', exact: true });
            await expect(download).toBeVisible();
            await tabTo(referencePage, download);
            const pending = referencePage.waitForEvent('download');
            await referencePage.keyboard.press('Enter');
            const saved = await pending;
            expect(saved.suggestedFilename()).toBe(source.fixture.fileName);
            expect(await readFile((await saved.path())!)).toEqual(source.bytes);
          }
        } finally {
          await referencePage.close();
        }
      }
    } finally {
      await backend.dispose();
    }
  });
}

async function expectAnimatedFrames(owner: Locator) {
  const image = owner.locator('[data-image-preview-image]');
  await imagePixels(owner);
  const frames = new Set<string>();
  await expect
    .poll(
      async () => {
        frames.add(
          createHash('sha256')
            .update(await image.screenshot())
            .digest('hex'),
        );
        return frames.size;
      },
      { timeout: 4_000, intervals: [160, 200, 250] },
    )
    .toBeGreaterThan(1);
}

for (const extension of ['gif', 'webp']) {
  test(`@regression actual displayed ${extension} frame animation matches both reference hosts`, async ({
    page,
    context,
  }) => {
    const backend = await localFilePreviewBackend();
    try {
      const source = await loadDeviceFilePreviewFixture(
        extension.includes('-') ? extension : `image-${extension}`,
      );
      const { pane } = await openDeviceFilePreview(page, backend, source.fixture.id);
      await expectAnimatedFrames(pane);
      for (const host of ['duty', 'analysis'] as const) {
        const referencePage = await context
          .browser()!
          .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
        try {
          await expectAnimatedFrames(await openReferenceHost(referencePage, host, source));
        } finally {
          await referencePage.close();
        }
      }
    } finally {
      await backend.dispose();
    }
  });
}

async function viewerReady(owner: Locator, id: string) {
  if (id === 'image-png') await imagePixels(owner);
  else if (id === 'document-pdf')
    await expect(owner.locator('.react-pdf__Page__canvas').first()).toBeVisible();
  else if (id === 'document-xlsx')
    await expect(owner.getByRole('cell', { name: 'Київ', exact: true })).toBeVisible();
  else if (id === 'archive-zip')
    await expect(owner.getByRole('button', { name: 'Звіт.txt', exact: true })).toBeEnabled();
  else if (id === 'native-map-kml')
    await expect(owner.locator('.leaflet-overlay-pane canvas').first()).toBeAttached();
  else if (id === 'audio-wav')
    await expect
      .poll(() =>
        owner
          .locator('custom-audio-player')
          .evaluate(
            (node: HTMLElement & { audio?: HTMLAudioElement }) => node.audio?.readyState ?? 0,
          ),
      )
      .toBeGreaterThan(0);
  else if (id === 'video-mp4')
    await expect
      .poll(() => owner.locator('video').evaluate((node: HTMLVideoElement) => node.readyState))
      .toBeGreaterThan(0);
  else await expect(owner).toContainText('Сервіс конвертації геоданих недоступний');
}

for (const width of [390, 1440]) {
  for (const id of [
    'document-pdf',
    'document-xlsx',
    'image-png',
    'audio-wav',
    'video-mp4',
    'archive-zip',
    'native-map-kml',
  ]) {
    test(`@regression @new-api keyboard-only file actions and retained context ${width}px ${id}`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      const backend = await localFilePreviewBackend();
      try {
        const source = await loadDeviceFilePreviewFixture(id);
        const { pane } = await openDeviceFilePreview(page, backend, id);
        await viewerReady(pane, id);
        if (width === 390)
          await page.getByRole('button', { name: 'До файлів', exact: true }).click();
        const filters = page.getByRole('button', {
          name: width === 390 ? 'Фільтри' : 'Показати додаткові фільтри',
          exact: true,
        });
        await filters.click();
        await page
          .getByRole('textbox', { name: 'Розширення', exact: true })
          .fill(source.fixture.extension);
        await tabTo(page, page.getByRole('button', { name: 'Знайти', exact: true }));
        await page.keyboard.press('Enter');
        const row = page
          .getByRole('region', { name: 'Результати пошуку файлів' })
          .getByRole('button', { name: source.fixture.fileName, exact: true });
        await tabTo(page, row);
        await page.keyboard.press('Enter');
        await viewerReady(pane, id);
        const url = page.url();
        await originalByKeyboard(page, pane, source);
        const fullscreen = pane.getByRole('button', { name: 'На весь екран', exact: true });
        await tabTo(page, fullscreen);
        await page.keyboard.press('Enter');
        const dialog = page.getByRole('dialog');
        await viewerReady(dialog, id);
        await expect(
          dialog.getByRole('button', { name: 'Скачати файл', exact: true }),
        ).toBeInViewport();
        await originalByKeyboard(page, dialog, source);
        for (let step = 0; step < 16; step += 1) {
          await page.keyboard.press('Tab');
          expect(await dialog.evaluate((node) => node.contains(document.activeElement))).toBe(true);
        }
        if (id === 'document-xlsx') {
          await tabTo(page, dialog.getByRole('button', { name: 'Підсумок', exact: true }));
          await page.keyboard.press('Enter');
          await expect(dialog.getByRole('cell', { name: 'Усього', exact: true })).toBeVisible();
        }
        await escapeDialogByKeyboard(page, dialog);
        await expect(fullscreen).toBeFocused();
        await expect(page).toHaveURL(url);
        if (width === 390) {
          await tabTo(page, page.getByRole('button', { name: 'До файлів', exact: true }));
          await page.keyboard.press('Enter');
          await expect(row).toBeFocused();
        }
        await expect(page.getByRole('textbox', { name: 'Назва містить', exact: true })).toHaveValue(
          source.fixture.fileName,
        );
        await expect(row).toBeVisible();
        const filterToggle = page.getByRole('button', {
          name: width === 390 ? 'Фільтри' : /^(Показати|Сховати) додаткові фільтри$/,
        });
        if ((await filterToggle.getAttribute('aria-expanded')) !== 'true') {
          await tabTo(page, filterToggle);
          await page.keyboard.press('Enter');
        }
        await expect(page.getByRole('textbox', { name: 'Розширення', exact: true })).toHaveValue(
          source.fixture.extension,
        );
      } finally {
        await backend.dispose();
      }
    });
  }
}

function multiPagePdf(paddingBytes = 0): Buffer {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R 6 0 R] /Count 4 >>',
  ];
  for (let page = 1; page <= 4; page += 1)
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 600] /Resources << /Font << /F1 7 0 R >> >> /Contents ${7 + page} 0 R >>`,
    );
  objects.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  for (let page = 1; page <= 4; page += 1) {
    const content = `BT /F1 24 Tf 40 540 Td (Echo acceptance page ${page}) Tj ET`;
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  if (paddingBytes > 0)
    objects.push(`<< /Length ${paddingBytes} >>\nstream\n${' '.repeat(paddingBytes)}\nendstream`);
  let output = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(output));
    output += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

async function customSource(
  backend: FilePreviewBackend,
  id: string,
  extension: string,
  mimeType: string,
  bytes: Buffer,
): Promise<Source> {
  const template = (
    await loadDeviceFilePreviewFixture(
      extension === 'svg' ? 'image-svg' : extension === 'kml' ? 'native-map-kml' : 'document-pdf',
    )
  ).fixture;
  const fixture: DeviceFilePreviewFixture = {
    ...template,
    id,
    fileName: `${id}.${extension}`,
    extension,
    mimeType,
    sizeBytes: bytes.length,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
  const file = await syncPreviewFile(
    await backend.login('source'),
    backend.fixtures.deviceId!,
    fixture,
  );
  backend.fixtures.seeded.push({
    fixtureId: id,
    file,
    ...(await uploadPreviewContent(
      await backend.login('source'),
      backend.fixtures.deviceId!,
      file,
      bytes,
    )),
  });
  return { fixture, bytes };
}

async function openCustom(page: Page, backend: FilePreviewBackend, source: Source) {
  await page.context().addCookies((await (await backend.login('reader')).storageState()).cookies);
  await page.goto(`/devices/${backend.fixtures.deviceId}`);
  await openDeviceSection(page, 'Файли');
  await page
    .getByRole('button', { name: /Вибрати каталог C:/ })
    .first()
    .click();
  await page.getByRole('button', { name: 'Показати пошук файлів', exact: true }).click();
  await page
    .getByRole('textbox', { name: 'Назва містить', exact: true })
    .fill(source.fixture.fileName);
  await page.getByRole('button', { name: 'Знайти', exact: true }).click();
  await page
    .getByRole('region', { name: 'Результати пошуку файлів' })
    .getByRole('button', { name: source.fixture.fileName, exact: true })
    .click();
  return page.getByTestId('device-file-content-pane');
}

test('@regression multipage PDF above 10 MiB scrolls and zooms in Device and message previews', async ({
  page,
  context,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const source = await customSource(
      backend,
      'acceptance-multipage-above-10mib',
      'pdf',
      'application/pdf',
      multiPagePdf(11 * 1024 * 1024),
    );
    expect(source.bytes.length).toBeGreaterThan(10 * 1024 * 1024);
    const pane = await openCustom(page, backend, source);
    await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await multipageActions(dialog, page);
    for (const host of ['duty', 'analysis'] as const) {
      const referencePage = await context
        .browser()!
        .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
      try {
        await multipageActions(await openReferenceHost(referencePage, host, source), referencePage);
      } finally {
        await referencePage.close();
      }
    }
  } finally {
    await backend.dispose();
  }
});

async function multipageActions(owner: Locator, page: Page) {
  await expect(owner.locator('[data-pdf-page-shell]')).toHaveCount(4);
  await expect(owner.locator('[data-pdf-page-number="1"] .react-pdf__Page__canvas')).toBeVisible();
  const last = owner.locator('[data-pdf-page-number="4"]');
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('.react-pdf__Page__canvas')).toBeVisible();
  await expect(last.locator('.react-pdf__Page__textContent')).toContainText(
    'Echo acceptance page 4',
  );
  const canvas = last.locator('canvas');
  const initial = await canvas.evaluate((node: HTMLCanvasElement) => node.width);
  const deviceZoom = owner.getByRole('button', { name: 'Збільшити масштаб', exact: true });
  if (await deviceZoom.count()) await deviceZoom.press('Enter');
  else {
    await owner.locator('[data-document-preview-content]').hover();
    await page.keyboard.down('Control');
    await page.mouse.wheel(0, -100);
    await page.keyboard.up('Control');
  }
  await expect
    .poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.width))
    .toBeGreaterThan(initial);
}

test('@regression actual Device image drag pans a zoomed large SVG and resets like reference hosts', async ({
  page,
  context,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const source = await customSource(
      backend,
      'acceptance-pan',
      'svg',
      'image/svg+xml',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#336699"/><circle cx="512" cy="384" r="100" fill="#ff8800"/></svg>',
      ),
    );
    const pane = await openCustom(page, backend, source);
    await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
    await panActions(page.getByRole('dialog'), page);
    for (const host of ['duty', 'analysis'] as const) {
      const referencePage = await context
        .browser()!
        .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
      try {
        await panActions(await openReferenceHost(referencePage, host, source), referencePage);
      } finally {
        await referencePage.close();
      }
    }
  } finally {
    await backend.dispose();
  }
});

async function panActions(owner: Locator, page: Page) {
  const image = owner.locator('[data-image-preview-image]');
  await imageReady(owner);
  const stage = owner.locator('[data-image-preview-stage]');
  await stage.hover();
  await page.keyboard.down('Control');
  await page.mouse.wheel(0, -500);
  await page.keyboard.up('Control');
  await expect
    .poll(async () => Number(await image.getAttribute('data-image-preview-zoom')))
    .toBeGreaterThan(100);
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(
      async () =>
        Math.abs(Number(await image.getAttribute('data-image-preview-pan-x'))) +
        Math.abs(Number(await image.getAttribute('data-image-preview-pan-y'))),
    )
    .toBeGreaterThan(20);
  await owner.getByRole('button', { name: /\d+%/ }).click();
  await expect(image).toHaveAttribute('data-image-preview-zoom', '100');
  await expect(image).toHaveAttribute('data-image-preview-pan-x', '0');
  await expect(image).toHaveAttribute('data-image-preview-pan-y', '0');
}

test('@regression long Ukrainian TXT and Markdown scroll to final content in Devices and reference hosts', async ({
  page,
  context,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    for (const extension of ['txt', 'md']) {
      const text = `${extension === 'md' ? '# Довгий документ\n\n' : ''}${Array.from({ length: 160 }, (_, index) => `Український рядок ${index + 1}: Київ, Львів, Ґґ Єє Іі Її.`).join('\n\n')}\n\nКІНЕЦЬ КОНТРОЛЬНОГО ДОКУМЕНТА`;
      const source = await customSource(
        backend,
        `acceptance-long-${extension}`,
        extension,
        extension === 'md' ? 'text/markdown' : 'text/plain',
        Buffer.from(text),
      );
      const pane = await openCustom(page, backend, source);
      await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
      await scrollText(page.getByRole('dialog'), extension);
      await page.keyboard.press('Escape');
      for (const host of ['duty', 'analysis'] as const) {
        const referencePage = await context
          .browser()!
          .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
        try {
          await scrollText(await openReferenceHost(referencePage, host, source), extension);
        } finally {
          await referencePage.close();
        }
      }
    }
  } finally {
    await backend.dispose();
  }
});

async function scrollText(owner: Locator, extension: string) {
  const leaf =
    extension === 'txt'
      ? owner.locator('pre')
      : owner.getByText('КІНЕЦЬ КОНТРОЛЬНОГО ДОКУМЕНТА', { exact: true });
  await expect(leaf).toBeAttached();
  const scroller = owner.locator('[data-document-preview-content] > div');
  await expect
    .poll(() => scroller.evaluate((node) => node.scrollHeight - node.clientHeight))
    .toBeGreaterThan(500);
  await scroller.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
  });
  await expect.poll(() => scroller.evaluate((node) => node.scrollTop)).toBeGreaterThan(500);
  if (extension === 'md') await expect(leaf).toBeInViewport();
  else {
    const bottom = await leaf.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      range.setStart(node.firstChild!, (node.textContent?.length ?? 0) - 30);
      const parent = node.parentElement!;
      const rect = range.getBoundingClientRect();
      const visible = parent.getBoundingClientRect();
      return rect.top >= visible.top && rect.bottom <= visible.bottom + 1;
    });
    expect(bottom).toBe(true);
  }
}

test('@regression same-byte ZIP reference-host listing and nested member download parity', async ({
  page,
  context,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const source = await loadDeviceFilePreviewFixture('archive-zip');
    const { pane } = await openDeviceFilePreview(page, backend, source.fixture.id);
    await expect(pane.getByRole('button', { name: 'Звіт.txt', exact: true })).toBeVisible();
    await pane.getByRole('button', { name: 'Розгорнути каталог nested', exact: true }).click();
    await pane.getByRole('button', { name: 'Дані.csv', exact: true }).click();
    const save = pane.getByRole('button', { name: 'Скачати файл', exact: true });
    await expect(save).toBeEnabled();
    const pending = page.waitForEvent('download');
    await save.press('Enter');
    expect(await readFile((await (await pending).path())!)).toEqual(
      (await loadDeviceFilePreviewFixture('document-csv')).bytes,
    );
    for (const host of ['duty', 'analysis'] as const) {
      const referencePage = await context
        .browser()!
        .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
      try {
        await zipActions(await openReferenceHost(referencePage, host, source), referencePage);
      } finally {
        await referencePage.close();
      }
    }
  } finally {
    await backend.dispose();
  }
});

async function zipActions(owner: Locator, page: Page) {
  await expect(owner.locator('[data-zip-entry-name]').first()).toBeVisible();
  const names = await owner.locator('[data-zip-entry-name]').allTextContents();
  expect(names).toEqual(expect.arrayContaining(['Звіт.txt', 'nested/Дані.csv']));
  const pending = page.waitForEvent('download');
  await owner.getByRole('button', { name: 'Скачати nested/Дані.csv', exact: true }).press('Enter');
  const saved = await pending;
  expect(saved.suggestedFilename()).toBe('Дані.csv');
  expect(await readFile((await saved.path())!)).toEqual(
    (await loadDeviceFilePreviewFixture('document-csv')).bytes,
  );
  return names;
}

async function observeMapDrawing(page: Page) {
  await page.addInitScript(() => {
    const records: { style: string; alpha: number; rings: number; rule: string }[] = [];
    (window as unknown as { acceptanceMapFills: typeof records }).acceptanceMapFills = records;
    const paths = new WeakMap<CanvasRenderingContext2D, number>();
    const begin = CanvasRenderingContext2D.prototype.beginPath;
    const move = CanvasRenderingContext2D.prototype.moveTo;
    const fill = CanvasRenderingContext2D.prototype.fill;
    CanvasRenderingContext2D.prototype.beginPath = function () {
      paths.set(this, 0);
      return begin.call(this);
    };
    CanvasRenderingContext2D.prototype.moveTo = function (x, y) {
      paths.set(this, (paths.get(this) ?? 0) + 1);
      return move.call(this, x, y);
    };
    CanvasRenderingContext2D.prototype.fill = function (...args: Parameters<typeof fill>) {
      if (this.canvas.closest('.leaflet-overlay-pane'))
        records.push({
          style: String(this.fillStyle),
          alpha: this.globalAlpha,
          rings: paths.get(this) ?? 0,
          rule: String(args[0] ?? 'nonzero'),
        });
      return fill.apply(this, args);
    } as typeof fill;
  });
}

for (const id of ['native-map-kml', 'native-map-kmz', 'kmz-zip-mime']) {
  test(`@regression same-byte native map reference-host geometry styles holes zoom and drag ${id}`, async ({
    page,
    context,
  }) => {
    const backend = await localFilePreviewBackend();
    try {
      await observeMapDrawing(page);
      const source = await loadDeviceFilePreviewFixture(id);
      const { pane } = await openDeviceFilePreview(page, backend, id);
      await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
      await mapActions(page.getByRole('dialog'), page);
      for (const host of ['duty', 'analysis'] as const) {
        const referencePage = await context
          .browser()!
          .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
        try {
          await observeMapDrawing(referencePage);
          await mapActions(await openReferenceHost(referencePage, host, source), referencePage);
        } finally {
          await referencePage.close();
        }
      }
    } finally {
      await backend.dispose();
    }
  });
}

async function mapActions(owner: Locator, page: Page) {
  const geometry = owner.locator('[data-map-preview-points]');
  await expect(geometry).toHaveAttribute('data-map-preview-points', '1');
  await expect(geometry).toHaveAttribute('data-map-preview-lines', '1');
  await expect(geometry).toHaveAttribute('data-map-preview-polygons', '1');
  await expect
    .poll(() =>
      page.evaluate(() =>
        (
          window as unknown as {
            acceptanceMapFills: { style: string; rings: number; rule: string; alpha: number }[];
          }
        ).acceptanceMapFills.some(
          (fill) =>
            fill.style === '#0000ff' &&
            fill.rings === 2 &&
            fill.rule === 'evenodd' &&
            fill.alpha === 0.25,
        ),
      ),
    )
    .toBe(true);
  const canvas = owner.locator('.leaflet-overlay-pane canvas').first();
  await expect(canvas).toBeAttached();
  const beforeZoom = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  const map = owner.locator('.leaflet-container');
  await map.hover();
  await page.mouse.wheel(0, -300);
  await expect
    .poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()))
    .not.toBe(beforeZoom);
  const beforePan = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL());
  const box = (await map.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 70, box.y + box.height / 2 + 30, { steps: 8 });
  await page.mouse.up();
  await expect
    .poll(() => canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL()))
    .not.toBe(beforePan);
}

async function assertReadableMapLabels(owner: Locator, page: Page, host: string) {
  const labels = owner.getByRole('tooltip', { name: 'Київ — контрольна точка', exact: true });
  const observation = () =>
    labels.evaluateAll((nodes) =>
      nodes.map((node) => {
        const bounds = node.getBoundingClientRect();
        const style = getComputedStyle(node);
        return {
          text: node.textContent?.trim(),
          opacity: Number(style.opacity),
          visible:
            bounds.width > 0 &&
            bounds.height > 0 &&
            style.visibility !== 'hidden' &&
            style.display !== 'none' &&
            Number(style.opacity) > 0,
          inViewport:
            bounds.top >= 0 &&
            bounds.left >= 0 &&
            bounds.right <= innerWidth &&
            bounds.bottom <= innerHeight,
          bounds: bounds.toJSON(),
          mapBounds: node.closest('.leaflet-container')?.getBoundingClientRect().toJSON(),
        };
      }),
    );
  await expect
    .poll(async () => {
      const visible = (await observation()).filter((label) => label.visible);
      return (
        visible.length > 0 &&
        visible.every((label) => label.inViewport && label.text === 'Київ — контрольна точка')
      );
    })
    .toBe(true);
  const evidence = test.info().outputPath(`map-labels-${host}.json`);
  await writeFile(
    evidence,
    JSON.stringify({
      maps: await owner.locator('.leaflet-container').count(),
      labels: await observation(),
    }),
  );
  await test
    .info()
    .attach(`map-labels-${host}`, { path: evidence, contentType: 'application/json' });
  await page.screenshot({
    path: test.info().outputPath(`map-labels-${host}.png`),
    animations: 'disabled',
  });
}

const POINT_LABEL_KML = Buffer.from(
  '<?xml version="1.0" encoding="UTF-8"?><kml><Document><Placemark><name>Київ — контрольна точка</name><Point><coordinates>30.52,50.45</coordinates></Point></Placemark></Document></kml>',
);

for (const host of ['duty', 'analysis'] as const) {
  test(`@regression ${host} readable native point reference keeps the same exact label in view`, async ({
    page,
  }) => {
    const { fixture } = await loadDeviceFilePreviewFixture('native-map-kml');
    const source: Source = {
      fixture: {
        ...fixture,
        id: 'acceptance-map-label',
        fileName: 'acceptance-map-label.kml',
        sizeBytes: POINT_LABEL_KML.length,
        sha256: createHash('sha256').update(POINT_LABEL_KML).digest('hex'),
      },
      bytes: POINT_LABEL_KML,
    };
    const owner = await openReferenceHost(page, host, source);
    await expect(owner.locator('[data-map-preview-points]')).toHaveAttribute(
      'data-map-preview-points',
      '1',
    );
    await assertReadableMapLabels(owner, page, host);
  });
}

test('@regression native KML point label stays readable with identical bytes in both reference hosts', async ({
  page,
  context,
}) => {
  const backend = await localFilePreviewBackend();
  try {
    const source = await customSource(
      backend,
      'acceptance-map-label',
      'kml',
      'application/vnd.google-earth.kml+xml',
      POINT_LABEL_KML,
    );
    const pane = await openCustom(page, backend, source);
    await assertReadableMapLabels(pane, page, 'device');
    for (const host of ['duty', 'analysis'] as const) {
      const referencePage = await context
        .browser()!
        .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
      try {
        await assertReadableMapLabels(
          await openReferenceHost(referencePage, host, source),
          referencePage,
          host,
        );
      } finally {
        await referencePage.close();
      }
    }
  } finally {
    await backend.dispose();
  }
});

test('@regression narrow Device image native touch pinch and pan preserve the reference gesture behavior', async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const backend = await localFilePreviewBackend();
  try {
    const source = await customSource(
      backend,
      'acceptance-touch-pan',
      'svg',
      'image/svg+xml',
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="768"><rect width="1024" height="768" fill="#336699"/><circle cx="512" cy="384" r="100" fill="#ff8800"/></svg>',
      ),
    );
    const pane = await openCustom(page, backend, source);
    await pane.getByRole('button', { name: 'На весь екран', exact: true }).click();
    await touchImageActions(page.getByRole('dialog'), page);
    for (const host of ['duty', 'analysis'] as const) {
      const referencePage = await context
        .browser()!
        .newPage({ baseURL: process.env.PLAYWRIGHT_BASE_URL, viewport: page.viewportSize()! });
      try {
        await touchImageActions(
          await openReferenceHost(referencePage, host, source),
          referencePage,
        );
      } finally {
        await referencePage.close();
      }
    }
  } finally {
    await backend.dispose();
  }
});

async function touchImageActions(owner: Locator, page: Page) {
  const image = owner.locator('[data-image-preview-image]');
  await imageReady(owner);
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  const box = (await owner.locator('[data-image-preview-stage]').boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [
      { x: x - 40, y, id: 1 },
      { x: x + 40, y, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [
      { x: x - 120, y, id: 1 },
      { x: x + 120, y, id: 2 },
    ],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(async () => Number(await image.getAttribute('data-image-preview-zoom')))
    .toBeGreaterThan(200);
  const before = Number(await image.getAttribute('data-image-preview-pan-y'));
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x, y, id: 1 }],
  });
  await client.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x, y: y + 50, id: 1 }],
  });
  await client.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await expect
    .poll(async () =>
      Math.abs(Number(await image.getAttribute('data-image-preview-pan-y')) - before),
    )
    .toBeGreaterThan(20);
  await expect(owner).toBeVisible();
  await client.detach();
}

function rangeSeparatedPdf(): Buffer {
  const pages = 8;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Count ${pages} /Kids [${Array.from({ length: pages }, (_, i) => `${3 + i} 0 R`).join(' ')}] >>`,
  ];
  for (let i = 0; i < pages; i += 1) {
    objects.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 400] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${3 + pages + i * 2} 0 R >>`,
    );
  }
  for (let i = 0; i < pages; i += 1) {
    const text = `BT /F1 20 Tf 30 350 Td (Range page ${i + 1}) Tj ET`;
    objects.push(`<< /Length ${text.length} >>\nstream\n${text}\nendstream`);
    const padding = ' '.repeat(256 * 1024);
    objects.push(`<< /Length ${padding.length} >>\nstream\n${padding}\nendstream`);
  }
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}

test('#3830 @regression a denied late PDF range clears rendered pages and shows the access error', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const backend = await localFilePreviewBackend();
  try {
    const source = await customSource(
      backend,
      `pdf-ranges-${Date.now()}`,
      'pdf',
      'application/pdf',
      rangeSeparatedPdf(),
    );
    const entry = backend.fixtures.seeded.find((entry) => entry.fixtureId === source.fixture.id)!;
    const href = entry.originalHref.replace(/\/content$/, '/preview/media');
    let deny = false;
    let denied = 0;
    const rangeReads: string[] = [];
    await page.route(`**${href}`, async (route) => {
      const range = /^bytes=(\d+)-(\d+)$/.exec(route.request().headers().range ?? '');
      rangeReads.push(`${route.request().method()}:${route.request().headers().range ?? 'full'}`);
      if (deny && range) {
        denied += 1;
        await route.fulfill({ status: 403, body: 'Forbidden' });
        return;
      }
      const start = range ? Number(range[1]) : 0;
      const end = range ? Math.min(Number(range[2]) + 1, source.bytes.length) : source.bytes.length;
      await route.fulfill({
        status: range ? 206 : 200,
        headers: {
          'Content-Type': 'application/pdf',
          'Accept-Ranges': 'bytes',
          'Content-Length': String(end - start),
          ...(range ? { 'Content-Range': `bytes ${start}-${end - 1}/${source.bytes.length}` } : {}),
        },
        body:
          route.request().method() === 'HEAD' ? Buffer.alloc(0) : source.bytes.subarray(start, end),
      });
    });
    const pane = await openCustom(page, backend, source);
    await expect(pane.locator('.react-pdf__Page__canvas')).toHaveCount(3, { timeout: 30_000 });
    expect(rangeReads.some((request) => request.startsWith('GET:bytes='))).toBe(true);
    deny = true;
    await pane.locator('[data-pdf-page-number="4"]').scrollIntoViewIfNeeded();
    await expect
      .poll(() => denied, { timeout: 15_000, message: JSON.stringify(rangeReads) })
      .toBeGreaterThan(0);
    await expect(pane.locator('.react-pdf__Page__canvas')).toHaveCount(0);
    await expect(pane.getByRole('alert')).toContainText(/доступ|прав|403/i);
  } finally {
    await backend.dispose();
  }
});
