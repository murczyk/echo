import { expect, test, type Locator, type Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const groupMasterKey = 'group-a';
const groupName = 'Group Alpha';
const cursor = { created_at: 1_720_000_140_000, message_id: 140 };

function message(id = 101): InboxMessage {
  return minimalInboxMessage({
    messageUid: `shared-unread-message-${id}`,
    text: `Shared unread message ${id}`,
    timestamp: 1_720_000_000_000 + id * 1_000,
    createdAt: 1_720_000_000_000 + id * 1_000,
    groupMasterKey,
  });
}

function inboxResponse(): InboxMessagesRspRaw {
  return {
    inbox_items: Array.from({ length: 40 }, (_, index) => {
      const id = 101 + index;
      return [id, message(id)];
    }) as InboxMessagesRspRaw['inbox_items'],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 50,
  };
}

function stateResponse(unreadCount: number) {
  return {
    groups: [
      {
        master_key: groupMasterKey,
        name: groupName,
        ignore_operativny: false,
        unread_count: unreadCount,
        oldest_unread_message_ref: null,
        last_activity_at: cursor.created_at,
        latest_cursor: cursor,
      },
    ],
  };
}

async function dispatchInboxBurst(page: Page) {
  await page.evaluate(() => {
    for (let index = 0; index < 8; index += 1) {
      window.dispatchEvent(
        new CustomEvent('echo-inbox-changed', {
          detail: {
            events: [{ messageId: 101, origin: null, intelligenceReport: false }],
          },
        }),
      );
    }
  });
}

async function reachPhysicalTail(column: Locator) {
  const scroller = column.locator('[data-duty-feed-scroller="true"]');
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll'));
  });
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    element.dispatchEvent(new Event('scroll'));
  });
}

test('shares unread state across Duty and Analysis and clears it from an unfiltered tail', async ({
  context,
}) => {
  let unreadCount = 0;
  let acknowledgementCount = 0;
  const dutyPage = await context.newPage();
  const analysisPage = await context.newPage();
  await installRerDutyShortStateMocks(dutyPage, {
    signalGroups: [groupMasterKey],
    inboxResponseForRequest: () => inboxResponse(),
  });
  await installAnalysisNeoApiMocks(analysisPage, {
    signalGroups: [groupMasterKey],
    inboxResponse: inboxResponse(),
  });
  for (const page of [dutyPage, analysisPage]) {
    await page.route('**/api/rer-importer/group-feed-state/acknowledge', (route) => {
      acknowledgementCount += 1;
      unreadCount = 0;
      return route.fulfill({ json: stateResponse(unreadCount).groups[0] });
    });
    await page.route('**/api/rer-importer/group-feed-state', (route) =>
      route.fulfill({ json: stateResponse(unreadCount) }),
    );
  }

  await dutyPage.goto('/rer-duty-neo');
  await analysisPage.goto('/rer-analysis-neo');
  const dutyColumn = dutyPage.locator('[data-duty-feed-column]');
  await dutyColumn.locator('[data-group-island]').click();
  const dutyList = dutyColumn.locator('[data-group-panel]');
  const analysisList = analysisPage.locator('[data-analysis-group-list]:visible').first();
  await expect(dutyList.locator('[data-group-unread]')).toHaveCount(0);
  await expect(analysisList.locator('[data-group-unread]')).toHaveCount(0);

  unreadCount = 1;
  await dispatchInboxBurst(dutyPage);
  await dispatchInboxBurst(analysisPage);
  await expect(dutyList.getByRole('button', { name: /Group Alpha, 1 / })).toBeVisible();
  await expect(analysisList.getByRole('button', { name: /Group Alpha, 1 / })).toBeVisible();

  await dutyList.getByRole('button', { name: /Group Alpha, 1 / }).click();
  await reachPhysicalTail(dutyColumn);
  await expect.poll(() => acknowledgementCount).toBeGreaterThan(0);
  await dispatchInboxBurst(analysisPage);
  await expect(analysisList.locator('[data-group-unread]')).toHaveCount(0);
});

test('keeps a filtered Duty group unread at its visible tail', async ({ page }) => {
  let acknowledgementCount = 0;
  await installRerDutyShortStateMocks(page, {
    signalGroups: [groupMasterKey],
    inboxResponseForRequest: () => inboxResponse(),
  });
  await page.route('**/api/rer-importer/group-feed-state/acknowledge', (route) => {
    acknowledgementCount += 1;
    return route.fulfill({ json: stateResponse(0).groups[0] });
  });
  await page.route('**/api/rer-importer/group-feed-state', (route) =>
    route.fulfill({ json: stateResponse(1) }),
  );
  const state = { messageFeeds: [['mf-filtered', { freqsSelected: ['100'] }]] };
  await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
  const column = page.locator('[data-duty-feed-column]');
  await column.locator('[data-group-island]').click();
  await column.getByRole('button', { name: /Group Alpha, 1 / }).click();
  await reachPhysicalTail(column);
  await page.waitForTimeout(400);

  expect(acknowledgementCount).toBe(0);
});

test('coalesces visible Duty panels and stays silent while every panel is closed', async ({
  page,
}) => {
  let requestCount = 0;
  await installRerDutyShortStateMocks(page, {
    signalGroups: [groupMasterKey],
    inboxResponseForRequest: () => inboxResponse(),
  });
  await page.route('**/api/rer-importer/group-feed-state', (route) => {
    requestCount += 1;
    return route.fulfill({ json: stateResponse(1) });
  });
  const state = {
    messageFeeds: [
      ['mf-a', {}],
      ['mf-b', {}],
    ],
  };
  await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
  const columns = page.locator('[data-duty-feed-column]');

  await columns.nth(0).locator('[data-group-island]').click();
  await columns.nth(1).locator('[data-group-island]').click();
  await expect.poll(() => requestCount).toBe(1);

  await dispatchInboxBurst(page);
  await expect.poll(() => requestCount).toBe(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('[data-group-panel]')).toHaveCount(0);
  await dispatchInboxBurst(page);
  await page.waitForTimeout(400);
  expect(requestCount).toBe(2);
});

test('falls back to all groups after Analysis access is revoked', async ({ page }) => {
  let accessible = true;
  let stateRequestCount = 0;
  await installAnalysisNeoApiMocks(page, {
    signalGroups: [groupMasterKey],
    inboxResponse: inboxResponse(),
  });
  await page.route('**/api/rer-importer/group-feed-state', (route) => {
    stateRequestCount += 1;
    return route.fulfill({ json: accessible ? stateResponse(1) : { groups: [] } });
  });

  await page.goto('/rer-analysis-neo');
  const groupList = page.locator('[data-analysis-group-list]:visible').first();
  await expect(groupList).toBeVisible();
  await groupList.getByRole('button', { name: /Group Alpha/ }).click();
  await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
    groupName,
  );
  const initialRequestCount = stateRequestCount;
  accessible = false;
  await dispatchInboxBurst(page);

  await expect.poll(() => stateRequestCount).toBeGreaterThan(initialRequestCount);
  await expect(page).not.toHaveURL(/(?:\?|&)group=/, { timeout: 10_000 });
  await expect(page.getByText('Обрана група більше недоступна.')).toBeVisible();
  await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
    'Всі групи',
  );
});
