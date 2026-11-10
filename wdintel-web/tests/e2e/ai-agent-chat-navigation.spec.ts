import { createServer, type ServerResponse } from 'node:http';
import { expect, test, type Page } from '@playwright/test';
import type { AiAgentActivityPresentation } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const conversationId = '11111111-1111-4111-8111-111111111111';
const otherId = '22222222-2222-4222-8222-222222222222';
const conversation = {
  id: conversationId,
  title: 'Розвіддані',
  aiEngineId: 'engine',
  createdAt: 1,
  updatedAt: 1,
};

async function installChat(page: Page, saved = false) {
  await installAnalysisNeoApiMocks(page);
  const state = {
    conversations: saved
      ? [conversation, { ...conversation, id: otherId, title: 'Інша розмова' }]
      : [],
    deletes: [] as string[],
    rejectDelete: false,
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
    route.fulfill({ json: { items: state.conversations } }),
  );
  await page.route('**/api/ai-agent/conversations/get', (route) => {
    const selected = state.conversations.find(
      (item) => item.id === route.request().postDataJSON().id,
    );
    return selected
      ? route.fulfill({
          json: {
            ...selected,
            messages: [
              {
                requestId: `request-${selected.id}`,
                requestState: 'completed',
                role: 'assistant',
                content: `Збережена відповідь: ${selected.title}`,
                createdAt: 1,
              },
            ],
          },
        })
      : route.fulfill({ status: 404, body: 'Розмову не знайдено' });
  });
  await page.route('**/api/ai-agent/requests/create', (route) => {
    if (!state.conversations.length) state.conversations.push(conversation);
    return route.fulfill({
      json: { requestId: `request-${conversationId}`, conversationId, state: 'queued' },
    });
  });
  await page.route('**/api/ai-agent/requests/*/events*', (route) =>
    route.fulfill({
      contentType: 'text/event-stream',
      body: `data: ${JSON.stringify({ sequence: 1, eventType: 'completion', createdAt: 1, payloadJson: JSON.stringify({ text: 'Збережена відповідь: Розвіддані' }) })}\n\n`,
    }),
  );
  await page.route('**/api/ai-agent/conversations/delete', (route) => {
    const { id } = route.request().postDataJSON();
    state.deletes.push(id);
    if (state.rejectDelete)
      return route.fulfill({ status: 400, body: 'Неможливо видалити розмову з активним запитом' });
    state.conversations = state.conversations.filter((item) => item.id !== id);
    return route.fulfill({ status: 204 });
  });
  return state;
}

async function openHistory(page: Page) {
  await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
  await expect(page.locator('ai-agent-chat aside')).toHaveAttribute('aria-hidden', 'false');
}

