import { expect, test, type Locator } from '@playwright/test';
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

function responseWithMessages(messages: Array<{ id: number; text: string }>): InboxMessagesRspRaw {
  const result = response(messages.map(({ id }) => id));
  const textById = new Map(messages.map(({ id, text }) => [id, text]));
  for (const [id, message] of result.inbox_items) {
    message.text = textById.get(id) ?? message.text;
  }
  return result;
}

function stateForGroups(groups: string[]): string {
  return encodeURIComponent(
    JSON.stringify({
      messageFeeds: groups.map((group, index) => [`mf-${index}`, { groupsSelected: [group] }]),
    }),
  );
}

async function openDutySearch(column: Locator): Promise<Locator> {
  await column.getByRole('button', { name: /пошук/i }).click();
  const query = column.getByRole('combobox', { name: /пошук/i });
  await expect(query).toBeVisible();
  return query;
}

for (const panel of ['search', 'groups'] as const) {
  test(`#3571 keeps the ${panel} panel invisible after exit finishes until unmount @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: ['Навчальна група'],
      inboxResponseForRequest: () => response([1]),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]').first();
    const selector = panel === 'search' ? '[data-duty-search-panel]' : '[data-group-panel]';
    await column
      .getByRole('button', {
        name: panel === 'search' ? 'Пошук у стрічці' : 'Розгорнути список груп',
        exact: true,
      })
      .click();
    await expect(column.locator(selector)).toBeVisible();
    await column.evaluate((column, selector) => {
      const observer = new MutationObserver(() => {
        const content = column.querySelector(selector);
        const exiting =
          selector === '[data-duty-search-panel]'
            ? content?.parentElement
            : content?.closest('.duty-group-motion');
        if (exiting?.getAttribute('aria-hidden') !== 'true') return;
        const animation = exiting.getAnimations()[0];
        if (!animation) return;
        observer.disconnect();
        void animation.finished.then(() => {
          column.setAttribute(
            'data-exit-opacity',
            exiting.isConnected ? getComputedStyle(exiting).opacity : '0',
          );
        });
      });
      observer.observe(column, {
        attributes: true,
        subtree: true,
        attributeFilter: ['aria-hidden'],
      });
    }, selector);
    await column
      .getByRole('button', {
        name: panel === 'search' ? 'Пошук у стрічці' : 'Згорнути список груп',
        exact: true,
      })
      .click();
    await expect(column).toHaveAttribute('data-exit-opacity', '0');
    await expect(column.locator(selector)).toHaveCount(0);
  });
}

for (const feedCount of [1, 2]) {
  test(`#3571 keeps the header and search inside the resizing column (${feedCount} feeds) @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: feedCount === 1 ? 2400 : 1600, height: 900 });
    const groups = Array.from({ length: feedCount }, (_, index) => `group-${index}`);
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: groups,
      inboxResponse: response([1, 2, 3, 4, 5, 6, 7, 8]),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
    const column = page.locator('[data-duty-feed-column]').first();
    await expect(column.locator('[data-duty-message-id]')).toHaveCount(8);
    const measure = () =>
      column.evaluate((column) => {
        const rect = column.getBoundingClientRect();
        const main = column.querySelector('[data-duty-feed-main]')!.getBoundingClientRect();
        const header = column
          .querySelector('[data-duty-feed-header-layout]')!
          .getBoundingClientRect();
        const panel = column.querySelector('[data-duty-search-panel]')?.parentElement;
        return {
          left: rect.left,
          right: rect.right,
          width: rect.width,
          mainLeft: main.left,
          mainRight: main.right,
          mainWidth: main.width,
          headerLeft: header.left,
          headerRight: header.right,
          panelRight: panel?.getBoundingClientRect().right ?? rect.left,
          cardWidth: column.querySelector('[data-duty-message-id]')!.getBoundingClientRect().width,
          nextLeft: column.nextElementSibling?.getBoundingClientRect().left ?? null,
        };
      });
    const settle = () =>
      column.evaluate(async (column) => {
        const targets = [
          column,
          column.querySelector('[data-duty-feed-main]'),
          column.querySelector('[data-duty-search-panel]')?.parentElement,
        ];
        await Promise.all(
          targets
            .flatMap((target) => target?.getAnimations() ?? [])
            .map((animation) => {
              animation.play();
              return animation.finished.catch(() => {});
            }),
        );
      });
    const closed = await measure();
    const trigger = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
    await trigger.click();
    await settle();
    for (const direction of ['closing', 'opening']) {
      await column.evaluate((column, direction) => {
        const observer = new MutationObserver(() => {
          const targets = [
            column,
            column.querySelector('[data-duty-feed-main]'),
            column.querySelector('[data-duty-search-panel]')?.parentElement,
          ];
          const animations = targets
            .flatMap((target) => target?.getAnimations() ?? [])
            .filter((animation) => animation.playState === 'running');
          if (!animations.length) return;
          observer.disconnect();
          for (const animation of animations) {
            animation.pause();
            animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
          }
          column.setAttribute('data-width-sampled', direction);
        });
        observer.observe(column, {
          childList: true,
          subtree: true,
          attributes: true,
          attributeFilter: ['aria-expanded'],
        });
      }, direction);
      await trigger.evaluate((button: HTMLButtonElement) => button.click());
      await expect(column).toHaveAttribute('data-width-sampled', direction);
      const midpoint = await measure();
      expect(midpoint.width).toBeGreaterThan(closed.width + 1);
      expect(midpoint.width).toBeLessThan(closed.width + 269);
      expect(midpoint.headerLeft).toBeGreaterThanOrEqual(midpoint.left - 1);
      expect(midpoint.headerRight).toBeLessThanOrEqual(midpoint.right + 1);
      expect(midpoint.mainRight).toBeLessThanOrEqual(midpoint.right + 1);
      expect(midpoint.mainWidth).toBeCloseTo(closed.mainWidth, 0);
      expect(midpoint.cardWidth).toBeCloseTo(closed.cardWidth, 0);
      expect(midpoint.panelRight).toBeLessThanOrEqual(midpoint.mainLeft + 1);
      if (midpoint.nextLeft !== null && closed.nextLeft !== null)
        expect(midpoint.nextLeft - midpoint.right).toBeCloseTo(closed.nextLeft - closed.right, 0);
      await page.screenshot({ path: test.info().outputPath(`${direction}-midpoint.png`) });
      await settle();
      if (direction === 'closing')
        await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    }
  });
}

