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
  test('keeps independent column scopes, aggregate filters, and scoped create actions', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
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
    expect(mocks.getStateRequestCount()).toBe(0);

    await columns.nth(0).locator('[data-group-island]').click();
    await expect(columns.nth(0).locator('[data-group-panel]')).toBeVisible();
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

    await columns.nth(1).locator('[data-group-island]').click();
    await columns
      .nth(1)
      .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
      .click();
    await expect(columns.nth(1).getByText('Beta-only message')).toBeVisible();
    await expect(columns.nth(1).getByText('Alpha-only message')).toHaveCount(0);
    expect(mocks.getStateRequestCount()).toBeGreaterThan(0);

    await columns.nth(0).locator('[data-group-island]').click();
    await columns
      .nth(0)
      .getByRole('button', { name: /Всі групи, 5 непрочитаних/ })
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

    await columns.nth(0).locator('[data-group-island]').click();
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

    await column.locator('[data-group-island]').click();
    await expect(column.locator('[data-group-panel][data-variant="overlay"]')).toBeVisible();
    await expect(column.locator('[data-group-panel-backdrop]')).toBeVisible();
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
    await column.locator('[data-group-island]').click();
    await column.getByRole('button', { name: /Group Alpha, 2 непрочитаних/ }).click();
    await column.locator('[data-group-island]').click();
    await column.getByRole('button', { name: /Group Beta, 3 непрочитаних/ }).click();
    await expect(column.locator('[data-group-name]').first()).toHaveText('Group Beta');
    releaseGroupA();
    await expect(column.getByText('Beta-only message')).toBeVisible();
    expect(
      mocks.inboxRequests.some(
        (request) => JSON.stringify(request.selected_groups) === JSON.stringify(['group-a']),
      ),
    ).toBe(false);
  });
});
