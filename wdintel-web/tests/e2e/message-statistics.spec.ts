import { expect, test, type Page, type Locator } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

async function boundingBox(
  locator: Locator,
): Promise<NonNullable<Awaited<ReturnType<Locator['boundingBox']>>>> {
  let bounds: Awaited<ReturnType<Locator['boundingBox']>> = null;
  await expect
    .poll(async () => {
      bounds = await locator.boundingBox();
      return bounds;
    })
    .not.toBeNull();
  return bounds!;
}

type StatsRequest = {
  from_date: string;
  to_date: string;
  grouping: 'Groups' | 'Senders';
  selected_groups: string[] | null;
  selected_senders: Array<{ sender: string | null }> | null;
  selected_unit_ids: number[] | null;
  cursor: string | null;
  user_label_id: number | null;
};
const hierarchy = {
  revision: '3873',
  groups: [
    { id: 'group:2:army', label: 'Army', level: 2, parent_index: null },
    { id: 'group:2:army|3:child', label: 'Child', level: 3, parent_index: 0 },
  ],
  units: [
    { id: 10, name: 'Army', group_index: 0 },
    { id: 11, name: 'Child', group_index: 1 },
  ],
};
function dates(from: string, to: string) {
  const result: string[] = [];
  for (
    let date = new Date(`${from}T00:00:00Z`);
    date.toISOString().slice(0, 10) <= to;
    date.setUTCDate(date.getUTCDate() + 1)
  )
    result.push(date.toISOString().slice(0, 10));
  return result;
}
async function install(page: Page) {
  await page.clock.install({ time: new Date('2026-11-11T12:00:00Z') });
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer'] });
  const requests: StatsRequest[] = [];
  let status = 200;
  let dataKind: 'normal' | 'zero' | 'empty' | 'low' = 'normal';
  let pendingStats: Promise<void> | null = null;
  const catalogs: unknown[] = [];
  const facets: Array<{
    facet: 'Groups' | 'Units';
    filter: StatsRequest;
    include_children: boolean;
  }> = [];
  const senders: Array<{ filter: StatsRequest; search: string | null; cursor: string | null }> = [];
  let accessRevision = 'access-a';
  let senderLabel = 'Sender A';
  let panels = [
    { label_id: -1, name: 'Без лейбла', color: '#87d7f1', organism_name: null as string | null },
  ];
  await page.route('**/api/rer/analysis/stats/daily-messages/panels', (route) =>
    route.fulfill({ json: { access_revision: accessRevision, panels } }),
  );
  await page.route('**/api/rer/analysis/stats/daily-messages/catalog', (route) => {
    const body = route.request().postDataJSON();
    catalogs.push(body);
    return route.fulfill({
      json: {
        access_revision: accessRevision,
        groups:
          accessRevision === 'access-a'
            ? [
                { key: 'group-a', label: 'Alpha' },
                { key: 'group-b', label: 'Beta' },
              ]
            : [{ key: 'group-b', label: 'Beta' }],
        unit_hierarchy: body.known_hierarchy_revision === hierarchy.revision ? null : hierarchy,
        sender_labels: body.selected_senders.map((entry: { sender: string | null }) => ({
          key: entry.sender,
          label: entry.sender === null ? 'Невідомий відправник' : senderLabel,
        })),
      },
    });
  });
  await page.route('**/api/rer/analysis/stats/daily-messages/facet-counts', (route) => {
    const body = route.request().postDataJSON();
    facets.push(body);
    return route.fulfill({
      json: {
        access_revision: accessRevision,
        hierarchy_revision: body.facet === 'Units' ? hierarchy.revision : null,
        generated_at_ms: Date.now(),
        counts:
          body.facet === 'Groups'
            ? [
                { value: 'group-a', count: 84 },
                { value: 'group-b', count: 42 },
              ]
            : [
                { value: 'unit-id:10', count: body.include_children === false ? 12 : 24 },
                { value: 'unit-id:11', count: 12 },
                { value: 'unit-id:0', count: 3 },
              ],
      },
    });
  });
  await page.route('**/api/rer/analysis/stats/daily-messages/senders', (route) => {
    senders.push(route.request().postDataJSON());
    return route.fulfill({
      json: {
        access_revision: accessRevision,
        generated_at_ms: Date.now(),
        next_cursor: null,
        total: 2,
        options: [
          { key: 'sender-a', label: 'Sender A' },
          { key: null, label: 'Невідомий відправник' },
        ],
      },
    });
  });
  await page.route('**/api/rer/analysis/stats/daily-messages', async (route) => {
    const req = route.request().postDataJSON() as StatsRequest;
    requests.push(req);
    if (pendingStats) await pendingStats;
    if (status !== 200)
      return route.fulfill({ status, json: { message: 'Статистика недоступна' } });
    const days = dates(req.from_date, req.to_date);
    const keys =
      dataKind === 'empty'
        ? []
        : req.grouping === 'Groups'
          ? (req.selected_groups ?? ['group-a', 'group-b'])
          : (req.selected_senders?.map((entry) => entry.sender) ?? ['sender-a', null]);
    return route.fulfill({
      json: {
        days,
        series: keys.map((key) => ({
          key,
          label:
            key === 'group-a'
              ? 'Alpha'
              : key === 'group-b'
                ? 'Beta'
                : key === null
                  ? 'Невідомий відправник'
                  : 'Sender A',
          points: days.map((_, index) => ({
            messages: dataKind === 'zero' ? 0 : dataKind === 'low' ? (index === 0 ? 120 : 1) : 12,
            counterparts: dataKind === 'zero' ? 0 : dataKind === 'low' ? 1 : 2,
          })),
        })),
        total_series: keys.length,
        next_cursor: null,
        generated_at_ms: Date.now(),
      },
    });
  });
  return {
    setPanels: (value: typeof panels) => {
      panels = value;
    },
    requests,
    catalogs,
    facets,
    senders,
    changeAccess: () => {
      accessRevision = 'access-b';
    },
    renameSender: () => {
      senderLabel = 'Renamed Sender';
    },
    fail: (code: number) => {
      status = code;
    },
    setData: (kind: 'normal' | 'zero' | 'empty' | 'low') => {
      dataKind = kind;
    },
    holdStats: () => {
      let release!: () => void;
      pendingStats = new Promise<void>((resolve) => {
        release = resolve;
      });
      return () => {
        pendingStats = null;
        release();
      };
    },
  };
}

