import { expect, test } from '@playwright/test';

import { createEmptyInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

// Regression: https://github.com/echoua/echo/issues/3780
for (const routePath of ['/rer-analysis', '/rer-analysis-neo']) {
  test(`@regression #3780 ${routePath} applies and restores search modes and explains them`, async ({
    page,
  }) => {
    const inboxResponse = { ...createEmptyInboxResponse(), poll_cursor_id: null };
    await installRerDutyShortStateMocks(page, { inboxResponse });
    await installAnalysisNeoApiMocks(page, { inboxResponse });
    const inboxRequests: Array<Record<string, unknown>> = [];
    const countRequests: Array<Record<string, unknown>> = [];
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fallback();
    });
    await page.route('**/api/rer/analysis/stats/groups/count', async (route) => {
      countRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fallback();
    });
    await page.goto(routePath);
    const mode = page.getByRole('combobox', { name: 'Режим пошуку' });
    await expect(mode).toHaveValue('Fuzzy');
    await expect(mode.locator('option')).toHaveText([
      'Гнучкий пошук',
      'Точний збіг',
      'Збіг за входженням',
    ]);
    await page.getByPlaceholder(/пошук/i, { exact: true }).fill('НоРа');
    await mode.selectOption('Exact');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Exact');
    await expect.poll(() => inboxRequests.at(-1)?.search).toBe('НоРа');
    await expect.poll(() => countRequests.at(-1)?.search_mode).toBe('Exact');
    await page.reload();
    await expect(mode).toHaveValue('Exact');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Exact');
    await mode.selectOption('Substring');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Substring');
    await expect.poll(() => countRequests.at(-1)?.search_mode).toBe('Substring');
    await page.getByRole('button', { name: 'Довідка про пошук' }).click();
    await expect(page.getByText('Гнучкий пошук: також «норма», «нормальний».')).toBeVisible();
    await expect(page.getByText('Точний збіг: лише слово «нора», також «НОРА!».')).toBeVisible();
    await expect(page.getByText('Збіг за входженням: також «панорама».')).toBeVisible();
    await expect(page.getByRole('link', { name: 'Докладніше про пошук' })).toHaveAttribute(
      'href',
      '/docs/analysis-search/',
    );
    if (routePath.endsWith('-neo')) await page.keyboard.press('Escape');
    await mode.selectOption('Fuzzy');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Fuzzy');
  });
}

test('@regression #3780 Neo search modes and help remain reachable on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 844 });
  await installAnalysisNeoApiMocks(page, { inboxResponse: createEmptyInboxResponse() });
  await page.goto('/rer-analysis-neo');
  await page.getByRole('button', { name: 'Відкрити пошук' }).click();
  await page.getByPlaceholder('Пошук', { exact: true }).fill('нора');
  const mode = page.getByRole('combobox', { name: 'Режим пошуку' });
  await mode.selectOption('Exact');
  const box = await mode.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(375);
  await page.getByRole('button', { name: 'Довідка про пошук' }).click();
  await expect(page.getByRole('link', { name: 'Докладніше про пошук' })).toBeVisible();
});
