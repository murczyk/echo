import { expect, test, type Page } from '@playwright/test';

import { createEmptyInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

async function installSearchApiMocks(page: Page) {
  const inboxResponse = { ...createEmptyInboxResponse(), poll_cursor_id: null };
  await installRerDutyShortStateMocks(page, { inboxResponse });
  await installAnalysisNeoApiMocks(page, { inboxResponse });
  await page.route('**/api/sigint/aor', (route) => route.fulfill({ json: [] }));
  await page.route('**/api/rer/message/comments-batch', (route) =>
    route.fulfill({ json: { data: [] } }),
  );
}

// Regressions: https://github.com/echoua/echo/issues/3780 and https://github.com/echoua/echo/issues/3790
for (const routePath of ['/rer-analysis', '/rer-analysis-neo']) {
  test(`@regression #3780 ${routePath} #3790 suggests, applies and restores search modes and explains them`, async ({
    page,
  }) => {
    await installSearchApiMocks(page);
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
    const search = page.getByRole('combobox', { name: 'Пошук', exact: true });
    const options = page.getByRole('option');
    await search.focus();
    await expect(options).toHaveCount(0);
    await search.fill('xxx');
    await expect(options).toHaveText([
      'xxx - Гнучкий пошук',
      'xxx - Точний збіг',
      'xxx - Збіг за входженням',
    ]);
    await search.fill('РоТа');
    await expect(options).toHaveText([
      'РоТа - Гнучкий пошук',
      'РоТа - Точний збіг',
      'РоТа - Збіг за входженням',
    ]);
    await search.press('ArrowDown');
    await search.press('ArrowDown');
    await search.press('Enter');
    await expect(options).toHaveCount(0);
    await expect(search).toHaveValue('РоТа');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Exact');
    await expect.poll(() => inboxRequests.at(-1)?.search).toBe('РоТа');
    await expect.poll(() => countRequests.at(-1)?.search_mode).toBe('Exact');
    await page.reload();
    await expect(search).toHaveValue('РоТа');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Exact');
    await search.click();
    await expect(page.getByRole('option', { selected: true })).toHaveText('РоТа - Точний збіг');
    await page.getByRole('option', { name: 'РоТа - Збіг за входженням', exact: true }).click();
    await expect(options).toHaveCount(0);
    await expect(search).toHaveValue('РоТа');
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Substring');
    await expect.poll(() => countRequests.at(-1)?.search_mode).toBe('Substring');
    await page.getByRole('button', { name: 'Довідка про пошук' }).click();
    await expect(page.getByText('Гнучкий пошук: також «ротний», «роти»')).toBeVisible();
    await expect(page.getByText('Точний збіг: лише слово «рота»')).toBeVisible();
    await expect(page.getByText('Збіг за входженням: також «воротар»')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Докладніше на сторінці документації' }),
    ).toHaveAttribute('href', '/docs/analysis-search/');
    if (routePath.endsWith('-neo')) await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: 'Довідка про пошук' }).click();
    await search.click();
    await page.getByRole('option', { name: 'РоТа - Гнучкий пошук', exact: true }).click();
    await expect.poll(() => inboxRequests.at(-1)?.search_mode).toBe('Fuzzy');
    await search.click();
    await search.press('Escape');
    await expect(options).toHaveCount(0);
    await search.fill('новий');
    await expect(options).toHaveCount(3);
    await page.getByRole('button', { name: 'Довідка про пошук' }).click();
    await expect(options).toHaveCount(0);
    if (routePath.endsWith('-neo')) await page.keyboard.press('Escape');
    else await page.getByRole('button', { name: 'Довідка про пошук' }).click();
    await page.getByRole('button', { name: 'Очистити пошук', exact: true }).click();
    await search.focus();
    await expect(options).toHaveCount(0);
  });
}

test('@regression #3780 legacy saved filters reconcile omitted and explicit fuzzy search', async ({
  page,
}) => {
  await installSearchApiMocks(page);
  let currentReq: Record<string, unknown> | undefined;
  let savedReq: Record<string, unknown> | undefined;
  await page.route('**/api/rer/analysis/stats/groups/count', async (route) => {
    currentReq = route.request().postDataJSON() as Record<string, unknown>;
    await route.fallback();
  });
  await page.route('**/api/rer/analysis/saved-filters', async (route) => {
    await route.fulfill({
      contentType: 'application/json',
      body: JSON.stringify(
        savedReq ? [{ id: 3780, name: 'Старий пошук', req: savedReq, unit_filter: null }] : [],
      ),
    });
  });
  await page.goto('/rer-analysis');
  await expect.poll(() => currentReq).toBeDefined();
  savedReq = { ...currentReq };
  delete savedReq.search_mode;
  await page.reload();
  await page.getByRole('button', { name: 'збережені', exact: true }).click();
  const savedFilter = page.getByText('Старий пошук', { exact: true });
  await savedFilter.click();
  await expect(savedFilter).toHaveClass(/font-medium/);
  const search = page.getByRole('combobox', { name: 'Пошук', exact: true });
  await search.fill('рота');
  await page.getByRole('option', { name: 'рота - Точний збіг', exact: true }).click();
  await expect(savedFilter).not.toHaveClass(/font-medium/);
  await search.click();
  await page.getByRole('option', { name: 'рота - Гнучкий пошук', exact: true }).click();
  await page.getByRole('button', { name: 'Очистити пошук', exact: true }).click();
  await expect(savedFilter).toHaveClass(/font-medium/);
});

test('@regression #3780 Neo search modes and help remain reachable on a phone', async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await installSearchApiMocks(page);
  await page.goto('/rer-analysis-neo');
  await page.getByRole('button', { name: 'Закрити фільтри' }).click();
  await page.getByRole('button', { name: 'Відкрити пошук' }).click();
  const search = page.getByRole('combobox', { name: 'Пошук', exact: true });
  await search.fill('рота');
  await page.getByRole('option', { name: 'рота - Точний збіг', exact: true }).click();
  const help = page.getByRole('button', { name: 'Довідка про пошук' });
  for (const width of [320, 375, 768]) {
    await page.setViewportSize({ width, height: 844 });
    await search.click();
    const suggestions = page.getByRole('listbox', { name: 'Режим пошуку' });
    await expect(suggestions).toBeVisible();
    for (const control of [
      search,
      suggestions,
      help,
      page.getByRole('button', { name: /^Інтервал:/ }),
    ]) {
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    }
  }
  await search.press('Escape');
  await help.click();
  await expect(
    page.getByRole('link', { name: 'Докладніше на сторінці документації' }),
  ).toBeVisible();
});
