import { expect, test, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const groups = [
  { masterKey: 'group-a', name: 'Group Alpha', unreadCount: 2, colorKey: 'blue' },
  { masterKey: 'group-b', name: 'Group Beta', unreadCount: 3, colorKey: 'deep_purple' },
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
  let stateRequestCount = 0;
  await page.route('**/api/rer-importer/group-feed-state', (route) => {
    stateRequestCount += 1;
    return route.fulfill({
      json: {
        groups: groups.map((group, index) => ({
          master_key: group.masterKey,
          name: group.name,
          color_key: group.colorKey,
          ignore_operativny: false,
          unread_count: group.unreadCount,
          oldest_unread_message_ref: null,
          last_activity_at: 1_720_000_100_000 - index,
          latest_cursor: null,
        })),
      },
    });
  });
  return { inboxRequests, getStateRequestCount: () => stateRequestCount };
}

test.describe('Duty group feed navigation', () => {
  test('hides only the source unread divider after a successful message submission', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1920, height: 900 });
    await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({
        json: {
          groups: groups.map((group, index) => ({
            master_key: group.masterKey,
            name: group.name,
            color_key: group.colorKey,
            ignore_operativny: false,
            unread_count: group.unreadCount,
            oldest_unread_message_ref: `group-feed-${index === 0 ? 101 : 201}`,
            last_read_created_at_order: null,
            last_read_message_id: null,
            last_activity_at: null,
            latest_cursor: null,
          })),
        },
      }),
    );
    let submissions = 0;
    await page.route('**/api/1.1/submit-direct', (route) => {
      submissions += 1;
      return submissions === 1
        ? route.fulfill({ status: 500, json: { error: 'Creation failed' } })
        : route.fulfill({ json: { signal_message_id: 301 } });
    });
    const state = {
      messageFeeds: [
        ['mf-a', {}, { groupScopeMasterKey: 'group-a' }],
        ['mf-b', {}, { groupScopeMasterKey: 'group-b' }],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const first = page.locator('[data-duty-feed-column][data-duty-feed-id="mf-a"]');
    const second = page.locator('[data-duty-feed-column][data-duty-feed-id="mf-b"]');
    const divider = '[data-duty-unread-divider]';
    await expect(first.locator(divider)).toBeVisible();
    await expect(second.locator(divider)).toBeVisible();
    await first.getByRole('button', { name: 'Додати повідомлення' }).click();
    await page.getByRole('textbox', { name: 'Текст повідомлення' }).fill('Own new message');
    const submit = page.getByRole('button', { name: 'Створити', exact: true });
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect.poll(() => submissions).toBe(1);
    await expect(submit).toBeEnabled();
    await expect(first.locator(divider)).toBeVisible();
    await expect(second.locator(divider)).toBeVisible();
    await submit.click();
    await expect.poll(() => submissions).toBe(2);
    await expect(first.locator(divider)).toHaveCount(0);
    await expect(second.locator(divider)).toBeVisible();
    await first.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(first.getByRole('button', { name: /Group Alpha, 2 непрочитаних/ })).toBeVisible();
  });

  test('places the unread divider when filters exclude the globally oldest unread message', async ({
    page,
  }) => {
    await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({
        json: {
          groups: [
            {
              master_key: 'group-b',
              name: 'Group Beta',
              color_key: 'deep_purple',
              ignore_operativny: false,
              unread_count: 2,
              oldest_unread_message_ref: 'group-feed-200',
              last_read_created_at_order: 1_720_000_199_000_000,
              last_read_message_id: 9999,
              last_activity_at: 1_720_000_201_000,
              latest_cursor: { created_at: 1_720_000_201_000, message_id: 201 },
            },
          ],
        },
      }),
    );
    await page.route('**/api/rer-importer/get-inbox', (route) =>
      route.fulfill({
        json: {
          ...inboxResponse(['group-b']),
          inbox_items: [
            [
              201,
              { ...message(201, 'group-b', 'Filtered unread message'), sender: 'sender-match' },
            ],
          ],
        },
      }),
    );
    const state = {
      messageFeeds: [
        ['mf-filtered', { sendersSelected: ['sender-match'] }, { groupScopeMasterKey: 'group-b' }],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    await expect(page.getByText('Filtered unread message')).toBeVisible();
    await expect(
      page.locator('[data-duty-message-id="201"] [data-duty-unread-divider]'),
    ).toBeVisible();
    await expect(page.locator('[data-message-feed-highlighted]')).toHaveCount(0);
  });

  test('records reading for every accessible membership of a shared message', async ({ page }) => {
    await installGroupNavigationMocks(page);
    const unread = new Set(['group-a', 'group-b']);
    const groupState = (masterKey: string) => ({
      master_key: masterKey,
      name: masterKey === 'group-a' ? 'Group Alpha' : 'Group Beta',
      color_key: 'blue',
      ignore_operativny: false,
      unread_count: unread.has(masterKey) ? 1 : 0,
      oldest_unread_message_ref: null,
      last_activity_at: 1_720_000_201_000,
      latest_cursor: { created_at: 1_720_000_201_000, message_id: 201 },
    });
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({ json: { groups: groups.map((group) => groupState(group.masterKey)) } }),
    );
    await page.route('**/api/rer-importer/get-inbox', (route) =>
      route.fulfill({
        json: {
          ...inboxResponse(['group-b']),
          inbox_items: [
            [
              201,
              {
                ...message(201, 'group-a', 'Shared group message'),
                group_master_keys: ['group-a', 'group-b', 'inaccessible-group'],
              },
            ],
          ],
        },
      }),
    );
    const acknowledgements: string[] = [];
    await page.route('**/api/rer-importer/group-feed-state/acknowledge', (route) => {
      const request = route.request().postDataJSON();
      acknowledgements.push(request.master_key);
      unread.delete(request.master_key);
      return route.fulfill({ json: groupState(request.master_key) });
    });
    await page.goto('/rer-duty-neo');
    await expect(page.getByText('Shared group message')).toBeVisible();
    await expect.poll(() => [...acknowledgements].sort()).toEqual(['group-a', 'group-b']);
  });

  test('records reading with all groups selected while navigation is closed', async ({
    page,
  }, testInfo) => {
    await installGroupNavigationMocks(page);
    let unreadCount = 1;
    let acknowledgeCount = 0;
    let releaseStates!: () => void;
    const statesGate = new Promise<void>((resolve) => {
      releaseStates = resolve;
    });
    const groupState = () => ({
      master_key: 'group-b',
      name: 'Group Beta',
      color_key: 'deep_purple',
      ignore_operativny: false,
      unread_count: unreadCount,
      oldest_unread_message_ref: 'group-feed-201',
      last_activity_at: 1_720_000_201_000,
      latest_cursor: { created_at: 1_720_000_201_000, message_id: 201 },
    });
    await page.route('**/api/rer-importer/group-feed-state', async (route) => {
      await statesGate;
      await route.fulfill({ json: { groups: [groupState()] } });
    });
    await page.route('**/api/rer-importer/group-feed-state/acknowledge', (route) => {
      const request = route.request().postDataJSON();
      expect(request.master_key).toBe('group-b');
      expect(request.cursor.message_id).toBe(201);
      acknowledgeCount += 1;
      unreadCount = 0;
      return route.fulfill({ json: groupState() });
    });
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    await expect(column.locator('[data-group-panel]')).toHaveCount(0);
    await expect(column.getByText('Beta-only message')).toBeVisible();
    releaseStates();
    await expect.poll(() => acknowledgeCount).toBe(1);
    await expect(column.getByRole('separator', { name: 'Непрочитані повідомлення' })).toBeVisible();
    await expect(
      column.locator('[data-duty-message-id="201"] [data-duty-unread-divider]'),
    ).toHaveCount(1);
    await expect(column.locator('[data-message-feed-highlighted]')).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await expect(column).toHaveCSS('max-width', width === 390 ? '100%' : '960px');
      await expect(
        column.getByRole('separator', { name: 'Непрочитані повідомлення' }),
      ).toBeVisible();
      await page.screenshot({ path: testInfo.outputPath(`unread-divider-${width}.png`) });
    }
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(column.getByRole('button', { name: 'Group Beta', exact: true })).toBeVisible();
  });

  test('does not use other groups unread counts for the all-groups badge', async ({ page }) => {
    await installGroupNavigationMocks(page);
    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(column.getByRole('button', { name: 'Всі групи', exact: true })).toBeVisible();
  });

  test('returns to all groups when the selected Duty group is no longer accessible', async ({
    page,
  }) => {
    let accessible = true;
    await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({
        json: {
          groups: groups
            .filter((group) => accessible || group.masterKey !== 'group-a')
            .map((group) => ({
              master_key: group.masterKey,
              name: group.name,
              color_key: group.colorKey,
              ignore_operativny: false,
              unread_count: group.unreadCount,
              oldest_unread_message_ref: null,
              last_activity_at: null,
              latest_cursor: null,
            })),
        },
      }),
    );
    const state = {
      messageFeeds: [['mf-a', {}, { groupScopeMasterKey: 'group-a' }]],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const column = page.locator('[data-duty-feed-column]');
    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Group Alpha');
    accessible = false;
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 101, origin: null, intelligenceReport: false }] },
        }),
      ),
    );
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Всі групи');
    await expect(page.getByText('Обрана група більше недоступна.')).toBeVisible();
  });

  test('hides Duty-excluded groups from the navigation list', async ({ page }) => {
    await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({
        json: {
          groups: groups.map((group) => ({
            master_key: group.masterKey,
            name: group.name,
            color_key: group.colorKey,
            ignore_operativny: group.masterKey === 'group-b',
            unread_count: group.unreadCount,
            oldest_unread_message_ref: null,
            last_activity_at: null,
            latest_cursor: null,
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

    const state = {
      messageFeeds: [['mf-hidden', {}, { groupScopeMasterKey: 'group-b' }]],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Всі групи');
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
    await expect.poll(mocks.getStateRequestCount).toBe(1);
  });

  test('retries a closed-list name lookup interrupted by an inbox update', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await installGroupNavigationMocks(page);
    let stateRequestCount = 0;
    let releaseFirstRequest!: () => void;
    const firstRequestGate = new Promise<void>((resolve) => {
      releaseFirstRequest = resolve;
    });
    await page.route('**/api/rer-importer/group-feed-state', async (route) => {
      stateRequestCount += 1;
      if (stateRequestCount === 1) await firstRequestGate;
      await route
        .fulfill({
          json: {
            groups: groups.map((group) => ({
              master_key: group.masterKey,
              name: group.name,
              color_key: group.colorKey,
              ignore_operativny: false,
              unread_count: group.unreadCount,
              oldest_unread_message_ref: null,
              last_activity_at: null,
              latest_cursor: null,
            })),
          },
        })
        .catch(() => {});
    });
    const state = {
      messageFeeds: [['mf-race', {}, { groupScopeMasterKey: 'group-b' }]],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const column = page.locator('[data-duty-feed-column]');
    await expect.poll(() => stateRequestCount).toBe(1);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: { events: [{ messageId: 201, origin: null, intelligenceReport: false }] },
        }),
      ),
    );
    releaseFirstRequest();
    await expect.poll(() => stateRequestCount).toBe(2);
    await expect(column.locator('[data-group-panel]')).toHaveCount(0);
    await expect(column.locator('[data-group-island] [data-group-name]')).toHaveText('Group Beta');
  });

  test('keeps independent column scopes, aggregate filters, and scoped create actions', async ({
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
    await expect.poll(mocks.getStateRequestCount).toBe(1);

    const firstIsland = columns.nth(0).locator('[data-group-island]');
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
    await columns
      .nth(0)
      .getByRole('button', { name: /Group Alpha, 2 непрочитаних/ })
      .click();
    await expect(columns.nth(0).getByText('Alpha-only message')).toBeVisible();
    await expect(columns.nth(0).getByText('Beta-only message')).toHaveCount(0);
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();
    const scopedFilterPanel = columns.nth(0).getByLabel('Панель фільтрів');
    await expect(scopedFilterPanel).toBeVisible();
    await expect(scopedFilterPanel.getByText('Групи', { exact: true })).toHaveCount(0);
    await columns.nth(0).getByRole('button', { name: 'Фільтри' }).click();

    await columns.nth(1).getByRole('button', { name: 'Розгорнути список груп' }).click();
    await columns
      .nth(1)
      .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
      .click();
    await expect(columns.nth(1).getByText('Beta-only message')).toBeVisible();
    await expect(columns.nth(1).getByText('Alpha-only message')).toHaveCount(0);
    expect(mocks.getStateRequestCount()).toBeGreaterThan(0);

    await columns.nth(0).getByRole('button', { name: 'Розгорнути список груп' }).click();
    await columns
      .nth(0)
      .getByRole('button', { name: /Всі групи/ })
      .click();
    await expect(columns.nth(0).getByText('Alpha-only message')).toBeVisible();
    await expect(columns.nth(0).getByText('Beta-only message')).toBeVisible();
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
    await columns
      .nth(0)
      .getByRole('button', { name: /Group Alpha, 2 непрочитаних/ })
      .click();
    await columns.nth(0).hover();
    const firstCreate = columns.nth(0).getByRole('button', { name: 'Додати повідомлення' });
    await expect(firstCreate).toBeVisible();
    await firstCreate.click();
    await expect(page.getByRole('combobox', { name: 'Група', exact: true })).toHaveValue('group-a');
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

  test('cancels stale first-unread navigation when another group is selected', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 800 });
    const mocks = await installGroupNavigationMocks(page);
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({
        json: {
          groups: groups.map((group, index) => ({
            master_key: group.masterKey,
            name: group.name,
            ignore_operativny: false,
            unread_count: group.unreadCount,
            oldest_unread_message_ref: `first-unread-${group.masterKey}`,
            last_activity_at: 1_720_000_100_000 - index,
            latest_cursor: null,
          })),
        },
      }),
    );
    let releaseGroupA!: () => void;
    const delayedGroupA = new Promise<void>((resolve) => {
      releaseGroupA = resolve;
    });
    await page.route('**/api/rer-importer/inbox-item-context', async (route) => {
      const reference = route.request().postDataJSON().message_uid as string;
      const groupMasterKey = reference.endsWith('group-a') ? 'group-a' : 'group-b';
      if (groupMasterKey === 'group-a') await delayedGroupA;
      await route
        .fulfill({
          json: {
            message: [
              groupMasterKey === 'group-a' ? 101 : 201,
              message(
                groupMasterKey === 'group-a' ? 101 : 201,
                groupMasterKey,
                `${groupMasterKey} target`,
              ),
            ],
            group_master_keys: [groupMasterKey],
            sigint_inbox_item_ids: [groupMasterKey === 'group-a' ? 101 : 201],
            since_ts: null,
            till_ts: null,
          },
        })
        .catch(() => {});
    });
    await page.route('**/api/rer-importer/messages-by-id-with-metadata', (route) =>
      route.fulfill({ json: inboxResponse(['group-b']) }),
    );

    await page.goto('/rer-duty-neo');
    const column = page.locator('[data-duty-feed-column]');
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await column.getByRole('button', { name: /Group Alpha, 2 непрочитаних/ }).click();
    await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
    await column.getByRole('button', { name: /Group Beta, 3 непрочитаних/ }).click();
    await expect(column.locator('[data-group-name]').first()).toHaveText('Group Beta');
    releaseGroupA();
    await expect(column.getByText('Beta-only message')).toBeVisible();
    await expect(column.locator('[data-message-feed-highlighted]')).toHaveCount(0);
    expect(
      mocks.inboxRequests.some(
        (request) => JSON.stringify(request.selected_groups) === JSON.stringify(['group-a']),
      ),
    ).toBe(false);
  });
});
