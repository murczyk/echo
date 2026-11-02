import { expect, test, type Page } from '@playwright/test';
import type {
  AiAgentAdminRequestDetail,
  AiAgentAdminRequestItem,
  AiAgentMessageItem,
  AiAgentRequestEventItem,
} from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function installRequests(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const requests: AiAgentAdminRequestItem[] = Array.from({ length: 65 }, (_, index) => ({
    id: `request-${index + 1}`,
    conversationId: 'conversation',
    humanLoginId: 'human',
    humanLogin: 'admin',
    aiEngineId: 'engine',
    aiEngineName: 'Engine',
    prompt: `Audit prompt ${index + 1}`,
    response: null,
    state: 'completed',
    error: null,
    queuedAt: 1_700_000_000_000 - index,
    startedAt: null,
    completedAt: null,
    review: null,
  }));
  const state = { fail: false, starts: [] as (string | null)[] };
  await page.route('**/api/admin/ai-agent/requests/list', async (route) => {
    const { pageStartId } = route.request().postDataJSON();
    state.starts.push(pageStartId);
    if (state.fail) {
      await route.fulfill({ status: 500, body: 'Pagination unavailable' });
      return;
    }
    const start = pageStartId ? requests.findIndex((request) => request.id === pageStartId) : 0;
    await route.fulfill({
      json: {
        items: requests.slice(start, start + 20),
        pageSize: 20,
        total: null,
        pageStartIds: [requests[start]?.id, requests[start + 20]?.id].filter(Boolean),
      },
    });
  });
  return state;
}

