import { expect, test } from '@playwright/test';
import { createEmptyInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

// Regression: https://github.com/echoua/echo/issues/3064
test('@smoke @regression #3064 #3757 AI citations recover failed lookups and revalidate previews', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page);
  const conversation = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Citation replay',
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
            content: 'Підсумок повідомлення. [джерело](/rer-analysis-neo?m=citation-source)',
            citations: [{ messageId: 77, messageIdentifier: 'citation-source' }],
          },
        ],
      },
    }),
  );
  const fullBody = 'Повний текст повідомлення. '.repeat(400) + 'КІНЕЦЬ ПОВІДОМЛЕННЯ';
  let available = true;
  let failLookup = true;
  await page.route('**/api/rer-importer/messages-by-id-with-metadata', (route) => {
    if (failLookup)
      return route.fulfill({ status: 502, contentType: 'text/plain', body: 'Bad Gateway' });
    return route.fulfill({
      json: {
        ...createEmptyInboxResponse(),
        inbox_items: available
          ? [
              [
                77,
                {
                  message_uid: 'citation-source',
                  text: fullBody,
                  date: '2025-09-26',
                  time: '11:23',
                  timestamp: null,
                  group_master_key: 'group',
                  media: [],
                },
              ],
            ]
          : [],
        signal_groups: [{ master_key: 'group', name: 'Натрій' }],
      },
    });
  });
  await page.goto(`/?conversation=${conversation.id}`);
  const chat = page.locator('ai-agent-chat');
  await expect(chat).toContainText('Не вдалося завантажити джерело');
  await expect(chat).not.toContainText('Джерело недоступне');
  failLookup = false;
  await chat.getByRole('button', { name: 'Повторити завантаження джерел' }).click();
  const chip = page.locator('ai-agent-chat').getByRole('link', { name: '26.09.2025 11:23 Натрій' });
  await expect(chip).toBeVisible({ timeout: 20000 });
  await chip.hover();
  await expect(page.getByTestId('message-summary-preview-77')).toContainText('КІНЕЦЬ ПОВІДОМЛЕННЯ');
  await page.keyboard.press('Escape');
  await chip.focus();
  await expect(page.getByTestId('message-summary-preview-77')).toContainText('КІНЕЦЬ ПОВІДОМЛЕННЯ');
  const popupPromise = page.waitForEvent('popup');
  await chip.click();
  const popup = await popupPromise;
  await expect(popup).toHaveURL(/\/rer-analysis-neo\?m=citation-source/);
  await popup.close();
  await page.reload();
  await expect(chip).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(chip).toBeVisible();
  const chipBox = await chip.boundingBox();
  expect(chipBox).not.toBeNull();
  expect(chipBox!.x).toBeGreaterThanOrEqual(0);
  expect(chipBox!.x + chipBox!.width).toBeLessThanOrEqual(390);
  await chip.focus();
  await expect(page.getByTestId('message-summary-preview-77')).toContainText('КІНЕЦЬ ПОВІДОМЛЕННЯ');
  await page.keyboard.press('Escape');
  await page.locator('[role="alert"]').evaluateAll((nodes) => {
    for (const node of nodes) node.remove();
  });
  failLookup = true;
  await chip.hover();
  await expect(chat).toContainText('Не вдалося завантажити джерело');
  await expect(page.getByTestId('message-summary-preview-77')).toHaveCount(0);
  failLookup = false;
  await chat.getByRole('button', { name: 'Повторити завантаження джерел' }).click();
  await expect(chip).toBeVisible();
  available = false;
  await chip.hover();
  await expect(page.locator('ai-agent-chat')).toContainText('Джерело недоступне');
  await expect(page.getByTestId('message-summary-preview-77')).toHaveCount(0);
});
