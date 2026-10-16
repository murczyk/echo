import { expect, test } from '@playwright/test';

import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

test.describe('Analysis characterization workflows @regression', () => {
  test('@smoke search, clear, and newest-first controls update both URL and inbox request', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createLoadedInboxResponse(),
    });

    const inboxRequests: Array<Record<string, unknown>> = [];
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fallback();
    });

    await page.goto('/rer-analysis-neo');
    await expect(page.locator('[data-message-id="101"]')).toBeVisible();

    const search = page.getByPlaceholder('Пошук', { exact: true });
    await expect(search).toBeVisible();
    await search.fill('тестовий пошук');

    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBe('тестовий пошук');
    await expect.poll(() => inboxRequests.at(-1)?.search).toBe('тестовий пошук');

    const newestFirst = page.getByRole('checkbox', { name: 'спочатку нові' });
    await expect(newestFirst).toBeChecked();
    await newestFirst.click();
    await expect.poll(() => new URL(page.url()).searchParams.get('newestFirst')).toBe('false');
    await expect.poll(() => inboxRequests.at(-1)?.newest_first).toBe(false);

    await page.getByRole('button', { name: 'Очистити пошук' }).click();
    await expect.poll(() => new URL(page.url()).searchParams.get('search')).toBeNull();
    await expect.poll(() => inboxRequests.at(-1)?.search).toBeNull();
  });

  test('@smoke URL facets produce the exact request and reset clears them', async ({ page }) => {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createLoadedInboxResponse(),
    });

    const inboxRequests: Array<Record<string, unknown>> = [];
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fallback();
    });

    await page.goto(
      '/rer-analysis-neo?freqs=123.4&callsigns=ALPHA&only_with_media=true&onlyWithMetadata=true',
    );

    await expect.poll(() => inboxRequests.length).toBeGreaterThan(0);
    expect(inboxRequests.at(-1)).toEqual(
      expect.objectContaining({
        selected_freqs: ['123.4'],
        selected_callsigns: ['alpha'],
        only_with_media: true,
        only_with_metadata: true,
      }),
    );

    const reset = page.getByRole('button', { name: 'Скинути' });
    await expect(reset).toBeEnabled();
    await reset.click();

    await expect.poll(() => new URL(page.url()).searchParams.get('freqs')).toBeNull();
    await expect.poll(() => inboxRequests.at(-1)?.selected_freqs).toBeNull();
    expect(inboxRequests.at(-1)).toEqual(
      expect.objectContaining({
        selected_callsigns: null,
        only_with_media: false,
        only_with_metadata: false,
      }),
    );
  });

  test('summary row action applies its frequency without changing the active tab', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, {
      inboxResponse: createLoadedInboxResponse(),
    });

    const inboxRequests: Array<Record<string, unknown>> = [];
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      inboxRequests.push(route.request().postDataJSON() as Record<string, unknown>);
      await route.fallback();
    });

    await page.goto('/rer-analysis-neo');
    const summaryTab = page.getByRole('tab', { name: 'Зведена таблиця' });
    await summaryTab.click();
    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
    const table = page.getByRole('table', { name: 'Таблиця частот аналізу' });
    await expect(table).toContainText('123.4');
    const row = table.getByRole('row', { name: /1 Дії 123\.4/ });
    await row.getByRole('button', { name: 'Дії' }).click();
    await page.getByRole('menuitem', { name: 'У фільтр' }).click();

    await expect(summaryTab).toHaveAttribute('aria-selected', 'true');
    await expect.poll(() => new URL(page.url()).searchParams.get('freqs')).toBe('123.4');
    await expect.poll(() => inboxRequests.at(-1)?.selected_freqs).toEqual(['123.4']);

    await page.getByRole('tab', { name: 'Повідомлення' }).click();
    await expect(page.locator('[data-message-id="101"]')).toBeVisible();
  });

  test('message deletion preserves the card on cancel and failure, then removes it on success', async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, {
      userRoles: ['Rer', 'Admin', 'DeleteMsg'],
      inboxResponse: createLoadedInboxResponse(),
    });

    let deleteAttempts = 0;
    await page.route('**/api/rer-importer/delete-message', async (route) => {
      deleteAttempts += 1;
      if (deleteAttempts === 1) {
        await route.fulfill({ status: 500, contentType: 'text/plain', body: 'Delete failed' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/rer-analysis-neo');
    const card = page.locator('[data-message-id="101"]');
    await expect(card).toBeVisible();

    const openDeleteDialog = async () => {
      await card.getByTitle('Більше дій').click();
      await page.getByRole('menuitem', { name: 'Видалити' }).click();
      const dialog = page.getByRole('dialog', { name: 'Видалити повідомлення?' });
      await expect(dialog).toBeVisible();
      return dialog;
    };

    let dialog = await openDeleteDialog();
    await dialog.getByRole('button', { name: 'Скасувати' }).click();
    await expect(card).toBeVisible();
    expect(deleteAttempts).toBe(0);

    dialog = await openDeleteDialog();
    await dialog.getByRole('button', { name: 'Видалити' }).click();
    await expect.poll(() => deleteAttempts).toBe(1);
    await expect(page.getByRole('alert')).toContainText('Delete failed');
    await expect(card).toBeVisible();

    dialog = await openDeleteDialog();
    await dialog.getByRole('button', { name: 'Видалити' }).click();
    await expect.poll(() => deleteAttempts).toBe(2);
    await expect(card).not.toBeVisible();
  });
});