test('@regression #3873 opens statistics from Analysis group navigation and filters accessible groups', async ({
  page,
}) => {
  test.setTimeout(60_000);
  const fixture = await install(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/rer-analysis-neo?leftPanelOpen=true');
  await page.getByRole('link', { name: 'Статистика', exact: true }).click();
  await expect(page).toHaveURL('/message-statistics');
  await expect(page.getByRole('heading', { name: 'Статистика повідомлень' })).toBeVisible();
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(0);
  expect(fixture.requests[0]).toMatchObject({
    from_date: '2026-11-05',
    to_date: '2026-11-11',
    grouping: 'Groups',
    selected_groups: null,
  });
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await page.getByRole('textbox', { name: 'Пошук групи' }).fill('Alpha');
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await expect(page).toHaveURL(/groups=group-a/);
  await page.reload();
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await expect(page.locator('.message-statistics-chart svg')).toBeVisible();
  await page.screenshot({ path: '/tmp/echo-3873-desktop-light.png', fullPage: true });
});

test('@regression #3873 preserves day resolution, optional descendants, sender mode and no bar navigation', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
  await page.goto(
    '/message-statistics?from=2026-08-14&to=2026-11-11&units=unit-id%3A10&children=false',
  );
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toEqual([10]);
  await page.getByRole('button', { name: 'Включати дочірні' }).click();
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toEqual([10, 11]);
  await page.getByRole('button', { name: 'Відправниках', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.grouping).toBe('Senders');
  const dateLabels = page
    .locator('.message-statistics-chart svg text')
    .filter({ hasText: /^\d{2}\.\d{2}$/ });
  await expect(dateLabels).toHaveCount(90);
  await expect(dateLabels.first()).toHaveText('14.08');
  await expect(dateLabels.last()).toHaveText('11.11');
  const href = page.url();
  await page
    .getByRole('img', { name: 'Денна статистика повідомлень', exact: true })
    .click({ position: { x: 100, y: 100 } });
  await expect(page).toHaveURL(href);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    document.querySelector('.message-statistics-content')?.scrollTo(0, 0);
  });
  await page.screenshot({ path: '/tmp/echo-3873-desktop.png', fullPage: true });
});

for (const remainingSenders of [0, 10]) {
  test(`@regression #3873 resets filter pagination and preserves back navigation when refresh leaves ${remainingSenders} senders`, async ({
    page,
  }) => {
    await install(page);
    let total = 11;
    await page.route('**/api/rer/analysis/stats/daily-messages', (route) => {
      const req = route.request().postDataJSON() as StatsRequest;
      const days = dates(req.from_date, req.to_date);
      const offset = req.cursor ? 10 : 0;
      return route.fulfill({
        json: {
          days,
          series: Array.from({ length: Math.max(0, Math.min(10, total - offset)) }, (_, i) => ({
            key: `sender-${offset + i}`,
            label: `Sender ${offset + i}`,
            points: days.map(() => ({ messages: 12, counterparts: 2 })),
          })),
          total_series: total,
          next_cursor: !req.cursor && total > 10 ? 'next-page' : null,
          generated_at_ms: Date.now(),
        },
      });
    });
    await page.goto('/message-statistics?grouping=Senders');
    const pagination = page.getByRole('navigation', { name: 'Сторінки серій', exact: true });
    await expect(pagination).toContainText('1–10 з 11');
    await pagination.getByRole('button', { name: 'Наступні', exact: true }).click();
    await expect(pagination).toContainText('11–11 з 11');
    await expect(page.locator('.message-statistics-chart-content')).toHaveAttribute(
      'aria-busy',
      'false',
    );
    for (const label of ['Сьогодні', '7 днів']) {
      const firstPage = page.waitForRequest('**/api/rer/analysis/stats/daily-messages');
      await page.getByRole('button', { name: label, exact: true }).click();
      expect((await firstPage).postDataJSON().cursor).toBeNull();
      await expect(pagination).toContainText('1–10 з 11');
    }
    await pagination.getByRole('button', { name: 'Наступні', exact: true }).click();
    await expect(pagination).toContainText('11–11 з 11');
    await expect(page.locator('.message-statistics-chart-content')).toHaveAttribute(
      'aria-busy',
      'false',
    );

    total = remainingSenders;
    const refreshed = page.waitForResponse(
      async (response) =>
        response.url().endsWith('/api/rer/analysis/stats/daily-messages') &&
        (await response.json()).total_series === remainingSenders,
    );
    await page.clock.fastForward(121_000);
    await refreshed;
    await expect(
      page.getByText('За вибраними фільтрами повідомлень немає.', { exact: true }),
    ).toBeVisible();
    await expect(pagination.getByRole('button', { name: 'Попередні', exact: true })).toBeEnabled();
    await expect(pagination.getByRole('button', { name: 'Наступні', exact: true })).toBeDisabled();

    const previousPage = page.waitForRequest('**/api/rer/analysis/stats/daily-messages');
    await pagination.getByRole('button', { name: 'Попередні', exact: true }).click();
    expect((await previousPage).postDataJSON().cursor).toBeNull();
    await expect(pagination).toHaveCount(0);
    if (remainingSenders > 0)
      await expect(
        page.getByRole('img', { name: 'Денна статистика повідомлень', exact: true }),
      ).toBeVisible();
  });
}

