import { expect, test } from '@playwright/test';

import {
  createLoadedInboxResponse,
  createOverflowingInboxResponse,
  installAnalysisNeoApiMocks,
} from './analysis-neo.fixtures';

async function setupAnalysisNeoPage(
  page: Parameters<typeof installAnalysisNeoApiMocks>[0],
  options?: Parameters<typeof installAnalysisNeoApiMocks>[1],
) {
  await installAnalysisNeoApiMocks(page, options);
}

// @test-scope regression: https://github.com/echoua/echo/pull/3268
test.describe('@smoke @regression', () => {
  test('analysis neo summary flow loads a known row', async ({ page }) => {
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');

    await expect(page).toHaveTitle('РЕР-аналіз');
    await expect(page.getByRole('heading', { name: 'Аналіз' })).toBeVisible();

    await expect(page.getByText('Analysis summary fixture message', { exact: true })).toBeVisible();

    const summaryTab = page.getByRole('tab', { name: 'Зведена таблиця' });
    await summaryTab.click();
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');

    const summaryPanel = page.getByRole('tabpanel', { name: 'Зведена таблиця' });
    await expect(summaryPanel).toBeVisible();
    await expect(summaryPanel.getByRole('table', { name: 'Таблиця частот аналізу' })).toBeVisible();
    await expect(summaryPanel.getByText('123.4', { exact: true })).toBeVisible();
  });

  test('analysis neo keeps narrow controls fixed while messages scroll', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createOverflowingInboxResponse() });
    await page.goto('/rer-analysis-neo');

    const messageList = page.locator('section[aria-labelledby] ul').first();
    const messageScrollContainer = messageList.locator('..');
    await expect(messageList.locator('li')).toHaveCount(20);
    await expect
      .poll(() =>
        messageScrollContainer.evaluate((element) => element.scrollHeight > element.clientHeight),
      )
      .toBe(true);

    const tab = page.getByRole('tab', { name: 'Повідомлення' });
    const tabBoxBefore = await tab.boundingBox();
    const card = messageList.locator('li').first();
    const cardBox = await card.boundingBox();
    expect(tabBoxBefore).not.toBeNull();
    expect(cardBox).not.toBeNull();

    const scrollBefore = await messageScrollContainer.evaluate((element) => element.scrollTop);
    const documentScrollBefore = await page.evaluate(
      () => document.scrollingElement?.scrollTop ?? 0,
    );
    await page.mouse.move(cardBox!.x + cardBox!.width / 2, cardBox!.y + cardBox!.height / 2);
    await page.mouse.wheel(0, 600);
    await expect
      .poll(() => messageScrollContainer.evaluate((element) => element.scrollTop))
      .toBeGreaterThan(scrollBefore);

    const tabBoxAfter = await tab.boundingBox();
    const documentScrollAfter = await page.evaluate(
      () => document.scrollingElement?.scrollTop ?? 0,
    );
    expect(tabBoxAfter?.y).toBe(tabBoxBefore!.y);
    expect(documentScrollAfter).toBe(documentScrollBefore);

    const cardBoxes = await messageList.locator('li').evaluateAll((items) =>
      items.map((item) => {
        const box = item.getBoundingClientRect();
        return { left: box.left, right: box.right };
      }),
    );
    expect(cardBoxes.every(({ left, right }) => left >= 0 && right <= 375)).toBe(true);
  });

  test('analysis neo keeps the compact panel toggle available during initial loading', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, {
      inboxDelayMs: 2000,
      inboxResponse: createLoadedInboxResponse(),
    });
    await page.goto('/rer-analysis-neo');

    await expect(page.getByRole('region', { name: 'Центральна секція' })).toBeVisible();
    const expandButton = page.getByRole('button', { name: 'Розгорнути праву панель' });
    await expect(expandButton).toBeVisible();
    await expandButton.click();

    const collapseButton = page.getByRole('button', { name: 'Закрити праву панель' });
    await expect(collapseButton).toBeVisible();
    await collapseButton.click();
    await expect(page.getByRole('button', { name: 'Розгорнути праву панель' })).toBeVisible();
  });

  test('analysis neo keeps the narrow right-panel header fixed', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');

    const expandButton = page.getByRole('button', { name: 'Розгорнути праву панель' });
    await expandButton.click();

    const panel = page.locator('[data-analysis-right-panel]');
    const firstTab = panel.getByRole('tab').first();
    const collapseButton = page.getByRole('button', { name: 'Закрити праву панель' });
    const body = panel.locator('[data-analysis-sidebar-scroll-body]');
    await expect(panel).toBeVisible();
    await expect(collapseButton).toBeVisible();

    const metrics = await Promise.all([
      firstTab.boundingBox(),
      collapseButton.boundingBox(),
      panel.boundingBox(),
      body.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.clientHeight,
          overflowY: style.overflowY,
          overflowX: style.overflowX,
          scrollHeight: element.scrollHeight,
        };
      }),
    ]);
    expect(metrics[0]).not.toBeNull();
    expect(metrics[1]).not.toBeNull();
    expect(metrics[2]).not.toBeNull();
    expect(metrics[1]!.y + metrics[1]!.height).toBeLessThanOrEqual(metrics[0]!.y);
    expect(metrics[2]!.height).toBeGreaterThan(0);
    expect(metrics[3]).toEqual({
      height: expect.any(Number),
      overflowY: 'auto',
      overflowX: 'hidden',
      scrollHeight: expect.any(Number),
    });

    const closeButtonY = metrics[1]!.y;
    await body.evaluate((element) => {
      element.scrollTop = 100;
    });
    await expect
      .poll(async () => (await collapseButton.boundingBox())?.y)
      .toBeCloseTo(closeButtonY, 0);

    await collapseButton.click();
    await expect(page.getByRole('button', { name: 'Розгорнути праву панель' })).toBeVisible();
  });

  test('analysis neo expands phone map search and date controls without overflow', async ({
    page,
  }) => {
    for (const width of [375, 320]) {
      await page.setViewportSize({ width, height: 844 });
      await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
      await page.goto('/rer-analysis-neo');
      await page.getByRole('tab', { name: 'Мапа' }).click();

      const map = page.locator('#analysis-map');
      const searchControl = map.locator('.narrow-map-search-control');
      const dateControl = map.locator('.narrow-map-date-control');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
      expect(await searchControl.boundingBox()).toMatchObject({ width: 48, height: 48 });
      expect(await dateControl.boundingBox()).toMatchObject({ width: 48, height: 48 });

      await searchControl.getByRole('button', { name: 'Розгорнути пошук на мапі' }).click();
      await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toBeHidden();
      const expandedSearchBox = await searchControl.boundingBox();
      expect(expandedSearchBox).not.toBeNull();
      expect(expandedSearchBox!.x).toBeGreaterThanOrEqual(0);
      expect(expandedSearchBox!.x + expandedSearchBox!.width).toBeLessThanOrEqual(width);

      await map.dispatchEvent('click');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);

      await dateControl.getByRole('button', { name: 'Розгорнути діапазон дат на мапі' }).click();
      await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);
      await expect(searchControl).toBeHidden();
      const expandedDateBox = await dateControl.boundingBox();
      expect(expandedDateBox).not.toBeNull();
      expect(expandedDateBox!.x).toBeGreaterThanOrEqual(0);
      expect(expandedDateBox!.x + expandedDateBox!.width).toBeLessThanOrEqual(width);

      await map.dispatchEvent('click');
      await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
      await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
        width,
      );
    }
  });

  test('analysis neo synchronizes map controls across viewport transitions', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('tab', { name: 'Мапа' }).click();

    const map = page.locator('#analysis-map');
    const searchControl = map.locator('.narrow-map-search-control');
    const dateControl = map.locator('.narrow-map-date-control');
    await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);

    await page.setViewportSize({ width: 375, height: 844 });
    await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
    expect(await searchControl.boundingBox()).toMatchObject({ width: 48, height: 48 });
    expect(await dateControl.boundingBox()).toMatchObject({ width: 48, height: 48 });

    await page.setViewportSize({ width: 900, height: 844 });
    await expect(searchControl).not.toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).not.toHaveClass(/narrow-map-control--collapsed/);

    await page.setViewportSize({ width: 375, height: 844 });
    await expect(searchControl).toHaveClass(/narrow-map-control--collapsed/);
    await expect(dateControl).toHaveClass(/narrow-map-control--collapsed/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      375,
    );
  });

  test('analysis neo updates summary page-size controls across phone resize', async ({ page }) => {
    await page.setViewportSize({ width: 844, height: 844 });
    await setupAnalysisNeoPage(page, { inboxResponse: createLoadedInboxResponse() });
    await page.goto('/rer-analysis-neo');
    await page.getByRole('tab', { name: 'Зведена таблиця' }).click();

    const rowsPerPageSelect = page.getByText('Рядків на сторінці:', { exact: true });
    await expect(rowsPerPageSelect).toBeVisible();

    await page.setViewportSize({ width: 390, height: 844 });
    await expect(rowsPerPageSelect).toBeHidden();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      390,
    );

    await page.setViewportSize({ width: 844, height: 844 });
    await expect(rowsPerPageSelect).toBeVisible();
  });
});