test('#3571 mobile search overlays the feed and restores results after landing @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponse: response(Array.from({ length: 20 }, (_, index) => index + 1)),
    inboxCountResponseForRequest: () => ({ quantity: 20, first_element_ts: null }),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  await expect(column.locator('[data-duty-message-id]')).toHaveCount(20);
  const closedWidth = await column.evaluate((column) => column.getBoundingClientRect().width);
  const query = await openDutySearch(column);
  await expect(query).toBeFocused();
  const panel = column.locator('[data-duty-search-panel]');
  const geometry = await column.evaluate((column) => ({
    width: column.getBoundingClientRect().width,
    panelWidth: column.querySelector('[data-duty-search-panel]')!.getBoundingClientRect().width,
    overflow: column.parentElement!.scrollWidth - column.parentElement!.clientWidth,
  }));
  expect(geometry.width).toBeCloseTo(closedWidth, 0);
  expect(geometry.panelWidth).toBeCloseTo(closedWidth, 0);
  expect(geometry.overflow).toBeLessThanOrEqual(1);
  await query.fill('needle');
  await query.press('Escape');
  const list = panel.locator('[data-duty-search-list]');
  await expect(list.locator('[data-duty-search-result]')).toHaveCount(20);
  await list.evaluate((list) => {
    list.scrollTop = 240;
    list.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const position = await list.evaluate((list) => list.scrollTop);
  const selectedId = await list.evaluate((list) => {
    const bounds = list.getBoundingClientRect();
    const row = [...list.querySelectorAll<HTMLElement>('[data-duty-search-result]')].find((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
    });
    return row!.dataset.dutySearchResult!;
  });
  await list.locator(`[data-duty-search-result="${selectedId}"]`).click();
  await expect(panel).toHaveCount(0);
  await expect(
    column.locator(
      `[data-duty-message-id="${selectedId}"][data-message-feed-highlighted], [data-duty-message-id="${selectedId}"] [data-message-feed-highlighted]`,
    ),
  ).toHaveCount(1);
  await expect(column.locator(`[data-duty-message-id="${selectedId}"]`)).toBeInViewport();
  const reopened = await openDutySearch(column);
  await expect(reopened).toHaveValue('needle');
  await expect(reopened).not.toBeFocused();
  await expect(list.locator('[data-duty-search-result]')).toHaveCount(20);
  await expect.poll(() => list.evaluate((list) => list.scrollTop)).toBeCloseTo(position, 0);
  await expect(list.locator(`[data-duty-search-result="${selectedId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.evaluate(async (panel) => {
    await Promise.all(
      panel.parentElement!.getAnimations().map((animation) => animation.finished.catch(() => {})),
    );
  });
  expect(
    await panel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect();
      return panel.contains(document.elementFromPoint(rect.right - 32, rect.bottom - 24));
    }),
  ).toBe(true);
  await page.screenshot({ path: test.info().outputPath('mobile-restored-search.png') });
  await panel.getByRole('button', { name: 'Наступний результат', exact: true }).click();
  await expect(panel).toHaveCount(0);
  const nextId = String(Number(selectedId) - 1);
  await expect(column.locator(`[data-duty-message-id="${nextId}"]`)).toBeInViewport();
  await openDutySearch(column);
  await expect(reopened).not.toBeFocused();
  await expect(list.locator(`[data-duty-search-result="${nextId}"]`)).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await panel.getByRole('button', { name: 'Очистити пошук', exact: true }).click();
  await expect(reopened).toBeFocused();
  await expect(list.locator('[data-duty-search-result]')).toHaveCount(0);
  await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(await openDutySearch(column)).toHaveValue('');
  await expect(query).toBeFocused();
});

for (const dismissal of ['enter', 'reopen'] as const) {
  test(`#3571 dismisses mobile search with Escape after ${dismissal} without input focus @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 900 });
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      inboxResponse: response([1]),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]').first();
    const trigger = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
    const query = await openDutySearch(column);
    await query.fill('needle');
    await query.press('Escape');
    await expect(column.locator('[data-duty-search-result]')).toHaveCount(1);
    if (dismissal === 'enter') await query.press('Enter');
    else {
      await trigger.click();
      await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
      await openDutySearch(column);
    }
    await expect(query).not.toBeFocused();
    await page.keyboard.press('Escape');
    await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    await expect(trigger).toBeFocused();
    await expect(await openDutySearch(column)).toHaveValue('needle');
    await expect(query).not.toBeFocused();
  });
}

test('#3571 keeps search open when Escape belongs to settings or another column groups @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: ['g1', 'g2'],
    inboxResponse: response([1]),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`/rer-duty-neo?state=${stateForGroups(['g1', 'g2'])}`);
  const columns = page.locator('[data-duty-feed-column]');
  const query = await openDutySearch(columns.first());
  await query.fill('needle');
  await query.press('Escape');
  await expect(columns.first().locator('[data-duty-search-result]')).toHaveCount(1);
  await columns
    .first()
    .getByRole('button', { name: /^Фільтри/ })
    .click();
  await expect(columns.first().getByLabel('Панель фільтрів')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(columns.first().getByLabel('Панель фільтрів')).toHaveCount(0);
  await expect(columns.first().locator('[data-duty-search-panel]')).toBeVisible();
  await columns.nth(1).getByRole('button', { name: 'Розгорнути список груп', exact: true }).click();
  await expect(columns.nth(1).locator('[data-group-panel]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(columns.nth(1).locator('[data-group-panel]')).toHaveCount(0);
  await expect(columns.first().locator('[data-duty-search-panel]')).toBeVisible();
});

test('#3571 applies rapid search reversals and result steps immediately @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponseForRequest: () => response([1, 2, 3, 4]),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  const trigger = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
  await expect(trigger).toBeVisible();
  await trigger.evaluate((button: HTMLButtonElement) => {
    button.click();
  });
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await trigger.evaluate((button: HTMLButtonElement) => button.click());
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await trigger.evaluate((button: HTMLButtonElement) => button.click());
  const query = column.getByRole('combobox', { name: 'Пошук', exact: true });
  await expect(query).toBeFocused();
  await query.fill('needle');
  await query.press('Escape');
  const panel = column.locator('[data-duty-search-panel]');
  await expect(panel.locator('[data-duty-search-result]')).toHaveCount(4);
  const next = panel.getByRole('button', { name: 'Наступний результат', exact: true });
  await next.evaluate((button: HTMLButtonElement) => button.click());
  await expect(panel.locator('[data-duty-search-result="4"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await next.evaluate((button: HTMLButtonElement) => button.click());
  await expect(panel.locator('[data-duty-search-result="3"]')).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test('#3571 keeps the same visible search row fixed when pending counts change @regression', async ({
  page,
}) => {
  let added = 0;
  const ids = () => Array.from({ length: 20 + added }, (_, i) => 20 + added - i);
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 20 + added, first_element_ts: null }),
    inboxResponseForRequest: () => response(ids()),
  });
  await page.route('**/api/rer-importer/messages-by-id-matching-filters', (route) =>
    route.fulfill({ json: { messages: response(ids()).inbox_items } }),
  );
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  const query = await openDutySearch(column);
  await query.fill('needle');
  await query.press('Escape');
  const list = column.locator('[data-duty-search-list]');
  await expect(list.locator('[data-duty-search-result]')).toHaveCount(20);
  await list.evaluate((n) => {
    n.scrollTop = 300;
    n.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const snapshot = () =>
    list.evaluate((n) => {
      const bounds = n.getBoundingClientRect();
      const row = [...n.querySelectorAll('[data-duty-search-result]')].find(
        (row) => row.getBoundingClientRect().bottom > bounds.top,
      )!;
      return {
        y: bounds.y,
        height: bounds.height,
        top: n.scrollTop,
        row: row.getAttribute('data-duty-search-result'),
        rowY: row.getBoundingClientRect().y,
      };
    });
  const before = await snapshot();
  for (const count of [1, 10]) {
    if (count === 10) {
      await page.clock.install();
      await page.clock.runFor(10000);
      await page.clock.resume();
    }
    added = count;
    await page.evaluate(
      (ids) =>
        window.dispatchEvent(
          new CustomEvent('echo-inbox-changed', { detail: { messageIds: ids } }),
        ),
      ids().slice(0, count),
    );
    await expect(
      column.getByRole('button', { name: `Нові результати: ${count}`, exact: true }),
    ).toBeVisible();
    expect(await snapshot()).toEqual(before);
  }
  await column.getByRole('button', { name: 'Нові результати: 10', exact: true }).click();
  await expect(list.locator('[data-duty-search-result="30"]')).toBeVisible();
  await expect.poll(() => list.evaluate((n) => n.scrollTop)).toBe(0);
});

test('#3571 makes pending search loading static with reduced motion @regression', async ({
  page,
}) => {
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponseForRequest: async (body) => {
      if ((body as Record<string, unknown>).search) await pending;
      return response([1]);
    },
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const query = await openDutySearch(page.locator('[data-duty-feed-column]').first());
  await query.fill('needle');
  await query.press('Escape');
  const panel = page.locator('[data-duty-search-panel]');
  await expect(panel.getByRole('progressbar')).toBeVisible();
  expect(
    await panel.evaluate(
      (n) => n.getAnimations({ subtree: true }).filter((a) => a.playState === 'running').length,
    ),
  ).toBe(0);
  release();
  await expect(panel.locator('[data-duty-search-result]')).toHaveCount(1);
});

test('#3571 highlights backend search matches in the source feed only @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1600, height: 1000 });
  const source = responseWithMessages([
    { id: 1, text: 'Нова позиція' },
    { id: 2, text: 'Контекст' },
  ]);
  source.inbox_items[0][1].textMarked = [{ CNTextC: { text: 'Нова позиція', begin: 0, end: 12 } }];
  const found = responseWithMessages([{ id: 1, text: 'Нова позиція' }]);
  found.inbox_items[0][1].textMarked = [
    { CNHighlightC: { text: 'Нова', begin: 0, end: 4 } },
    { CNTextC: { text: ' позиція', begin: 4, end: 12 } },
  ];
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: ['g1', 'g2'],
    inboxResponseForRequest: (body) => ((body as Record<string, unknown>).search ? found : source),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`/rer-duty-neo?state=${stateForGroups(['g1', 'g2'])}`);
  const columns = page.locator('[data-duty-feed-column]');
  const column = columns.first();
  const marks = column.locator('[data-duty-message-id="1"] .badge-highlighed-token');
  const query = await openDutySearch(column);
  await query.fill('новий');
  await query.press('Escape');
  await expect(marks).toHaveText(['Нова']);
  await expect(
    columns.nth(1).locator('[data-duty-message-id="1"] .badge-highlighed-token'),
  ).toHaveCount(0);
  await expect(column.locator('[data-duty-message-id]')).toHaveCount(2);
  await column.locator('[data-duty-search-result="1"]').click();
  await expect(marks).toHaveText(['Нова']);
  await page.screenshot({ path: test.info().outputPath('source-search-highlight.png') });
  await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
  await expect(marks).toHaveCount(0);
  const reopened = await openDutySearch(column);
  await expect(marks).toHaveText(['Нова']);
  await reopened.fill('');
  await expect(marks).toHaveCount(0);
  await expect(column.locator('[data-duty-message-id]')).toHaveCount(2);
});

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
  const search = panel.getByRole('combobox', {
    name: 'Фільтр по ключовому слову',
    exact: true,
  });
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
  await expect(
    page.getByRole('combobox', { name: 'Фільтр по ключовому слову', exact: true }),
  ).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Завантажити ще', exact: true })).toHaveCount(0);
});