test('@regression #3873 refreshes today, clears forbidden data and filters groups on mobile', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/message-statistics');
  await expect.poll(() => fixture.requests.length).toBe(1);
  await expect(page.locator('.message-statistics-chart svg')).toBeVisible();
  await expect(page.getByRole('status', { name: 'Завантаження користувача' })).toHaveCount(0);
  await page.clock.fastForward(61_000);
  await expect.poll(() => fixture.requests.length).toBe(2);
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await page.getByRole('textbox', { name: 'Пошук групи' }).fill('Beta');
  await page.getByRole('checkbox', { name: 'Beta', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toEqual(['group-b']);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  const explanation = await page
    .getByText('Висота колонки і число над нею — повідомлень за день', { exact: true })
    .boundingBox();
  expect(explanation).not.toBeNull();
  expect(explanation!.x + explanation!.width).toBeLessThanOrEqual(374);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '/tmp/echo-3873-mobile.png', fullPage: true });
  await page.locator('.message-statistics-chart').scrollIntoViewIfNeeded();
  await expect(page.locator('.message-statistics-chart svg')).toBeVisible();
  await page.screenshot({ path: '/tmp/echo-3873-mobile-chart.png', fullPage: true });
  fixture.fail(403);
  await page.clock.fastForward(61_000);
  await expect(
    page.getByRole('img', { name: 'Денна статистика повідомлень', exact: true }),
  ).not.toBeVisible();
  await expect(page.getByText('Статистика недоступна').first()).toBeVisible();
  await expect(page.getByRole('button', { name: /^Підрозділи противника:/ })).toBeDisabled();
});

