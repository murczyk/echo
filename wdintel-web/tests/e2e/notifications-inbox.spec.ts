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
  await expect(page.getByLabel('Вхідні')).toBeVisible();
  await expect(page.getByLabel('Вхідні')).toContainText('1');
  await page.getByLabel('Вхідні').click();
  await expect(page.getByRole('heading', { name: 'Вхідні' })).toBeVisible();
  await expect(page.getByTestId('notification-inbox-item')).toHaveAttribute(
    'href',
    '/rer-analysis-neo?m=inbox-e2e-message',
  );
  await expect(page.getByTestId('notification-inbox-item')).toHaveAttribute('target', '_blank');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
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
  await expect(page.getByTestId('notification-unread-dot')).toHaveCount(1);
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
  await expect(page.getByRole('heading', { name: 'Сповістити всіх?' })).toBeVisible();
  const notifyGroup = page.getByRole('checkbox', { name: 'Сповістити всіх?' });
  await expect(notifyGroup).not.toBeChecked();
  await notifyGroup.check();
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
  await page.getByTestId('notification-inbox-item').first().click();
  const destination = await popup;
  await destination.waitForLoadState();

  await expect.poll(() => reads).toBe(1);
  await expect(destination).toHaveURL(/\/rer-analysis-neo\?m=inbox-e2e-message/);
  const panel = page.locator('section[aria-label="Вхідні"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('button[aria-label="Вхідні"]')).toBeVisible();
  await expect(page.locator('button[aria-label="Вхідні"] .MuiBadge-badge')).toBeHidden();
  await expect(panel.locator('a')).toHaveCount(1);
  await expect(panel.getByTestId('notification-unread-dot')).toHaveCount(0);
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

test('#3610 inbox renders normalized quotations and three complete rows @smoke', async ({
  page,
}) => {
  const longQuote = `\r\n  \r\n${'Довгий перший рядок для перевірки обрізання. '.repeat(12)}\r\n\t\r\nДругий рядок\r\nТретій рядок\r\nЧетвертий рядок`;
  const items = Array.from({ length: 5 }, (_, index) => ({
    ...item,
    receipt_id: `00000000-0000-7000-8000-00000000010${index}`,
    event_id: `00000000-0000-7000-8000-00000000011${index}`,
    group_name: `Test group ${index + 1}`,
    created_at: item.created_at - index,
    read_at: index === 4 ? item.created_at : null,
    quote: {
      ...item.quote,
      message_id: 101 + index,
      message_uid: `inbox-e2e-message-${index}`,
      text:
        index === 0
          ? longQuote
          : index === 3
            ? ' \r\n\t'
            : `Inbox notification fixture ${index + 1}`,
      attachments_count: index === 3 ? 2 : 0,
    },
  }));
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: 4 } }),
  );
  await page.route('**/api/notifications/list', (route) =>
    route.fulfill({
      json: {
        items,
        unread_count: 4,
        next_cursor: null,
        mark_all_boundary: '00000000-0000-7000-8000-000000000031',
        removed_receipt_ids: [],
      },
    }),
  );

  await page.goto('/rer-analysis-neo');
  await page.getByLabel('Вхідні').click();
  const panel = page.locator('section[aria-label="Вхідні"]');
  await expect(panel.getByTestId('notification-inbox-item')).toHaveCount(5);
  await expect(panel.getByTestId('notification-unread-dot')).toHaveCount(4);
  const listMetrics = await panel.getByTestId('notification-list').evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight,
  }));
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  const quote = panel.getByTestId('notification-quote').first();
  const dimensions = await quote.evaluate((element) => {
    const style = window.getComputedStyle(element);
    return {
      clientHeight: element.clientHeight,
      display: style.display,
      lineHeight: Number.parseFloat(style.lineHeight),
      overflow: style.overflow,
      scrollHeight: element.scrollHeight,
      webkitLineClamp: style.webkitLineClamp,
    };
  });
  expect(dimensions.display).not.toBe('block');
  expect(dimensions.webkitLineClamp).toBe('3');
  expect(dimensions.overflow).toBe('hidden');
  expect(dimensions.scrollHeight).toBeGreaterThan(dimensions.clientHeight);
  expect(dimensions.clientHeight).toBeLessThanOrEqual(dimensions.lineHeight * 3 + 1);
  await expect(quote).toContainText('Другий рядок\nТретій рядок …');
  await expect(panel.getByTestId('notification-quote').nth(3)).toHaveText('Вкладення (2)');
  const mentionTypography = await panel
    .getByTestId('notification-mention')
    .first()
    .evaluate((element) => {
      const style = window.getComputedStyle(element);
      return { fontSize: style.fontSize, lineHeight: style.lineHeight };
    });
  expect(mentionTypography).toEqual({ fontSize: '14px', lineHeight: '20px' });
  const rowBoxes = await panel
    .getByTestId('notification-inbox-item')
    .evaluateAll((rows) => rows.map((row) => row.getBoundingClientRect().toJSON()));
  const listBox = await panel.getByTestId('notification-list').boundingBox();
  expect(listBox).not.toBeNull();
  expect(rowBoxes[2].bottom).toBeLessThanOrEqual(listBox!.y + listBox!.height + 1);
  expect(rowBoxes[3].y).toBeGreaterThanOrEqual(listBox!.y + listBox!.height - 2);
  await expect(panel.getByTestId('notification-inbox-item').first()).toHaveAttribute(
    'href',
    '/rer-analysis-neo?m=inbox-e2e-message-0',
  );
});

