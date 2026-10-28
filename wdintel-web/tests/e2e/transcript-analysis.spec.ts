import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

// https://github.com/echoua/echo/issues/3646
test('admin tests a draft independently, saves results, and selects the worker model @regression', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const engineId = 'd4dc620c-947c-4b61-95c1-c540da4db6bd';
  const messageId = '7cef571b-c02c-42ce-b89e-9bfdb0b7a6bc';
  let savedPrompt = 'Стандартний промпт';
  let worker = { enabled: false, aiEngineId: null as string | null };
  let savedResults: unknown[] = [];
  let saves = 0;
  await page.route('**/api/admin/ai-transcript-analysis/**', async (route) => {
    const endpoint = new URL(route.request().url()).pathname.split('/').at(-1);
    if (endpoint === 'page') {
      await route.fulfill({
        json: {
          prompt: savedPrompt,
          promptOverridden: saves > 0,
          worker,
          engines: [{ id: engineId, name: 'Тестовий движок', modelName: 'fixture' }],
          messages: [
            {
              id: messageId,
              message: 'Перевірка зв’язку',
              version: 'version-1',
              results: savedResults,
            },
          ],
        },
      });
    } else if (endpoint === 'test') {
      expect(route.request().postDataJSON()).toEqual({
        prompt: 'Власний промпт',
        aiEngineIds: [engineId],
      });
      await route.fulfill({
        json: {
          results: [
            {
              testMessageId: messageId,
              aiEngineId: engineId,
              important: true,
              responseText:
                '{"important":true,"description":"Короткий опис","quotes":["Перевірка зв’язку"]}',
              error: null,
              updatedAt: null,
            },
          ],
          messageVersions: [{ id: messageId, version: 'version-1' }],
          engineVersions: [{ id: engineId, version: 'engine-1' }],
        },
      });
    } else if (route.request().url().endsWith('/worker/save')) {
      worker = route.request().postDataJSON();
      await route.fulfill({ json: worker });
    } else if (endpoint === 'save') {
      const request = route.request().postDataJSON();
      expect(request.messageVersions).toEqual([{ id: messageId, version: 'version-1' }]);
      expect(request.engineVersions).toEqual([{ id: engineId, version: 'engine-1' }]);
      saves += 1;
      savedPrompt = request.prompt;
      savedResults = request.results;
      await route.fulfill({ json: request });
    } else await route.fulfill({ status: 404, json: { error: 'Unexpected operation' } });
  });
  await page.goto('/admin/ai/transcript-analysis');
  await expect(page.getByRole('heading', { name: 'Аналіз транскрипцій' })).toBeVisible();
  await page.getByRole('textbox', { name: /^Промпт аналізу/ }).fill('Власний промпт');
  const promptPanel = page.getByRole('complementary', { name: 'Панель промпту' });
  const tableBounds = await page.getByRole('table').boundingBox();
  const panelBounds = await promptPanel.boundingBox();
  expect(tableBounds).not.toBeNull();
  expect(panelBounds).not.toBeNull();
  expect(panelBounds!.x).toBeGreaterThanOrEqual(tableBounds!.x + tableBounds!.width);
  await page.getByRole('button', { name: 'Згорнути праву панель' }).click();
  await expect(promptPanel).not.toBeVisible();
  await expect(page.getByRole('table')).toBeVisible();
  await page.getByRole('button', { name: 'Розгорнути праву панель' }).click();
  await expect(promptPanel.getByRole('textbox', { name: /^Промпт аналізу/ })).toHaveValue(
    'Власний промпт',
  );
  await promptPanel.getByRole('button', { name: 'Тест', exact: true }).click();
  await expect(page.getByText('ТЕСТ:', { exact: true })).toBeVisible();
  await expect(page.getByText('Важливе', { exact: true })).toBeVisible();
  expect(savedPrompt).toBe('Стандартний промпт');
  expect(saves).toBe(0);
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByText('ТЕСТ:', { exact: true })).not.toBeVisible();
  await expect(page.getByText('Важливе', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Воркер', exact: true }).click();
  await page.getByRole('checkbox', { name: 'Увімкнути воркер аналізу транскрипцій' }).check();
  await page.getByRole('combobox', { name: /^ШІ движок/ }).click();
  await page.getByRole('option', { name: 'Тестовий движок · fixture' }).click();
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => worker).toEqual({ enabled: true, aiEngineId: engineId });
  await page.reload();
  await page.getByRole('tab', { name: 'Воркер', exact: true }).click();
  await expect(
    page.getByRole('checkbox', { name: 'Увімкнути воркер аналізу транскрипцій' }),
  ).toBeChecked();
});

test('admin sees load failures as an alert @regression', async ({ page }) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/admin/ai-transcript-analysis/page', (route) =>
    route.fulfill({ status: 500, json: { error: 'Немає з’єднання з БД' } }),
  );
  await page.goto('/admin/ai/transcript-analysis');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Немає з’єднання з БД' }).first(),
  ).toBeVisible();
});