test('@regression #3873 applies custom and quick date ranges without dropping group filters', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics?groups=group-a&grouping=Senders');
  await expect.poll(() => fixture.requests.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: /^Період:/ }).click();
  const picker = page.getByRole('dialog', { name: 'Період статистики', exact: true });
  const from = picker.getByRole('textbox', { name: 'Від дати', exact: true });
  await from.fill('01.11.2026');
  await from.press('Tab');
  await page.clock.fastForward(300);
  await picker.getByRole('button', { name: 'Застосувати', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.from_date).toBe('2026-11-01');
  expect(fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.from_date).toBe('2026-11-11');
  expect(fixture.requests.at(-1)?.to_date).toBe('2026-11-11');
  expect(fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await page.getByRole('button', { name: '7 днів', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.from_date).toBe('2026-11-05');
  expect(fixture.requests.at(-1)?.to_date).toBe('2026-11-11');
  expect(fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  expect(fixture.requests.at(-1)?.grouping).toBe('Senders');
  await expect(
    page.getByRole('group', { name: 'Швидкий період' }).locator('button[aria-pressed]'),
  ).toHaveCount(0);
});

test('@regression #3873 searches, counts and resets selections inside the dropdown with keyboard support', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics');
  const trigger = page.getByRole('button', { name: /^Групи:/ });
  await trigger.click();
  const panel = page.getByRole('dialog', { name: 'Фільтр: Групи', exact: true });
  await expect(panel.getByText('84', { exact: true })).toBeVisible();
  await expect(panel.getByRole('status')).toHaveText('Обрано 0 з 2');
  await panel.getByRole('checkbox', { name: 'Alpha', exact: true }).check();
  await expect(panel.getByRole('status')).toHaveText('Обрано 1 з 2');
  const search = panel.getByRole('textbox', { name: 'Пошук групи' });
  await search.fill('Beta');
  await expect(panel.getByRole('checkbox', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('checkbox', { name: 'Beta', exact: true })).toBeVisible();
  await panel.getByRole('button', { name: 'Скинути', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toBeNull();
  await search.fill('');
  await search.press('ArrowDown');
  await expect(panel.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await page.keyboard.press('Escape');
  await expect(panel).not.toBeVisible();
  await expect(trigger).toBeFocused();
});

test('@regression #3873 expands and searches the unit tree and resets only its own filter', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics?groups=group-a');
  await page.getByRole('button', { name: /^Підрозділи противника:/ }).click();
  const panel = page.getByRole('dialog', { name: 'Фільтр: Підрозділи противника', exact: true });
  await expect(panel.getByText('24', { exact: true })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Child', exact: true })).toHaveCount(0);
  await panel.getByRole('button', { name: 'Розгорнути Army', exact: true }).click();
  await panel.getByRole('checkbox', { name: 'Child', exact: true }).check();
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toEqual([11]);
  await expect(panel.getByRole('status')).toHaveText('Обрано 1 з 3');
  await panel.getByRole('textbox', { name: 'Пошук підрозділа' }).fill('Child');
  await expect(panel.getByRole('checkbox', { name: 'Army', exact: true })).toBeVisible();
  await expect(panel.getByRole('checkbox', { name: 'Child', exact: true })).toBeChecked();
  await panel.getByRole('button', { name: 'Скинути', exact: true }).click();
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toBeNull();
  expect(fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  await panel.getByRole('textbox', { name: 'Пошук підрозділа' }).fill('');
  await panel.getByRole('checkbox', { name: 'Не визначено', exact: true }).check();
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toEqual([0]);
});

test('@regression #3873 loads only open facets and reuses their scope without refetching own selection', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics');
  await expect(page.getByRole('button', { name: /^Відправник:/ })).toBeEnabled();
  expect(fixture.catalogs).toHaveLength(1);
  expect(fixture.facets).toHaveLength(0);
  expect(fixture.senders).toHaveLength(0);
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByText('84', { exact: true })).toBeVisible();
  expect(fixture.facets).toHaveLength(1);
  await page.getByRole('checkbox', { name: 'Alpha', exact: true }).check();
  await expect.poll(() => fixture.requests.at(-1)?.selected_groups).toEqual(['group-a']);
  expect(fixture.facets).toHaveLength(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByText('84', { exact: true })).toBeVisible();
  expect(fixture.facets).toHaveLength(1);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Підрозділи противника:/ }).click();
  await expect(page.getByText('24', { exact: true })).toBeVisible();
  expect(fixture.facets.at(-1)?.filter.selected_groups).toEqual(['group-a']);
  await page.getByRole('checkbox', { name: 'Army', exact: true }).check();
  await expect.poll(() => fixture.requests.at(-1)?.selected_unit_ids).toEqual([10, 11]);
  expect(fixture.facets).toHaveLength(2);
  expect(fixture.senders).toHaveLength(0);
});

test('@regression #3873 loads sender labels immediately, debounces search and preserves unknown selection', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics');
  await page.getByRole('button', { name: /^Відправник:/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Sender A', exact: true })).toBeVisible();
  expect(fixture.senders).toHaveLength(1);
  await page.getByRole('checkbox', { name: 'Невідомий відправник', exact: true }).check();
  await expect.poll(() => fixture.requests.at(-1)?.selected_senders).toEqual([{ sender: null }]);
  expect(fixture.senders).toHaveLength(1);
  const search = page.getByRole('textbox', { name: 'Пошук відправника' });
  await search.fill('Send');
  await search.fill('Sender');
  expect(fixture.senders).toHaveLength(1);
  await page.clock.fastForward(250);
  await expect.poll(() => fixture.senders.length).toBe(2);
  expect(fixture.senders.at(-1)?.search).toBe('Sender');
  expect(fixture.senders.at(-1)?.filter.selected_senders).toBeNull();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Відправник:/ })).toContainText(
    'Невідомий відправник',
  );
});

test('@regression #3873 refreshes metadata for historical dates and clears caches when access changes', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics?from=2026-10-01&to=2026-10-07');
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByText('84', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  fixture.changeAccess();
  await page.clock.fastForward(61_000);
  await expect.poll(() => fixture.catalogs.length).toBe(2);
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByRole('checkbox', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect(page.getByRole('checkbox', { name: 'Beta', exact: true })).toBeVisible();
  await expect.poll(() => fixture.facets.length).toBe(2);
  expect(fixture.senders).toHaveLength(0);
});

test('@regression #3873 hides old counters while a new period loads and retains labels and selections', async ({
  page,
}) => {
  await install(page);
  await page.goto('/message-statistics?groups=group-a');
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByText('84', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/rer/analysis/stats/daily-messages/facet-counts', async (route) => {
    await ready;
    await route.fulfill({
      json: {
        counts: [{ value: 'group-a', count: 7 }],
        access_revision: 'access-a',
        hierarchy_revision: null,
        generated_at_ms: Date.now(),
      },
    });
  });
  await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  await page.getByRole('button', { name: /^Групи:/ }).click();
  const panel = page.getByRole('dialog', { name: 'Фільтр: Групи', exact: true });
  await expect(panel.getByRole('checkbox', { name: 'Alpha', exact: true })).toBeChecked();
  await expect(panel.getByText('84', { exact: true })).toHaveCount(0);
  await expect(panel.getByLabel('Завантаження варіантів')).toBeVisible();
  release();
  await expect(panel.getByText('7', { exact: true })).toBeVisible();
});

