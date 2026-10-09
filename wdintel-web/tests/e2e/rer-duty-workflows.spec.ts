import { expect, test, type Locator, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

function buildInboxMessage(id: number, overrides: Partial<InboxMessage> = {}): InboxMessage {
  return minimalInboxMessage({
    messageUid: `duty-msg-${id}`,
    text: `Duty message text ${id}`,
    timestamp: 1_720_000_000_000 + id * 1_000,
    createdAt: 1_720_000_000_000 + id * 1_000,
    groupMasterKey: 'group-1',
    ...overrides,
  });
}

function buildInboxResponse(ids: number[]): InboxMessagesRspRaw {
  return {
    inbox_items: ids.map((id) => [id, buildInboxMessage(id) as never]),
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

async function openFilterPanel(page: Page): Promise<Locator> {
  const filterToggle = page.getByRole('button', { name: 'Фільтри' }).first();
  await expect(filterToggle).toBeVisible();
  await filterToggle.click();

  const panel = page.locator('[aria-label="Панель фільтрів"]').first();
  await expect(panel).toBeVisible();
  return panel;
}

async function addFrequencies(page: Page, panel: Locator, values: string[]): Promise<void> {
  const bulkMenuButton = panel.getByRole('button', { name: 'Додати кілька частот' });
  await expect(bulkMenuButton).toBeVisible();
  await bulkMenuButton.click();
  await page.getByRole('menuitem', { name: 'Додати кілька частот' }).click();

  const dialog = page.getByRole('dialog', { name: 'Додати кілька частот' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Частоти' }).fill(values.join('\n'));
  await dialog.getByRole('button', { name: 'Додати' }).click();
  await expect(dialog).not.toBeVisible();
}

test.describe('Duty characterization workflows @regression', () => {
  test('@smoke persists the four-feed workspace and closes the selected middle feed', async ({
    page,
  }) => {
    await installRerDutyShortStateMocks(page, {
      inboxResponse: buildInboxResponse([1, 2]),
    });
    await page.goto('/rer-duty-neo');

    for (let expectedCount = 2; expectedCount <= 4; expectedCount += 1) {
      await page.getByRole('button', { name: 'Додати стрічку' }).click();
      await expect(page.locator('[data-duty-feed-column]')).toHaveCount(expectedCount);
    }
    await expect(page.getByRole('button', { name: 'Додати стрічку' })).not.toBeVisible();

    await page.reload();
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(4);

    await page.getByRole('button', { name: 'Закрити стрічку' }).nth(1).click();
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toContainText('Видалити');
    await confirmDialog.getByRole('button', { name: 'Видалити' }).click();
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(3);
  });

  test('narrow workspace keeps exactly one feed mounted while switching tabs', async ({ page }) => {
    await installRerDutyShortStateMocks(page, {
      inboxResponse: buildInboxResponse([10, 11]),
    });

    await page.goto('/rer-duty-neo');
    await page.getByRole('button', { name: 'Додати стрічку' }).click();
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(2);

    await page.setViewportSize({ width: 375, height: 667 });
    const tabs = page.getByRole('tab');
    await expect(tabs).toHaveCount(2);
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    await expect(page.locator('[data-duty-feed-column-active="true"]')).toHaveCount(1);
  });

  test('@smoke bulk frequencies update the inbox request, refresh their catalog, and reset cleanly', async ({
    page,
  }) => {
    const fixture = await installRerDutyShortStateMocks(page, {
      inboxResponse: buildInboxResponse([1]),
      latestFrequencies: ['123.456', '234.567'],
    });
    let frequencyCatalogRequests = 0;
    await page.route('**/api/sigint/latest-frequencies', async (route) => {
      frequencyCatalogRequests += 1;
      await route.fallback();
    });

    await page.goto('/rer-duty-neo');
    const panel = await openFilterPanel(page);
    await addFrequencies(page, panel, ['123.456', '234.567']);

    await expect
      .poll(() => (fixture.getLastInboxRequest() as Record<string, unknown> | null)?.selected_freqs)
      .toEqual(['123.456', '234.567']);

    const initialCatalogRequests = frequencyCatalogRequests;
    await panel.getByRole('button', { name: 'Оновити список частот' }).click();
    await expect.poll(() => frequencyCatalogRequests).toBe(initialCatalogRequests + 1);

    const reset = panel.getByRole('button', { name: 'Скинути поточний фільтр' });
    await expect(reset).toBeEnabled();
    await reset.click();
    await expect
      .poll(() => (fixture.getLastInboxRequest() as Record<string, unknown> | null)?.selected_freqs)
      .toBeNull();
    await expect(reset).toBeDisabled();
  });

  test('saved feed filter completes create, dirty update, rename, and delete lifecycle', async ({
    page,
  }) => {
    const fixture = await installRerDutyShortStateMocks(page, {
      inboxResponse: buildInboxResponse([1]),
      latestFrequencies: ['123.456', '234.567'],
    });
    await page.goto('/rer-duty-neo');
    const panel = await openFilterPanel(page);
    await addFrequencies(page, panel, ['123.456']);

    const actions = panel.getByRole('button', { name: 'Дії зі збереженими фільтрами' });
    await actions.click();
    await page.getByText('Зберегти як новий', { exact: true }).click();
    const saveDialog = page.getByRole('dialog', { name: 'Зберегти як новий' });
    await saveDialog.getByRole('textbox', { name: 'Назва' }).fill('Тестовий фільтр');
    await saveDialog.getByRole('button', { name: 'Зберегти' }).click();

    const savedFilter = panel.getByRole('combobox', { name: 'Фільтр' });
    await expect(savedFilter).toHaveValue('Тестовий фільтр');
    expect(fixture.getSavedFilters()).toEqual([
      expect.objectContaining({
        id: 1,
        name: 'Тестовий фільтр',
        req: expect.objectContaining({ freqs_selected: ['123.456'] }),
      }),
    ]);

    await addFrequencies(page, panel, ['234.567']);
    await actions.click();
    const update = page.getByText('Оновити вибраний фільтр', { exact: true });
    await expect(update).toBeEnabled();
    await update.click();
    await expect
      .poll(() => {
        const req = fixture.getSavedFilters()[0]?.req as Record<string, unknown> | undefined;
        return req?.freqs_selected;
      })
      .toEqual(['123.456', '234.567']);
    expect(fixture.getSavedFilters()).toHaveLength(1);

    await actions.click();
    await page.getByText('Перейменувати', { exact: true }).click();
    const renameDialog = page.getByRole('dialog', { name: 'Перейменувати фільтр' });
    const nameInput = renameDialog.getByRole('textbox', { name: 'Назва' });
    await nameInput.fill('Перейменований фільтр');
    await renameDialog.getByRole('button', { name: 'Перейменувати' }).click();
    await expect(savedFilter).toHaveValue('Перейменований фільтр');
    expect(fixture.getSavedFilters()[0]?.name).toBe('Перейменований фільтр');

    await actions.click();
    await page.getByText('Видалити', { exact: true }).click();
    await expect(panel.getByText('Збережені фільтри відсутні')).toBeVisible();
    expect(fixture.getSavedFilters()).toEqual([]);
  });

  test('card actions toggle important state and preserve source context for navigation and report', async ({
    page,
  }) => {
    await installRerDutyShortStateMocks(page, {
      rerReportEligible: true,
      rerReportEnabled: true,
      inboxResponse: buildInboxResponse([99]),
    });
    const importantRequests: Array<{ path: string; body: unknown }> = [];
    await page.route('**/api/rer/important/*', async (route) => {
      importantRequests.push({
        path: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      await route.fallback();
    });

    await page.goto('/rer-duty-neo');
    const card = page.locator('[data-message-id="99"]');
    await expect(card).toContainText('Duty message text 99');

    await card.getByRole('button', { name: 'Позначити як важливе' }).click();
    await expect(card.getByRole('button', { name: 'Позначити як не важливе' })).toBeVisible();
    await card.getByRole('button', { name: 'Позначити як не важливе' }).click();
    await expect(card.getByRole('button', { name: 'Позначити як важливе' })).toBeVisible();
    expect(importantRequests).toEqual([
      { path: '/api/rer/important/add', body: { message_id: 99 } },
      { path: '/api/rer/important/delete', body: { message_id: 99 } },
    ]);

    await card.getByTitle('Перейти…').click();
    const analysisLink = page.getByRole('menuitem').filter({ hasText: 'В аналіз' });
    await expect(analysisLink).toHaveAttribute('href', /\/rer-analysis-neo/);
    await expect(analysisLink).toHaveAttribute('href', /search=duty-msg-99/);
    await page.keyboard.press('Escape');

    await card.getByTitle('Створити розвіддонесення').click();
    const editor = page.locator('[data-duty-editor-dock]');
    await expect(editor).toBeVisible();
    await expect(editor).toContainText('Duty message text 99');
  });
});
