import { expect, test, type Page } from '@playwright/test';
import type {
  AiIntelReportAttemptItem,
  AiIntelReportSettingsItem,
  SaveAiIntelReportSettingsReq,
} from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function installReports(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const settings: AiIntelReportSettingsItem = {
    quickSuggestionEnabled: true,
    quickAiEngineId: 'engine',
    fallbackAiEngineId: null,
    engineBudgets: [
      { aiEngineId: 'engine', maxTokens: 512 },
      { aiEngineId: 'fallback', maxTokens: 512 },
    ],
    primaryTimeoutSecs: 20,
    fallbackTimeoutSecs: 20,
    totalTimeoutSecs: 20,
    legacyCommentCutoff: 1,
    updatedAt: 1,
  };
  const attempts: AiIntelReportAttemptItem[] = Array.from({ length: 65 }, (_, index) => ({
    id: `attempt-${index + 1}`,
    loginId: 'operator',
    login: 'operator',
    aiEngineId: 'engine',
    aiEngineName: 'Gov GLM',
    sourceMessageId: 3128000 + index,
    outcome: 'failed',
    suggestions: [],
    rawResponse: null,
    error: `Attempt failure ${index + 1}`,
    durationMs: 20000,
    createdAt: 1_700_000_000_000 - index,
  }));
  const state = {
    fail: false,
    failSave: false,
    starts: [] as (string | null)[],
    saved: [] as SaveAiIntelReportSettingsReq[],
  };
  await page.route('**/api/admin/ai-engines/list', (route) =>
    route.fulfill({
      json: {
        items: [
          {
            id: 'engine',
            name: 'Gov GLM',
            modelName: 'glm-5.3',
            enabled: true,
            callsignEnabled: true,
            ocrEnabled: false,
            ocrRequestProfile: 'openai_vision',
            hasToken: false,
            createdAt: 1,
            updatedAt: 1,
            url: 'https://inference.ai.mod.gov.ua/v1',
          },
          {
            id: 'fallback',
            name: 'Gemma',
            modelName: 'gemma',
            enabled: true,
            callsignEnabled: true,
            ocrEnabled: false,
            ocrRequestProfile: 'openai_vision',
            hasToken: false,
            createdAt: 1,
            updatedAt: 1,
            url: 'http://example.local/v1',
          },
          {
            id: 'unavailable',
            name: 'Unavailable',
            modelName: 'unavailable',
            enabled: false,
            callsignEnabled: true,
            ocrEnabled: false,
            ocrRequestProfile: 'openai_vision',
            hasToken: false,
            createdAt: 1,
            updatedAt: 1,
            url: 'http://example.local/v1',
          },
        ],
      },
    }),
  );
  await page.route('**/api/admin/ai-intel-report/settings', async (route) => {
    if (route.request().method() === 'POST') {
      if (state.failSave) {
        await route.fulfill({ status: 500, body: 'Settings unavailable' });
        return;
      }
      const request = route.request().postDataJSON() as SaveAiIntelReportSettingsReq;
      state.saved.push(request);
      Object.assign(settings, request);
    }
    await route.fulfill({ json: settings });
  });
  await page.route('**/api/admin/ai-intel-report/attempts/list', async (route) => {
    const { pageStartId } = route.request().postDataJSON();
    state.starts.push(pageStartId);
    if (state.fail) {
      await route.fulfill({ status: 500, body: 'Pagination unavailable' });
      return;
    }
    const start = pageStartId ? attempts.findIndex((attempt) => attempt.id === pageStartId) : 0;
    await route.fulfill({
      json: {
        items: attempts.slice(start, start + 20),
        pageSize: 20,
        total: null,
        pageStartIds: [attempts[start]?.id, attempts[start + 20]?.id].filter(Boolean),
      },
    });
  });
  return state;
}