test('@regression #3873 resets requests and cached facets on identity change with identical roles', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics');
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect(page.getByText('84', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.evaluate(() =>
    document.querySelector('message-statistics')?.setAttribute('data-auth-user-id', 'another-user'),
  );
  await expect.poll(() => fixture.catalogs.length).toBe(2);
  await page.getByRole('button', { name: /^Групи:/ }).click();
  await expect.poll(() => fixture.facets.length).toBe(2);
  await expect(page.getByText('84', { exact: true })).toBeVisible();
});

test('@regression #3873 refreshes selected sender labels without polling a closed sender panel', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.goto('/message-statistics');
  await page.getByRole('button', { name: /^Відправник:/ }).click();
  await page.getByRole('checkbox', { name: 'Sender A', exact: true }).check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: /^Відправник:/ })).toContainText('Sender A');
  await expect(page.getByRole('status', { name: 'Завантаження користувача' })).toHaveCount(0);
  fixture.renameSender();
  await page.clock.fastForward(61_000);
  await expect(page.getByRole('button', { name: /^Відправник:/ })).toContainText('Renamed Sender');
  expect(fixture.senders).toHaveLength(1);
});

test('@regression #3873 delays refresh progress and cancels it for fast responses', async ({
  page,
  context,
}) => {
  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const fixture = await install(page);
  await page.goto('/message-statistics');
  const content = page.locator('.message-statistics-chart-content');
  const progress = page.getByRole('progressbar', { name: 'Оновлення статистики' });
  await expect(page.locator('.message-statistics-chart svg')).toBeVisible();
  await expect(content).toHaveAttribute('aria-busy', 'false');
  await page.clock.pauseAt(new Date((await page.evaluate(() => Date.now())) + 1000));
  await page.evaluate(() => {
    const state = { mounts: 0 };
    (window as any).__refreshProgressProbe = state;
    const observer = new MutationObserver((records) => {
      for (const record of records)
        for (const node of record.addedNodes)
          if (
            node instanceof Element &&
            (node.matches('.message-statistics-chart-progress') ||
              node.querySelector('.message-statistics-chart-progress'))
          )
            state.mounts += 1;
    });
    observer.observe(document.querySelector('.message-statistics-card')!, {
      subtree: true,
      childList: true,
    });
    (window as any).__refreshProgressObserver = observer;
  });
  const releaseFast = fixture.holdStats();
  await page.getByRole('button', { name: 'Відправниках', exact: true }).click();
  await expect(content).toHaveAttribute('aria-busy', 'true');
  await page.clock.runFor(200);
  await expect(progress).toHaveCount(0);
  releaseFast();
  await expect(content).toHaveAttribute('aria-busy', 'false');
  await page.clock.runFor(300);
  await expect(progress).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__refreshProgressProbe.mounts)).toBe(0);
  const releaseSlow = fixture.holdStats();
  await page.getByRole('button', { name: 'Групах', exact: true }).click();
  await expect(content).toHaveAttribute('aria-busy', 'true');
  await page.clock.runFor(249);
  await expect(progress).toHaveCount(0);
  await page.clock.runFor(1);
  await expect(progress).toBeVisible();
  releaseSlow();
  await expect(content).toHaveAttribute('aria-busy', 'false');
  await expect(progress).toHaveCount(0);
  await page.evaluate(() => (window as any).__refreshProgressObserver.disconnect());
});

for (const width of [1440, 390]) {
  for (const reducedMotion of ['no-preference', 'reduce'] as const) {
    test(`@regression #3873 uses one vertical page scroll over charts at ${width}px with ${reducedMotion} motion`, async ({
      page,
      context,
    }) => {
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.emulateMedia({ reducedMotion });
      await page.setViewportSize({ width, height: 1000 });
      const fixture = await install(page);
      fixture.setPanels(
        [1, 2, 3, 4].map((label_id) => ({
          label_id,
          name: `Панель ${label_id}`,
          color: '#87d7f1',
          organism_name: null,
        })),
      );
      await page.goto('/message-statistics?from=2026-10-12&to=2026-11-11');
      const charts = page.locator('.message-statistics-chart-viewport');
      const cards = page.locator('.message-statistics-card');
      await expect(page.locator('.message-statistics-chart svg')).toHaveCount(4);
      await expect(page.locator('.message-statistics-chart-content[aria-busy="true"]')).toHaveCount(
        0,
      );
      await page.evaluate(() => document.fonts.ready);
      const height = await page.evaluate(() => document.documentElement.scrollHeight);
      const horizontal = await charts.first().evaluate((node) => node.scrollLeft);
      expect(horizontal).toBeGreaterThan(0);
      const plot = await boundingBox(charts.first());
      await page.mouse.move(plot.x + plot.width / 2, Math.min(plot.y + plot.height / 2, 950));
      await page.mouse.wheel(-300, 0);
      await expect
        .poll(() => charts.first().evaluate((node) => node.scrollLeft))
        .toBeLessThan(horizontal);
      expect(await page.evaluate(() => window.scrollY + document.body.scrollTop)).toBe(0);
      await page.mouse.wheel(0, 500);
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
      expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
      expect(await charts.evaluateAll((nodes) => nodes.every((node) => node.scrollTop === 0))).toBe(
        true,
      );
      await page.mouse.move(5, 500);
      for (let step = 0; step < 2; step++) {
        await page.mouse.wheel(0, 10000);
        await expect
          .poll(
            async () =>
              (await boundingBox(cards.last())).y + (await boundingBox(cards.last())).height,
          )
          .toBeCloseTo(976, 0);
        expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
        expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBe(height);
      }
      await charts.first().evaluate(
        (node) =>
          new Promise<void>((resolve) => {
            document.addEventListener('scrollend', () => resolve(), { once: true });
            (node as HTMLElement).focus();
          }),
      );
      const beforeKey = await page.evaluate(() => window.scrollY);
      await page.keyboard.press('PageDown');
      await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(beforeKey);
      expect(await page.evaluate(() => document.body.scrollTop)).toBe(0);
      expect(await charts.evaluateAll((nodes) => nodes.every((node) => node.scrollTop === 0))).toBe(
        true,
      );
    });
  }
}