test('#3571 names the preserved keyword filter separately from Duty panel search @regression', async ({
  page,
}) => {
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponse: response([1]),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  await page.getByRole('button', { name: 'Фільтри', exact: true }).first().click();

  const panel = page.getByLabel('Панель фільтрів');
  await expect(
    panel.getByRole('combobox', { name: 'Фільтр по ключовому слову', exact: true }),
  ).toBeVisible();
  await expect(
    page.locator('[data-duty-feed-column]').first().getByRole('button', { name: /пошук/i }),
  ).toBeVisible();
  await cpu.detach();
});

test('#3571 blocks Duty panel search while the keyword filter is applied @regression', async ({
  page,
}) => {
  const requests: Array<Record<string, unknown>> = [];
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxResponseForRequest: (body) => {
      requests.push(body as Record<string, unknown>);
      return response([1]);
    },
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const state = encodeURIComponent(
    JSON.stringify({ messageFeeds: [['mf-0', { search: 'needle', searchMode: 'Substring' }]] }),
  );
  await page.goto(`/rer-duty-neo?state=${state}`);

  const searchButton = page
    .locator('[data-duty-feed-column]')
    .first()
    .getByRole('button', { name: /пошук/i });
  await expect(searchButton).toBeDisabled();
  await searchButton.hover();
  await expect(
    page.getByText('Щоб скористатися пошуком, очистіть фільтр по ключовому слову', {
      exact: true,
    }),
  ).toBeVisible();
  expect(requests.length).toBeGreaterThan(0);
  expect(requests.every((request) => request.search === 'needle')).toBe(true);
  await cpu.detach();
});