test('per-model budgets, primary, fallback and all timeouts persist and survive save failure', async ({
  page,
}) => {
  const state = await installReports(page);
  await page.goto('/admin/ai/intelligence-reports');
  const budget = page.getByRole('spinbutton', { name: 'Бюджет токенів: Gov GLM', exact: true });
  const fallbackBudget = page.getByRole('spinbutton', {
    name: 'Бюджет токенів: Gemma',
    exact: true,
  });
  await expect(budget).toHaveValue('512');
  await expect(fallbackBudget).toHaveValue('512');
  await expect(page.getByRole('radio', { name: 'Основна: Gov GLM', exact: true })).toBeChecked();
  await expect(page.getByRole('radio', { name: 'Резервна: Gov GLM', exact: true })).toBeDisabled();
  await expect(
    page.getByRole('radio', { name: 'Основна: Unavailable', exact: true }),
  ).toBeDisabled();
  await page.getByRole('radio', { name: 'Резервна: Gemma', exact: true }).check();
  await budget.fill('1024');
  await fallbackBudget.fill('2048');
  await page.getByRole('spinbutton', { name: 'Ліміт спроби 1, с', exact: true }).fill('5');
  await page.getByRole('spinbutton', { name: 'Ліміт спроби 2, с', exact: true }).fill('10');
  await page.getByRole('spinbutton', { name: 'Загальний ліміт часу, с', exact: true }).fill('15');
  state.failSave = true;
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося зберегти налаштування' }).first(),
  ).toBeVisible();
  await expect(budget).toHaveValue('1024');
  state.failSave = false;
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click({ delay: 450 });
  await expect
    .poll(() => state.saved)
    .toEqual([
      {
        quickSuggestionEnabled: true,
        quickAiEngineId: 'engine',
        fallbackAiEngineId: 'fallback',
        engineBudgets: [
          { aiEngineId: 'engine', maxTokens: 1024 },
          { aiEngineId: 'fallback', maxTokens: 2048 },
        ],
        primaryTimeoutSecs: 5,
        fallbackTimeoutSecs: 10,
        totalTimeoutSecs: 15,
      },
    ]);
  await page.reload();
  await expect(budget).toHaveValue('1024');
  await expect(fallbackBudget).toHaveValue('2048');
  await expect(page.getByRole('radio', { name: 'Резервна: Gemma', exact: true })).toBeChecked();
  await expect(
    page.getByRole('spinbutton', { name: 'Загальний ліміт часу, с', exact: true }),
  ).toHaveValue('15');
  await page.getByRole('radio', { name: 'Основна: Gemma', exact: true }).check();
  await expect(
    page.getByRole('radio', { name: 'Без резервної моделі', exact: true }),
  ).toBeChecked();
  await expect(budget).toHaveValue('1024');
  await expect(fallbackBudget).toHaveValue('2048');
});

test('report attempt history discovers bounded cursors and revisits discovered pages', async ({
  page,
}) => {
  const state = await installReports(page);
  await page.goto('/admin/ai/intelligence-reports');
  const rows = page
    .getByRole('region', { name: 'Спроби швидких пропозицій', exact: true })
    .locator('tbody tr');
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('1');
  await expect(page.getByText('Усього:', { exact: false })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Go to page 3', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(40);
  await expect(rows.last().getByRole('cell').first()).toHaveText('40');
  expect(state.starts).toEqual([null, 'attempt-21']);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('41');
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await expect(rows.first().getByRole('cell').first()).toHaveText('61');
  await expect(page.getByText('Attempt failure 61', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'SHOW MORE', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Go to page 2', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('21');
  await page.getByRole('button', { name: 'Go to page 4', exact: true }).click();
  await expect(rows).toHaveCount(5);
  await page.getByRole('button', { name: 'Go to page 3', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await page.getByRole('button', { name: 'SHOW MORE', exact: true }).click();
  await expect(rows).toHaveCount(25);
  await expect(rows.first().getByRole('cell').first()).toHaveText('41');
  await expect(rows.last().getByRole('cell').first()).toHaveText('65');
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(rows).toHaveCount(20);
  await expect(rows.first().getByRole('cell').first()).toHaveText('1');
  await expect(page.getByText('Attempt failure 1', { exact: true })).toBeVisible();
  expect(state.starts).toEqual([
    null,
    'attempt-21',
    'attempt-41',
    'attempt-61',
    'attempt-21',
    'attempt-61',
    'attempt-41',
    'attempt-61',
    null,
  ]);
});

test('report pagination failures preserve entries and allow retry', async ({ page }) => {
  const state = await installReports(page);
  await page.goto('/admin/ai/intelligence-reports');
  const rows = page
    .getByRole('region', { name: 'Спроби швидких пропозицій', exact: true })
    .locator('tbody tr');
  await expect(rows).toHaveCount(20);
  state.fail = true;
  const showMore = page.getByRole('button', { name: 'SHOW MORE', exact: true });
  await showMore.click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося завантажити спроби' }).first(),
  ).toBeVisible();
  await expect(rows).toHaveCount(20);
  await expect(showMore).toBeEnabled();
  state.fail = false;
  await showMore.click({ delay: 450 });
  await expect(rows).toHaveCount(40);
  expect(state.starts).toEqual([null, 'attempt-21', 'attempt-21']);
});
