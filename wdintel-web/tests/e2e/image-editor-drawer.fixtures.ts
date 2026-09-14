import { expect, type Page } from '@playwright/test';
import { deflateSync } from 'node:zlib';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

export type ImageEditorDrawerHost = 'duty' | 'analysis';

function pngChunk(type: string, data: Buffer) {
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, 'ascii');
  data.copy(chunk, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, data.length + 8)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  chunk.writeUInt32BE((crc ^ 0xffffffff) >>> 0, data.length + 8);
  return chunk;
}

function createEditorFixturePng() {
  const width = 200;
  const height = 150;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 3;
      const checker = (Math.floor(x / 20) + Math.floor(y / 20)) % 2 === 0;
      pixels[offset] = x < 100 ? 220 : 30;
      pixels[offset + 1] = checker ? 40 : 210;
      pixels[offset + 2] = y < 75 ? 50 : 225;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export const IMAGE_EDITOR_DRAWER_PNG = {
  name: 'editor-fixture.png',
  mimeType: 'image/png',
  buffer: createEditorFixturePng(),
};

export function createImageEditorNoisePng() {
  const width = 1024;
  const height = 1024;
  const pixels = Buffer.alloc((width * 3 + 1) * height);
  let random = 20260911;
  for (let y = 0; y < height; y += 1) {
    for (let x = 1; x <= width * 3; x += 1) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      pixels[y * (width * 3 + 1) + x] = random & 255;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return {
    name: 'editor-large-idat.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk('IHDR', header),
      pngChunk('IDAT', deflateSync(pixels)),
      pngChunk('IEND', Buffer.alloc(0)),
    ]),
  };
}

export function parseTusMetadata(value: string | undefined): Record<string, string> {
  if (!value) return {};
  return Object.fromEntries(
    value.split(',').flatMap((entry) => {
      const [key, encoded] = entry.trim().split(/\s+/, 2);
      if (!key || !encoded) return [];
      return [[key, Buffer.from(encoded, 'base64').toString('utf8')]];
    }),
  );
}

export async function observeImageEditorSubmission(
  page: Page,
  options: { failTusChunks?: boolean } = {},
) {
  const uploads: Array<{ bytes: Buffer; metadata: Record<string, string> }> = [];
  const fallbackUploads: Buffer[] = [];
  const submissions: unknown[] = [];
  let uploadMetadata: string | undefined;
  await page.route('**/api/sigint/file-upload/tus', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    uploadMetadata = route.request().headers()['upload-metadata'];
    await route.fulfill({
      status: 201,
      headers: {
        Location: '/api/sigint/file-upload/tus/editor-upload',
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': '0',
      },
    });
  });
  await page.route('**/api/sigint/file-upload/tus/editor-upload', async (route) => {
    const request = route.request();
    if (options.failTusChunks) {
      await route.fulfill({ status: 405 });
      return;
    }
    if (
      request.method() === 'POST' &&
      request.headers()['x-http-method-override']?.toUpperCase() === 'PATCH'
    ) {
      uploads.push({
        bytes: request.postDataBuffer() ?? Buffer.alloc(0),
        metadata: parseTusMetadata(uploadMetadata),
      });
    }
    await route.fulfill({
      status: 204,
      headers: {
        'Tus-Resumable': '1.0.0',
        'Upload-Offset': String(request.postDataBuffer()?.length ?? 0),
      },
    });
  });
  await page.route('**/api/sigint/file-upload/fallback', async (route) => {
    fallbackUploads.push(route.request().postDataBuffer() ?? Buffer.alloc(0));
    await route.fulfill({
      status: 201,
      contentType: 'application/json',
      body: JSON.stringify({
        upload_url: '/api/sigint/file-upload/tus/fallback-upload',
      }),
    });
  });
  await page.route('**/api/1.1/submit-direct', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ signal_message_id: 701 }),
    });
  });
  await page.route('**/api/1.1/message/*/edit', async (route) => {
    submissions.push(route.request().postDataJSON());
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ signal_message_id: 702 }),
    });
  });
  return { submissions, uploads, fallbackUploads };
}

export async function openCreateMessageDrawer(
  page: Page,
  host: ImageEditorDrawerHost,
): Promise<void> {
  const dutyMocks =
    host === 'duty'
      ? await installRerDutyShortStateMocks(page, { signalGroups: ['editor-e2e-group'] })
      : null;
  if (host === 'analysis')
    await installAnalysisNeoApiMocks(page, { signalGroups: ['editor-e2e-group'] });
  await page.goto(host === 'duty' ? '/rer-duty-neo' : '/rer-analysis-neo');

  if (dutyMocks) await dutyMocks.systemSettingsReady;

  const readyText =
    host === 'duty' ? 'Немає повідомлень' : 'Немає жодного повідомлення для аналізу.';
  await expect(page.getByText(readyText, { exact: true })).toBeVisible();
  if (dutyMocks)
    await expect(page.getByText('Помилка завантаження системних налаштувань')).toHaveCount(0);
  await page.getByRole('button', { name: 'Додати повідомлення' }).click();
  await expect(page.getByRole('heading', { name: 'Створити повідомлення' })).toBeVisible();
}