for (const width of [1600, 390]) {
  test(`#3571 disables search beneath feed settings at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 950 });
    const groups = width === 1600 ? ['group-1', 'group-2'] : ['group-1'];
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: groups,
      inboxResponse: response([1]),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
    const columns = page.locator('[data-duty-feed-column]');
    const column = columns.first();
    const header = column.locator('[data-duty-feed-header-layout]');
    const search = header.getByRole('button', { name: 'Пошук у стрічці', exact: true });
    const panels = [/^Фільтри/, /^Сповіщення(?: —|$)/, /^Підсвітка$/];
    for (const name of panels) {
      const toggle = header.getByRole('button', { name });
      await toggle.click();
      await expect(toggle).toHaveAttribute('aria-expanded', 'true');
      await expect(search).toBeDisabled();
      await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
      if (width === 1600)
        await expect(
          columns.nth(1).getByRole('button', { name: 'Пошук у стрічці', exact: true }),
        ).toBeEnabled();
      await toggle.click();
      await expect(search).toBeEnabled();
    }
    const query = await openDutySearch(column);
    await query.fill('needle');
    await query.press('Escape');
    for (const name of panels) {
      const toggle = header.getByRole('button', { name });
      await toggle.click();
      await expect(search).toBeDisabled();
      await expect(query).toHaveValue('needle');
      if (name.source === '^Фільтри') {
        const keyword = column.getByRole('combobox', {
          name: 'Фільтр по ключовому слову',
          exact: true,
        });
        await expect(keyword).toBeVisible();
        await keyword.scrollIntoViewIfNeeded();
        await expect(keyword).toBeInViewport();
        expect(
          await keyword.evaluate((input) => {
            const bounds = input.getBoundingClientRect();
            return (
              document.elementFromPoint(bounds.left + 12, bounds.top + bounds.height / 2) === input
            );
          }),
        ).toBe(true);
      }
      await toggle.click();
      await expect(search).toBeEnabled();
      await expect(query).toHaveValue('needle');
    }
    await search.click();
    await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    await cpu.detach();
  });
}

test('#3571 searches independently and lands in the source feed with context @regression', async ({
  page,
}) => {
  const groups = ['group-1', 'group-2'];
  const requests: Array<Record<string, unknown>> = [];
  const navigationRequests: string[] = [];
  page.on('request', (request) => {
    if (
      request.url().endsWith('/inbox-item-context') ||
      (request.url().endsWith('/messages-by-id-matching-filters') &&
        request.postDataJSON().inbox_req?.search == null)
    )
      navigationRequests.push(request.url());
  });
  const targetResponse = responseWithMessages([{ id: 2, text: 'needle match' }]);
  targetResponse.inbox_items[0][1].messageUuid = 'duty-msg-2';
  targetResponse.inbox_items[0][1].groupMasterKey = 'group-1';
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: groups,
    inboxResponseForRequest: (body) => {
      const request = body as Record<string, unknown>;
      requests.push(request);
      if (request.search === 'needle') {
        return targetResponse;
      }
      const group = (request.selected_groups as string[] | null)?.[0];
      return group === 'group-1'
        ? responseWithMessages([
            { id: 1, text: 'before context' },
            { id: 2, text: 'needle match' },
            { id: 3, text: 'after context' },
            { id: 4, text: 'later context 4' },
            { id: 5, text: 'later context 5' },
            { id: 6, text: 'later context 6' },
            { id: 7, text: 'later context 7' },
          ])
        : responseWithMessages([{ id: 11, text: 'sibling message' }]);
    },
  });
  await page.route('**/api/rer-importer/inbox-item-context', (route) =>
    route.fulfill({
      json: {
        message: [2, targetResponse.inbox_items[0][1]],
        group_master_keys: ['group-1'],
        sigint_inbox_item_ids: [2],
        since_ts: null,
        till_ts: null,
      },
    }),
  );
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
  const columns = page.locator('[data-duty-feed-column]');
  await expect(columns).toHaveCount(2);
  await expect(columns.nth(0).locator('[data-duty-message-id]')).toHaveCount(7);
  await expect(columns.nth(1).locator('[data-duty-message-id]')).toHaveCount(1);

  const searchA = await openDutySearch(columns.nth(0));
  await searchA.fill('needle');
  const result = columns.nth(0).getByRole('button', { name: 'needle match', exact: true });
  await expect(result).toBeVisible();
  await columns.nth(0).getByRole('combobox', { name: 'Пошук', exact: true }).press('Escape');
  expect(
    requests.some(
      (request) =>
        request.search === 'needle' &&
        (request.selected_groups as string[] | null)?.includes('group-1'),
    ),
  ).toBe(true);
  const scroller = columns.nth(0).locator('[data-duty-feed-scroller]');
  await page.evaluate(() => document.fonts.ready);
  await expect(scroller).toHaveAttribute('aria-busy', 'false');
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  const scrollSamples = scroller.evaluate(
    (element) =>
      new Promise<number[]>((resolve) => {
        const positions = [element.scrollTop];
        const start = performance.now();
        const sample = () => {
          positions.push(element.scrollTop);
          if (performance.now() - start < 1000) requestAnimationFrame(sample);
          else resolve(positions);
        };
        requestAnimationFrame(sample);
      }),
  );
  await result.click();
  await expect(
    columns
      .nth(0)
      .locator(
        '[data-duty-message-id="2"][data-message-feed-highlighted], [data-duty-message-id="2"] [data-message-feed-highlighted]',
      ),
  ).toHaveCount(1);
  expect(navigationRequests).toEqual([]);
  const positions = await scrollSamples;
  const initial = positions[0];
  const final = positions.at(-1)!;
  expect(Math.abs(initial - final)).toBeGreaterThan(100);
  expect(
    positions.filter(
      (position) => Math.min(Math.abs(position - initial), Math.abs(position - final)) > 3,
    ),
  ).toEqual([]);
  await expect(columns.nth(0).locator('[data-duty-message-id="1"]')).toBeAttached();
  await expect(columns.nth(0).locator('[data-duty-message-id="3"]')).toBeAttached();
  await expect(columns.nth(1).locator('[data-duty-message-id="11"]')).toBeAttached();
  expect(
    requests.some(
      (request) =>
        (request.selected_groups as string[] | null)?.includes('group-1') && request.search == null,
    ),
  ).toBe(true);
  await expect(result).toHaveAttribute('aria-pressed', 'true');
  await columns
    .nth(0)
    .getByRole('button', { name: 'Завантажити нові та перейти вниз', exact: true })
    .click();
  await expect(result).toHaveAttribute('aria-pressed', 'false');
  await expect(searchA).toHaveValue('needle');
  await cpu.detach();
});

for (const width of [1600, 390]) {
  test(`#3571 lands an unloaded 40-day result beyond adaptive history with filtered context at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const now = Date.UTC(2026, 10, 11, 12);
    const targetTime = now - 40 * 24 * 60 * 60 * 1000;
    const adaptiveSince = now - period;
    const groups = ['group-1'];
    const contextRequests: Array<Record<string, unknown>> = [];
    const listRequests: Array<Record<string, unknown>> = [];
    let contextLookups = 0;
    let releaseValidation!: () => void;
    const validationReady = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const messages = [
      [4, 'before historical context', targetTime - 1000, 'group-1', 'sender-a'],
      [5, 'needle 40 days ago', targetTime, 'group-1', 'sender-a'],
      [6, 'after historical context', targetTime + 1000, 'group-1', 'sender-a'],
      [7, 'excluded group context', targetTime + 2000, 'group-2', 'sender-a'],
      [8, 'excluded sender context', targetTime + 3000, 'group-1', 'sender-b'],
      [89, 'recent older', now - 2000, 'group-1', 'sender-a'],
      [90, 'recent newest', now - 1000, 'group-1', 'sender-a'],
    ].map(([id, text, createdAt, groupMasterKey, sender]) => [
      Number(id),
      minimalInboxMessage({
        text: String(text),
        createdAt: Number(createdAt),
        groupMasterKey: String(groupMasterKey),
        sender: String(sender),
      }),
    ]) as InboxMessagesRspRaw['inbox_items'];
    const target = messages.find(([id]) => id === 5)!;
    const matches = (request: Record<string, unknown>, [id, message]: (typeof messages)[number]) =>
      (request.since_date_inclusive_ms == null ||
        message.createdAt >= Number(request.since_date_inclusive_ms)) &&
      (request.till_date_inclusive_ms == null ||
        message.createdAt <= Number(request.till_date_inclusive_ms)) &&
      (request.before_id_noninclusive == null || id < Number(request.before_id_noninclusive)) &&
      (request.since_id_noninclusive == null || id > Number(request.since_id_noninclusive)) &&
      (request.selected_groups == null ||
        (request.selected_groups as string[]).includes(message.groupMasterKey!)) &&
      (request.denied_senders == null ||
        !(request.denied_senders as string[]).includes(message.sender!)) &&
      (request.search == null || message.text?.includes(String(request.search)));
    const reply = (
      rows: typeof messages,
      historySince: number | null = null,
    ): InboxMessagesRspRaw => ({
      ...response(),
      inbox_items: rows,
      history_since_ms: historySince,
      history_period_ms: historySince == null ? null : period,
    });
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: groups,
      inboxCountResponseForRequest: (body) => ({
        quantity: messages.filter((message) => matches(body as Record<string, unknown>, message))
          .length,
        first_element_ts: null,
      }),
      inboxResponseForRequest: (body) => {
        const request = body as Record<string, unknown>;
        listRequests.push(request);
        const adaptive =
          request.load_latest === true &&
          request.before_id_noninclusive == null &&
          request.since_id_noninclusive == null &&
          request.since_date_inclusive_ms == null &&
          request.till_date_inclusive_ms == null;
        return reply(
          messages.filter((message) =>
            matches(
              adaptive ? { ...request, since_date_inclusive_ms: adaptiveSince } : request,
              message,
            ),
          ),
          adaptive ? adaptiveSince : null,
        );
      },
    });
    await page.route('**/api/rer-importer/inbox-item-context', (route) => {
      contextLookups += 1;
      return route.fulfill({
        json: {
          message: target,
          group_master_keys: groups,
          sigint_inbox_item_ids: [5],
          since_ts: null,
          till_ts: null,
        },
      });
    });
    await page.route('**/api/rer-importer/messages-by-id-matching-filters', async (route) => {
      const request = (await route.request().postDataJSON()).inbox_req as Record<string, unknown>;
      if (request.search == null) {
        contextRequests.push(request);
        await validationReady;
      }
      await route.fulfill({ json: { messages: matches(request, target) ? [target] : [] } });
    });
    await page.route('**/api/rer-importer/messages-by-id-with-metadata', async (route) => {
      const request = await route.request().postDataJSON();
      await route.fulfill({
        json: reply(
          messages.filter(
            (message) =>
              request.message_ids.includes(message[0]) &&
              matches(
                {
                  ...request.inbox_req,
                  before_id_noninclusive: null,
                  since_id_noninclusive: null,
                },
                message,
              ),
          ),
        ),
      });
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const state = encodeURIComponent(
      JSON.stringify({
        messageFeeds: [
          [
            'mf-0',
            {
              groupsSelected: groups,
              deniedSenders: ['sender-b'],
            },
          ],
        ],
      }),
    );
    await page.goto(`/rer-duty-neo?state=${state}`);
    const column = page.locator('[data-duty-feed-column]').first();
    await expect(column.locator('[data-duty-message-id]')).toHaveCount(2);
    expect(listRequests[0].load_latest).toBe(true);
    const query = await openDutySearch(column);
    await query.fill('needle');
    const result = column.getByRole('button', { name: 'needle 40 days ago', exact: true });
    await expect(result.locator('[data-duty-search-result-group]')).toHaveText('group-1');
    await expect(result.locator('[data-duty-search-result-sender]')).toHaveText('sender-a');
    await expect(result.locator('strong')).toHaveText('needle');
    await query.press('Escape');
    await result.click();
    await expect.poll(() => contextRequests.length).toBe(1);
    await expect(column.locator('[data-duty-search-panel]').getByRole('progressbar')).toHaveCount(
      0,
    );
    await expect(column.locator('[data-duty-message-id="90"]')).toBeVisible();
    expect(contextLookups).toBe(0);
    releaseValidation();
    await expect(
      column.locator(
        '[data-duty-message-id="5"][data-message-feed-highlighted], [data-duty-message-id="5"] [data-message-feed-highlighted]',
      ),
    ).toHaveCount(1);
    await expect(column.locator('[data-duty-message-id="5"]')).toBeInViewport();
    await expect(column.locator('[data-duty-message-id="4"]')).toBeAttached();
    await expect(column.locator('[data-duty-message-id="6"]')).toBeAttached();
    await expect(
      column.locator('[data-duty-message-id="7"], [data-duty-message-id="8"]'),
    ).toHaveCount(0);
    if (width === 390) await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    else await expect(query).toBeVisible();
    await expect(column.getByRole('progressbar', { name: 'Перехід до повідомлення' })).toHaveCount(
      0,
    );
    expect(contextRequests).toHaveLength(1);
    expect(contextRequests[0]).toMatchObject({
      since_date_inclusive_ms: null,
      selected_groups: groups,
      denied_senders: ['sender-b'],
      search: null,
    });
    const aroundRequests = listRequests.filter(
      (request) => request.before_id_noninclusive === 5 || request.since_id_noninclusive === 5,
    );
    expect(aroundRequests).toHaveLength(2);
    for (const request of aroundRequests)
      expect(request).toMatchObject({
        since_date_inclusive_ms: null,
        selected_groups: groups,
        denied_senders: ['sender-b'],
        search: null,
      });
    if (width === 390) {
      await expect(await openDutySearch(column)).toHaveValue('needle');
      await expect(
        column.getByRole('button', { name: 'needle 40 days ago', exact: true }),
      ).toHaveAttribute('aria-pressed', 'true');
    }
    await cpu.detach();
  });
}