for (const width of [1280, 320]) {
  test(`@regression #3064 composer stops a restored long task and preserves the draft at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installChat(page, true);
    const requestId = 'request-stop';
    let cancelled = false;
    let attempts = 0;
    let acceptStop!: () => void;
    let finishStream!: () => void;
    const stopAccepted = new Promise<void>((resolve) => {
      acceptStop = resolve;
    });
    const streamFinished = new Promise<void>((resolve) => {
      finishStream = resolve;
    });
    const partial = Array.from(
      { length: 80 },
      (_, index) => `Часткова відповідь ${index + 1}.`,
    ).join('\n\n');
    await page.route('**/api/ai-agent/conversations/get', (route) =>
      route.fulfill({
        json: {
          ...conversation,
          messages: [
            {
              requestId,
              requestState: cancelled ? 'cancelled' : 'running',
              role: 'user',
              content: 'Тривалий запит',
              createdAt: 1,
            },
            {
              requestId,
              requestState: cancelled ? 'cancelled' : 'running',
              role: 'assistant',
              content: partial,
              createdAt: 1,
            },
          ],
        },
      }),
    );
    await page.route('**/api/ai-agent/requests/*/events*', async (route) => {
      await streamFinished;
      await route.fulfill({
        contentType: 'text/event-stream',
        body: `data: ${JSON.stringify({ sequence: 1, eventType: 'cancellation', createdAt: Date.now(), payloadJson: '{}' })}\n\n`,
      });
    });
    await page.route('**/api/ai-agent/requests/cancel', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ requestId });
      attempts += 1;
      if (attempts === 1) return route.fulfill({ status: 500, body: 'Сервіс недоступний' });
      await stopAccepted;
      cancelled = true;
      await route.fulfill({ json: { state: 'cancelled' } });
    });
    try {
      await page.goto(`/?conversation=${conversationId}`);
      const chat = page.locator('ai-agent-chat');
      const input = chat.getByPlaceholder('Повідомлення');
      const stop = chat.getByRole('button', { name: 'Зупинити запит', exact: true });
      await expect(stop).toBeVisible();
      await expect(stop).toBeInViewport();
      const box = await stop.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await input.fill('Чернетка наступного запиту');
      await stop.focus();
      const failedAt = Date.now();
      await page.keyboard.press('Enter');
      await expect(
        page.getByRole('alert').filter({ hasText: 'Не вдалося скасувати запит' }),
      ).toBeVisible();
      await expect(stop).toBeEnabled();
      await expect(input).toHaveValue('Чернетка наступного запиту');
      await page.getByRole('button', { name: 'Закрити сповіщення', exact: true }).click();
      await expect(
        page.getByRole('alert').filter({ hasText: 'Не вдалося скасувати запит' }),
      ).toHaveCount(0);
      await expect.poll(() => Date.now() - failedAt).toBeGreaterThan(410);
      await stop.click();
      await expect.poll(() => attempts).toBe(2);
      await expect(stop).toBeDisabled();
      await stop.evaluate((button: HTMLButtonElement) => button.click());
      expect(attempts).toBe(2);
      acceptStop();
      finishStream();
      await expect(stop).toHaveCount(0);
      await expect(chat).toContainText(/скасовано/i);
      await expect(chat).toContainText('Часткова відповідь 80.');
      await expect(input).toHaveValue('Чернетка наступного запиту');
      await page.reload();
      await expect(chat).toContainText(/скасовано/i);
      await expect(chat).toContainText('Часткова відповідь 80.');
      await expect(stop).toHaveCount(0);
    } finally {
      acceptStop();
      finishStream();
    }
  });
}

test('@regression #3064 parallel searches stream independent activity before the answer finishes', async ({
  page,
}) => {
  let eventResponse: ServerResponse | undefined;
  const server = createServer((request, response) => {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Access-Control-Allow-Origin': request.headers.origin ?? new URL(page.url()).origin,
      'Access-Control-Allow-Credentials': 'true',
    });
    response.flushHeaders();
    eventResponse = response;
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  expect(address).not.toBeNull();
  expect(typeof address).toBe('object');
  const port = (address as { port: number }).port;
  const emitEvent = (
    sequence: number,
    eventType: string,
    payload: Record<string, unknown>,
    presentation?: AiAgentActivityPresentation,
    activityOnly = false,
  ) => {
    const metadata = presentation ? { activityPresentation: presentation, activityOnly } : {};
    eventResponse!.write(
      `data: ${JSON.stringify({ sequence, eventType, createdAt: Date.now(), payloadJson: JSON.stringify(activityOnly ? metadata : payload), ...metadata })}\n\n`,
    );
  };

  try {
    await installChat(page);
    await page.route('**/api/ai-agent/requests/*/events*', (route) =>
      route.continue({ url: `http://127.0.0.1:${port}/events` }),
    );
    await page.goto('/');
    const chat = page.locator('ai-agent-chat');
    await chat
      .getByPlaceholder('Повідомлення')
      .fill('знайди 20 головних подій за тиждень, по підрозділах противника');
    await chat.getByRole('button', { name: 'Надіслати', exact: true }).click();
    await expect.poll(() => Boolean(eventResponse)).toBe(true);
    const liveRequest = chat.getByTestId(`live-request-request-${conversationId}`);
    const firstSearch = liveRequest.getByTestId('tool-activity-search-unit-a');
    const secondSearch = liveRequest.getByTestId('tool-activity-search-unit-b');
    const activityDetails = liveRequest.locator('details');
    const activitySummary = activityDetails.locator('summary');
    const currentAction = liveRequest.getByTestId('request-activity-title');
    const currentDetail = liveRequest.getByTestId('request-activity-detail');
    const historyRows = activityDetails.locator('summary + div > *');
    const activity = {
      toolName: 'echo_inbox_messages',
      toolLabel: 'Шукаю перехоплення: джерела «Група А» · за 23–29 вер. 2026 р.',
    };
    const secondActivity = {
      ...activity,
      toolLabel: 'Шукаю перехоплення: джерела «Група Б» · за 23–29 вер. 2026 р.',
    };
    const firstPresentation: AiAgentActivityPresentation = {
      key: 1,
      title: 'Шукаю перехоплення',
      detail: 'Джерела «Група А» · за 23–29 вер. 2026 р.',
    };
    const generatedFirstPresentation = {
      ...firstPresentation,
      title: 'Збираю події з повідомлень за тиждень',
    };
    const secondPresentation = {
      ...firstPresentation,
      key: 2,
      detail: 'Джерела «Група Б» · за 23–29 вер. 2026 р.',
    };
    const firstCompletedLabel =
      'Переглядаю повідомлення з добірки: 12 · зібрано для запиту: 12 · джерела «Група А» · за 23–29 вер. 2026 р.';

    await page.emulateMedia({ reducedMotion: 'no-preference' });
    emitEvent(1, 'request_start', {});
    emitEvent(2, 'tool_start', { ...activity, toolCallId: 'search-unit-a' }, firstPresentation);
    await expect(firstSearch).toHaveAttribute('data-status', 'running');
    await expect(activityDetails).toHaveJSProperty('open', false);
    await expect(firstSearch.getByLabel('Виконується')).toBeHidden();
    await expect(currentAction).toHaveText(firstPresentation.title);
    await expect(currentDetail).toHaveText(firstPresentation.detail!);
    await expect(secondSearch).toHaveCount(0);
    await expect(historyRows).toHaveCount(1);

    emitEvent(3, 'progress', {}, generatedFirstPresentation, true);
    await expect(currentAction).toHaveText(generatedFirstPresentation.title);
    await expect(currentAction).toHaveAttribute('role', 'status');
    await expect(historyRows).toHaveCount(1);
    await expect(firstSearch).toHaveAttribute('data-status', 'running');
    await expect(firstSearch).toContainText(activity.toolLabel);
    await expect(activityDetails).toHaveJSProperty('open', false);
    await expect(currentAction).toHaveCSS('animation-name', 'requestActivityTitlePulse');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(currentAction).toHaveCSS('animation-name', 'none');
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await expect(currentAction).toHaveCSS('animation-name', 'requestActivityTitlePulse');

    const duration = liveRequest.getByLabel('Час виконання');
    await expect(duration).toHaveCount(1);
    await expect(activitySummary.getByLabel('Час виконання')).toBeVisible();
    const initialDuration = await duration.textContent();
    await expect(duration).not.toHaveText(initialDuration!);
    await activitySummary.click();
    await expect(firstSearch.getByLabel('Виконується')).toBeVisible();

    emitEvent(
      4,
      'tool_start',
      { ...secondActivity, toolCallId: 'search-unit-b' },
      secondPresentation,
    );
    await expect(secondSearch).toHaveAttribute('data-status', 'running');
    await expect(firstSearch).toHaveAttribute('data-status', 'running');
    await expect(activityDetails).toHaveJSProperty('open', true);
    await expect(currentAction).toHaveText(secondPresentation.title);
    await expect(currentDetail).toHaveText(secondPresentation.detail);
    await expect(liveRequest.locator('[data-testid^="tool-activity-"]')).toHaveCount(2);
    await expect(firstSearch).toContainText(activity.toolLabel);
    await expect(secondSearch).toContainText(secondActivity.toolLabel);

    emitEvent(
      5,
      'progress',
      {},
      {
        ...firstPresentation,
        title: 'Застаріла назва пошуку групи А',
      },
      true,
    );
    emitEvent(
      6,
      'tool_end',
      {
        ...activity,
        toolCallId: 'search-unit-a',
        toolLabel: firstCompletedLabel,
        isError: false,
      },
      {
        key: 3,
        title: 'Переглядаю повідомлення з добірки',
        detail:
          '12 повідомлень · зібрано для запиту: 12 · джерела «Група А» · за 23–29 вер. 2026 р.',
      },
    );
    await expect(firstSearch).toHaveAttribute('data-status', 'completed');
    await expect(firstSearch.getByLabel('Завершено')).toBeVisible();
    await expect(secondSearch).toHaveAttribute('data-status', 'running');
    await expect(secondSearch.getByLabel('Виконується')).toBeVisible();
    await expect(currentAction).toHaveText(secondPresentation.title);
    await expect(currentDetail).toHaveText(secondPresentation.detail);
    await expect(historyRows).toHaveCount(2);
    await activitySummary.click();
    await expect(activityDetails).toHaveJSProperty('open', false);
    await expect(firstSearch).toBeHidden();
    await expect(secondSearch).toBeHidden();
    const cancel = liveRequest.getByRole('button', { name: 'Скасувати запит', exact: true });
    await expect(cancel).toBeEnabled();

    const groupingLabel = 'Групую знайдені події за підрозділами';
    emitEvent(
      7,
      'progress',
      { text: groupingLabel },
      {
        key: 4,
        title: 'Групую знайдені події',
        detail: null,
      },
    );
    await expect(currentAction).toHaveText(secondPresentation.title);
    await expect(activityDetails.getByText(groupingLabel, { exact: true })).toBeHidden();
    await expect(activityDetails).toHaveJSProperty('open', false);
    const updatedLabel =
      'Переглядаю повідомлення з добірки: 12 · зібрано для запиту: 24 · джерела «Група Б» · за 23–29 вер. 2026 р.';
    const updatedPresentation: AiAgentActivityPresentation = {
      key: 5,
      title: 'Переглядаю повідомлення з добірки',
      detail: '12 повідомлень · зібрано для запиту: 24 · джерела «Група Б» · за 23–29 вер. 2026 р.',
    };
    emitEvent(
      8,
      'tool_update',
      {
        ...secondActivity,
        toolCallId: 'search-unit-b',
        toolLabel: updatedLabel,
      },
      updatedPresentation,
    );
    await expect(secondSearch).toContainText(updatedLabel);
    await expect(secondSearch).toHaveAttribute('data-status', 'running');
    await expect(firstSearch).toHaveAttribute('data-status', 'completed');
    await expect(activityDetails).toHaveJSProperty('open', false);
    await expect(secondSearch).toBeHidden();
    await expect(currentAction).toHaveText(updatedPresentation.title);
    const generatedPresentation = {
      ...updatedPresentation,
      title: 'Відбираю головні події для тижневого підсумку',
    };
    emitEvent(9, 'progress', {}, generatedPresentation, true);
    await expect(currentAction).toHaveText(generatedPresentation.title);
    await expect(currentAction).toHaveAttribute('title', generatedPresentation.title);
    await expect(currentDetail).toHaveText(generatedPresentation.detail!);
    await expect(currentDetail).toHaveCount(1);
    await expect(historyRows).toHaveCount(3);
    await expect(liveRequest.getByText(generatedPresentation.title, { exact: true })).toHaveCount(
      1,
    );
    await expect(secondSearch).toHaveAttribute('data-status', 'running');
    await expect(secondSearch).toContainText(updatedLabel);

    const desktopViewport = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    for (const line of [currentAction, currentDetail]) {
      await expect
        .poll(() =>
          line.evaluate((element) => {
            const style = getComputedStyle(element);
            return {
              whiteSpace: style.whiteSpace,
              overflow: style.overflow,
              textOverflow: style.textOverflow,
              truncated: element.scrollWidth > element.clientWidth,
            };
          }),
        )
        .toEqual({
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          truncated: true,
        });
    }
    const actionBounds = (await currentAction.boundingBox())!;
    for (const control of [duration, cancel]) {
      const controlBounds = (await control.boundingBox())!;
      expect(controlBounds.y).toBeLessThan(actionBounds.y + actionBounds.height);
      expect(controlBounds.y + controlBounds.height).toBeGreaterThan(actionBounds.y);
    }
    const detailBounds = (await currentDetail.boundingBox())!;
    const summaryBounds = (await activitySummary.boundingBox())!;
    expect(detailBounds.y).toBeGreaterThanOrEqual(actionBounds.y + actionBounds.height);
    expect(summaryBounds.height).toBeLessThanOrEqual(
      (await cancel.boundingBox())!.height + detailBounds.height + 4,
    );
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
      true,
    );
    await page.setViewportSize(desktopViewport);
    await expect(page.getByRole('alert')).toHaveCount(0);
    const progressPreview = test.info().outputPath('progress-fixture-preview.png');
    await page.screenshot({ path: progressPreview });
    await test.info().attach('Fixture preview: generated activity title and factual detail', {
      path: progressPreview,
      contentType: 'image/png',
    });

    emitEvent(
      10,
      'progress',
      {},
      {
        ...secondPresentation,
        title: 'Запізніла назва попереднього кроку групи Б',
      },
      true,
    );
    emitEvent(11, 'assistant_delta', {
      delta: '## Головні події\n\nПідрозділ А: переміщення техніки.',
    });
    await expect(liveRequest.getByRole('heading', { name: 'Головні події' })).toBeVisible();
    await expect(currentAction).toHaveText(generatedPresentation.title);
    await expect(currentDetail).toHaveText(generatedPresentation.detail!);
    await expect(historyRows).toHaveCount(3);
    await expect(secondSearch).toHaveAttribute('data-status', 'running');
    await expect(cancel).toBeEnabled();
    await activitySummary.click();
    await expect(activityDetails).toHaveJSProperty('open', true);
    await expect(secondSearch).toBeVisible();
    const secondCompletedLabel = updatedLabel;
    const completedPresentation = {
      ...updatedPresentation,
      key: 6,
      title: 'Переглядаю знайдені повідомлення',
    };
    emitEvent(
      12,
      'tool_end',
      {
        ...secondActivity,
        toolCallId: 'search-unit-b',
        toolLabel: secondCompletedLabel,
        isError: false,
      },
      completedPresentation,
    );
    await expect(secondSearch).toHaveAttribute('data-status', 'completed');
    await expect(currentAction).toHaveText(completedPresentation.title);
    emitEvent(13, 'completion', {});
    emitEvent(
      14,
      'progress',
      {},
      {
        ...completedPresentation,
        title: 'Запізніла назва завершеного запиту',
        detail: 'Пізні деталі завершеного запиту',
      },
      true,
    );
    eventResponse!.end();
    await expect(cancel).toHaveCount(0);
    await expect(firstSearch).toHaveAttribute('data-status', 'completed');
    await expect(secondSearch).toHaveAttribute('data-status', 'completed');
    await expect(liveRequest.getByRole('status')).toHaveCount(0);
    await expect(currentAction).toHaveCSS('animation-name', 'none');
    await expect(currentAction).toContainText('Хід виконання');
    await expect(currentDetail).toHaveCount(0);
    await expect(historyRows).toHaveCount(3);
    await expect(liveRequest).not.toContainText('Запізніла назва завершеного запиту');
    await expect(activityDetails).toHaveJSProperty('open', false);
    await expect(duration).toHaveCount(1);
    await expect(activitySummary.getByLabel('Час виконання')).toBeVisible();
    await activitySummary.click();
    await expect(firstSearch).toBeVisible();
    await expect(secondSearch).toBeVisible();
    await activitySummary.click();
    await expect(activityDetails).toHaveJSProperty('open', false);
    const completedDuration = await duration.textContent();
    const completedAt = Date.now();
    await expect
      .poll(async () => ({
        elapsed: Date.now() - completedAt >= 1100,
        duration: await duration.textContent(),
      }))
      .toEqual({ elapsed: true, duration: completedDuration });
    const completedPreview = test.info().outputPath('compact-progress-fixture-preview.png');
    await page.screenshot({ path: completedPreview });
    await test.info().attach('Fixture preview: compact completed progress', {
      path: completedPreview,
      contentType: 'image/png',
    });

    await page.route('**/api/ai-agent/requests/create', (route) =>
      route.fulfill({ json: { requestId: 'request-cancel', conversationId, state: 'queued' } }),
    );
    await page.route('**/api/ai-agent/requests/cancel', (route) =>
      route.fulfill({ json: { state: 'cancelled' } }),
    );
    eventResponse = undefined;
    await chat.getByPlaceholder('Повідомлення').fill('Перевір події за підрозділами');
    await chat.getByRole('button', { name: 'Надіслати', exact: true }).click();
    await expect.poll(() => Boolean(eventResponse)).toBe(true);
    const cancelledRequest = chat.getByTestId('live-request-request-cancel');
    const cancelledSearch = cancelledRequest.getByTestId('tool-activity-search-unit-b');
    emitEvent(1, 'request_start', {});
    emitEvent(2, 'tool_start', { ...activity, toolCallId: 'search-unit-a' });
    emitEvent(3, 'tool_start', { ...activity, toolCallId: 'search-unit-b' });
    emitEvent(4, 'tool_end', { ...activity, toolCallId: 'search-unit-a', isError: false });
    await expect(cancelledSearch).toHaveAttribute('data-status', 'running');
    await expect(cancelledRequest.locator('details')).toHaveJSProperty('open', false);
    await cancelledRequest.getByRole('button', { name: 'Скасувати запит', exact: true }).click();
    await expect(cancelledRequest.locator('details')).toHaveJSProperty('open', false);
    await expect(cancelledSearch).toHaveAttribute('data-status', 'cancelled');
    await expect(cancelledSearch.getByLabel('Перервано')).toHaveCount(1);
    await expect(cancelledRequest.getByRole('progressbar')).toHaveCount(0);
    await expect(cancelledRequest.getByTestId('request-activity-title')).toHaveCSS(
      'animation-name',
      'none',
    );
    await expect(cancelledRequest.getByTestId('request-activity-detail')).toHaveCount(0);
    await expect(cancelledRequest.getByTestId('tool-activity-search-unit-a')).toHaveAttribute(
      'data-status',
      'completed',
    );
    eventResponse?.end();
  } finally {
    eventResponse?.end();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test('@regression #3064 failed chat retries preserve the prompt, provider and draft after reload', async ({
  page,
}) => {
  await installChat(page, true);
  const originalPrompt = 'знайди 20 головних подій за тиждень, по підрозділах противника';
  const draft = 'Чернетка наступного запиту';
  const submissions: unknown[] = [];
  let acceptRetry!: () => void;
  const retryAccepted = new Promise<void>((resolve) => {
    acceptRetry = resolve;
  });
  let completeRetry!: () => void;
  const retryCompleted = new Promise<void>((resolve) => {
    completeRetry = resolve;
  });
  let failed = false;
  const streamEvent = (eventType: string, text: string) =>
    `data: ${JSON.stringify({ sequence: 1, eventType, createdAt: Date.now(), payloadJson: JSON.stringify({ text }) })}\n\n`;

  await page.route('**/api/ai-agent/conversations/get', (route) =>
    route.fulfill({
      json: {
        ...conversation,
        messages: failed
          ? [
              {
                requestId: 'request-retry-1',
                requestState: 'failed',
                role: 'user',
                content: originalPrompt,
                createdAt: Date.now(),
              },
            ]
          : [],
      },
    }),
  );
  await page.route('**/api/ai-agent/requests/create', async (route) => {
    submissions.push(route.request().postDataJSON());
    const attempt = submissions.length;
    if (attempt === 2) await retryAccepted;
    await route.fulfill({
      json: { requestId: `request-retry-${attempt}`, conversationId, state: 'running' },
    });
  });
  await page.route('**/api/ai-agent/requests/*/events*', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    const firstRequest = pathname.includes('/request-retry-1/');
    if (firstRequest) failed = true;
    if (pathname.includes('/request-retry-2/')) await retryCompleted;
    await route.fulfill({
      contentType: 'text/event-stream',
      body: streamEvent(
        firstRequest ? 'error' : 'completion',
        firstRequest ? 'Сервіс тимчасово недоступний' : 'Повторний запит завершено.',
      ),
    });
  });

  try {
    await page.goto('/');
    const chat = page.locator('ai-agent-chat');
    const input = chat.getByPlaceholder('Повідомлення');
    await input.fill(originalPrompt);
    await chat.getByRole('button', { name: 'Надіслати', exact: true }).click();
    await expect(page).toHaveURL(`/?conversation=${conversationId}`);
    const failedRequest = chat.getByTestId('live-request-request-retry-1');
    const retry = failedRequest.getByRole('button', { name: 'Спробувати ще раз', exact: true });
    await expect(retry).toBeEnabled();
    await expect(failedRequest).toContainText(originalPrompt);
    await expect(
      page
        .getByRole('alert')
        .filter({ hasText: 'Помилка завантаження статистики активності груп' }),
    ).toHaveCount(0);
    const retryPreview = test.info().outputPath('retry-fixture-preview.png');
    await page.screenshot({ path: retryPreview });
    await test.info().attach('Fixture preview: failed message retry', {
      path: retryPreview,
      contentType: 'image/png',
    });

    await input.fill(draft);
    await retry.click();
    await expect.poll(() => submissions.length).toBe(2);
    expect(submissions[1]).toEqual({
      conversationId,
      aiEngineId: 'engine',
      prompt: originalPrompt,
      mapEdit: null,
      documentTarget: null,
      reasoningPreset: null,
      uploadIds: [],
    });
    await expect(retry).toBeDisabled();
    await expect(input).toHaveValue(draft);
    await retry.evaluate((button: HTMLButtonElement) => button.click());
    expect(submissions).toHaveLength(2);
    acceptRetry();
    const repeatedRequest = chat.getByTestId('live-request-request-retry-2');
    await expect(
      repeatedRequest.getByRole('button', { name: 'Скасувати запит', exact: true }),
    ).toBeVisible();
    await expect(retry).toBeDisabled();
    await expect(input).toHaveValue(draft);
    await retry.evaluate((button: HTMLButtonElement) => button.click());
    expect(submissions).toHaveLength(2);
    completeRetry();
    await expect(repeatedRequest).toContainText('Повторний запит завершено.');
    await expect(retry).toBeEnabled();
    await expect(input).toHaveValue(draft);

    await page.reload();
    const savedMessage = chat.getByText(originalPrompt, { exact: true }).locator('..');
    const savedRetry = savedMessage.getByRole('button', { name: 'Спробувати ще раз', exact: true });
    await expect(savedRetry).toBeEnabled();
    await input.fill(draft);
    await savedRetry.click();
    await expect.poll(() => submissions.length).toBe(3);
    expect(submissions[2]).toEqual({
      conversationId,
      aiEngineId: 'engine',
      prompt: originalPrompt,
      mapEdit: null,
      documentTarget: null,
      reasoningPreset: null,
      uploadIds: [],
    });
    await expect(chat.getByTestId('live-request-request-retry-3')).toContainText(
      'Повторний запит завершено.',
    );
    await expect(input).toHaveValue(draft);
  } finally {
    acceptRetry();
    completeRetry();
  }
});

