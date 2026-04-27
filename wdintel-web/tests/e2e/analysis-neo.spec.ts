import { expect, test } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function setupAnalysisNeoPage(page: Parameters<typeof installAnalysisNeoApiMocks>[0], options?: Parameters<typeof installAnalysisNeoApiMocks>[1]) {
  await installAnalysisNeoApiMocks(page, options);
}

test.describe('@smoke', () => {
  test('analysis neo page sets the title and shell', async ({ page }) => {
    await setupAnalysisNeoPage(page);
    await page.goto('/rer-analysis-neo');

    await expect(page).toHaveTitle('РЕР-аналіз');
    await expect(page.getByRole('heading', { name: 'Аналіз' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Панель фільтрів' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Повідомлення (0)' })).toBeVisible();
    await expect(page.getByRole('complementary', { name: 'Аналітична права секція' })).toBeVisible();
  });

  test('analysis neo page renders the initial counters', async ({ page }) => {
    await setupAnalysisNeoPage(page);
    await page.goto('/rer-analysis-neo');

    await expect(page.getByRole('status', { name: 'Поточна статистика вибірки' })).toContainText('Всього: 2');
    await expect(page.getByRole('status', { name: 'Поточна статистика вибірки' })).toContainText('Обрано: 1');
  });

  test('analysis neo summary tab loads lazily', async ({ page }) => {
    await setupAnalysisNeoPage(page);
    await page.goto('/rer-analysis-neo');

    await page.getByRole('tab', { name: 'Таблиця: Частоти' }).click();

    await expect(page.getByRole('table', { name: 'Таблиця частот аналізу' })).toBeVisible();
  });

  test('analysis neo right sidebar stats load lazily', async ({ page }) => {
    await setupAnalysisNeoPage(page);
    await page.goto('/rer-analysis-neo');

    await page.getByRole('button', { name: 'Розгорнути праву секцію' }).click();
    await page.getByRole('button', { name: 'Зведення' }).click();

    const sidebar = page.getByRole('complementary', { name: 'Аналітична бічна панель' });
    await expect(sidebar.getByRole('heading', { name: 'Частоти', exact: true })).toBeVisible();
  });

  test('analysis neo shows first paint before deferred loads resolve', async ({ page }) => {
    await setupAnalysisNeoPage(page, {
      summaryDelayMs: 1500,
      sidebarDelayMs: 1500,
    });

    await page.goto('/rer-analysis-neo');

    await expect(page.getByRole('heading', { name: 'Аналіз' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Повідомлення (0)' })).toBeVisible();

    await page.getByRole('tab', { name: 'Таблиця: Частоти' }).click();
    const summaryPanel = page.getByRole('tabpanel', { name: 'Таблиця: Частоти' });
    await expect(summaryPanel.locator('.MuiSkeleton-root').first()).toBeVisible();

    await page.getByRole('button', { name: 'Розгорнути праву секцію' }).click();
    await page.getByRole('button', { name: 'Зведення' }).click();

    const sidebar = page.getByRole('complementary', { name: 'Аналітична бічна панель' });
    await expect(sidebar.locator('.MuiSkeleton-root').first()).toBeVisible();
  });
});