for (const viewport of [
  { width: 1440, height: 1000 },
  { width: 390, height: 844 },
]) {
  test(`@regression #3873 keeps the chart card and plot stationary across periods and loading states at ${viewport.width}px`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60_000);
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const fixture = await install(page);
    await page.setViewportSize(viewport);
    const releaseInitial = fixture.holdStats();
    await page.goto('/message-statistics');
    const card = page.locator('.message-statistics-card');
    const chart = page.locator('.message-statistics-chart');
    const zero = page.locator('.message-statistics-y-axis span').filter({ hasText: /^0$/ });
    await expect(page.getByLabel('Завантаження статистики', { exact: true })).toBeVisible();
    await expect.poll(() => fixture.requests.length).toBeGreaterThan(0);
    await page.evaluate(() => document.fonts.ready);
    const initial = await boundingBox(card);
    const expectCardStable = async () => {
      const bounds = await boundingBox(card);
      expect(bounds.height).toBeCloseTo(initial.height, 1);
      expect(bounds.y).toBeCloseTo(initial.y, 1);
    };
    releaseInitial();
    await expect(chart.locator('svg')).toBeVisible();
    await expect(page.getByRole('status', { name: 'Завантаження користувача' })).toHaveCount(0);
    const plot = await boundingBox(chart);
    const baseline = await boundingBox(zero);
    const originalHost = await chart.elementHandle();
    const originalSvg = await chart.locator('svg').elementHandle();
    const expectPlotStable = async (refreshing = false, empty = false) => {
      await expect(page.locator('.message-statistics-chart-content')).toHaveAttribute(
        'aria-busy',
        String(refreshing),
      );
      if (empty) await expect(chart.locator('svg')).toBeHidden();
      else {
        await expect(chart.locator('svg')).toBeVisible();
        await expect(zero).toBeVisible();
      }
      expect(await chart.evaluate((node, original) => node === original, originalHost)).toBe(true);
      expect(
        await chart.locator('svg').evaluate((node, original) => node === original, originalSvg),
      ).toBe(true);
      await expectCardStable();
      const bounds = await chart.evaluate((node) => node.getBoundingClientRect().toJSON());
      expect(bounds.height).toBeCloseTo(plot.height, 1);
      expect(bounds.y).toBeCloseTo(plot.y, 1);
      expect(await zero.evaluate((node) => node.getBoundingClientRect().y)).toBeCloseTo(
        baseline.y,
        1,
      );
    };
    const changeStats = async (label: string) => {
      await Promise.all([
        page.waitForResponse('**/api/rer/analysis/stats/daily-messages'),
        page.getByRole('button', { name: label, exact: true }).click(),
      ]);
    };
    await expectPlotStable();
    const releaseDay = fixture.holdStats();
    const dayResponse = page.waitForResponse('**/api/rer/analysis/stats/daily-messages');
    await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
    await expect(page.getByRole('progressbar', { name: 'Оновлення статистики' })).toBeVisible();
    await expectPlotStable(true);
    await expectCardStable();
    releaseDay();
    await dayResponse;
    await expectPlotStable();
    const releaseGrouping = fixture.holdStats();
    await page.getByRole('button', { name: 'Відправниках', exact: true }).click();
    await expectPlotStable(true);
    await expect(
      card.getByText('Число на кольоровому тлі — скільки відправників працювало над групою', {
        exact: true,
      }),
    ).toBeVisible();
    const reversed = page.waitForResponse(
      (response) =>
        response.url().endsWith('/api/rer/analysis/stats/daily-messages') &&
        response.request().postDataJSON().grouping === 'Groups',
    );
    await page.getByRole('button', { name: 'Групах', exact: true }).click();
    await expectPlotStable(true);
    releaseGrouping();
    await reversed;
    await expectPlotStable();
    await changeStats('Відправниках');
    await expectPlotStable();
    await changeStats('7 днів');
    await expectPlotStable();
    const releaseRefresh = fixture.holdStats();
    const refreshResponse = page.waitForResponse('**/api/rer/analysis/stats/daily-messages');
    await page.clock.fastForward(61_000);
    await expect(page.getByRole('progressbar', { name: 'Оновлення статистики' })).toBeVisible();
    await expectPlotStable(true);
    releaseRefresh();
    await refreshResponse;
    await expect(page.getByRole('progressbar', { name: 'Оновлення статистики' })).toHaveCount(0);
    fixture.setData('zero');
    await changeStats('Сьогодні');
    await expect(
      card.getByText('За вибраними фільтрами повідомлень немає.', { exact: true }),
    ).toBeVisible();
    await expectPlotStable(false, true);
    fixture.setData('empty');
    await changeStats('7 днів');
    await expect(
      card.getByText('За вибраними фільтрами повідомлень немає.', { exact: true }),
    ).toBeVisible();
    await expectCardStable();
    fixture.setData('normal');
    await changeStats('Сьогодні');
    await expectPlotStable();
    fixture.fail(503);
    await page.clock.fastForward(61_000);
    await expect(card.getByText('Статистика недоступна')).toBeVisible();
    await expectPlotStable();
  });
}

