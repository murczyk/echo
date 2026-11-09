import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import type {
  AiAgentDocumentArtifact,
  AiAgentDocumentSummary,
  AiAgentDocumentWorkspaceRsp,
  AiAgentUploadItem,
} from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const conversationId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const documentId = '33333333-3333-4333-8333-333333333333';
const docx = readFileSync(new URL('./fixtures/device-file-preview/document.docx', import.meta.url));
const artifact: AiAgentDocumentArtifact = {
  documentId,
  revision: 2,
  title: 'Звіт за жовтень',
  fileName: 'Звіт за жовтень.docx',
  sizeBytes: docx.length,
};
const template: AiAgentUploadItem = {
  id: '44444444-4444-4444-8444-444444444444',
  conversationId,
  requestId,
  fileName: 'Звіт за вересень.docx',
  contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  sizeBytes: docx.length,
  state: 'ready',
  isImage: false,
  chunkCount: 1,
  lastError: null,
  createdAt: 1,
};

function summary(headRevision: number): AiAgentDocumentSummary {
  return {
    id: documentId,
    conversationId,
    title: artifact.title,
    fileName: artifact.fileName,
    headRevision,
    sizeBytes: docx.length,
    sourceUploadId: template.id,
    createdAt: 1,
    updatedAt: 2,
  };
}

function workspace(headRevision: number): AiAgentDocumentWorkspaceRsp {
  return {
    document: summary(headRevision),
    revisions: [2, 1].map((revision) => ({
      revision,
      parentRevision: revision === 1 ? null : 1,
      origin: 'agent',
      summary: revision === 2 ? 'Оновив таблицю' : 'Заповнив зразок',
      requestId,
      sizeBytes: docx.length,
      createdAt: 1_700_000_000_000 + revision,
    })),
    undoRevision: headRevision === 2 ? 1 : null,
    redoRevision: headRevision === 1 ? 2 : null,
  };
}

