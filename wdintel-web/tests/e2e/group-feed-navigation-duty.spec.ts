import { expect, test, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const groups = [
  { masterKey: 'group-a', name: 'Group Alpha', colorKey: 'blue' },
  { masterKey: 'group-b', name: 'Group Beta', colorKey: 'deep_purple' },
];

function message(id: number, groupMasterKey: string, text: string): InboxMessage {
  return minimalInboxMessage({
    messageUid: `group-feed-${id}`,
    text,
    timestamp: 1_720_000_000_000 + id * 1_000,
    createdAt: 1_720_000_000_000 + id * 1_000,
    groupMasterKey,
  });
}

function inboxResponse(selectedGroups: string[] | null): InboxMessagesRspRaw {
  const selected = selectedGroups ?? groups.map(({ masterKey }) => masterKey);
  const inboxItems = [
    selected.includes('group-a') ? [101, message(101, 'group-a', 'Alpha-only message')] : null,
    selected.includes('group-b') ? [201, message(201, 'group-b', 'Beta-only message')] : null,
  ].filter((item): item is [number, InboxMessage] => item !== null);
  return {
    inbox_items: inboxItems as InboxMessagesRspRaw['inbox_items'],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

async function installGroupNavigationMocks(page: Page) {
  const inboxRequests: Array<{ selected_groups?: string[] | null }> = [];
  await installRerDutyShortStateMocks(page, {
    signalGroups: groups.map(({ masterKey }) => masterKey),
    inboxResponseForRequest: (requestBody) => {
      const request = requestBody as { selected_groups?: string[] | null };
      inboxRequests.push(request);
      return inboxResponse(request.selected_groups ?? null);
    },
  });
  await page.route('**/api/rer-importer/signal-group-batch', (route) =>
    route.fulfill({
      json: {
        data: groups.map((group) => ({
          master_key: group.masterKey,
          name: group.name,
          color_key: group.colorKey,
        })),
      },
    }),
  );
  return { inboxRequests };
}

test.describe('Duty group feed navigation', () => {
  test('@regression #3727 preserves the draft and its group when the source column changes scope', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await installGroupNavigationMocks(page);
    const state = {
      messageFeeds: [
        ['mf-a', {}, { groupScopeMasterKey: 'group-a' }],
        ['mf-b', {}, { groupScopeMasterKey: 'group-b' }],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const column = page.locator('[data-duty-feed-id="mf-a"][data-duty-feed-column]');
    await column.getByRole('button', { name: 'Додати повідомлення' }).click();
    const text = page.getByRole('textbox', { name: 'Текст повідомлення' });
    await text.fill('Unsaved group Alpha draft');
    await expect(page.getByRole('combobox', { name: 'Група', exact: true })).toHaveValue(
      'Group Alpha',
    );

    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await column.getByRole('button', { name: 'Group Beta' }).click();

    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Group Beta');
    await expect(text).toHaveValue('Unsaved group Alpha draft');
    await expect(page.getByRole('combobox', { name: 'Група', exact: true })).toHaveValue(
      'Group Alpha',
    );
    await column
      .getByRole('button', { name: 'Створити розвіддонесення', exact: true })
      .first()
      .click();
    await expect(page.getByRole('dialog', { name: 'Відхилити незбережені зміни?' })).toBeVisible();
    await page.getByRole('button', { name: 'Продовжити редагування' }).click();
    await expect(text).toHaveValue('Unsaved group Alpha draft');
  });

  test('shows all groups without per-group unread badges', async ({ page }) => {
    await installGroupNavigationMocks(page);
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(column.getByRole('button', { name: 'Всі групи', exact: true })).toBeVisible();
  });

  test('hides Duty-excluded groups from the navigation list', async ({ page }) => {
    await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/signal-group-batch', (route) =>
      route.fulfill({
        json: {
          data: groups.map((group) => ({
            master_key: group.masterKey,
            name: group.name,
            color_key: group.colorKey,
            ignore_operativny: group.masterKey === 'group-b',
          })),
        },
      }),
    );
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(
      column.locator('[data-group-panel]').getByRole('button', { name: /Group Alpha/ }),
    ).toBeVisible();
    await expect(
      column.locator('[data-group-panel]').getByRole('button', { name: /Group Beta/ }),
    ).toHaveCount(0);
  });

  test('resolves the selected group name while the group list is closed', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const mocks = await installGroupNavigationMocks(page);
    const state = {
      messageFeeds: [
        [
          'mf-a',
          {},
          {
            adjacentFreqsRange: 0,
            highlightSignalsEnabled: false,
            onlyMyUnitTagsEnabled: false,
            groupScopeMasterKey: 'group-b',
          },
        ],
      ],
    };

    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);

    const column = page.locator('[data-duty-feed-column]');
    await expect(column.locator('[data-group-panel]')).toHaveCount(0);
    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Group Beta');
  });

  test('keeps column filters independent and prefills create with the selected group', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
    const mocks = await installGroupNavigationMocks(page);
    const aggregateFilter = { groupsSelected: ['group-a', 'group-b'] };
    const state = {
      messageFeeds: [
        ['mf-a', aggregateFilter],
        ['mf-b', aggregateFilter],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const columns = page.locator('[data-duty-feed-column]');
    await expect(columns).toHaveCount(2);

    const firstIsland = columns.nth(0).locator('[data-group-island]');
    const cardGroups = '[data-message-card-root] [data-message-card-metadata-icon-kind="group"]';
    await expect(columns.nth(0).locator(cardGroups)).toHaveCount(2);
    await expect(firstIsland).toHaveJSProperty('tagName', 'DIV');
    await expect(firstIsland).toHaveCSS('border-width', '1px');
    await expect(firstIsland).toHaveCSS('border-style', 'solid');
    await firstIsland.click();
    await expect(columns.nth(0).locator('[data-group-panel]')).toHaveCount(0);
    const firstGroupsToggle = columns
      .nth(0)
      .getByRole('button', { name: 'Розгорнути список груп' });
    await expect(firstGroupsToggle).toHaveCSS('border-radius', '0px');
    await expect(firstGroupsToggle).toHaveCSS('border-top-width', '0px');
    await expect(firstGroupsToggle).toHaveCSS('border-bottom-width', '0px');
    await expect(firstGroupsToggle).toHaveCSS('border-left-width', '0px');
    await expect(firstGroupsToggle).toHaveCSS('border-right-width', '1px');
    expect(
      await firstGroupsToggle.evaluate((button) => {
        const header = button.closest('[data-duty-feed-header-layout]')?.parentElement;
        return {
          button: getComputedStyle(button).borderRightColor,
          header: header == null ? null : getComputedStyle(header).borderTopColor,
        };
      }),
    ).toEqual({
      button: 'rgba(148, 163, 184, 0.28)',
      header: 'rgba(148, 163, 184, 0.28)',
    });
    await firstGroupsToggle.click();
    await expect(
      columns.nth(0).getByRole('button', { name: 'Згорнути список груп' }),
    ).toBeVisible();
    const firstGroupPanel = columns.nth(0).locator('[data-group-panel]');
    await expect(firstGroupPanel).toBeVisible();
    expect(
      await columns.nth(0).evaluate((column) => {
        const header = column.querySelector('[data-duty-feed-header-layout]');
        const panel = column.querySelector('[data-group-panel]');
        return (
          header != null &&
          panel != null &&
          panel.getBoundingClientRect().top >= header.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    const panelStyle = await firstGroupPanel.evaluate((panel) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor =
        'color-mix(in srgb, var(--echo-color-text) 4%, var(--echo-color-surface-inactive))';
      document.body.append(probe);
      const contextualBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const style = getComputedStyle(panel);
      return {
        background: style.backgroundColor,
        borderWidth: style.borderWidth,
        contextualBackground,
      };
    });
    expect(panelStyle.background).toBe(panelStyle.contextualBackground);
    expect(panelStyle.borderWidth).toBe('0px');
    const selectedMarker = await firstGroupPanel
      .locator('[data-group-list-item][data-selected="true"]')
      .evaluate((item) => getComputedStyle(item, '::before').content);
    expect(selectedMarker).toBe('none');
    const islandStyle = await firstIsland.evaluate((island) => {
      const probe = document.createElement('span');
      probe.style.backgroundColor =
        'color-mix(in srgb, var(--echo-color-text) 8%, var(--echo-color-surface-inactive))';
      document.body.append(probe);
      const contextualBackground = getComputedStyle(probe).backgroundColor;
      probe.remove();
      const style = getComputedStyle(island);
      return {
        background: style.backgroundColor,
        boxShadow: style.boxShadow,
        cursor: style.cursor,
        contextualBackground,
      };
    });
    expect(islandStyle.background).toBe(islandStyle.contextualBackground);
    expect(islandStyle.boxShadow).not.toBe('none');
    expect(islandStyle.cursor).toBe('default');
    const avatars = columns.nth(0).locator('[data-group-panel] [data-group-avatar]');
    expect(
      await avatars.nth(1).evaluate((avatar) => getComputedStyle(avatar).backgroundColor),
    ).not.toBe(await avatars.nth(2).evaluate((avatar) => getComputedStyle(avatar).backgroundColor));
    await columns.nth(0).getByRole('button', { name: 'Group Alpha' }).click();
    await expect(columns.nth(0).getByText('Alpha-only message')).toBeVisible();
    await expect(columns.nth(0).getByText('Beta-only message')).toHaveCount(0);
    await expect(columns.nth(0).locator(cardGroups)).toHaveCount(0);
    await expect(columns.nth(1).locator(cardGroups)).toHaveCount(2);
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();
    const scopedFilterPanel = columns.nth(0).getByLabel('Панель фільтрів');
    await expect(scopedFilterPanel).toBeVisible();
    await expect(scopedFilterPanel.getByText('Групи', { exact: true })).toBeVisible();
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();

    await columns.nth(1).getByRole('button', { name: 'Розгорнути список груп' }).click();
    await columns.nth(1).getByRole('button', { name: 'Group Beta' }).click();
    await expect(columns.nth(1).getByText('Beta-only message')).toBeVisible();
    await expect(columns.nth(1).getByText('Alpha-only message')).toHaveCount(0);
    await expect(columns.nth(1).locator(cardGroups)).toHaveCount(0);

    await columns.nth(0).getByRole('button', { name: 'Розгорнути список груп' }).click();
    await columns
      .nth(0)
      .getByRole('button', { name: /Всі групи/ })
      .click();
    await expect(columns.nth(0).getByText('Alpha-only message')).toBeVisible();
    await expect(columns.nth(0).getByText('Beta-only message')).toBeVisible();
    await expect(columns.nth(0).locator(cardGroups)).toHaveCount(2);
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();
    await expect(
      columns.nth(0).getByLabel('Панель фільтрів').getByText('Групи', { exact: true }),
    ).toBeVisible();
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();
    expect(
      mocks.inboxRequests.some(
        (request) =>
          JSON.stringify(request.selected_groups) === JSON.stringify(['group-a', 'group-b']),
      ),
    ).toBe(true);

    await columns.nth(0).getByRole('button', { name: 'Розгорнути список груп' }).click();
    await columns.nth(0).getByRole('button', { name: 'Group Alpha' }).click();
    await columns.nth(0).hover();
    const firstCreate = columns.nth(0).getByRole('button', { name: 'Додати повідомлення' });
    await expect(firstCreate).toBeVisible();
    await firstCreate.click();
    await expect(page.getByRole('combobox', { name: 'Група', exact: true })).toHaveValue(
      'Group Alpha',
    );
  });

  test('opens the group list over the mobile feed and preserves its scroll position', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    const scroller = column.locator('[data-duty-feed-scroller="true"]');
    await scroller.evaluate((element) => {
      element.scrollTop = 37;
    });
    const before = await scroller.evaluate((element) => element.scrollTop);
    await expect(column.getByRole('button', { name: 'Додати повідомлення' })).toBeVisible();

    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(column.locator('[data-group-panel][data-variant="overlay"]')).toBeVisible();
    await expect(column.locator('[data-group-panel-backdrop]')).toHaveCount(0);
    await expect(column.locator('[data-group-panel]')).toHaveCSS(
      'animation-name',
      'group-navigation-panel-enter',
    );
    await expect(column.locator('[data-group-panel]')).toHaveCSS('animation-duration', '0.2s');
    expect(
      await column.evaluate((element) => {
        const header = element.querySelector('[data-duty-feed-header-layout]');
        const panel = element.querySelector('[data-group-panel]');
        return (
          header != null &&
          panel != null &&
          panel.getBoundingClientRect().top >= header.getBoundingClientRect().bottom
        );
      }),
    ).toBe(true);
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(before);
  });
});
