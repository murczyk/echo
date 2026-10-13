import { expect, test } from '@playwright/test';
import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const item = {
  receipt_id: '00000000-0000-7000-8000-000000000001',
  event_id: '00000000-0000-7000-8000-000000000011',
  actor_id: '00000000-0000-7000-8000-000000000021',
  actor_login: 'operator',
  group_name: 'Test group',
  created_at: 1_720_000_000_000,
  read_at: null,
  quote: {
    message_id: 101,
    message_uuid: null,
    message_uid: 'inbox-e2e-message',
    text: 'Inbox notification fixture',
    attachments_count: 0,
    media_file_names: [],
    coords: null,
  },
};

test('#3610 inbox loads its badge before opening and reuses the boundary while polling @smoke', async ({
  page,
}) => {
  await page.clock.install();
  await installAnalysisNeoApiMocks(page);
  const requests: Array<{ boundary_id: string | null }> = [];
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: 1 } }),
  );
  await page.route('**/api/notifications/list', (route) => {
    const request = route.request().postDataJSON() as { boundary_id: string | null };
    requests.push(request);
    return route.fulfill({
      json: {
        items: [item],
        unread_count: 1,
        next_cursor: null,
        mark_all_boundary: '00000000-0000-7000-8000-000000000031',
        removed_receipt_ids: [],
      },
    });
  });

  await page.goto('/rer-analysis-neo');
  await expect(page.getByLabel('Вхідні')).toContainText('1');
  await page.getByLabel('Вхідні').click();
  await expect(page.getByRole('heading', { name: 'Вхідні (1)' })).toBeVisible();
  await expect(page.locator('a.font-medium')).toHaveAttribute(
    'href',
    '/rer-analysis-neo?m=inbox-e2e-message',
  );
  await expect(page.locator('a.font-medium')).toHaveAttribute('target', '_blank');
  await page.clock.fastForward(30_000);
  await expect.poll(() => requests.length).toBeGreaterThanOrEqual(2);
  expect(requests[1].boundary_id).toBe('00000000-0000-7000-8000-000000000031');
});

test('#3610 expired mark-all keeps rows unread and refreshes the snapshot @smoke', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page);
  let lists = 0;
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: 1 } }),
  );
  await page.route('**/api/notifications/list', (route) => {
    lists += 1;
    return route.fulfill({
      json: {
        items: [item],
        unread_count: 1,
        next_cursor: null,
        mark_all_boundary: `00000000-0000-7000-8000-00000000003${lists}`,
        removed_receipt_ids: [],
      },
    });
  });
  await page.route('**/api/notifications/read-all', (route) =>
    route.fulfill({
      json: {
        outcome: 'NotificationReadAllBoundaryExpired',
        unread_count: 1,
        receipt_ids: [],
      },
    }),
  );

  await page.goto('/rer-analysis-neo');
  await page.getByLabel('Вхідні').click();
  const markAll = page.getByRole('button', { name: 'Позначити всі як прочитані' });
  await expect(markAll).toBeEnabled();
  await markAll.click();
  await expect(page.getByText('Вхідні змінилися', { exact: false })).toBeVisible();
  await expect.poll(() => lists).toBeGreaterThanOrEqual(2);
  await expect(page.locator('a.font-medium')).toHaveCount(1);
});

test('#3610 analysis entry opens the notification dialog and submits its optional group flag @smoke', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, {
    inboxResponse: createLoadedInboxResponse(),
    signalGroups: ['analysis-summary-e2e-group'],
  });
  const requests: unknown[] = [];
  await page.route('**/api/rer/important/add', async (route) => {
    requests.push(route.request().postDataJSON());
    await route.fulfill({ json: { important: true } });
  });

  await page.goto('/rer-analysis-neo');
  await page.getByRole('button', { name: 'Позначити як важливе' }).click();
  await expect(page.getByRole('heading', { name: 'Хочете сповістити групу?' })).toBeVisible();
  await expect(page.getByLabel('Сповістити всіх?')).not.toBeChecked();
  await page.getByLabel('Сповістити всіх?').check();
  await page.getByRole('button', { name: 'Позначити', exact: true }).click();

  await expect.poll(() => requests.length).toBe(1);
  expect(requests[0]).toMatchObject({
    message_id: 101,
    group_master_key: 'analysis-summary-e2e-group',
    notify_group: true,
  });
});

test('#3610 opening the last unread receipt clears its badge and retains panel history @smoke', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page);
  let unreadCount = 1;
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: unreadCount } }),
  );
  await page.route('**/api/notifications/list', (route) =>
    route.fulfill({
      json: {
        items: [item],
        unread_count: unreadCount,
        next_cursor: null,
        mark_all_boundary: '00000000-0000-7000-8000-000000000031',
        removed_receipt_ids: [],
      },
    }),
  );
  let reads = 0;
  await page.route('**/api/notifications/read', (route) => {
    reads += 1;
    unreadCount = 0;
    return route.fulfill({ json: {} });
  });

  await page.goto('/rer-analysis-neo');
  await page.getByLabel('Вхідні').click();
  const popup = page.waitForEvent('popup');
  await page.locator('a.font-medium').first().click();
  const destination = await popup;
  await destination.waitForLoadState();

  await expect.poll(() => reads).toBe(1);
  await expect(destination).toHaveURL(/\/rer-analysis-neo\?m=inbox-e2e-message/);
  const panel = page.locator('section[aria-label="Вхідні"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('button[aria-label="Вхідні"]')).toBeVisible();
  await expect(page.locator('button[aria-label="Вхідні"] .MuiBadge-badge')).toBeHidden();
  await expect(panel.locator('a')).toHaveCount(1);
  await expect(panel.locator('a.font-medium')).toHaveCount(0);
  await expect(panel.getByText('Немає непрочитаних згадок')).toBeVisible();
});

test('#3610 inbox links remain keyboard-accessible on a narrow viewport @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: 1 } }),
  );
  await page.route('**/api/notifications/list', (route) =>
    route.fulfill({
      json: {
        items: [item],
        unread_count: 1,
        next_cursor: null,
        mark_all_boundary: '00000000-0000-7000-8000-000000000031',
        removed_receipt_ids: [],
      },
    }),
  );
  await page.route('**/api/notifications/read', (route) =>
    route.fulfill({ json: { unread_count: 0 } }),
  );

  await page.goto('/rer-analysis-neo');
  await page.getByLabel('Вхідні').click();
  const link = page.locator('section[aria-label="Вхідні"] a').first();
  await link.focus();
  await expect(link).toBeFocused();
  const popup = page.waitForEvent('popup');
  await page.keyboard.press('Enter');
  await expect(await popup).toHaveURL(/\/rer-analysis-neo\?m=inbox-e2e-message/);
});