test('@regression #3064 chat URLs survive reload and browser history; logo starts fresh', async ({
  page,
}) => {
  await installChat(page);
  await page.goto('/');
  const chat = page.locator('ai-agent-chat');
  const input = chat.getByPlaceholder('Повідомлення');
  await input.fill('Запит');
  await expect(page).toHaveURL(/\/$/);
  await chat.getByRole('button', { name: 'Надіслати', exact: true }).click();
  await expect(page).toHaveURL(`/?conversation=${conversationId}`);
  await expect(chat).toContainText('Збережена відповідь: Розвіддані');
  await page.goBack();
  await expect(page).toHaveURL(/\/$/);
  await expect(chat).not.toContainText('Збережена відповідь: Розвіддані');
  await page.goForward();
  await expect(chat).toContainText('Збережена відповідь: Розвіддані');
  await page.reload();
  await expect(chat).toContainText('Збережена відповідь: Розвіддані');
  const logo = page.locator('a.app-navbar-logo');
  const popupPromise = page.context().waitForEvent('page');
  await logo.click({ modifiers: ['Control'] });
  const popup = await popupPromise;
  await popup.close();
  await expect(page).toHaveURL(`/?conversation=${conversationId}`);
  await expect(chat).toContainText('Збережена відповідь: Розвіддані');
  await logo.click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chat).not.toContainText('Збережена відповідь: Розвіддані');
  await input.fill('Чернетка');
  await logo.click();
  await expect(input).toHaveValue('');
  await openHistory(page);
  await chat
    .getByRole('button', { name: /Розвіддані/ })
    .first()
    .click();
  await expect(page).toHaveURL(`/?conversation=${conversationId}`);
  await expect(chat).toContainText('Збережена відповідь: Розвіддані');
});