async function installDocuments(page: Page) {
  await installAnalysisNeoApiMocks(page);
  const state = {
    head: 2,
    files: [] as string[],
    heads: [] as unknown[],
    creates: [] as Array<Record<string, unknown>>,
  };
  const conversation = {
    id: conversationId,
    title: 'Звіти',
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
            requestId,
            requestState: 'completed',
            role: 'user',
            createdAt: 1,
            content: 'Заповни такий самий звіт за жовтень',
            citations: [],
            attachments: [template],
          },
          {
            requestId,
            requestState: 'completed',
            role: 'assistant',
            createdAt: 2,
            content: `Готово: [${artifact.title}](echo-document:${documentId}).`,
            citations: [],
            documents: [artifact],
          },
        ],
      },
    }),
  );
  await page.route('**/api/ai-agent/documents/list', (route) =>
    route.fulfill({ json: { documents: [summary(state.head)] } }),
  );
  await page.route('**/api/ai-agent/uploads/list', (route) =>
    route.fulfill({ json: { uploads: [template] } }),
  );
  await page.route('**/api/ai-agent/documents/workspace', (route) =>
    route.fulfill({ json: workspace(state.head) }),
  );
  await page.route('**/api/ai-agent/documents/head', (route) => {
    const body = route.request().postDataJSON();
    state.heads.push(body);
    state.head = body.revision;
    return route.fulfill({ json: workspace(state.head) });
  });
  await page.route(`**/api/ai-agent/documents/${documentId}/revisions/*/file`, (route) => {
    state.files.push(new URL(route.request().url()).pathname);
    return route.fulfill({ contentType: 'application/octet-stream', body: docx });
  });
  await page.route(`**/api/ai-agent/uploads/${template.id}/original`, (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: docx }),
  );
  await page.route('**/api/ai-agent/requests/create', (route) => {
    state.creates.push(route.request().postDataJSON());
    return route.fulfill({
      json: { requestId: '55555555-5555-4555-8555-555555555555', conversationId, state: 'queued' },
    });
  });
  await page.route('**/api/ai-agent/requests/*/events*', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ sequence: 1, eventType: 'completion', createdAt: 3, payloadJson: JSON.stringify({ text: 'Додав колонку.' }) })}\n\n`,
    }),
  );
  await page.goto(`/?conversation=${conversationId}`);
  return state;
}

test('@regression #3985 a generated document opens beside the docked chat and its versions steer the next request', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const state = await installDocuments(page);
  const chat = page.locator('ai-agent-chat');
  await chat.getByRole('button', { name: 'Відкрити документ «Звіт за жовтень», версія 2' }).click();

  const panel = page.getByRole('region', { name: 'Документи розмови' });
  await expect(panel).toBeVisible();
  expect(await panel.evaluate((element) => element.parentElement?.className)).toContain(
    'ai-document-workspace-frame',
  );
  const chatBox = await chat.getByTestId('ai-agent-chat-pane').boundingBox();
  expect(Math.round(chatBox!.width)).toBe(420);
  await expect(
    panel.frameLocator('iframe').getByText('Device DOCX content — тільки читання'),
  ).toBeVisible();
  await expect(
    panel.getByRole('link', { name: `Завантажити ${artifact.fileName}` }),
  ).toHaveAttribute('href', `/api/ai-agent/documents/${documentId}/revisions/2/file`);
  await expect(chat.getByRole('button', { name: 'Документ: Звіт за жовтень · v2' })).toBeVisible();

  await panel.getByTestId('ai-document-revision-1').click();
  await expect
    .poll(() => state.files.at(-1))
    .toBe(`/api/ai-agent/documents/${documentId}/revisions/1/file`);
  await panel.getByRole('button', { name: 'Зробити v1 поточною' }).click();
  await expect.poll(() => state.heads).toEqual([{ documentId, expectedRevision: 2, revision: 1 }]);
  await expect(chat.getByRole('button', { name: 'Документ: Звіт за жовтень · v1' })).toBeVisible();

  await chat.getByPlaceholder('Повідомлення').fill('Додай колонку «Примітка»');
  await chat.getByRole('button', { name: 'Надіслати', exact: true }).click();
  await expect
    .poll(() => state.creates.at(-1)?.documentTarget)
    .toEqual({ documentId, revision: 1 });

  await panel.getByRole('button', { name: 'Використати як шаблон' }).click();
  await expect(chat.getByPlaceholder('Повідомлення')).toHaveValue(
    `Створи документ за зразком «${template.fileName}»: `,
  );
});

test('@regression #3985 below the Echo breakpoint the conversation files open as a full-width drawer', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1023, height: 900 });
  await installDocuments(page);
  const chat = page.locator('ai-agent-chat');
  await chat.getByRole('button', { name: 'Файли розмови: 2' }).click();
  const panel = page.getByRole('region', { name: 'Документи розмови' });
  await expect(panel).toBeVisible();
  const rect = await panel.boundingBox();
  expect(rect!.width).toBe(1023);
  await expect(panel.getByRole('complementary', { name: 'Файли розмови' })).toContainText(
    template.fileName,
  );
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
});

test('@regression #3985 an undo finishing after switching documents leaves the newly opened document shown', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installDocuments(page);
  const otherId = '66666666-6666-4666-8666-666666666666';
  const other: AiAgentDocumentSummary = {
    ...summary(1),
    id: otherId,
    title: 'Довідка',
    fileName: 'Довідка.docx',
    sourceUploadId: null,
  };
  await page.route('**/api/ai-agent/documents/list', (route) =>
    route.fulfill({ json: { documents: [summary(2), other] } }),
  );
  await page.route('**/api/ai-agent/documents/workspace', (route) =>
    route.fulfill({
      json:
        route.request().postDataJSON().documentId === otherId
          ? { ...workspace(1), document: other, revisions: workspace(1).revisions.slice(1) }
          : workspace(2),
    }),
  );
  await page.route(`**/api/ai-agent/documents/${otherId}/revisions/*/file`, (route) =>
    route.fulfill({ contentType: 'application/octet-stream', body: docx }),
  );
  let releaseHead = () => {};
  const held = new Promise<void>((resolve) => (releaseHead = resolve));
  await page.route('**/api/ai-agent/documents/head', async (route) => {
    await held;
    await route.fulfill({ json: workspace(1) });
  });

  const chat = page.locator('ai-agent-chat');
  await chat.getByRole('button', { name: 'Відкрити документ «Звіт за жовтень», версія 2' }).click();
  const panel = page.getByRole('region', { name: 'Документи розмови' });
  await panel.getByRole('button', { name: 'Повернути попередню версію' }).click();
  await expect(panel.getByLabel('Зберігаємо')).toBeVisible();
  await panel.getByRole('button', { name: /Довідка/ }).click();
  await expect(panel.getByRole('link', { name: 'Завантажити Довідка.docx' })).toBeVisible();

  releaseHead();
  await expect(panel.getByLabel('Зберігаємо')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Завантажити Довідка.docx' })).toHaveAttribute(
    'href',
    `/api/ai-agent/documents/${otherId}/revisions/1/file`,
  );
  await expect(
    panel.frameLocator('iframe').getByText('Device DOCX content — тільки читання'),
  ).toBeVisible();
  await expect(chat.getByRole('button', { name: 'Документ: Довідка · v1' })).toBeVisible();
});