for (const width of [1440, 390]) {
  for (const mode of ['light', 'dark']) {
    test(`@regression #3873 keeps low-bar values, tooltip dates and the pinned scale readable at ${width}px in ${mode}`, async ({
      page,
      context,
    }) => {
      test.setTimeout(60_000);
      const cdp = await context.newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
      await page.emulateMedia({ reducedMotion: mode === 'light' ? 'reduce' : 'no-preference' });
      const fixture = await install(page);
      fixture.setData('low');
      await page.setViewportSize({ width, height: 1000 });
      await page.addInitScript((value) => localStorage.setItem('echo-theme-mode', value), mode);
      await page.goto('/message-statistics?from=2026-11-05&to=2026-11-11');
      const chart = page.locator('.message-statistics-chart');
      const viewport = page.getByRole('region', { name: 'Прокручування графіка', exact: true });
      const axis = page.locator('.message-statistics-y-axis');
      await expect(chart.locator('svg')).toBeVisible();
      await expect(axis.getByText('160', { exact: true })).toBeVisible();
      await viewport.evaluate((node) => {
        node.scrollLeft = 0;
      });
      const before = await boundingBox(axis);
      await viewport.evaluate((node) => {
        node.scrollLeft = node.scrollWidth;
      });
      const after = await boundingBox(axis);
      expect(after.x).toBeCloseTo(before.x, 1);
      expect(after.y).toBeCloseTo(before.y, 1);
      expect(after.x + after.width).toBeLessThanOrEqual((await boundingBox(viewport)).x + 1);
      const lowValues = await chart.evaluate((node) => {
        const clip = node.parentElement!.getBoundingClientRect();
        const baseline = node.getBoundingClientRect().bottom - 114;
        return [...node.querySelectorAll('svg text')]
          .filter((text) => text.textContent === '1')
          .map((text) => text.getBoundingClientRect())
          .filter((box) => box.x >= clip.x && box.right <= clip.right && box.y > baseline - 80)
          .map((box) => ({ bottom: box.bottom, baseline }));
      });
      expect(lowValues.length).toBeGreaterThanOrEqual(4);
      expect(lowValues.every((box) => box.bottom < box.baseline)).toBe(true);
      await viewport.evaluate((node) => {
        node.scrollLeft = 0;
      });
      const bar = await chart.locator('svg path[fill="#87d7f1"]').evaluateAll((nodes) => {
        const box = nodes
          .map((node) => node.getBoundingClientRect())
          .find((box) => box.height > 100);
        return box ? { x: box.x + box.width / 2, y: box.y + box.height / 2 } : null;
      });
      expect(bar).not.toBeNull();
      await page.mouse.move(bar!.x, bar!.y);
      await expect(chart.locator('svg text').filter({ hasText: /^05\.11\.2026$/ })).toBeVisible();
      await expect(
        chart.locator('svg text').filter({ hasText: /^Повідомлень: 120$/ }),
      ).toBeVisible();
      expect(await chart.locator('svg').textContent()).not.toContain('group-a');
      await page.screenshot({ path: test.info().outputPath('chart-details.png'), fullPage: true });
      fixture.setData('zero');
      await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
      const empty = page.locator('.message-statistics-chart-empty');
      await expect(empty).toHaveText('За вибраними фільтрами повідомлень немає.');
      await expect(empty).toBeVisible();
      await expect(page.locator('.message-statistics-card').getByRole('alert')).toHaveCount(0);
      const notice = await boundingBox(empty.locator('p'));
      const content = await boundingBox(page.locator('.message-statistics-chart-content'));
      expect(notice.x + notice.width / 2).toBeCloseTo(content.x + content.width / 2, 1);
      expect(notice.y + notice.height / 2).toBeCloseTo(
        content.y + 20 + (content.height - 20) / 2,
        1,
      );
      await page.screenshot({ path: test.info().outputPath('chart-empty.png'), fullPage: true });
    });
  }
}

