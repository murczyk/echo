import { expect, test, type Page } from '@playwright/test';
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
