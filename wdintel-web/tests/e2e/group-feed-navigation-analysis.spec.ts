import { expect, test, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const groups = [
  { masterKey: 'group-a', name: 'Group Alpha', unreadCount: 2 },
  { masterKey: 'group-b', name: 'Group Beta', unreadCount: 3 },
];

function message(id: number, groupMasterKey: string, text: string): InboxMessage {
  return minimalInboxMessage({
    messageUid: `analysis-group-feed-${id}`,
    text,
    timestamp: 1_720_000_000_000 + id * 1_000,
    createdAt: 1_720_000_000_000 + id * 1_000,
    groupMasterKey,
  });
}

function inboxResponse(selectedGroups: string[] | null): InboxMessagesRspRaw {
  const selected = selectedGroups ?? groups.map(({ masterKey }) => masterKey);
  const inboxItems = [
    selected.includes('group-a') ? [101, message(101, 'group-a', 'Analysis Alpha message')] : null,
    selected.includes('group-b') ? [201, message(201, 'group-b', 'Analysis Beta message')] : null,
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
  await installAnalysisNeoApiMocks(page, {
    signalGroups: groups.map(({ masterKey }) => masterKey),
    inboxResponse: inboxResponse(null),
  });
  const inboxRequests: Array<{ selected_groups?: string[] | null }> = [];
  await page.route('**/api/rer-importer/get-inbox', (route) => {
    const request = route.request().postDataJSON() as { selected_groups?: string[] | null };
    inboxRequests.push(request);
    return route.fulfill({ json: inboxResponse(request.selected_groups ?? null) });
  });
  let stateRequestCount = 0;
  await page.route('**/api/rer-importer/group-feed-state', (route) => {
    stateRequestCount += 1;
    return route.fulfill({
      json: {
        groups: groups.map((group, index) => ({
          master_key: group.masterKey,
          name: group.name,
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

test.describe('Analysis group feed navigation', () => {
  test('keeps URL scope separate from aggregate filters and prefills create', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    const mocks = await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo?groups=group-a&groups=group-b');

    const groupList = page.locator('[data-analysis-group-list]:visible').first();
    await expect(groupList).toBeVisible();
    await groupList.getByRole('button', { name: /Group Beta, 3 непрочитаних/ }).click();
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);
    await expect(page.getByText('Analysis Beta message')).toBeVisible();
    await expect(page.getByText('Analysis Alpha message')).toHaveCount(0);
    await expect(page.locator('[data-section-id="Групи"]')).toHaveCount(0);
    await expect(page.locator('[data-group-island] [data-group-name]')).toHaveText('Group Beta');

    await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    await expect(page.getByRole('button', { name: 'Закрити ліву панель' })).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: /Група/ })).toHaveValue('group-b');
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);

    await page.reload();
    await expect(page).toHaveURL(/(?:\?|&)group=group-b(?:&|$)/);
    await expect(page.locator('[data-group-island] [data-group-name]')).toHaveText('Group Beta');
    await expect(page.getByText('Analysis Beta message')).toBeVisible();

    await page.locator('[data-group-island]').click();
    await page
      .locator('[data-analysis-group-list]:visible')
      .first()
      .getByRole('button', { name: /Всі групи, 5 непрочитаних/ })
      .click();
    await expect(page).not.toHaveURL(/(?:\?|&)group=/);
    await expect(page.locator('[data-section-id="Групи"]:visible').first()).toBeVisible();
    expect(
      mocks.inboxRequests.some(
        (request) =>
          JSON.stringify(request.selected_groups) === JSON.stringify(['group-a', 'group-b']),
      ),
    ).toBe(true);
    expect(mocks.getStateRequestCount()).toBeGreaterThan(0);
  });

  test('opens the mobile list over the feed and preserves its scroll position', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await installGroupNavigationMocks(page);
    await page.goto('/rer-analysis-neo');
    await expect(page.locator('[data-analysis-group-list]')).toHaveCount(0);
    const scroller = page.locator('[data-analysis-message-scroller]');
    await scroller.evaluate((element) => {
      element.scrollTop = 23;
    });
    const before = await scroller.evaluate((element) => element.scrollTop);

    await page.locator('[data-group-island]').click();
    await expect(page.locator('[data-analysis-group-list]')).toBeVisible();
    await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(before);
  });

  for (const newestFirst of [true, false]) {
    test(`opens the oldest unread message with newestFirst=${newestFirst}`, async ({ page }) => {
      await page.setViewportSize({ width: 1500, height: 900 });
      await installGroupNavigationMocks(page);
      await page.route('**/api/rer-importer/group-feed-state', (route) =>
        route.fulfill({
          json: {
            groups: groups.map((group, index) => ({
              master_key: group.masterKey,
              name: group.name,
              ignore_operativny: false,
              unread_count: group.unreadCount,
              oldest_unread_message_ref:
                group.masterKey === 'group-b' ? 'analysis-group-feed-201' : null,
              last_activity_at: 1_720_000_100_000 - index,
              latest_cursor: null,
            })),
          },
        }),
      );
      await page.goto('/rer-analysis-neo');
      if (!newestFirst) {
        await page.getByRole('checkbox', { name: 'спочатку нові' }).click();
      }

      await page
        .locator('[data-analysis-group-list]:visible')
        .first()
        .getByRole('button', { name: /Group Beta, 3 непрочитаних/ })
        .click();

      const target = page.locator('[data-message-id="201"]');
      await expect(target).toBeVisible();
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
    });
  }
});