for (const outcome of ['close', 'missing', 'error', 'replace', 'newest'] as const) {
  test(`#3571 clears pending search navigation on ${outcome} without landing a stale result @regression`, async ({
    page,
  }) => {
    const current = responseWithMessages(
      outcome === 'newest'
        ? Array.from({ length: 20 }, (_, index) => ({
            id: index + 10,
            text: index === 1 ? 'needle loaded result' : `current context ${index}`,
          }))
        : [
            { id: 10, text: 'current context' },
            { id: 11, text: 'needle loaded result' },
          ],
    );
    const target = responseWithMessages([{ id: 5, text: 'needle historical result' }]);
    let releaseValidation!: () => void;
    const validationReady = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    const navigationReloads: unknown[] = [];
    let validationRequests = 0;
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: ['group-1'],
      inboxCountResponseForRequest: (body) => ({
        quantity: (body as Record<string, unknown>).search ? 2 : current.inbox_items.length,
        first_element_ts: null,
      }),
      inboxResponseForRequest: (body) => {
        const request = body as Record<string, unknown>;
        if (request.before_id_noninclusive === 5 || request.since_id_noninclusive === 5)
          navigationReloads.push(request);
        return request.search
          ? { ...target, inbox_items: [...target.inbox_items, current.inbox_items[1]] }
          : current;
      },
    });
    await page.route('**/api/rer-importer/messages-by-id-matching-filters', async (route) => {
      const request = route.request().postDataJSON();
      if (request.inbox_req?.search != null)
        return route.fulfill({ json: { messages: target.inbox_items } });
      validationRequests += 1;
      await validationReady;
      if (outcome === 'error')
        return route.fulfill({ status: 500, body: 'Synthetic navigation failure' });
      return route.fulfill({ json: { messages: outcome === 'missing' ? [] : target.inbox_items } });
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`/rer-duty-neo?state=${stateForGroups(['group-1'])}`);
    const column = page.locator('[data-duty-feed-column]').first();
    const query = await openDutySearch(column);
    if (outcome === 'newest') {
      await column.locator('[data-duty-feed-scroller]').evaluate((element) => {
        element.scrollTop = 1000;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
    }
    await query.fill('needle');
    await query.press('Escape');
    await column.getByRole('button', { name: 'needle historical result', exact: true }).click();
    const progress = column.locator('[data-duty-search-panel]').getByRole('progressbar');
    await expect.poll(() => validationRequests).toBe(1);
    await expect(progress).toHaveCount(0);
    const aborted = ['close', 'replace', 'newest'].includes(outcome)
      ? page.waitForEvent('requestfailed', {
          predicate: (request) =>
            request.url().endsWith('/messages-by-id-matching-filters') &&
            request.postDataJSON().inbox_req?.search == null,
        })
      : null;
    if (outcome === 'close')
      await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
    if (outcome === 'replace') {
      await column.getByRole('button', { name: 'needle loaded result', exact: true }).click();
      await expect(
        column.locator('[data-duty-message-id="11"][data-message-feed-highlighted]'),
      ).toHaveCount(1);
    }
    if (outcome === 'newest') {
      await column
        .getByRole('button', { name: 'Завантажити нові та перейти вниз', exact: true })
        .click();
      await expect(
        column.getByRole('button', { name: 'needle historical result', exact: true }),
      ).toHaveAttribute('aria-pressed', 'false');
      await expect(query).toHaveValue('needle');
    }
    if (aborted) await aborted;
    releaseValidation();
    if (outcome === 'missing')
      await expect(
        page.getByText(
          'Повідомлення поза поточними фільтрами. Змініть фільтри, щоб побачити його.',
          { exact: true },
        ),
      ).toBeVisible();
    if (outcome === 'error')
      await expect(
        page.getByText('Не вдалося відкрити повідомлення за посиланням. Спробуйте ще раз.', {
          exact: true,
        }),
      ).toBeVisible();
    await expect(progress).toHaveCount(0);
    await expect(column.locator('[data-duty-message-id="5"]')).toHaveCount(0);
    await expect(
      column.locator('[data-duty-message-id="10"], [data-duty-message-id="11"]'),
    ).toHaveCount(2);
    expect(navigationReloads).toEqual([]);
    await cpu.detach();
  });
}

for (const outcome of ['close', 'replace', 'query'] as const) {
  test(`#3571 cancels an already loading search context on ${outcome} @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 900 });
    const current = responseWithMessages([
      { id: 10, text: 'current context' },
      { id: 11, text: 'needle loaded result' },
    ]);
    const target = responseWithMessages([{ id: 5, text: 'needle historical result' }]);
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let contextRequests = 0;
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      inboxCountResponseForRequest: () => ({ quantity: 2, first_element_ts: null }),
      inboxResponseForRequest: async (body) => {
        const request = body as Record<string, unknown>;
        if (request.search)
          return { ...target, inbox_items: [...target.inbox_items, current.inbox_items[1]] };
        if (request.before_id_noninclusive === 5 || request.since_id_noninclusive === 5) {
          contextRequests += 1;
          await pending;
          return target;
        }
        return current;
      },
    });
    await page.route('**/api/rer-importer/messages-by-id-matching-filters', (route) =>
      route.fulfill({ json: { messages: target.inbox_items } }),
    );
    await page.route('**/api/rer-importer/messages-by-id-with-metadata', async (route) => {
      await pending;
      await route.fulfill({ json: target });
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]').first();
    await expect(column.locator('[data-duty-message-id]')).toHaveCount(2);
    const query = await openDutySearch(column);
    await query.fill('needle');
    await query.press('Escape');
    await column.getByRole('button', { name: 'needle historical result', exact: true }).click();
    await expect.poll(() => contextRequests).toBe(2);
    try {
      if (outcome === 'close')
        await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
      else if (outcome === 'replace')
        await column.getByRole('button', { name: 'needle loaded result', exact: true }).click();
      else await query.fill('different');
      await expect(column.locator('[data-message-feed-skeleton="refresh"]')).toHaveCount(0);
      release();
      await expect(column.locator('[data-duty-message-id="5"]')).toHaveCount(0);
      await expect(column.locator('[data-duty-message-id="10"]')).toBeVisible();
      if (outcome === 'replace') {
        await expect(column.locator('[data-duty-message-id="11"]')).toBeInViewport();
        await expect(
          column.getByRole('button', { name: 'needle loaded result', exact: true }),
        ).toHaveAttribute('aria-pressed', 'true');
      }
    } finally {
      release();
    }
  });
}

test('#3571 keeps search list geometry stable while loading results and older pages @regression', async ({
  page,
}) => {
  let release!: () => void;
  let pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxCountResponseForRequest: () => ({ quantity: 21, first_element_ts: null }),
    inboxResponseForRequest: async (body) => {
      const request = body as Record<string, unknown>;
      if (!request.search) return response([50]);
      await pending;
      return response(
        request.before_id_noninclusive == null ? Array.from({ length: 20 }, (_, i) => 20 - i) : [0],
      );
    },
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  const query = await openDutySearch(column);
  const panel = column.locator('[data-duty-search-panel]');
  const list = panel.locator('[data-duty-search-list]');
  const geometry = () =>
    list.evaluate((n) => {
      const { y, height } = n.getBoundingClientRect();
      return { y, height };
    });
  const initial = await geometry();
  const progress = panel.getByRole('progressbar', { name: 'Завантаження результатів пошуку' });
  await query.fill('needle');
  await query.press('Escape');
  await expect(progress).toBeVisible();
  expect(await geometry()).toEqual(initial);
  release();
  await expect(panel.locator('[data-duty-search-result]')).toHaveCount(20);
  await expect(progress).toHaveCount(0);
  expect(await geometry()).toEqual(initial);
  pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await panel.getByRole('button', { name: 'Завантажити ще результати', exact: true }).click();
  await expect(progress).toBeVisible();
  expect(await geometry()).toEqual(initial);
  release();
  await expect(panel.locator('[data-duty-search-result]')).toHaveCount(21);
  await expect(progress).toHaveCount(0);
  expect(await geometry()).toEqual(initial);
});

test('#3571 refreshes only on inbox updates and reports search failures in a snackbar @regression', async ({
  page,
}) => {
  let searchRequests = 0;
  let failSearch = false;
  let showNewMessage = false;
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    inboxCountResponseForRequest: (body) => ({
      quantity: (body as Record<string, unknown>).search ? (showNewMessage ? 2 : 1) : 0,
      first_element_ts: null,
    }),
    inboxResponseForRequest: (body) => {
      if ((body as Record<string, unknown>).search) {
        searchRequests += 1;
        return responseWithMessages([
          { id: 1, text: 'needle original' },
          ...(showNewMessage ? [{ id: 2, text: 'needle new message' }] : []),
        ]);
      }
      return response([1]);
    },
  });
  await page.route('**/api/rer-importer/get-inbox', async (route) => {
    if (route.request().postDataJSON().search && failSearch) {
      await route.fulfill({ status: 503, json: 'Search unavailable' });
    } else await route.fallback();
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  const query = await openDutySearch(column);
  await query.fill('needle');
  await query.press('Escape');
  const panel = column.locator('[data-duty-search-panel]');
  await expect(panel.getByRole('button', { name: 'needle original', exact: true })).toBeVisible();
  await expect(panel.getByText('Вся доступна історія', { exact: true })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: /^Інтервал:/ })).toHaveCount(0);
  const requestsBeforeIdle = searchRequests;
  await page.clock.install();
  await page.clock.runFor(10000);
  expect(searchRequests).toBe(requestsBeforeIdle);
  await expect(panel.getByRole('progressbar')).toHaveCount(0);
  await page.clock.resume();

  failSearch = true;
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: { messageIds: [2] } })),
  );
  const error = page.getByRole('alert').filter({ hasText: 'Не вдалося оновити результати пошуку' });
  await expect(error).toBeVisible();
  await expect(panel.getByRole('alert')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'needle original', exact: true })).toBeVisible();
  await expect(panel.getByRole('progressbar')).toHaveCount(0);

  failSearch = false;
  showNewMessage = true;
  await error.getByRole('button', { name: 'Повторити', exact: true }).click();
  await expect.poll(() => searchRequests).toBeGreaterThan(requestsBeforeIdle);
  await expect(
    panel.getByRole('button', { name: 'needle new message', exact: true }),
  ).toBeVisible();
  expect(searchRequests).toBeGreaterThan(requestsBeforeIdle);
  await cpu.detach();
});

for (const width of [1600, 390]) {
  test(`#3571 offers Analysis-style search modes in a dropdown at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const requests: Array<Record<string, unknown>> = [];
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      inboxResponseForRequest: (body) => {
        const request = body as Record<string, unknown>;
        requests.push(request);
        return responseWithMessages([{ id: 1, text: 'needle match' }]);
      },
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]').first();
    const query = await openDutySearch(column);
    await query.fill('needle');
    await expect(column.getByRole('button', { name: 'needle match', exact: true })).toBeVisible();
    const options = page.getByRole('listbox', { name: 'Режим пошуку' });
    await expect(options).toBeVisible();
    if (width === 390) {
      await query.dispatchEvent('keydown', {
        key: 'Enter',
        keyCode: 229,
        which: 229,
        isComposing: true,
      });
      await expect(query).toBeFocused();
      await expect(options).toBeVisible();
    }
    await query.press('Enter');
    if (width === 390) await expect(query).not.toBeFocused();
    else await expect(query).toBeFocused();
    await expect(query).toHaveValue('needle');
    await expect(column.locator('[data-duty-search-panel]')).toBeVisible();
    await expect(options).toHaveCount(0);
    await query.press('ArrowDown');
    await expect(options).toBeVisible();
    await options.getByRole('option', { name: /Точний збіг/ }).click();
    await expect(options).toHaveCount(0);
    await expect
      .poll(() =>
        requests.some((request) => request.search === 'needle' && request.search_mode === 'Exact'),
      )
      .toBe(true);
    await query.press('ArrowUp');
    await expect(options).toBeVisible();
    await query.press('ArrowUp');
    await expect(query).toHaveAttribute(
      'aria-activedescendant',
      (await options.getByRole('option', { name: /Збіг за входженням/ }).getAttribute('id'))!,
    );
    await query.press('Enter');
    if (width === 390) await expect(query).not.toBeFocused();
    else await expect(query).toBeFocused();
    await expect(query).toHaveValue('needle');
    await expect
      .poll(() =>
        requests.some(
          (request) => request.search === 'needle' && request.search_mode === 'Substring',
        ),
      )
      .toBe(true);
    await expect(
      column.getByRole('button', { name: 'Довідка про пошук', exact: true }),
    ).toHaveCount(0);
    await expect(page.getByText('Пошук працює в 3 режимах.', { exact: false })).toHaveCount(0);
    await query.press('ArrowDown');
    await expect(options.getByRole('option')).toHaveCount(3);
    const help = page.getByRole('button', { name: 'Як працює пошук', exact: true });
    await query.press('Tab');
    await expect(help).toBeFocused();
    await help.press('Shift+Tab');
    await expect(query).toBeFocused();
    await query.press('Tab');
    await expect(help).toBeFocused();
    await help.press('Enter');
    await expect(page.getByText('Пошук працює в 3 режимах.', { exact: false })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Точний збіг', exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(query).toBeFocused();
    await expect(column.locator('[data-duty-search-panel]')).toBeVisible();
    await query.press('ArrowDown');
    await help.click();
    await expect(page.getByText('Пошук працює в 3 режимах.', { exact: false })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(query).toBeFocused();
    await query.press('ArrowDown');
    await query.press('Tab');
    await expect(help).toBeFocused();
    await help.press('Tab');
    await expect(options).toHaveCount(0);
    await expect(column.getByRole('button', { name: 'Очистити пошук', exact: true })).toBeFocused();
    await query.focus();
    await query.press('ArrowDown');
    await expect(options).toBeVisible();
    await query.press('Tab');
    await expect(help).toBeFocused();
    await help.press('Escape');
    await expect(query).toBeFocused();
    await expect(options).toHaveCount(0);
    await expect(column.locator('[data-duty-search-panel]')).toBeVisible();
    await query.press('Escape');
    await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    await expect(
      column.getByRole('button', { name: 'Пошук у стрічці', exact: true }),
    ).toBeFocused();
    await cpu.detach();
  });
}

test('#3571 preserves one panel and per-feed query when switching A to B and back @regression', async ({
  page,
}) => {
  const groups = ['group-1', 'group-2'];
  const requests: Array<Record<string, unknown>> = [];
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: groups,
    inboxResponseForRequest: (body) => {
      const request = body as Record<string, unknown>;
      requests.push(request);
      return request.search
        ? responseWithMessages([{ id: 90, text: `${request.search} match` }])
        : responseWithMessages([{ id: 1, text: 'feed message' }]);
    },
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
  const columns = page.locator('[data-duty-feed-column]');
  await expect(columns).toHaveCount(2);

  const searchA = await openDutySearch(columns.nth(0));
  await searchA.fill('alpha');
  await expect(
    columns.nth(0).getByRole('button', { name: 'alpha match', exact: true }),
  ).toBeVisible();
  const alphaSearches = requests.filter((request) => request.search === 'alpha').length;
  await columns.nth(1).getByRole('button', { name: /пошук/i }).click();
  await expect(searchA).toHaveCount(0);
  const searchB = columns.nth(1).getByRole('combobox', { name: /пошук/i });
  await expect(searchB).toBeVisible();
  await searchB.fill('bravo');
  await expect(
    columns.nth(1).getByRole('button', { name: 'bravo match', exact: true }),
  ).toBeVisible();
  expect(requests.filter((request) => request.search === 'alpha')).toHaveLength(alphaSearches);

  await columns.nth(1).getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
  await columns.nth(0).getByRole('button', { name: /пошук/i }).click();
  await expect(columns.nth(0).getByRole('combobox', { name: /пошук/i })).toHaveValue('alpha');
  await expect(
    columns.nth(0).getByRole('button', { name: 'alpha match', exact: true }),
  ).toBeVisible();
  await expect(columns.nth(1).getByRole('combobox', { name: /пошук/i })).toHaveCount(0);
  await cpu.detach();
});

for (const width of [1600, 390]) {
  test(`#3571 switches groups and search without losing reading state at ${width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      disableAutoScroll: true,
      signalGroups: ['group-1', 'group-2'],
      inboxResponseForRequest: (body) => {
        const request = body as Record<string, unknown>;
        const group = (request.selected_groups as string[] | null)?.[0] ?? 'group-1';
        return responseWithMessages(
          Array.from({ length: 20 }, (_, index) => ({
            id: (group === 'group-2' ? 100 : 0) + index + 1,
            text: `${request.search ? 'needle' : 'feed'} ${group} ${index + 1}`,
          })),
        );
      },
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]').first();
    const scroller = column.locator('[data-duty-feed-scroller="true"]');
    await expect(column.locator('[data-duty-message-id]')).toHaveCount(20);
    await scroller.evaluate((element) => {
      element.scrollTop = 300;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    expect(await scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
    const readingOffset = () =>
      column.locator('[data-duty-message-id="1"]').evaluate((element) => {
        const scroller = element.closest('[data-duty-feed-scroller="true"]')!;
        return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      });
    const initialReadingOffset = await readingOffset();
    const groupsTrigger = column.getByRole('button', { name: 'Розгорнути список груп' });
    const searchTrigger = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
    const groups = column.locator('[data-group-panel]');
    const panel = column.locator('[data-duty-search-panel]');
    await groupsTrigger.click();
    await expect(groups).toBeVisible();
    await searchTrigger.focus();
    await searchTrigger.press('Enter');
    await expect(groups).toHaveCount(0);
    const query = column.getByRole('combobox', { name: 'Пошук', exact: true });
    await expect(query).toBeFocused();
    await query.fill('needle');
    await expect(panel.locator('[data-duty-search-result]')).toHaveCount(20);
    await query.press('Escape');
    const results = panel.locator('[data-duty-search-list]');
    await results.evaluate((element) => {
      element.scrollTop = 300;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const resultsTop = await results.evaluate((element) => element.scrollTop);
    expect(resultsTop).toBeGreaterThan(0);
    await groupsTrigger.click();
    await expect(panel).toHaveCount(0);
    await expect(groups).toBeVisible();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    await expect(groups.locator('[aria-current="true"]')).toBeFocused();
    await expect
      .poll(async () => Math.abs((await readingOffset()) - initialReadingOffset))
      .toBeLessThanOrEqual(1);
    await page.keyboard.press('Escape');
    await expect(groups).toHaveCount(0);
    await expect(groupsTrigger).toBeFocused();
    await expect(panel).toHaveCount(0);
    await searchTrigger.press('Enter');
    await expect(query).toHaveValue('needle');
    await expect(panel.locator('[data-duty-search-result]')).toHaveCount(20);
    await expect
      .poll(() => results.evaluate((element) => element.scrollTop))
      .toBeCloseTo(resultsTop, 0);
    await expect
      .poll(async () => Math.abs((await readingOffset()) - initialReadingOffset))
      .toBeLessThanOrEqual(1);
    await groupsTrigger.click();
    await groups.getByRole('button', { name: 'group-2', exact: true }).click();
    await expect(groups).toHaveCount(0);
    await expect(panel).toHaveCount(0);
    await searchTrigger.press('Enter');
    await expect(query).toHaveValue('needle');
    await expect(
      panel.getByRole('button', { name: 'needle group-2 1', exact: true }),
    ).toBeVisible();
    await expect(panel.getByRole('button', { name: /^needle group-1/ })).toHaveCount(0);
    await query.press('Escape');
    await expect(panel).toHaveCount(0);
    await expect(searchTrigger).toBeFocused();
    await cpu.detach();
  });
}

test('#3571 keeps groups and search independent across columns @regression', async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: ['group-1', 'group-2'],
    inboxResponse: response([1]),
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const state = encodeURIComponent(
    JSON.stringify({
      messageFeeds: [
        ['mf-0', {}],
        ['mf-1', {}],
      ],
    }),
  );
  await page.goto(`/rer-duty-neo?state=${state}`);
  const columns = page.locator('[data-duty-feed-column]');
  await expect(columns).toHaveCount(2);
  await openDutySearch(columns.nth(0));
  await columns.nth(1).getByRole('button', { name: 'Розгорнути список груп' }).click();
  await expect(columns.nth(1).locator('[data-group-panel]')).toBeVisible();
  await expect(columns.nth(0).locator('[data-duty-search-panel]')).toBeVisible();
  const searchB = columns.nth(1).getByRole('button', { name: 'Пошук у стрічці', exact: true });
  await searchB.focus();
  await searchB.press('Enter');
  await expect(columns.nth(1).locator('[data-group-panel]')).toHaveCount(0);
  await expect(columns.nth(1).getByRole('combobox', { name: 'Пошук', exact: true })).toBeFocused();
  await expect(columns.nth(0).locator('[data-duty-search-panel]')).toHaveCount(0);
  await columns.nth(0).getByRole('button', { name: 'Розгорнути список груп' }).click();
  await expect(columns.nth(0).locator('[data-group-panel]')).toBeVisible();
  await expect(columns.nth(1).locator('[data-duty-search-panel]')).toBeVisible();
  await cpu.detach();
});

test('#3571 expands only one of four feeds while keeping feed scroll stable @regression', async ({
  page,
}) => {
  const groups = ['group-1', 'group-2', 'group-3', 'group-4'];
  await page.setViewportSize({ width: 1600, height: 1000 });
  await installRerDutyShortStateMocks(page, {
    enableDutySearch: true,
    signalGroups: groups,
    inboxResponseForRequest: (body) => {
      const request = body as Record<string, unknown>;
      return request.search
        ? responseWithMessages([{ id: 200, text: 'needle match' }])
        : response(Array.from({ length: 20 }, (_, index) => index + 1));
    },
  });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
  const columns = page.locator('[data-duty-feed-column]');
  await expect(columns).toHaveCount(4);
  const scroller = columns.first().locator('[data-duty-feed-scroller="true"]');
  await scroller.evaluate((element) => {
    element.scrollTop = 600;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
  const initialScrollTop = await scroller.evaluate((element) => element.scrollTop);
  const initialWidths = await columns.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );

  const query = await openDutySearch(columns.first());
  await query.fill('needle');
  await expect(
    columns.first().getByRole('button', { name: 'needle match', exact: true }),
  ).toBeVisible();
  const expandedWidths = await columns.evaluateAll((elements) =>
    elements.map((element) => element.getBoundingClientRect().width),
  );
  expect(expandedWidths[0]).toBeGreaterThan(initialWidths[0]);
  const geometry = await columns.first().evaluate((column) => {
    const rect = (selector: string) => {
      const bounds = column.querySelector(selector)!.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    };
    return {
      column: column.getBoundingClientRect().toJSON(),
      panel: rect('[data-duty-search-panel]'),
      feed: rect('[data-duty-feed-main]'),
      header: rect('[data-duty-feed-header-layout]'),
    };
  });
  expect(geometry.panel.right).toBeLessThanOrEqual(geometry.feed.left + 1);
  expect(Math.abs(geometry.header.left - geometry.column.left)).toBeLessThanOrEqual(1);
  expect(Math.abs(geometry.header.right - geometry.column.right)).toBeLessThanOrEqual(1);
  expect(geometry.panel.top).toBeGreaterThanOrEqual(geometry.header.bottom);
  for (let index = 1; index < 4; index += 1) {
    expect(Math.abs(expandedWidths[index] - initialWidths[index])).toBeLessThanOrEqual(1);
  }
  const hasHorizontalOverflow = await columns.first().evaluate((column) => {
    for (
      let element: HTMLElement | null = column as HTMLElement;
      element;
      element = element.parentElement
    ) {
      if (element.scrollWidth > element.clientWidth) return true;
    }
    return false;
  });
  expect(hasHorizontalOverflow).toBe(true);
  await expect
    .poll(() =>
      scroller.evaluate(
        (element, initialTop) => Math.abs(element.scrollTop - initialTop),
        initialScrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  await cpu.detach();
});

for (const count of [2, 4]) {
  test(`#3571 expands later search columns to the right without moving earlier columns (${count} feeds) @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const groups = Array.from({ length: count }, (_, index) => `group-${index + 1}`);
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      signalGroups: groups,
      inboxResponse: response([1, 2, 3]),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await page.goto(`/rer-duty-neo?state=${stateForGroups(groups)}`);
    const columns = page.locator('[data-duty-feed-column]');
    await expect(columns).toHaveCount(count);
    const geometry = () =>
      columns.evaluateAll((elements) =>
        elements.map((column) => ({
          column: column.getBoundingClientRect().toJSON(),
          feed: column.querySelector('[data-duty-feed-main]')!.getBoundingClientRect().toJSON(),
        })),
      );
    const initial = await geometry();
    for (let index = 1; index < count; index++) {
      const column = columns.nth(index);
      const query = await openDutySearch(column);
      await expect(query).toBeFocused();
      await column.evaluate(async (column) => {
        await Promise.all(
          column.getAnimations().map((animation) => animation.finished.catch(() => {})),
        );
      });
      await page.screenshot({ path: test.info().outputPath(`expanded-column-${index + 1}.png`) });
      const expanded = await geometry();
      expect(
        Math.abs(expanded[index].column.left - initial[index].column.left),
      ).toBeLessThanOrEqual(1);
      expect(expanded[index].column.right - initial[index].column.right).toBeGreaterThan(260);
      for (let previous = 0; previous < index; previous++) {
        expect(
          Math.abs(expanded[previous].column.left - initial[previous].column.left),
        ).toBeLessThanOrEqual(1);
      }
      for (let sibling = 0; sibling < count; sibling++) {
        expect(
          Math.abs(expanded[sibling].feed.width - initial[sibling].feed.width),
        ).toBeLessThanOrEqual(1);
      }
      await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
      await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    }
    await cpu.detach();
  });
}

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
    await expect(
      page.getByRole('combobox', { name: 'Фільтр по ключовому слову', exact: true }),
    ).toHaveCount(enabled ? 1 : 0);
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
  const search = panel.getByRole('combobox', {
    name: 'Фільтр по ключовому слову',
    exact: true,
  });
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