test('@regression #3064 desktop history menu confirms deletion and preserves failed or other conversations', async ({
  page,
}) => {
  const state = await installChat(page, true);
  await page.goto(`/?conversation=${otherId}`);
  const chat = page.locator('ai-agent-chat');
  await expect(chat).toContainText('Збережена відповідь: Інша розмова');
  await openHistory(page);
  const menuButton = chat.getByRole('button', { name: 'Меню розмови «Розвіддані»', exact: true });
  await expect(menuButton).toHaveCSS('opacity', '0');
  await menuButton.locator('..').hover();
  await expect(menuButton).toHaveCSS('opacity', '1');
  await menuButton.click();
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Розвіддані');
  await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
  expect(state.deletes).toEqual([]);
  await menuButton.focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  state.rejectDelete = true;
  await dialog.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'активним запитом' })).toBeVisible();
  await expect(page).toHaveURL(`/?conversation=${otherId}`);
  await expect(chat.locator('[aria-label="Меню розмови «Розвіддані»"]')).toBeAttached();
  state.rejectDelete = false;
  await dialog.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(menuButton).toHaveCount(0);
  await expect(chat).toContainText('Збережена відповідь: Інша розмова');
  await expect(page).toHaveURL(`/?conversation=${otherId}`);
  await chat.getByRole('button', { name: 'Меню розмови «Інша розмова»', exact: true }).focus();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  await dialog.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chat).not.toContainText('Збережена відповідь: Інша розмова');
});

