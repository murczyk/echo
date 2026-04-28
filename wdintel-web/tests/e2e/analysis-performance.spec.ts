import { expect, test, type Browser } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

type LoadResult = {
  titleMs: number;
  shellMs: number;
};

test.describe('@perf', () => {
  async function measureRouteLoad(browser: Browser, path: '/rer-analysis' | '/rer-analysis-neo'): Promise<LoadResult> {
    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await installAnalysisNeoApiMocks(page, {
        summaryDelayMs: 1_500,
        sidebarDelayMs: 1_500,
      });

      const startedAt = performance.now();
      await page.goto(path);

      const title = path === '/rer-analysis-neo' ? page.getByRole('heading', { name: 'Аналіз', level: 1 }) : page.getByRole('heading', { name: 'аналіз', level: 1 });
      await expect(title).toBeVisible();
      const titleMs = performance.now() - startedAt;

      await expect(page.getByText(/немає жодного повідомлення для аналізу/i)).toBeVisible();
      const shellMs = performance.now() - startedAt;

      return { titleMs, shellMs };
    } finally {
      await context.close();
    }
  }

  test('rer-analysis-neo first load is not slower than rer-analysis', async ({ browser }, testInfo) => {
    const classic = await measureRouteLoad(browser, '/rer-analysis');
    const neo = await measureRouteLoad(browser, '/rer-analysis-neo');

    await testInfo.attach('classic-load', {
      body: JSON.stringify(classic, null, 2),
      contentType: 'application/json',
    });
    await testInfo.attach('neo-load', {
      body: JSON.stringify(neo, null, 2),
      contentType: 'application/json',
    });

    expect(neo.titleMs).toBeLessThanOrEqual(classic.titleMs + 750);
    expect(neo.shellMs).toBeLessThanOrEqual(classic.shellMs + 750);
  });

  test('rer-analysis-neo reaches the shell quickly on a delayed backend', async ({ page }) => {
    await installAnalysisNeoApiMocks(page, {
      summaryDelayMs: 1_500,
      sidebarDelayMs: 1_500,
    });

    const startedAt = performance.now();
    await page.goto('/rer-analysis-neo');

    await expect(page.getByRole('heading', { name: 'Аналіз', level: 1 })).toBeVisible();
    await expect(page.getByText(/немає жодного повідомлення для аналізу/i)).toBeVisible();

    const shellMs = performance.now() - startedAt;
    expect(shellMs).toBeLessThan(3_000);
  });
});