export async function openEditMessageDrawer(page: Page): Promise<void> {
  await openDrawerFromMediaMessage(page, 'Редагувати', 'Редагувати повідомлення');
}

export async function openCreateReportDrawer(page: Page): Promise<void> {
  await openDrawerFromMediaMessage(page, 'Створити розвіддонесення', 'Створити розвіддонесення');
}

export async function openEditReportDrawer(page: Page): Promise<void> {
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse();
  const [parentId, parent] = inboxResponse.inbox_items[0]!;
  const report = {
    ...(parent as any),
    text: 'E2E intelligence report',
    media: [
      {
        id: 'existing-editor-image',
        content_type: 'image/png',
        file_name: IMAGE_EDITOR_DRAWER_PNG.name,
        size_bytes: IMAGE_EDITOR_DRAWER_PNG.buffer.length,
        href: '/test-assets/message-card-media-preview/e2e-image-1.png',
      },
    ],
    images: [],
    parentMessages: [
      {
        id: parentId,
        isAccessible: true,
        isDeleted: false,
        text: (parent as any).text,
        attachmentsCount: 1,
        timestamp: (parent as any).timestamp,
        date: (parent as any).date,
        time: (parent as any).time,
        groupName: null,
        groupMasterKey: (parent as any).groupMasterKey,
      },
    ],
  };
  (parent as any).intelligenceReports = [
    {
      id: 501,
      isAccessible: true,
      isDeleted: false,
      text: report.text,
      attachmentsCount: 1,
      timestamp: report.timestamp,
      date: report.date,
      time: report.time,
      groupName: null,
      groupMasterKey: report.groupMasterKey,
    },
  ];
  await installMessageCardMediaPreviewAssetRoutes(page, undefined, {
    body: IMAGE_EDITOR_DRAWER_PNG.buffer,
    contentType: IMAGE_EDITOR_DRAWER_PNG.mimeType,
  });
  const dutyMocks = await installRerDutyShortStateMocks(page, {
    inboxResponse,
    signalGroups: ['e2e-group'],
  });
  await page.route('**/api/rer-importer/messages-by-id', (route) =>
    route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({ messages: [[501, report]] }),
    }),
  );
  await page.goto('/rer-duty-neo');
  await dutyMocks.systemSettingsReady;
  await expect(page.getByText('Помилка завантаження системних налаштувань')).toHaveCount(0);
  await page.getByRole('button', { name: 'Редагувати розвіддонесення' }).click();
  await expect(page.getByRole('heading', { name: 'Редагувати розвіддонесення' })).toBeVisible();
}

async function openDrawerFromMediaMessage(
  page: Page,
  actionName: string,
  heading: string,
): Promise<void> {
  const inboxResponse = buildMessageCardMediaPreviewInboxResponse();
  const [, message] = inboxResponse.inbox_items[0]!;
  (message as any).media = [
    {
      id: 'existing-editor-image',
      content_type: 'image/png',
      file_name: IMAGE_EDITOR_DRAWER_PNG.name,
      size_bytes: IMAGE_EDITOR_DRAWER_PNG.buffer.length,
      href: '/test-assets/message-card-media-preview/e2e-image-1.png',
    },
  ];
  (message as any).images = [];
  await installMessageCardMediaPreviewAssetRoutes(page, undefined, {
    body: IMAGE_EDITOR_DRAWER_PNG.buffer,
    contentType: IMAGE_EDITOR_DRAWER_PNG.mimeType,
  });
  const dutyMocks = await installRerDutyShortStateMocks(page, { inboxResponse });
  if (actionName === 'Створити розвіддонесення') {
    await page.route('**/api/1.1/messages/copy', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          payloads: [{ full_body: 'Copied E2E source message', parent_signal_message_ids: [101] }],
        }),
      }),
    );
  }
  await page.goto('/rer-duty-neo');
  await dutyMocks.systemSettingsReady;
  await expect(page.getByText('Помилка завантаження системних налаштувань')).toHaveCount(0);
  if (actionName === 'Редагувати') {
    await page.getByRole('button', { name: 'Більше дій', exact: true }).click();
    await page.getByRole('menuitem', { name: actionName, exact: true }).click();
  } else {
    await page.getByRole('button', { name: actionName }).click();
  }
  await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}
