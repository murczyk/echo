import { expect, test } from '@playwright/test';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';

const period = 14 * 24 * 60 * 60 * 1000;
const since = Date.UTC(2026, 9, 20);

function response(ids: number[] = []): InboxMessagesRspRaw {
  return {
    inbox_items: ids.map((id) => [
      id,
      minimalInboxMessage({
        text: `needle ${id}`,
        createdAt: since + id * 1000,
        createdAtOrder: (since + id * 1000) * 1000,
      }),
    ]),
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
    history_since_ms: since,
    history_period_ms: period,
  };
}

test('#3571 search below saved filters pages through empty periods @regression', async ({
  page,
}) => {
  const historyRequests: Array<Record<string, unknown>> = [];
  let releaseHistory!: () => void;
  const historyReply = new Promise<void>((resolve) => {
    releaseHistory = resolve;
  });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponseForRequest: async (body) => {
      const request = body as Record<string, unknown>;
      if (request.till_date_inclusive_ms != null) {
        historyRequests.push(request);
        if (historyRequests.length === 1) await historyReply;
      }
      return response(request.search ? [] : [1]);
    },
  });
  await page.goto('/rer-duty-neo');
  await page.getByRole('button', { name: 'Фільтри', exact: true }).first().click();
  const panel = page.getByLabel('Панель фільтрів');
  const search = panel.getByRole('combobox', { name: 'Пошук', exact: true });
  await search.scrollIntoViewIfNeeded();
  const saved = panel.getByRole('button', { name: 'Дії зі збереженими фільтрами' });
  const savedBox = await saved.boundingBox();
  const searchBox = await search.boundingBox();
  expect(savedBox).not.toBeNull();
  expect(searchBox!.y).toBeGreaterThan(savedBox!.y);
  await search.fill('needle');
  await page.keyboard.press('Escape');
  await page
    .getByRole('button', { name: /^Фільтри/ })
    .first()
    .click();
  await expect(panel).not.toBeVisible();
  await expect(page.locator('[data-duty-message-id]')).toHaveCount(0);
  const more = page.getByRole('button', { name: 'Завантажити ще', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await expect.poll(() => historyRequests.length).toBe(1);
  expect(historyRequests[0]).toMatchObject({
    search: 'needle',
    sort_by: 'IMSCreatedAt',
    since_date_inclusive_ms: since - period,
    till_date_inclusive_ms: since,
  });
  await expect(more).toBeDisabled();
  releaseHistory();
  await expect(more).toBeEnabled();
  await more.click();
  await expect.poll(() => historyRequests.length).toBe(2);
  expect(historyRequests[1]).toMatchObject({
    search: 'needle',
    since_date_inclusive_ms: since - 2 * period,
    till_date_inclusive_ms: since - period,
  });
});

