import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

// Regression: https://github.com/echoua/echo/issues/3064
test('@smoke @regression #3064 #3757 file citations preview and download pinned revisions and recheck access', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page);
  const source = {
    deviceId: '11111111-1111-4111-8111-111111111111',
    fileId: '22222222-2222-4222-8222-222222222222',
    revision: 3,
    extractionRevision: '33333333-3333-4333-8333-333333333333',
    section: 2,
  };
  const href = `/devices/${source.deviceId}?file=${source.fileId}&revision=3&extraction=${source.extractionRevision}&section=2`;
  const conversation = {
    id: '44444444-4444-4444-8444-444444444444',
    title: 'File citations',
    aiEngineId: 'engine',
    createdAt: 1,
    updatedAt: 1,
  };
  await page.route('**/api/ai-agent/configuration', (route) =>
    route.fulfill({
      json: {
        featureEnabled: true,
        defaultAiEngineId: 'engine',
        providers: [{ id: 'engine', name: 'Gemma', modelName: 'gemma' }],
      },
    }),
  );
  await page.route('**/api/ai-agent/conversations/list', (route) =>
    route.fulfill({ json: { items: [conversation] } }),
  );
  await page.route('**/api/ai-agent/conversations/get', (route) =>
    route.fulfill({
      json: {
        ...conversation,
        messages: [
          {
            requestId: 'request',
            requestState: 'completed',
            role: 'assistant',
            createdAt: 1,
            content: `Позиція з документа. [файл](${href})`,
            citations: [],
            fileCitations: [source],
          },
        ],
      },
    }),
  );
  let available = true;
  const requests: Array<Record<string, unknown>> = [];
  const bytes = Buffer.from('Original revision 3 — Документ');
  await page.route('**/api/device/files/locate', (route) => {
    expect(route.request().postDataJSON()).toEqual({
      deviceId: source.deviceId,
      fileId: source.fileId,
      revision: 3,
    });
    if (!available) return route.fulfill({ status: 403, json: { message: 'Forbidden' } });
    return route.fulfill({
      json: {
        file: transformCamelToSnake({
          entryId: source.fileId,
          fileId: source.fileId,
          parentEntryId: 'root',
          kind: 'file',
          name: 'positions.txt',
          pathComponents: ['positions.txt'],
          absolutePath: 'C:\\positions.txt',
          hasContent: true,
          mimeType: 'text/plain',
          extension: 'txt',
          revision: 3,
          syncId: null,
          sourceFileState: null,
          createdAt: '2026-10-10T00:00:00Z',
          updatedAt: '2026-10-10T00:00:00Z',
          fileMetadataCreatedAt: null,
          fileMetadataModifiedAt: null,
          tags: [],
        }),
        ancestors: [],
        rootEntryId: 'root',
        currentRevision: 4,
      },
    });
  });
  await page.route(
    `**/api/device/files/${source.deviceId}/${source.fileId}/revisions/3/content`,
    (route) =>
      route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        headers: { 'content-length': String(bytes.length) },
        body: route.request().method() === 'HEAD' ? '' : bytes,
      }),
  );
  await page.route('**/api/device/files/ai/read', (route) => {
    const req = route.request().postDataJSON();
    requests.push(req);
    if (!available) return route.fulfill({ status: 403, json: { message: 'Forbidden' } });
    const ordinal = req.after > 1 ? 3 : 2;
    return route.fulfill({
      json: {
        document: {
          ...source,
          fileName: 'positions.txt',
          path: 'C:\\positions.txt',
          format: 'xlsx',
          modifiedAt: null,
          current: false,
          hasContent: true,
          state: 'completed',
          complete: true,
          summary: 'Підсумок документа',
          summaryState: 'completed',
          positionState: 'completed',
          snippet: null,
          citation: href,
        },
        sections:
          req.limit === 0
            ? []
            : [
                {
                  id: `section-${ordinal}`,
                  ordinal,
                  member: 'positions.txt',
                  locator: `sheet 1; row ${ordinal + 1}`,
                  text: `Доказ ${ordinal}`,
                  markdown: `Доказ ${ordinal}`,
                  html: '',
                  summary: null,
                },
              ],
        nextAfter: req.limit === 0 || ordinal === 3 ? null : 2,
        warnings: [],
        coordinates: [],
        positions: [],
      },
    });
  });
  await page.goto(`/?conversation=${conversation.id}`);
  const chip = page.locator('ai-agent-chat').getByRole('link', { name: 'positions.txt · рев. 3' });
  await expect(chip).toBeVisible({ timeout: 20000 });
  await expect(chip).toHaveAttribute('href', href);
  await chip.click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('За посиланням');
  await expect(dialog).toContainText(bytes.toString());
  await expect(dialog.getByRole('link', { name: 'Відкрити у дереві файлів' })).toHaveAttribute(
    'href',
    href,
  );
  const downloaded = page.waitForEvent('download');
  await dialog.getByRole('button', { name: 'Скачати файл' }).click();
  const download = await downloaded;
  expect(await readFile((await download.path())!)).toEqual(bytes);
  await dialog.getByText('Підсумок, текст і позиції', { exact: true }).click();
  await expect(dialog).toContainText('Доказ 2');
  await dialog.getByRole('button', { name: 'Наступні розділи' }).click();
  await expect(dialog).toContainText('Доказ 3');
  expect(requests.at(-1)).toMatchObject({
    deviceId: source.deviceId,
    fileId: source.fileId,
    revision: 3,
    after: 2,
    extractionRevision: source.extractionRevision,
  });
  await dialog.getByRole('button', { name: 'Закрити перегляд' }).click();
  await page.reload();
  await expect(chip).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  available = false;
  await chip.click();
  await expect(dialog).toContainText('Не вдалося завантажити файл');
  await expect(dialog.getByTestId('device-file-content-pane')).toHaveCount(0);
  await expect(dialog).not.toContainText('Доказ 2');
  await expect(dialog).not.toContainText('Підсумок документа');
});
