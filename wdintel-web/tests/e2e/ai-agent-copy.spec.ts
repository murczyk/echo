import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const ANSWER = [
  '## Підсумок',
  '',
  'Команда для перевірки:',
  '',
  '```bash',
  'ls -la /var/log',
  'grep -n "Ехо" app.log',
  '```',
  '',
  '| Дата | Суть |',
  '| --- | --- |',
  '| 30.07 | **Рух** техніки |',
].join('\n');

async function installConversation(page: Page) {
  await installAnalysisNeoApiMocks(page);
  const conversation = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Copy',
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
            content: ANSWER,
            citations: [],
          },
        ],
      },
    }),
  );
  await page.goto(`/?conversation=${conversation.id}`);
  return page.locator('ai-agent-chat');
}

// Regression: https://github.com/echoua/echo/issues/4182
test('@regression #4182 AI answers copy code blocks and the whole answer', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const chat = await installConversation(page);
  const codeBlock = chat.locator('.ai-code-block');
  await expect(codeBlock).toContainText('bash');

  await codeBlock.getByRole('button', { name: 'Копіювати' }).click();
  await expect(codeBlock.getByRole('button', { name: 'Скопійовано' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
    'ls -la /var/log\ngrep -n "Ехо" app.log',
  );
  await expect(codeBlock.getByRole('button', { name: 'Копіювати' })).toBeVisible({
    timeout: 5000,
  });

  await chat.getByRole('button', { name: 'Копіювати відповідь' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Копіювати текст' })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: 'Копіювати як Markdown' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(chat.getByRole('button', { name: 'Копіювати відповідь' })).toBeFocused();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(ANSWER);

  await chat.getByRole('button', { name: 'Копіювати відповідь' }).click();
  await page.getByRole('menuitem', { name: 'Копіювати текст' }).click();
  await expect
    .poll(() => page.evaluate(async () => (await navigator.clipboard.read())[0].types))
    .toContain('text/html');
  const copied = await page.evaluate(async () => {
    const [item] = await navigator.clipboard.read();
    return {
      text: await (await item.getType('text/plain')).text(),
      html: await (await item.getType('text/html')).text(),
    };
  });
  expect(copied.text).toBe(
    [
      'Підсумок',
      '',
      'Команда для перевірки:',
      '',
      'ls -la /var/log',
      'grep -n "Ехо" app.log',
      '',
      'Дата\tСуть',
      '30.07\tРух техніки',
    ].join('\n'),
  );
  expect(copied.html).toContain('<strong>Рух</strong>');
  expect(copied.html).not.toContain('Копіювати');
});

// Plain-HTTP deployments have no Clipboard API; copying must not depend on moving
// focus out of the open menu.
test('@regression #4182 AI answers copy without the Clipboard API', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.addInitScript(() => {
    const clipboard = navigator.clipboard;
    Object.defineProperty(window, 'testClipboard', { value: clipboard });
    Object.defineProperty(Navigator.prototype, 'clipboard', { get: () => undefined });
  });
  const readClipboard = () =>
    page.evaluate(() =>
      (window as unknown as { testClipboard: Clipboard }).testClipboard.readText(),
    );
  const chat = await installConversation(page);

  await chat.getByRole('button', { name: 'Копіювати відповідь' }).click();
  await page.getByRole('menuitem', { name: 'Копіювати як Markdown' }).click();
  await expect.poll(readClipboard).toBe(ANSWER);

  await chat.getByRole('button', { name: 'Копіювати відповідь' }).click();
  await page.getByRole('menuitem', { name: 'Копіювати текст' }).click();
  await expect.poll(readClipboard).toContain('Дата\tСуть');

  await chat.locator('.ai-code-block').getByRole('button', { name: 'Копіювати' }).click();
  await expect.poll(readClipboard).toBe('ls -la /var/log\ngrep -n "Ехо" app.log');
});