test('#3571 hides search and history loading when the flag is absent @regression', async ({
  page,
}) => {
  await installRerDutyShortStateMocks(page, { inboxResponse: response() });
  await page.goto('/rer-duty-neo');
  await expect(page.getByText('Немає повідомлень', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Фільтри', exact: true }).first().click();
  await expect(page.getByRole('combobox', { name: 'Пошук', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Завантажити ще', exact: true })).toHaveCount(0);
});

for (const enabled of [false, true]) {
  test(`#3571 restored search highlights and filter indicators respect enableDutySearch=${enabled} @regression`, async ({
    page,
  }) => {
    const inboxResponse = response([1]);
    inboxResponse.inbox_items[0][1].textMarked = [
      { CNCallsignC: { text: 'needle', begin: 0, end: 6, etalon: 'needle' } },
    ];
    const fixture = await installRerDutyShortStateMocks(page, {
      enableDutySearch: enabled,
      inboxResponse,
    });
    const state = encodeURIComponent(
      JSON.stringify({ messageFeeds: [['mf-0', { search: 'needle', searchMode: 'Substring' }]] }),
    );
    await page.goto(`/rer-duty-neo?state=${state}`);
    const message = page.locator('[data-duty-message-id="1"]');
    await expect(message.getByTestId('callsign-token')).toHaveText('NEEDLE');
    await expect(message.locator('.badge-highlighed-token--callsign')).toHaveCount(enabled ? 1 : 0);
    await expect(page.locator('[data-duty-active-filter-indicator]')).toHaveCount(enabled ? 1 : 0);
    expect(fixture.getLastInboxRequest()).toMatchObject({
      search: enabled ? 'needle' : null,
      search_mode: enabled ? 'Substring' : null,
    });
    await page
      .getByRole('button', { name: /^Фільтри/ })
      .first()
      .click();
    await expect(page.getByRole('combobox', { name: 'Пошук', exact: true })).toHaveCount(
      enabled ? 1 : 0,
    );
  });
}

test('#3571 offers the preceding period at the oldest search result @regression', async ({
  page,
}) => {
  const historyRequests: Array<Record<string, unknown>> = [];
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: ['group-1'],
    inboxResponseForRequest: (body) => {
      const request = body as Record<string, unknown>;
      if (request.till_date_inclusive_ms != null) {
        historyRequests.push(request);
        return response();
      }
      if (request.before_id_noninclusive != null) return response();
      return response(Array.from({ length: 20 }, (_, index) => index + 21));
    },
  });
  const state = encodeURIComponent(
    JSON.stringify({
      messageFeeds: [['mf-0', { search: 'needle', groupsSelected: ['group-1'] }]],
    }),
  );
  await page.goto(`/rer-duty-neo?state=${state}`);
  await expect(page.locator('[data-duty-message-id]')).toHaveCount(20);
  const more = page.getByRole('button', { name: 'Завантажити ще', exact: true });
  await expect(more).toHaveCount(0);
  await page.locator('[data-duty-feed-scroller]').evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect(more).toBeVisible();
  await more.click();
  await expect.poll(() => historyRequests.length).toBe(1);
  expect(historyRequests[0]).toMatchObject({
    search: 'needle',
    selected_groups: ['group-1'],
    before_id_noninclusive: 21,
    since_date_inclusive_ms: since - period,
    till_date_inclusive_ms: since,
  });
  await expect(page.locator('[data-duty-message-id]')).toHaveCount(20);
});

test('#3571 reports feature-discovery failures without loading an unfiltered search @regression', async ({
  page,
}) => {
  const inboxRequests: unknown[] = [];
  await installRerDutyShortStateMocks(page, {
    inboxResponseForRequest: (request) => {
      inboxRequests.push(request);
      return response([1]);
    },
  });
  await page.route('**/api-public/server-info', (route) =>
    route.fulfill({ status: 503, contentType: 'application/json', body: '"Search unavailable"' }),
  );
  const state = encodeURIComponent(
    JSON.stringify({ messageFeeds: [['mf-0', { search: 'needle' }]] }),
  );
  await page.goto(`/rer-duty-neo?state=${state}`);
  await expect(page.getByRole('alert').filter({ hasText: 'налаштування пошуку' })).toBeVisible();
  await expect(page.locator('[data-duty-message-id]')).toHaveCount(0);
  expect(inboxRequests).toEqual([]);
});

test('#3571 persists search and mode through saved filters and reload on mobile @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const fixture = await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponse: response([1]),
  });
  await page.goto('/rer-duty-neo');
  await page.getByRole('button', { name: 'Фільтри', exact: true }).first().click();
  const panel = page.getByLabel('Панель фільтрів');
  const search = panel.getByRole('combobox', { name: 'Пошук', exact: true });
  await search.fill('needle');
  await page.getByRole('option', { name: /Збіг за входженням/ }).click();
  await expect(panel).toBeVisible();
  await expect
    .poll(() => fixture.getLastInboxRequest())
    .toMatchObject({
      search: 'needle',
      search_mode: 'Substring',
    });
  const actions = panel.getByRole('button', { name: 'Дії зі збереженими фільтрами' });
  await actions.click();
  await page.getByText('Зберегти як новий', { exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Зберегти як новий' });
  await dialog.getByRole('textbox', { name: 'Назва' }).fill('Пошук колонки');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(panel.getByRole('combobox', { name: 'Фільтр', exact: true })).toHaveValue(
    'Пошук колонки',
  );
  expect(fixture.getSavedFilters()[0]?.req).toMatchObject({
    search: 'needle',
    search_mode: 'Substring',
  });
  await search.fill('changed');
  await page.keyboard.press('Escape');
  await actions.click();
  const update = page.getByText('Оновити вибраний фільтр', { exact: true });
  await expect(update).toBeEnabled();
  await update.click();
  await expect
    .poll(() => fixture.getSavedFilters()[0]?.req)
    .toMatchObject({
      search: 'changed',
      search_mode: 'Substring',
    });
  await panel.getByRole('button', { name: 'Скинути поточний фільтр' }).click();
  await expect(search).toHaveValue('');
  await panel.getByRole('combobox', { name: 'Фільтр', exact: true }).click();
  await page.getByRole('option', { name: 'Пошук колонки' }).click();
  await expect(search).toHaveValue('changed');
  await page.reload();
  await expect(page.locator('[data-duty-message-id]')).toHaveCount(1);
  await page
    .getByRole('button', { name: /^Фільтри/ })
    .first()
    .click();
  await expect(search).toHaveValue('changed');
  await expect
    .poll(() => fixture.getLastInboxRequest())
    .toMatchObject({
      search: 'changed',
      search_mode: 'Substring',
      sort_by: 'IMSCreatedAt',
    });
});