test.describe('mobile navbar', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('@regression #3633 tapping the navbar logo keeps its front side visible', async ({
    page,
  }) => {
    await installChat(page, true);
    await page.goto(`/?conversation=${conversationId}`);
    const chat = page.locator('ai-agent-chat');
    const logo = page.locator('a.app-navbar-logo');
    const coin = logo.locator('.logo-coin');
    await expect(chat).toContainText('Збережена відповідь: Розвіддані');
    await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');

    await logo.tap();

    await expect(page).toHaveURL(/\/$/);
    await expect(chat).not.toContainText('Збережена відповідь: Розвіддані');
    await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');
  });
});

test('@regression #3633 keyboard focus flips the navbar logo and blur restores it', async ({
  page,
}) => {
  await installChat(page);
  await page.goto('/');
  const logo = page.locator('a.app-navbar-logo');
  const coin = logo.locator('.logo-coin');

  await page.keyboard.press('Tab');
  await expect(logo).toBeFocused();
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'back');

  await page.keyboard.press('Tab');
  await expect(logo).not.toBeFocused();
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');
});

test.describe('mobile history', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test('@regression #3064 touch scrolling cancels a hold; long press opens deletion without selecting', async ({
    page,
  }) => {
    await installChat(page, true);
    await page.goto('/');
    await openHistory(page);
    const row = page.locator('ai-agent-chat aside').getByRole('button', { name: /^Розвіддані/ });
    await row.tap({ trial: true });
    const box = await row.boundingBox();
    expect(box).not.toBeNull();
    const point = { x: box!.x + 40, y: box!.y + box!.height / 2 };
    const touch = await page.context().newCDPSession(page);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove',
      touchPoints: [{ ...point, y: point.y + 35 }],
    });
    await page.waitForTimeout(600);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page.getByRole('menuitem')).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    await expect(page.getByRole('menuitem', { name: 'Видалити', exact: true })).toBeVisible();
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(page).toHaveURL(/\/$/);
    await page.getByRole('menuitem', { name: 'Видалити', exact: true }).tap();
    await page.getByRole('dialog').getByRole('button', { name: 'Видалити', exact: true }).tap();
    await expect(row).toHaveCount(0);
    await expect(page).toHaveURL(/\/$/);
  });
});