test('@regression #3873 keeps label panels and their grouping independent across shared filters', async ({
  page,
}) => {
  const fixture = await install(page);
  const panels = [
    { label_id: 1, name: 'Аналітика', color: '#87d7f1', organism_name: 'Перший організм' },
    { label_id: 2, name: 'РЕР', color: '#dea0df', organism_name: 'Перший організм' },
    { label_id: -1, name: 'Без лейбла', color: '#87d7f1', organism_name: null },
  ];
  fixture.setPanels(panels);
  await page.goto('/message-statistics');
  const analytics = page.getByRole('region', {
    name: 'Графік статистики: Аналітика',
    exact: true,
  });
  const rer = page.getByRole('region', {
    name: 'Графік статистики: РЕР',
    exact: true,
  });
  await expect(analytics.locator('svg').first()).toBeVisible();
  await expect(rer.locator('svg').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Без лейбла', exact: true })).toBeVisible();
  await analytics.getByRole('button', { name: 'Відправниках', exact: true }).click();
  await expect
    .poll(() => fixture.requests.filter((request) => request.user_label_id === 1).at(-1)?.grouping)
    .toBe('Senders');
  await expect(rer.getByRole('button', { name: 'Групах', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  for (const id of [1, 2, -1]) {
    await expect
      .poll(
        () => fixture.requests.filter((request) => request.user_label_id === id).at(-1)?.from_date,
      )
      .toBe('2026-11-11');
  }
  await expect(
    analytics.getByRole('button', { name: 'Відправниках', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(rer.getByRole('button', { name: 'Групах', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  fixture.setPanels(panels.filter((panel) => panel.label_id !== 1));
  await page.getByRole('button', { name: '7 днів', exact: true }).click();
  await expect(analytics).toHaveCount(0);
  fixture.setPanels(panels);
  await page.getByRole('button', { name: 'Сьогодні', exact: true }).click();
  await expect(
    analytics.getByRole('button', { name: 'Відправниках', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(rer.getByRole('button', { name: 'Групах', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect
    .poll(() => fixture.requests.filter((request) => request.user_label_id === 1).at(-1)?.grouping)
    .toBe('Senders');
});

for (const width of [1440, 390]) {
  test(`@regression #3873 starts every chart at the latest dates and preserves manual scrolling at ${width}px`, async ({
    page,
  }) => {
    const fixture = await install(page);
    fixture.setPanels([
      { label_id: 1, name: 'Аналітика', color: '#87d7f1', organism_name: null },
      { label_id: 2, name: 'РЕР', color: '#dea0df', organism_name: null },
    ]);
    await page.setViewportSize({ width, height: 1000 });
    await page.goto('/message-statistics?from=2026-08-14&to=2026-11-11');
    const viewports = page.getByRole('region', { name: 'Прокручування графіка', exact: true });
    await expect(viewports).toHaveCount(2);
    await expect
      .poll(() =>
        viewports.evaluateAll((elements) =>
          elements.every(
            (element) =>
              element.scrollLeft > 0 &&
              Math.abs(element.scrollWidth - element.clientWidth - element.scrollLeft) <= 1,
          ),
        ),
      )
      .toBe(true);
    const axes = page.locator('.message-statistics-y-axis');
    const axisPositions = await axes.evaluateAll((elements) =>
      elements.map((element) => element.getBoundingClientRect().x),
    );
    for (const axis of await axes.all()) await expect(axis).toBeVisible();
    await viewports.evaluateAll((elements) => {
      for (const element of elements) element.scrollLeft = 80;
    });
    await page.setViewportSize({ width: width - 20, height: 1000 });
    const count = fixture.requests.length;
    await page.clock.fastForward(61_000);
    await expect.poll(() => fixture.requests.length).toBeGreaterThan(count);
    for (const chart of await page.locator('.message-statistics-chart-content').all())
      await expect(chart).toHaveAttribute('aria-busy', 'false');
    expect(
      await viewports.evaluateAll((elements) => elements.map((element) => element.scrollLeft)),
    ).toEqual([80, 80]);
    expect(
      await axes.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().x),
      ),
    ).toEqual(axisPositions);
    for (const axis of await axes.all()) await expect(axis).toBeVisible();
  });
}

test('@regression #3873 shows an empty state for users without an organism', async ({ page }) => {
  const fixture = await install(page);
  fixture.setPanels([]);
  await page.goto('/message-statistics');
  await expect(
    page.getByText('Немає доступних панелей статистики. Користувач має належати до організму.'),
  ).toBeVisible();
  await expect(page.getByRole('region', { name: /Графік статистики/ })).toHaveCount(0);
  expect(fixture.requests).toHaveLength(0);
});

test('@regression #3873 keeps exact counterpart values readable for dark custom label colors', async ({
  page,
}) => {
  const fixture = await install(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  fixture.setPanels([
    { label_id: 42, name: 'Темний лейбл', color: '#1e3a8a', organism_name: null },
  ]);
  await page.goto('/message-statistics?from=2026-11-11&to=2026-11-11');
  const values = page.locator('.message-statistics-chart svg text').filter({ hasText: /^2$/ });
  await expect(values).toHaveCount(2);
  await expect(values.first()).toBeVisible();
  expect(
    await values.evaluateAll((elements) =>
      elements.every((element) =>
        ['#fff', '#ffffff', 'rgb(255, 255, 255)'].includes(getComputedStyle(element).fill),
      ),
    ),
  ).toBe(true);
  await page.screenshot({
    path: test.info().outputPath('contrast-desktop.png'),
    animations: 'disabled',
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(values.first()).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('contrast-mobile.png'),
    animations: 'disabled',
  });
});