test('AI request pages discover bounded cursors and allow navigation to the final page', async ({
  page,
}) => {
  const state = await installRequests(page);
  await page.goto('/admin/ai/requests');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('1');
  await expect(page.getByText('Усього:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go to page 3', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(40);
  await expect(rows.last().getByRole('cell').first()).toHaveText('40');
  expect(state.starts).toEqual([null, 'request-21']);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('41');
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(rows.first().getByRole('cell').first()).toHaveText('61');
  await expect(page.getByText('Audit prompt 61', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SHOW MORE', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to page 2', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('21');
  await expect(page.getByText('Audit prompt 21', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(25);
  await expect(rows.first().getByRole('cell').first()).toHaveText('41');
  await expect(rows.last().getByRole('cell').first()).toHaveText('65');
  await expect(page.getByRole('button', { name: 'SHOW MORE', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('1');
  await expect(page.getByText('Audit prompt 1', { exact: true })).toBeVisible();
  expect(state.starts).toEqual([
    null,
    'request-21',
    'request-41',
    'request-61',
    'request-21',
    'request-61',
    'request-41',
    'request-61',
    null,
  ]);
});

test('AI request pagination failures preserve the current entries and allow retry', async ({
  page,
}) => {
  const state = await installRequests(page);
  await page.goto('/admin/ai/requests');
  const rows = page.locator('tbody tr');
  await expect(rows).toHaveCount(20);
  state.fail = true;
  const showMore = page.getByRole('button', { name: 'SHOW MORE', exact: true });
  await showMore.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося завантажити запити' }).first(),
  ).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(showMore).toBeEnabled();
  state.fail = false;
  await showMore.click({ delay: 450 });
  await expect(rows).toHaveCount(40);
  expect(state.starts).toEqual([null, 'request-21', 'request-21']);
});

const DETAIL_TURNS = 12;
const DETAIL_CURRENT = 'turn-6';

function detailRequestItem(id: string, state: string, response: string | null) {
  return {
    id,
    conversationId: 'conversation',
    humanLoginId: 'human',
    humanLogin: 'operator',
    aiEngineId: 'engine',
    aiEngineName: 'Engine',
    prompt: `Question ${id}`,
    response,
    state,
    error: null,
    queuedAt: 1_700_000_000_000,
    startedAt: 1_700_000_001_000,
    completedAt: state === 'running' ? null : 1_700_000_009_000,
    review: null,
  } satisfies AiAgentAdminRequestItem;
}

function detailMessage(
  requestId: string,
  role: 'user' | 'assistant',
  content: string,
  requestState = 'completed',
): AiAgentMessageItem {
  return {
    reasoningPreset: 'deep',
    maxRuntimeSeconds: 900,
    startedAt: 1_700_000_001_000,
    completionMetadata: null,
    requestId,
    requestState,
    role,
    content,
    createdAt: 1_700_000_000_000,
    citations: [],
    fileCitations: [],
    maps: [],
    attachments: [],
  };
}

function detailEvent(
  sequence: number,
  eventType: string,
  payload: object,
): AiAgentRequestEventItem {
  return {
    sequence,
    eventType,
    payloadJson: JSON.stringify(payload),
    createdAt: 1_700_000_001_000 + sequence,
    activityPresentation: null,
    activityOnly: false,
  };
}

function requestDetail(id: string, completed: boolean): AiAgentAdminRequestDetail {
  const running = id === DETAIL_CURRENT && !completed;
  const messages = Array.from({ length: DETAIL_TURNS }, (_, index) => `turn-${index + 1}`).flatMap(
    (requestId) =>
      requestId === DETAIL_CURRENT && running
        ? [detailMessage(requestId, 'user', `Question ${requestId}`, 'running')]
        : [
            detailMessage(requestId, 'user', `Question ${requestId}`),
            detailMessage(
              requestId,
              'assistant',
              requestId === DETAIL_CURRENT
                ? 'Final **streamed** answer'
                : `Answer for ${requestId} with **bold** text\n\n${'Long paragraph. '.repeat(30)}`,
            ),
          ],
  );
  return {
    request: detailRequestItem(
      id,
      running ? 'running' : 'completed',
      running ? null : id === DETAIL_CURRENT ? 'Final **streamed** answer' : `Answer for ${id}`,
    ),
    conversation: {
      id: 'conversation',
      title: 'Audit dialogue',
      aiEngineId: 'engine',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_000_000,
      messages,
    },
    events: running
      ? [
          detailEvent(1, 'request_start', {}),
          detailEvent(2, 'progress', { text: 'Шукаю повідомлення' }),
        ]
      : [],
    metadata: {
      aiEngineModelName: 'glm-5.3',
      aiEngineHost: 'llm.example:8443',
      agentLogin: 'agent',
      providerApi: 'openai-completions',
      reasoningPreset: 'deep',
      reasoningEffort: 'high',
      checkpointEffort: null,
      synthesisEffort: null,
      maxRuntimeSeconds: 900,
      finalizationSeconds: 60,
      completionMetadata: null,
    },
  };
}

test('AI request details render the dialogue like the chat and follow a running request live', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const state = { completed: false, gets: [] as string[] };
  let releaseStream!: () => void;
  const streamReleased = new Promise<void>((resolve) => (releaseStream = resolve));
  await page.route('**/api/admin/ai-agent/requests/list', (route) =>
    route.fulfill({
      json: {
        items: [detailRequestItem(DETAIL_CURRENT, 'running', null)],
        pageSize: 20,
        total: null,
        pageStartIds: [DETAIL_CURRENT],
      },
    }),
  );
  await page.route('**/api/admin/ai-agent/requests/get', (route) => {
    const { requestId } = route.request().postDataJSON();
    state.gets.push(requestId);
    return route.fulfill({ json: requestDetail(requestId, state.completed) });
  });
  await page.route('**/api/admin/ai-agent/requests/*/events*', async (route) => {
    expect(new URL(route.request().url()).searchParams.get('after')).toBe('2');
    await streamReleased;
    state.completed = true;
    const events = [
      detailEvent(3, 'assistant_delta', { text: 'Final **streamed** answer' }),
      detailEvent(4, 'completion', {}),
    ];
    await route.fulfill({
      contentType: 'text/event-stream',
      body: events
        .map((event) => `id: ${event.sequence}\ndata: ${JSON.stringify(event)}\n\n`)
        .join(''),
    });
  });

  await page.goto(`/admin/ai/requests?requestId=${DETAIL_CURRENT}`);
  const dialog = page.getByRole('dialog');
  const transcript = dialog.getByTestId('admin-ai-request-transcript');
  const current = dialog.getByTestId('admin-ai-current-turn');
  await expect(dialog.getByTestId('admin-ai-request-metadata')).toContainText('glm-5.3');
  await expect(current.getByTestId('request-activity-title')).toHaveText('Шукаю повідомлення');
  await expect(current).toBeInViewport();
  await expect(transcript.locator('strong', { hasText: 'bold' }).first()).toBeAttached();

  releaseStream();
  await expect(current.locator('strong')).toHaveText('streamed');
  await expect.poll(() => state.gets.filter((id) => id === DETAIL_CURRENT).length).toBe(2);
  await expect(dialog.getByText('completed', { exact: true }).first()).toBeVisible();

  const jump = dialog.getByRole('button', { name: 'До поточного запиту', exact: true });
  await expect(jump).toHaveCount(0);
  await transcript.evaluate((element) => element.scrollTo({ top: 0 }));
  await expect(jump).toBeVisible();
  await jump.click();
  await expect(current).toBeInViewport();
  await expect(jump).toHaveCount(0);

  const other = dialog.getByTestId('admin-ai-turn-turn-7');
  const openOther = other.getByRole('button', { name: 'Відкрити цей запит', exact: true });
  await other.hover();
  await expect(openOther.locator('xpath=..')).toHaveCSS('opacity', '1');
  await openOther.click();
  await expect(page).toHaveURL(/requestId=turn-7/);
  await expect(current).toContainText('Question turn-7');
  await page.goBack();
  await expect(page).toHaveURL(new RegExp(`requestId=${DETAIL_CURRENT}`));
  await expect(current).toContainText(`Question ${DETAIL_CURRENT}`);
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).first().click();
  await expect(page).not.toHaveURL(/requestId=/);
});
