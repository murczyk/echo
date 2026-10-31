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

function buildInboxResponse(ids: number[], groupMasterKey = 'group-1'): InboxMessagesRspRaw {
  return {
    inbox_items: ids.map((id) => [id, buildInboxMessage(id, { groupMasterKey }) as never]),
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
  test('#3923 clears unrelated cards when the selected group reload fails @regression', async ({
    page,
  }) => {
    await installRerDutyShortStateMocks(page, {
      signalGroups: ['group-1', 'avia-barrier'],
      inboxResponse: buildInboxResponse([1, 2]),
    });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      const request = route.request().postDataJSON() as { selected_groups?: string[] | null };
      if (!request.selected_groups?.includes('avia-barrier')) return route.fallback();
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ error: 'Group reload unavailable (503)' }),
      });
    });

    await page.goto('/rer-duty-neo');
    await expect(page.locator('[data-duty-message-id]')).toHaveCount(2);
    await page.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await page.getByRole('button', { name: 'avia-barrier', exact: true }).click();

    await expect(page.getByText('Group reload unavailable (503)', { exact: true })).toBeVisible();
    await expect(page.locator('[data-group-island]')).toContainText('avia-barrier');
    await expect(page.locator('[data-duty-message-id]')).toHaveCount(0);
    await expect(page.getByText('Немає повідомлень', { exact: true })).toBeVisible();
  });

  test('a copied Duty link opens one feed without forcing the message group @regression', async ({
    page,
    context,
  }) => {
    test.setTimeout(90_000);
    const messageUuid = '019a4aa8-0000-7000-8000-000000000065';
    const inboxResponse = buildInboxResponse([1, 2]);
    inboxResponse.inbox_items[1][1].messageUuid = messageUuid;
    const inboxRequests: unknown[] = [];
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await installRerDutyShortStateMocks(page, {
      inboxResponseForRequest: (requestBody) => {
        inboxRequests.push(requestBody);
        const request = requestBody as {
          before_id_noninclusive?: number | null;
          since_id_noninclusive?: number | null;
        };
        if (request.before_id_noninclusive === 2) return buildInboxResponse([1]);
        if (request.before_id_noninclusive != null || request.since_id_noninclusive != null) {
          return buildInboxResponse([]);
        }
        return inboxResponse;
      },
    });
    await page.route('**/api/rer-importer/inbox-item-context', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          message: inboxResponse.inbox_items[1],
          group_master_keys: ['group-1'],
          sigint_inbox_item_ids: [2],
          since_ts: null,
          till_ts: null,
        }),
      }),
    );
    await page.route('**/api/rer-importer/messages-by-id-with-metadata', (route) =>
      route.fulfill({
        contentType: 'application/json',
        body: JSON.stringify({
          ...inboxResponse,
          inbox_items: [inboxResponse.inbox_items[1]],
        }),
      }),
    );

    await page.goto('/rer-duty-neo');
    for (let count = 2; count <= 4; count += 1) {
      await page.getByRole('button', { name: 'Додати стрічку' }).click();
    }
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(4);
    const card = page
      .locator('[data-duty-feed-column]')
      .first()
      .locator('[data-duty-message-id="2"]');
    await card.getByRole('button', { name: 'Більше дій' }).click();
    await expect(page.getByRole('menuitem', { name: 'Копіювати…', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Копіювати посилання на повідомлення' }).click();
    await expect(page.getByText('Посилання на повідомлення скопійовано.')).toBeVisible();
    const link = await page.evaluate(() => navigator.clipboard.readText());
    expect(new URL(link).pathname).toBe('/rer-duty-neo');
    expect(new URL(link).searchParams.get('m')).toBe(messageUuid);

    inboxRequests.length = 0;
    await page.goto(link);
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    const targetCard = page.locator('[data-duty-message-id="2"]');
    await expect(targetCard).toBeVisible();
    await expect(targetCard).toHaveAttribute('data-message-feed-highlighted', 'true');
    await expect(targetCard.locator('[data-message-card-root]')).toHaveCSS('outline-width', '2px');
    expect(inboxRequests.length).toBeGreaterThan(0);
    expect(
      inboxRequests.map((requestBody) => {
        const request = requestBody as {
          selected_groups?: string[] | null;
          selectedGroups?: string[] | null;
        };
        return request.selected_groups ?? request.selectedGroups ?? null;
      }),
    ).toEqual(inboxRequests.map(() => null));
  });

  test('#3689 retains mounted cards in four feeds under CPU load and mounts only the active mobile tab', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 1080 });
    await installRerDutyShortStateMocks(page, {
      inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await cpu.send('Performance.enable');
    const startedAt = Date.now();
    await page.goto('/rer-duty-neo');
    for (let count = 2; count <= 4; count += 1) {
      await page.getByRole('button', { name: 'Додати стрічку' }).click();
      await expect(page.locator('[data-duty-feed-column]')).toHaveCount(count);
    }
    const columns = page.locator('[data-duty-feed-column]');
    for (let index = 0; index < 4; index += 1) {
      await expect(columns.nth(index).locator('[data-duty-message-id]')).toHaveCount(40);
    }
    await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[data-duty-message-id]'));
      (window as Window & { feedBenchmarkCards?: Element[] }).feedBenchmarkCards = cards;
    });
    await page.setViewportSize({ width: 1800, height: 1000 });
    await expect
      .poll(() =>
        page.evaluate(() => {
          const previous =
            (window as Window & { feedBenchmarkCards?: Element[] }).feedBenchmarkCards ?? [];
          const cards = Array.from(document.querySelectorAll('[data-duty-message-id]'));
          return cards.length === 160 && cards.every((card, index) => card === previous[index]);
        }),
      )
      .toBe(true);
    const metrics = await cpu.send('Performance.getMetrics');
    console.info(
      'message-feed workload',
      JSON.stringify({
        elapsedMs: Date.now() - startedAt,
        metrics: metrics.metrics.filter(({ name }) =>
          [
            'TaskDuration',
            'ScriptDuration',
            'LayoutDuration',
            'RecalcStyleDuration',
            'Nodes',
          ].includes(name),
        ),
      }),
    );
    await page.setViewportSize({ width: 375, height: 667 });
    await expect(page.getByRole('tab')).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await page.getByRole('tab').nth(index).click();
      await expect(columns).toHaveCount(1);
      await expect(columns.locator('[data-duty-message-id]')).toHaveCount(40);
    }
    await cpu.detach();
  });

  test('four filtered feeds paginate independently when one reaches its older edge @regression', async ({
    page,
  }) => {
    const groups = ['group-1', 'group-2', 'group-3', 'group-4'];
    const olderRequests: Array<{ group: string; beforeId: number }> = [];
    await installRerDutyShortStateMocks(page, {
      signalGroups: groups,
      inboxResponseForRequest: (requestBody) => {
        const request = requestBody as {
          selected_groups?: string[] | null;
          before_id_noninclusive?: number | null;
        };
        const group = request.selected_groups?.[0] ?? '';
        const groupIndex = groups.indexOf(group);
        if (groupIndex < 0) return buildInboxResponse([]);
        const base = groupIndex * 100;
        const beforeId = request.before_id_noninclusive;
        if (beforeId != null) olderRequests.push({ group, beforeId });
        if (beforeId === base + 21) {
          return buildInboxResponse(
            Array.from({ length: 20 }, (_, index) => base + index + 1),
            group,
          );
        }
        if (beforeId != null) return buildInboxResponse([]);
        return buildInboxResponse(
          Array.from({ length: 20 }, (_, index) => base + index + 21),
          group,
        );
      },
    });
    const state = {
      messageFeeds: groups.map((group, index) => [`mf-${index}`, { groupsSelected: [group] }]),
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const columns = page.locator('[data-duty-feed-column]');
    await expect(columns).toHaveCount(4);
    for (let index = 0; index < 4; index += 1) {
      await expect(columns.nth(index).locator('[data-duty-message-id]')).toHaveCount(20);
      await expect(
        columns.nth(index).locator(`[data-duty-message-id="${index * 100 + 21}"]`),
      ).toBeAttached();
    }
    const siblingScrollTops = await Promise.all(
      [1, 2, 3].map((index) =>
        columns
          .nth(index)
          .locator('[data-duty-feed-scroller="true"]')
          .evaluate((element) => element.scrollTop),
      ),
    );

    await columns.first().locator('[data-message-feed-skeleton="above"]').scrollIntoViewIfNeeded();
    await expect(columns.first().locator('[data-duty-message-id]')).toHaveCount(40);
    await expect(columns.first().locator('[data-duty-message-id="1"]')).toBeAttached();
    expect(olderRequests).toEqual([{ group: 'group-1', beforeId: 21 }]);
    for (let index = 1; index < 4; index += 1) {
      await expect(columns.nth(index).locator('[data-duty-message-id]')).toHaveCount(20);
      await expect(
        columns.nth(index).locator(`[data-duty-message-id="${index * 100 + 21}"]`),
      ).toBeAttached();
      await expect
        .poll(() =>
          columns
            .nth(index)
            .locator('[data-duty-feed-scroller="true"]')
            .evaluate(
              (element, initialScrollTop) => Math.abs(element.scrollTop - initialScrollTop),
              siblingScrollTops[index - 1],
            ),
        )
        .toBeLessThanOrEqual(1);
    }
  });

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
    const indicator = page.locator('[role="tablist"][aria-label="Стрічки"] > [aria-hidden="true"]');
    await expect(indicator).toHaveCount(1);
    expect(
      await indicator.evaluate((element) => getComputedStyle(element).transitionProperty),
    ).toBe('transform');
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    await expect(tabs.first()).toHaveAttribute('aria-selected', 'true');

    await tabs.nth(1).click();
    await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    await expect(page.locator('[data-duty-feed-column-active="true"]')).toHaveCount(1);
    await expect
      .poll(async () => {
        const indicatorBox = await indicator.boundingBox();
        const tabBox = await tabs.nth(1).boundingBox();
        return indicatorBox && tabBox
          ? Math.abs(indicatorBox.x - tabBox.x) + Math.abs(indicatorBox.width - tabBox.width)
          : Number.POSITIVE_INFINITY;
      })
      .toBeLessThan(1);
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
    await page
      .getByRole('dialog', { name: 'Сповістити всіх?' })
      .getByRole('button', { name: 'Позначити', exact: true })
      .click();
    await expect(card.getByRole('button', { name: 'Позначити як не важливе' })).toBeVisible();
    await card.getByRole('button', { name: 'Позначити як не важливе' }).click();
    await expect(card.getByRole('button', { name: 'Позначити як важливе' })).toBeVisible();
    expect(importantRequests).toEqual([
      {
        path: '/api/rer/important/add',
        body: {
          message_id: 99,
          group_master_key: null,
          notify_group: false,
          operation_id: expect.any(String),
        },
      },
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
