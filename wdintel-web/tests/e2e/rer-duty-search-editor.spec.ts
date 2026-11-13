import { expect, test, type Locator } from '@playwright/test';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';

async function assertContained(column: Locator, workspace: Locator) {
  const viewport = await workspace.boundingBox();
  for (const item of [
    column,
    column.locator('[data-duty-feed-header-variant]'),
    column.locator('[data-duty-feed-main]'),
  ]) {
    const box = await item.boundingBox();
    if (!box) continue;
    expect(box.x).toBeGreaterThanOrEqual(viewport!.x - 1);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport!.x + viewport!.width + 1);
  }
}

for (const scenario of [
  { width: 1920, feeds: 1, visible: 1, search: true, manualClose: false },
  { width: 2560, feeds: 2, visible: 2, search: true, manualClose: false },
  { width: 1600, feeds: 2, visible: 2, search: false, manualClose: false },
  { width: 1280, feeds: 4, visible: 1, search: false, manualClose: false },
  { width: 1280, feeds: 1, visible: 1, search: false, manualClose: true },
]) {
  test(`#3571 fits search and editor with ${scenario.feeds} feeds at ${scenario.width}px @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: scenario.width, height: 1000 });
    const inbox: InboxMessagesRspRaw = {
      inbox_items: Array.from(
        { length: 20 },
        (_, index): InboxMessagesRspRaw['inbox_items'][number] => [
          index + 1,
          minimalInboxMessage({
            text: `needle ${index + 1}`,
            createdAt: 1792000000000 + index * 1000,
            createdAtOrder: (1792000000000 + index * 1000) * 1000,
          }),
        ],
      ),
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
      page_limit: 20,
    };
    await installRerDutyShortStateMocks(page, {
      enableDutySearch: true,
      inboxResponseForRequest: (body) => {
        const request = body as Record<string, unknown>;
        return {
          ...inbox,
          inbox_items:
            request.search ||
            (request.before_id_noninclusive == null && request.since_id_noninclusive == null)
              ? inbox.inbox_items
              : [],
        };
      },
      inboxCountResponseForRequest: () => ({ quantity: 20, first_element_ts: null }),
    });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const state = encodeURIComponent(
      JSON.stringify({
        messageFeeds: Array.from({ length: scenario.feeds }, (_, index) => [`mf-${index}`, {}]),
      }),
    );
    await page.goto(`/rer-duty-neo?state=${state}`);
    const columns = page.locator('[data-duty-feed-column]');
    await expect(columns).toHaveCount(scenario.feeds);
    let column = columns.first();
    await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
    let query = column.getByRole('combobox', { name: /пошук/i });
    await query.fill('needle');
    await query.press('Escape');
    await expect(column.locator('[data-duty-search-result]')).toHaveCount(20);
    await column.locator('[data-duty-search-list]').evaluate((element) => {
      element.scrollTop = 240;
      element.dispatchEvent(new Event('scroll'));
    });
    const listTop = await column
      .locator('[data-duty-search-list]')
      .evaluate((element) => element.scrollTop);
    await column.hover();
    await column.getByRole('button', { name: 'Додати повідомлення', exact: true }).click();
    const editor = page.getByRole('complementary', { name: 'Створити повідомлення', exact: true });
    await expect(editor).toBeVisible();
    await expect(columns).toHaveCount(scenario.visible);
    column = columns.first();
    const workspace = page.locator('[data-duty-workspace-main]');
    await expect
      .poll(async () => {
        const [box, area] = await Promise.all([column.boundingBox(), workspace.boundingBox()]);
        return box!.x >= area!.x - 1 && box!.x + box!.width <= area!.x + area!.width + 1;
      })
      .toBe(true);
    for (const feed of await columns.all()) await assertContained(feed, workspace);
    const panel = column.locator('[data-duty-search-panel]');
    if (scenario.search) await expect(panel).toBeVisible();
    else {
      await expect(panel).toHaveCount(0);
      await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
      query = column.getByRole('combobox', { name: /пошук/i });
      await expect(query).toHaveValue('needle');
      await expect(panel).toBeVisible();
      await expect
        .poll(() =>
          column.locator('[data-duty-search-list]').evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(listTop, 0);
      await expect
        .poll(async () => {
          const [searchBox, feedBox] = await Promise.all([
            panel.boundingBox(),
            column.boundingBox(),
          ]);
          return Math.abs(searchBox!.width - feedBox!.width);
        })
        .toBeLessThan(2);
      await expect(columns).toHaveCount(scenario.visible);
      const text = editor.getByRole('textbox', { name: 'Текст повідомлення', exact: true });
      await text.fill('Збережена чернетка');
      await column.getByRole('button', { name: 'needle 19', exact: true }).click();
      await expect(panel).toHaveCount(0);
      await expect(column.locator('[data-duty-message-id="19"]')).toBeInViewport();
      await expect(text).toHaveValue('Збережена чернетка');
      if (scenario.visible < scenario.feeds) {
        await page.getByRole('tab', { name: 'Стрічка 2', exact: true }).click();
        await expect(text).toHaveValue('Збережена чернетка');
        await page.getByRole('tab', { name: 'Стрічка 1', exact: true }).click();
      }
      await text.fill('');
    }
    if (scenario.manualClose) {
      await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
      await expect(column.getByRole('combobox', { name: /пошук/i })).toHaveValue('needle');
      await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
      await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    }
    await page.screenshot({ path: test.info().outputPath('editor-search.png') });
    await editor.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(editor).toHaveCount(0);
    await expect(columns).toHaveCount(scenario.feeds);
    if (scenario.manualClose) {
      await expect(columns.first().getByRole('combobox', { name: /пошук/i })).toHaveCount(0);
      await columns.first().getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
    }
    await expect(columns.first().getByRole('combobox', { name: /пошук/i })).toHaveValue('needle');
    if (scenario.search)
      await expect
        .poll(() =>
          columns
            .first()
            .locator('[data-duty-search-list]')
            .evaluate((element) => element.scrollTop),
        )
        .toBeCloseTo(listTop, 0);
    await cpu.detach();
  });
}

test('#3571 places mobile search after highlighting without changing desktop order @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await installRerDutyShortStateMocks(page, { enableDutySearch: true });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]').first();
  const search = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
  const highlight = column.getByRole('button', { name: 'Підсвітка', exact: true });
  await expect(search).toBeVisible();
  expect((await search.boundingBox())!.x).toBeGreaterThan((await highlight.boundingBox())!.x);
  await search.click();
  await expect(column.getByRole('combobox', { name: /пошук/i })).toBeFocused();
  await page.screenshot({ path: test.info().outputPath('mobile-search.png') });
  await page.setViewportSize({ width: 1600, height: 900 });
  await expect
    .poll(async () => (await search.boundingBox())!.x < (await highlight.boundingBox())!.x)
    .toBe(true);
  await cpu.detach();
});

test('#3571 resizes an open single-feed search across desktop and mobile without clipping @regression', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1920, height: 900 });
  await installRerDutyShortStateMocks(page, { enableDutySearch: true });
  const cpu = await page.context().newCDPSession(page);
  await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await page.goto('/rer-duty-neo');
  const column = page.locator('[data-duty-feed-column]');
  await column.getByRole('button', { name: 'Пошук у стрічці', exact: true }).click();
  const query = column.getByRole('combobox', { name: /пошук/i });
  await query.fill('збережений запит');
  await query.press('Escape');
  const workspace = page.locator('[data-duty-workspace-main]');
  for (const width of [1280, 1140, 1040, 1025, 1023, 800, 390, 1140, 1920]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(query).toHaveValue('збережений запит');
    await expect
      .poll(async () => {
        const [box, area] = await Promise.all([column.boundingBox(), workspace.boundingBox()]);
        return box!.x >= area!.x - 1 && box!.x + box!.width <= area!.x + area!.width + 1;
      })
      .toBe(true);
    await assertContained(column, workspace);
    if (width < 1024) {
      const [panel, feed] = await Promise.all([
        column.locator('[data-duty-search-panel]').boundingBox(),
        column.boundingBox(),
      ]);
      expect(Math.abs(panel!.width - feed!.width)).toBeLessThan(2);
    }
  }
  await cpu.detach();
});

for (const { feedCount, reducedMotion } of [
  { feedCount: 1, reducedMotion: 'no-preference' },
  { feedCount: 1, reducedMotion: 'reduce' },
  { feedCount: 2, reducedMotion: 'no-preference' },
] as const) {
  test(`#3571 animates search geometry inside the editor with ${feedCount} feeds and ${reducedMotion} motion @regression`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: feedCount === 1 ? 1920 : 2560, height: 900 });
    await page.emulateMedia({ reducedMotion });
    await installRerDutyShortStateMocks(page, { enableDutySearch: true });
    const cpu = await page.context().newCDPSession(page);
    await cpu.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const state = encodeURIComponent(
      JSON.stringify({
        messageFeeds: Array.from({ length: feedCount }, (_, index) => [`mf-${index}`, {}]),
      }),
    );
    await page.goto(`/rer-duty-neo?state=${state}`);
    const columns = page.locator('[data-duty-feed-column]');
    const column = columns.first();
    await column.getByRole('button', { name: 'Додати повідомлення', exact: true }).click();
    await expect(page.locator('[data-manage-message-presentation="embedded"]')).toBeVisible();
    await page.locator('[data-duty-editor-layout]').evaluate(async (element) => {
      await Promise.all(
        element.getAnimations().map((animation) => animation.finished.catch(() => {})),
      );
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
    });
    const main = column.locator('[data-duty-feed-main]');
    const closedWidth = (await main.boundingBox())!.width;
    const trigger = column.getByRole('button', { name: 'Пошук у стрічці', exact: true });
    for (const direction of ['opening', 'closing']) {
      if (reducedMotion === 'no-preference')
        await column.evaluate((element, direction) => {
          const observer = new MutationObserver(() => {
            const main = element.querySelector('[data-duty-feed-main]')!;
            if (
              !main
                .getAnimations()
                .some((animation) =>
                  (animation.effect as KeyframeEffect)
                    .getKeyframes()
                    .some((frame) => frame.width != null),
                )
            )
              return;
            observer.disconnect();
            const targets = Array.from(
              element.parentElement!.querySelectorAll('[data-duty-feed-column]'),
            ).flatMap((column) => [
              column,
              column.querySelector('[data-duty-feed-main]'),
              column.querySelector('[data-duty-search-panel]')?.parentElement,
            ]);
            for (const target of targets)
              for (const animation of target?.getAnimations() ?? []) {
                animation.pause();
                animation.currentTime = Number(animation.effect!.getTiming().duration) / 2;
              }
            element.setAttribute('data-editor-search-sampled', direction);
          });
          observer.observe(element, {
            attributes: true,
            subtree: true,
            childList: true,
            attributeFilter: ['aria-expanded'],
          });
        }, direction);
      await trigger.evaluate((button: HTMLButtonElement) => button.click());
      if (reducedMotion === 'no-preference') {
        await expect(column).toHaveAttribute('data-editor-search-sampled', direction);
        const geometry = await column.evaluate((element) => {
          const main = element.querySelector('[data-duty-feed-main]')!.getBoundingClientRect();
          const panel = element
            .querySelector('[data-duty-search-panel]')!
            .parentElement!.getBoundingClientRect();
          const column = element.getBoundingClientRect();
          return {
            width: main.width,
            offset: main.left - column.left,
            right: main.right,
            columnRight: column.right,
            panelRight: panel.right,
            mainLeft: main.left,
          };
        });
        expect(geometry.width).toBeLessThan(closedWidth - 1);
        expect(geometry.width).toBeGreaterThan(closedWidth - 269);
        expect(geometry.offset).toBeGreaterThan(1);
        expect(geometry.offset).toBeLessThan(269);
        expect(geometry.right).toBeLessThanOrEqual(geometry.columnRight + 1);
        expect(geometry.panelRight).toBeLessThanOrEqual(geometry.mainLeft + 1);
        await assertContained(column, page.locator('[data-duty-workspace-main]'));
        if (feedCount > 1) {
          const [last, workspace] = await Promise.all([
            columns.last().boundingBox(),
            page.locator('[data-duty-workspace-main]').boundingBox(),
          ]);
          expect(Math.abs(last!.x + last!.width - workspace!.x - workspace!.width)).toBeLessThan(2);
          await assertContained(columns.last(), page.locator('[data-duty-workspace-main]'));
        }
        await page.screenshot({ path: test.info().outputPath(`${direction}-midpoint.png`) });
        await column.evaluate(async (element) => {
          const targets = Array.from(
            element.parentElement!.querySelectorAll('[data-duty-feed-column]'),
          ).flatMap((column) => [
            column,
            column.querySelector('[data-duty-feed-main]'),
            column.querySelector('[data-duty-search-panel]')?.parentElement,
          ]);
          await Promise.all(
            targets
              .flatMap((target) => target?.getAnimations() ?? [])
              .map((animation) => {
                animation.play();
                return animation.finished.catch(() => {});
              }),
          );
        });
      } else {
        expect(
          await column.evaluate(
            (element) =>
              element
                .getAnimations({ subtree: true })
                .filter((animation) => animation.playState === 'running').length,
          ),
        ).toBe(0);
      }
      await expect(trigger).toHaveAttribute('aria-expanded', String(direction === 'opening'));
    }
    await expect(column.locator('[data-duty-search-panel]')).toHaveCount(0);
    await cpu.detach();
  });
}