test('#3610 inbox measures row counts without moving its open viewport @smoke', async ({
  page,
}) => {
  let visibleItems = [item];
  await installAnalysisNeoApiMocks(page);
  await page.route('**/api/notifications/unread-count', (route) =>
    route.fulfill({ json: { unread_count: visibleItems.length } }),
  );
  await page.route('**/api/notifications/list', (route) =>
    route.fulfill({
      json: {
        items: visibleItems,
        unread_count: visibleItems.length,
        next_cursor: null,
        mark_all_boundary: '00000000-0000-7000-8000-000000000031',
        removed_receipt_ids: [],
      },
    }),
  );
  await page.route('**/api/notifications/read', (route) => route.fulfill({ json: {} }));
  await page.setViewportSize({ width: 1280, height: 900 });

  for (const count of [1, 2, 3, 5]) {
    visibleItems = Array.from({ length: count }, (_, index) => ({
      ...item,
      receipt_id: `00000000-0000-7000-8000-00000000020${index}`,
      event_id: `00000000-0000-7000-8000-00000000021${index}`,
      created_at: item.created_at - index,
      quote: { ...item.quote, message_uid: `inbox-height-${index}` },
    }));
    await page.goto('/rer-analysis-neo');
    await page.getByLabel('Вхідні').click();
    const panel = page.locator('section[aria-label="Вхідні"]');
    const list = panel.getByTestId('notification-list');
    await expect(panel.getByTestId('notification-inbox-item')).toHaveCount(count);
    await expect
      .poll(() =>
        list.evaluate((element) => {
          const rowHeight = Array.from(
            element.querySelectorAll<HTMLElement>('[data-testid="notification-inbox-item"]'),
          )
            .slice(0, 3)
            .reduce((sum, row) => sum + row.offsetHeight, 0);
          return Math.abs(element.clientHeight - rowHeight);
        }),
      )
      .toBeLessThanOrEqual(1);
    const rowHeights = await panel
      .getByTestId('notification-inbox-item')
      .evaluateAll((rows) => rows.slice(0, 3).map((row) => row.offsetHeight));
    const listMetrics = await list.evaluate((element) => ({
      clientHeight: element.clientHeight,
      scrollHeight: element.scrollHeight,
    }));
    expect(
      Math.abs(listMetrics.clientHeight - rowHeights.reduce((sum, height) => sum + height, 0)),
    ).toBeLessThanOrEqual(1);
    expect(listMetrics.scrollHeight - listMetrics.clientHeight > 1).toBe(count > 3);

    if (count === 5) {
      await list.evaluate((element) => {
        element.scrollTop = 24;
      });
      const geometry = await list.evaluate((element) => ({
        clientHeight: element.clientHeight,
        scrollTop: element.scrollTop,
      }));
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect
        .poll(() => list.evaluate((element) => element.clientHeight))
        .toBe(geometry.clientHeight);
      await expect
        .poll(() => list.evaluate((element) => element.scrollTop))
        .toBe(geometry.scrollTop);
      const popup = page.waitForEvent('popup');
      await panel.getByTestId('notification-inbox-item').first().click();
      await popup;
      await expect(panel).toBeVisible();
      await expect(panel.getByTestId('notification-unread-dot')).toHaveCount(4);
      await expect
        .poll(() => list.evaluate((element) => element.clientHeight))
        .toBe(geometry.clientHeight);
      const closingHeight = await list.evaluate(
        (element) =>
          new Promise<number>((resolve) => {
            const backdrop = document.querySelector<HTMLElement>(
              '.MuiPopover-root .MuiBackdrop-root',
            )!;
            backdrop.addEventListener(
              'click',
              () => window.requestAnimationFrame(() => resolve(element.clientHeight)),
              { once: true },
            );
            backdrop.click();
          }),
      );
      expect([0, geometry.clientHeight]).toContain(closingHeight);
      await expect(panel).not.toBeVisible();
      await page.getByLabel('Вхідні').click();
      await expect(panel).toBeVisible();
      await expect
        .poll(() => list.evaluate((element) => element.clientHeight))
        .toBe(geometry.clientHeight);
    }
  }

  await page.setViewportSize({ width: 360, height: 360 });
  await page.goto('/rer-analysis-neo');
  await page.getByLabel('Вхідні').click();
  const narrowList = page.locator('section[aria-label="Вхідні"]').getByTestId('notification-list');
  const narrowBox = await narrowList.boundingBox();
  expect(narrowBox).not.toBeNull();
  expect(narrowBox!.y + narrowBox!.height).toBeLessThanOrEqual(352);
});