test('admin creates, edits and deletes the test corpus @regression', async ({ page }) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  let messages: { id: string; message: string; version: string; results: [] }[] = [];
  await page.route('**/api/admin/ai-transcript-analysis/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/page')) {
      await route.fulfill({
        json: {
          prompt: 'Промпт',
          promptOverridden: false,
          engines: [],
          messages,
          worker: { enabled: false, aiEngineId: null },
        },
      });
    } else if (path.endsWith('/messages/save')) {
      const request = route.request().postDataJSON();
      const message = {
        id: request.id ?? '7cef571b-c02c-42ce-b89e-9bfdb0b7a6bc',
        message: request.message,
        version: 'updated',
        results: [] as [],
      };
      messages = [message];
      await route.fulfill({ json: message });
    } else if (path.endsWith('/messages/delete')) {
      expect(route.request().postDataJSON().id).toBe(messages[0].id);
      messages = [];
      await route.fulfill({ json: null });
    } else await route.fulfill({ status: 404 });
  });
  await page.goto('/admin/ai/transcript-analysis');
  await page.getByRole('button', { name: 'Додати', exact: true }).first().click();
  await expect(page.getByRole('heading', { name: 'Нове тестове повідомлення' })).toBeVisible();
  await expect(page.getByLabel('ID', { exact: true })).toBeDisabled();
  await page.getByLabel('Текст повідомлення').fill('Новий тестовий текст');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Нове тестове повідомлення' })).not.toBeVisible();
  await expect(page.getByText('Новий тестовий текст', { exact: true })).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: 'Новий тестовий текст' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Редагувати тестове повідомлення' }),
  ).toBeVisible();
  await expect(page.getByLabel('ID', { exact: true })).toHaveValue(messages[0].id);
  await page.getByLabel('Текст повідомлення').fill('Виправлений тестовий текст');
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Редагувати тестове повідомлення' }),
  ).not.toBeVisible();
  await expect(page.getByText('Виправлений тестовий текст', { exact: true })).toBeVisible();
  await page
    .getByRole('row')
    .filter({ hasText: 'Виправлений тестовий текст' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Виправлений тестовий текст', { exact: true })).toHaveCount(0);
  expect(messages).toEqual([]);
});

test('admin monitors the analysis queue, pages through history and recovers from errors @regression', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/admin/ai-transcript-analysis/page', (route) =>
    route.fulfill({
      json: {
        prompt: 'Збережений промпт',
        promptOverridden: false,
        engines: [],
        messages: [],
        worker: { enabled: false, aiEngineId: null },
      },
    }),
  );
  let requests = 0;
  let fail = false;
  const item = {
    messageId: 101,
    messageUuid: '7cef571b-c02c-42ce-b89e-9bfdb0b7a6bc',
    messageUid: null,
    groups: ['Аудіо група'],
    createdAt: Date.UTC(2026, 9, 25, 9),
    state: 'retry',
    attempts: 2,
    nextAttemptAt: Date.UTC(2026, 9, 25, 9, 1),
    completedAt: null,
    important: null,
    manualSuppressed: false,
    lastError: 'Модель тимчасово недоступна',
  };
  await page.route('**/api/admin/ai-transcript-analysis/queue', async (route) => {
    requests += 1;
    if (fail) {
      await route.fulfill({ status: 500, json: { error: 'Не вдалося прочитати чергу' } });
      return;
    }
    const { beforeMessageId } = route.request().postDataJSON();
    expect([null, 101]).toContain(beforeMessageId);
    await route.fulfill({
      json:
        beforeMessageId == null
          ? { items: [item], nextBeforeMessageId: 101 }
          : {
              items: [
                {
                  ...item,
                  messageId: 100,
                  state: 'completed',
                  important: false,
                  completedAt: Date.UTC(2026, 9, 25, 9, 2),
                  lastError: null,
                },
              ],
              nextBeforeMessageId: null,
            },
    });
  });
  await page.goto('/admin/ai/transcript-analysis');
  await page.getByRole('textbox', { name: /^Промпт аналізу/ }).fill('Незбережена чернетка');
  expect(requests).toBe(0);
  await page.getByRole('tab', { name: 'Черга', exact: true }).click();
  const queue = page.getByRole('region', { name: 'Черга аналізу транскрипцій' });
  await expect(queue.getByText('Повторна спроба', { exact: true })).toBeVisible();
  await expect(queue.getByText('Аудіо група', { exact: true })).toBeVisible();
  await expect(queue.getByText('Модель тимчасово недоступна', { exact: true })).toBeVisible();
  await expect(queue.getByRole('link', { name: '101', exact: true })).toHaveAttribute(
    'href',
    '/rer-analysis-neo?m=7cef571b-c02c-42ce-b89e-9bfdb0b7a6bc',
  );
  await expect(queue.getByRole('button', { name: 'Назад', exact: true })).toBeDisabled();
  const initialRequests = requests;
  await expect.poll(() => requests, { timeout: 15_000 }).toBeGreaterThan(initialRequests);
  await queue.getByRole('button', { name: 'Далі', exact: true }).click();
  await expect(queue.getByText('Неважливе', { exact: true })).toBeVisible();
  await expect(queue.getByText('Сторінка 2', { exact: true })).toBeVisible();
  await expect(queue.getByRole('button', { name: 'Далі', exact: true })).toBeDisabled();
  await queue.getByRole('button', { name: 'Назад', exact: true }).click();
  await expect(queue.getByText('Повторна спроба', { exact: true })).toBeVisible();
  fail = true;
  await queue.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(queue.getByRole('alert')).toContainText('Не вдалося прочитати чергу');
  fail = false;
  await expect
    .poll(
      async () => {
        await queue.getByRole('button', { name: 'Оновити', exact: true }).click();
        return queue.getByRole('alert').count();
      },
      { intervals: [500] },
    )
    .toBe(0);
  await expect(queue.getByText('Повторна спроба', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'Промпт', exact: true }).click();
  await expect(page.getByRole('textbox', { name: /^Промпт аналізу/ })).toHaveValue(
    'Незбережена чернетка',
  );
});