for (const width of [1280, 320]) {
  test(`@regression #3724 explicitly selects Deep and resets the composer at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    const state = await installChat(page);
    await page.route('**/api/ai-agent/configuration', (route) =>
      route.fulfill({
        json: {
          featureEnabled: true,
          reasoningPresetsEnabled: true,
          defaultAiEngineId: 'engine',
          providers: [
            {
              id: 'engine',
              name: 'Sol',
              modelName: 'gpt-6-sol',
              reasoningAvailable: true,
              reasoningPresets: [
                { preset: 'fast', maxRuntimeSeconds: 120, reasoningEffort: 'none' },
                { preset: 'balanced', maxRuntimeSeconds: 300, reasoningEffort: 'medium' },
                { preset: 'deep', maxRuntimeSeconds: 14_400, reasoningEffort: 'max' },
              ],
            },
          ],
        },
      }),
    );
    const submitted: string[] = [];
    await page.route('**/api/ai-agent/requests/create', (route) => {
      submitted.push(route.request().postDataJSON().reasoningPreset);
      if (!state.conversations.length) state.conversations.push(conversation);
      return route.fulfill({
        json: { requestId: `reasoning-${submitted.length}`, conversationId, state: 'queued' },
      });
    });
    await page.goto('/');
    const selector = page.getByRole('combobox', { name: 'Глибина аналізу' });
    await expect(selector).toHaveText('Збалансований');
    await selector.hover();
    await page.waitForTimeout(800);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await selector.click();
    await expect(page.getByRole('option')).toHaveText([
      'Швидкийдо 2 хв',
      'Збалансованийдо 5 хв',
      'Глибокийдо 4 год; нові повідомлення чекатимуть у черзі',
    ]);
    await expect(page.getByRole('tooltip')).toHaveCount(0);
    await page.getByRole('option', { name: /^Глибокий/ }).click();
    await page.getByPlaceholder('Повідомлення').fill('Докладне дослідження');
    await page.getByRole('button', { name: 'Надіслати', exact: true }).click();
    await expect.poll(() => submitted).toEqual(['deep']);
    await expect(selector).toContainText('Збалансований');
    await expect(selector).toBeEnabled();
    await page.getByPlaceholder('Повідомлення').fill('Коротке уточнення');
    await page.getByRole('button', { name: 'Надіслати', exact: true }).click();
    await expect.poll(() => submitted).toEqual(['deep', 'balanced']);
  });
}

for (const width of [1280, 320]) {
  test(`@regression #4031 continues an incomplete answer with Deep at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installChat(page, true);
    await page.route('**/api/ai-agent/configuration', (route) =>
      route.fulfill({
        json: {
          featureEnabled: true,
          reasoningPresetsEnabled: true,
          defaultAiEngineId: 'engine',
          providers: [
            {
              id: 'engine',
              name: 'Gemma',
              modelName: 'gemma',
              reasoningAvailable: true,
              reasoningPresets: [
                { preset: 'balanced', maxRuntimeSeconds: 300, reasoningEffort: 'high' },
                { preset: 'deep', maxRuntimeSeconds: 14_400, reasoningEffort: 'max' },
              ],
            },
          ],
        },
      }),
    );
    await page.route('**/api/ai-agent/conversations/get', (route) =>
      route.fulfill({
        json: {
          ...conversation,
          messages: [
            {
              requestId: 'request-limited',
              requestState: 'completed',
              role: 'assistant',
              content: 'Часткова відповідь',
              reasoningPreset: 'balanced',
              completionMetadata: { coverageLimited: true, reason: 'incomplete_research' },
              createdAt: 1,
            },
          ],
        },
      }),
    );
    const submitted: { reasoningPreset: string; hasPrompt: boolean }[] = [];
    await page.route('**/api/ai-agent/requests/create', (route) => {
      const { reasoningPreset, prompt } = route.request().postDataJSON();
      submitted.push({
        reasoningPreset,
        hasPrompt: prompt.startsWith('Продовж попереднє завдання'),
      });
      return route.fulfill({
        json: { requestId: 'request-continued', conversationId, state: 'queued' },
      });
    });
    await page.goto(`/?conversation=${conversationId}`);
    const continuation = page.getByRole('button', {
      name: 'Продовжити в глибокому режимі',
      exact: true,
    });
    await expect(continuation).toBeEnabled();
    await expect(page.getByText('до 4 год; нові повідомлення чекатимуть у черзі')).toBeVisible();
    const clipped = await continuation.evaluate(
      (button) => button.scrollWidth > button.clientWidth,
    );
    expect(clipped).toBe(false);
    const box = await continuation.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const preview = test.info().outputPath(`deep-continuation-${width}.png`);
    await page.screenshot({ path: preview });
    await test.info().attach(`Fixture preview: Deep continuation at ${width}px`, {
      path: preview,
      contentType: 'image/png',
    });

    await continuation.click();
    await expect.poll(() => submitted).toEqual([{ reasoningPreset: 'deep', hasPrompt: true }]);
    await expect(continuation).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Глибина аналізу' })).toContainText(
      'Збалансований',
    );
  });

  test(`@regression #4112 offers another engine after a provider failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 844 });
    await installChat(page, true);
    await page.route('**/api/ai-agent/configuration', (route) =>
      route.fulfill({
        json: {
          featureEnabled: true,
          defaultAiEngineId: 'engine',
          providers: [
            {
              id: 'engine',
              name: 'GLM-5.3',
              modelName: 'glm-5.3',
              unhealthy: true,
              healthMessage: 'Державний шлюз не відповідає',
            },
            { id: 'flash', name: 'GLM-5.3 Flash', modelName: 'glm-5.3-flash-uncensored' },
          ],
        },
      }),
    );
    await page.route('**/api/ai-agent/conversations/get', (route) =>
      route.fulfill({
        json: {
          ...conversation,
          messages: ['user', 'assistant'].map((role) => ({
            requestId: 'request-failed',
            requestState: 'completed',
            role,
            content: role === 'user' ? 'Де зараз позиції?' : 'Не вдалося підготувати відповідь.',
            reasoningPreset: 'balanced',
            aiEngineId: 'engine',
            aiEngineName: 'GLM-5.3',
            completionMetadata: { coverageLimited: true, reason: 'provider_error' },
            createdAt: 1,
          })),
        },
      }),
    );
    const submitted: { aiEngineId: string; prompt: string; conversationId: string }[] = [];
    await page.route('**/api/ai-agent/requests/create', (route) => {
      const { aiEngineId, prompt, conversationId: id } = route.request().postDataJSON();
      submitted.push({ aiEngineId, prompt, conversationId: id });
      return route.fulfill({
        json: { requestId: 'request-flash', conversationId, state: 'queued' },
      });
    });
    await page.goto(`/?conversation=${conversationId}`);
    await expect(page.getByText('Провайдер не відповів')).toBeVisible();
    await expect(
      page.getByText('GLM-5.3 тимчасово недоступний: Державний шлюз не відповідає.'),
    ).toBeVisible();
    const fallback = page.getByRole('button', { name: 'Спробувати з GLM-5.3 Flash', exact: true });
    await expect(fallback).toBeEnabled();
    const box = await fallback.boundingBox();
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    const preview = test.info().outputPath(`provider-fallback-${width}.png`);
    await page.screenshot({ path: preview });
    await test.info().attach(`Fixture preview: provider fallback at ${width}px`, {
      path: preview,
      contentType: 'image/png',
    });

    await fallback.click();
    await expect
      .poll(() => submitted)
      .toEqual([{ aiEngineId: 'flash', prompt: 'Де зараз позиції?', conversationId }]);
    await expect(page.getByRole('combobox', { name: 'Провайдер ШІ' })).toContainText(
      'GLM-5.3 Flash',
    );
  });
}
