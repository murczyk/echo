import { expect, test } from '@playwright/test';
import {
  createMessage,
  divider,
  expectUnread,
  expectUnreadDivider,
  groupFeedPath,
  groupList,
  holdNext,
  row,
  selectGroup,
  settleResponse,
  viewMessage,
  withGroupFeedActors,
  type Actor,
  type Screen,
} from './group-feed-actors.fixtures';

type Fixture = Parameters<Parameters<typeof withGroupFeedActors>[2]>[0];

async function setVisible(actor: Actor, visible: boolean) {
  await actor.page.evaluate((value) => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: value ? 'visible' : 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
  }, visible);
}

function filteredPath(screen: Screen) {
  return screen === 'analysis'
    ? `${groupFeedPath(screen, 'group-1')}&senders=match`
    : `/rer-duty-neo?state=${encodeURIComponent(JSON.stringify({ messageFeeds: [['mf-0', { sendersSelected: ['match'] }, { groupScopeMasterKey: 'group-1' }]] }))}`;
}

for (const screen of ['analysis', 'duty'] as const) {
  function scenario(name: string, run: (fixture: Fixture, reader: Actor) => Promise<void>) {
    test(`@regression #3727 ${screen}: ${name}`, async ({ browser, baseURL }) => {
      await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
        await run(fixture, await fixture.attach(page, screen, 'user-2'));
      });
    });
  }

  scenario(
    'persists unread and read state across reload, route changes and another tab',
    async (fixture, reader) => {
      fixture.add('user-1', 'Persistent incoming message');
      await reader.page.goto(groupFeedPath(screen, 'group-2'));
      await expectUnread(reader, 'group-1', 1);
      await reader.page.reload();
      await expectUnread(reader, 'group-1', 1);
      await selectGroup(reader, 'group-1');
      await expectUnreadDivider(reader);
      await expectUnread(reader, 'group-1', 0);
      await reader.page.reload();
      await expectUnread(reader, 'group-1', 0);
      await expect(divider(reader)).toHaveCount(0);
      await selectGroup(reader, 'group-2');
      await selectGroup(reader, 'group-1');
      await expect(divider(reader)).toHaveCount(0);

      const otherScreen = screen === 'analysis' ? 'duty' : 'analysis';
      const otherPage = await reader.page.context().newPage();
      const other = await fixture.attach(otherPage, otherScreen, reader.user);
      await otherPage.goto(groupFeedPath(otherScreen, 'group-1'));
      await expect(row(other, 101)).toContainText('Persistent incoming message');
      await expectUnread(other, 'group-1', 0);
      await expect(divider(other)).toHaveCount(0);
    },
  );

  scenario(
    'does not acknowledge visible messages in a hidden document',
    async (fixture, reader) => {
      fixture.add('user-1', 'Background unread message');
      await reader.page.addInitScript(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      });
      await reader.page.goto(groupFeedPath(screen, 'group-1'));
      await expect(row(reader, 101)).toBeVisible();
      await expectUnread(reader, 'group-1', 1);
      // Exceed the production read dwell to detect an accidental background receipt.
      await reader.page.waitForTimeout(500);
      expect(reader.receipts).toEqual([]);
      await setVisible(reader, true);
      await expectUnread(reader, 'group-1', 0);
    },
  );

  scenario(
    'does not clear filtered-out unread messages at the visible tail',
    async (fixture, reader) => {
      fixture.add('user-1', 'Visible matching message', { sender: 'match' });
      fixture.add('user-1', 'Excluded newer message', { sender: 'other' });
      await reader.page.goto(filteredPath(screen));
      await expect(row(reader, 101)).toBeVisible();
      await expect(row(reader, 102)).toHaveCount(0);
      await expectUnread(reader, 'group-1', 2);
      await reader.page.waitForTimeout(500);
      expect(reader.receipts).toEqual([]);
      await reader.page.goto(groupFeedPath(screen, 'all'));
      await expect(row(reader, 102)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
    },
  );

  for (const hidden of [false, true]) {
    scenario(
      `reads every accessible membership of a shared message${hidden ? ' including a Duty-hidden group' : ''}`,
      async (fixture, reader) => {
        fixture.groups[1].hidden = hidden;
        fixture.add('user-1', 'Shared incoming message', {
          groups: ['group-1', 'group-2', 'inaccessible-group'],
        });
        await reader.page.goto(groupFeedPath(screen, 'group-1'));
        await expect(row(reader, 101)).toBeVisible();
        await expectUnread(reader, 'group-1', 0);
        await expect
          .poll(() => reader.receipts.map((receipt) => receipt.master_key).sort())
          .toEqual(['group-1', 'group-2']);
        const list = await groupList(reader);
        if (hidden && screen === 'duty') {
          await expect(list.getByRole('button', { name: 'group-2', exact: true })).toHaveCount(0);
        } else {
          await expectUnread(reader, 'group-2', 0);
        }
      },
    );
  }

  scenario(
    'deduplicates repeated delivery events without duplicating rows or unread counts',
    async (fixture, reader) => {
      await reader.page.goto(groupFeedPath(screen, 'group-2'));
      await expectUnread(reader, 'group-1', 0);
      fixture.add('user-1', 'One message delivered repeatedly');
      fixture.emit(101, 5);
      await expectUnread(reader, 'group-1', 1);
      await selectGroup(reader, 'group-1');
      await expect(row(reader, 101)).toHaveCount(1);
      await expectUnread(reader, 'group-1', 0);
      const redelivered = reader.page.waitForResponse((response) =>
        response.url().endsWith('/api/rer-importer/group-feed-state'),
      );
      fixture.emit(101, 5);
      await settleResponse(reader, redelivered);
      await expect(row(reader, 101)).toHaveCount(1);
      await expectUnread(reader, 'group-1', 0);
    },
  );

  scenario(
    'preserves unread state after a failed receipt and retries after reload',
    async (fixture, reader) => {
      fixture.add('user-1', 'Receipt retry message');
      reader.failReceipts = 1;
      await reader.page.goto(groupFeedPath(screen, 'group-1'));
      await expect(row(reader, 101)).toBeVisible();
      await expect.poll(() => reader.receipts.length).toBe(1);
      await expectUnread(reader, 'group-1', 1);
      await reader.page.reload();
      await expectUnread(reader, 'group-1', 0);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101, 101]);
    },
  );

  scenario(
    'acknowledges already-visible messages when group metadata arrives late',
    async (fixture, reader) => {
      fixture.add('user-1', 'Late group metadata');
      const gate = holdNext(reader, 'state');
      try {
        await reader.page.goto(groupFeedPath(screen, 'group-1'));
        await gate.started;
        await expect(row(reader, 101)).toBeVisible();
        expect(reader.receipts).toEqual([]);
      } finally {
        gate.release();
      }
      await expectUnread(reader, 'group-1', 0);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101]);
    },
  );

  scenario(
    'does not overwrite a new unread message with an older acknowledgement response',
    async (fixture, reader) => {
      fixture.add('user-1', 'First incoming message');
      const gate = holdNext(reader, 'acknowledge');
      const acknowledgement = reader.page.waitForRequest((request) =>
        request.url().endsWith('/api/rer-importer/group-feed-state/acknowledge'),
      );
      try {
        await reader.page.goto(groupFeedPath(screen, 'group-1'));
        await gate.started;
        await selectGroup(reader, 'group-2');
        await groupList(reader);
        const refreshed = reader.page.waitForResponse(
          async (response) =>
            response.url().endsWith('/api/rer-importer/group-feed-state') &&
            (await response.json()).groups.some(
              (group: { master_key: string; latest_cursor: { message_id: number } | null }) =>
                group.master_key === 'group-1' && group.latest_cursor?.message_id === 102,
            ),
        );
        fixture.add('user-1', 'Newer message during acknowledgement');
        await settleResponse(reader, refreshed);
        await expectUnread(reader, 'group-1', 1);
      } finally {
        gate.release();
        await settleResponse(reader, (await acknowledgement).response());
      }
      await expectUnread(reader, 'group-1', 1);
      await selectGroup(reader, 'group-1');
      await expect(row(reader, 102)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101, 102]);
    },
  );

  scenario(
    'keeps the configured divider stable while reading and receiving later messages',
    async (fixture, reader) => {
      fixture.add('user-1', 'Initial unread boundary');
      await reader.page.goto(groupFeedPath(screen, 'group-1'));
      await expectUnreadDivider(reader, 101);
      await expectUnread(reader, 'group-1', 0);
      fixture.add('user-1', 'Later incoming message');
      await expect(row(reader, 102)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
      await expectUnreadDivider(reader);
      await expectUnreadDivider(reader, 101);
      await selectGroup(reader, 'group-2');
      await selectGroup(reader, 'group-1');
      await expect(divider(reader)).toHaveCount(0);
    },
  );

  scenario(
    'keeps the divider on composer cancellation or failure and hides it only after successful creation',
    async (fixture, reader) => {
      fixture.add('user-1', 'Unread before composing');
      await reader.page.goto(groupFeedPath(screen, 'group-2'));
      await expectUnread(reader, 'group-1', 1);
      await selectGroup(reader, 'group-1');
      await expectUnreadDivider(reader);
      await expectUnread(reader, 'group-1', 0);
      await reader.page.keyboard.press('Escape');
      await reader.page.getByRole('button', { name: 'Додати повідомлення', exact: true }).click();
      await expectUnreadDivider(reader);
      await reader.page.getByRole('button', { name: 'Закрити', exact: true }).click();
      await expect(reader.page.getByRole('textbox', { name: 'Текст повідомлення' })).toHaveCount(0);
      await expectUnreadDivider(reader);
      reader.failSubmissions = 1;
      const failed = reader.page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/1.1/submit-direct') && response.status() === 503,
      );
      void failed.catch(() => {});
      await createMessage(reader, 'Own reply after reading');
      await settleResponse(reader, failed);
      const submit = reader.page.getByRole('button', { name: 'Створити', exact: true });
      await expect(submit).toBeEnabled();
      await expect(reader.page.getByRole('textbox', { name: 'Текст повідомлення' })).toHaveValue(
        'Own reply after reading',
      );
      await expectUnreadDivider(reader);
      await submit.click();
      await expect(row(reader, 102)).toContainText('Own reply after reading');
      await expect(divider(reader)).toHaveCount(0);
      await expectUnread(reader, 'group-1', 0);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101]);
    },
  );

  scenario(
    'updates edited messages without marking them unread again and removes deleted unread messages',
    async (fixture, reader) => {
      const message = fixture.add('user-1', 'Original incoming text');
      await reader.page.goto(groupFeedPath(screen, 'group-2'));
      await expectUnread(reader, 'group-1', 1);
      message.text = 'Edited incoming text';
      fixture.emit(message.id);
      await expectUnread(reader, 'group-1', 1);
      await selectGroup(reader, 'group-1');
      await expect(row(reader, 101)).toContainText('Edited incoming text');
      await expectUnread(reader, 'group-1', 0);
      message.text = 'Edited after reading';
      fixture.emit(message.id);
      await expect(row(reader, 101)).toContainText('Edited after reading');
      await expectUnread(reader, 'group-1', 0);
      await selectGroup(reader, 'group-2');
      const deleted = fixture.add('user-1', 'Deleted before reading');
      await expectUnread(reader, 'group-1', 1);
      deleted.deleted = true;
      fixture.emit(deleted.id);
      await expectUnread(reader, 'group-1', 0);
      await selectGroup(reader, 'group-1');
      await expect(row(reader, deleted.id)).toHaveCount(0);
    },
  );

  scenario(
    'decreases the counter as individual messages are read, without moving the divider',
    async (fixture, reader) => {
      await reader.page.setViewportSize({ width: 1920, height: 420 });
      for (const id of [101, 102, 103]) {
        fixture.add('user-1', Array(20).fill(`Incoming message ${id}`).join('\n'));
      }
      if (screen === 'analysis') {
        await reader.page.goto(groupFeedPath(screen, 'group-1', '&newestFirst=false'));
      } else {
        await reader.page.goto(groupFeedPath(screen, 'group-2'));
        await expectUnread(reader, 'group-1', 3);
        await selectGroup(reader, 'group-1');
      }
      await expectUnread(reader, 'group-1', 2);
      await expectUnreadDivider(reader, 101);
      for (const [id, remaining] of [
        [102, 1],
        [103, 0],
      ]) {
        await viewMessage(reader, id);
        await expectUnread(reader, 'group-1', remaining);
      }
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101, 102, 103]);
      await expectUnreadDivider(reader);
    },
  );

  scenario(
    'retains off-screen incoming messages as unread until the reader navigates to them',
    async (fixture, reader) => {
      await reader.page.setViewportSize({ width: 1920, height: 500 });
      for (let i = 0; i < 8; i++)
        fixture.add(reader.user, Array(15).fill(`Own history ${i}`).join('\n'));
      await reader.page.goto(groupFeedPath(screen, 'group-1', '&newestFirst=false'));
      const scroller = reader.page.locator(
        screen === 'analysis'
          ? '[data-analysis-message-scroller]'
          : '[data-duty-feed-scroller="true"]',
      );
      await expect(scroller).toBeVisible();
      await scroller.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll'));
      });
      fixture.add('user-1', 'Incoming outside the viewport');
      await expectUnread(reader, 'group-1', 1);
      await reader.page.waitForTimeout(500);
      expect(reader.receipts).toEqual([]);
      await selectGroup(reader, 'group-2');
      await selectGroup(reader, 'group-1');
      await expect(row(reader, 109)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
    },
  );

  for (const scope of ['group-1', 'all'] as const) {
    scenario(
      `does not let a visible own message acknowledge an off-screen foreign message in ${scope}`,
      async (fixture, reader) => {
        await reader.page.setViewportSize({ width: 1920, height: 420 });
        fixture.add('user-1', Array(30).fill('Older foreign unread message').join('\n'));
        fixture.add(reader.user, Array(30).fill('Visible own message').join('\n'));
        await reader.page.addInitScript(() => {
          Object.defineProperty(document, 'visibilityState', {
            configurable: true,
            value: 'hidden',
          });
        });
        await reader.page.goto(
          groupFeedPath(screen, scope, screen === 'analysis' ? '&newestFirst=true' : ''),
        );
        await row(reader, 102).scrollIntoViewIfNeeded();
        await expect(row(reader, 102)).toBeVisible();
        await setVisible(reader, true);
        await expectUnread(reader, 'group-1', 1);
        await reader.page.waitForTimeout(500);
        expect(reader.receipts).toEqual([]);
        await expect(row(reader, 102).getByRole('separator')).toHaveCount(0);
        await viewMessage(reader, 101);
        await expectUnread(reader, 'group-1', 0);
        expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101]);
      },
    );
  }

  scenario(
    'uses creation time for read receipts even when interception time differs',
    async (fixture, reader) => {
      const timestamp = Date.now() - 3 * 24 * 60 * 60 * 1000;
      const message = fixture.add('user-1', 'Old interception newly created', { timestamp });
      const from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      const to = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 16);
      await reader.page.goto(
        groupFeedPath(
          screen,
          'group-1',
          `&fromDateTime=${encodeURIComponent(from)}&toDateTime=${encodeURIComponent(to)}`,
        ),
      );
      await expect(row(reader, message.id)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
      expect(reader.receipts.map((receipt) => receipt.cursor)).toEqual([
        { created_at: message.at, message_id: 101 },
      ]);
    },
  );

  scenario(
    'retains the unread boundary and count while paging through a bounded message window',
    async (fixture, reader) => {
      fixture.setPageLimit(2);
      await reader.page.setViewportSize({ width: 1920, height: 420 });
      for (const id of [101, 102, 103, 104, 105, 106]) {
        fixture.add('user-1', Array(20).fill(`Paged incoming message ${id}`).join('\n'));
      }
      if (screen === 'analysis') {
        await reader.page.goto(groupFeedPath(screen, 'group-1', '&newestFirst=false'));
      } else {
        await reader.page.goto(groupFeedPath(screen, 'group-2'));
        await expectUnread(reader, 'group-1', 6);
        await selectGroup(reader, 'group-1');
      }
      await expect(row(reader, 101)).toBeVisible();
      await expectUnread(reader, 'group-1', 5);
      const scroller = reader.page.locator(
        screen === 'analysis'
          ? '[data-analysis-message-scroller]'
          : '[data-duty-feed-scroller="true"]',
      );
      for (const id of [102, 103, 104, 105, 106]) {
        if (!(await row(reader, id).count())) {
          await scroller.hover();
          await reader.page.mouse.wheel(
            0,
            await scroller.evaluate((element) => element.scrollHeight),
          );
        }
        await expect(row(reader, id)).toBeAttached();
        await viewMessage(reader, id);
        await expectUnread(reader, 'group-1', 106 - id);
      }
      await expectUnreadDivider(reader);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([
        101, 102, 103, 104, 105, 106,
      ]);
    },
  );
}

test('@regression #3727 Duty: an inactive narrow column cannot read messages until activated', async ({
  browser,
  baseURL,
}) => {
  await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
    const reader = await fixture.attach(page, 'duty', 'user-2');
    fixture.add('user-1', 'Incoming in inactive column');
    await page.setViewportSize({ width: 900, height: 700 });
    const state = {
      messageFeeds: [
        ['mf-0', {}, { groupScopeMasterKey: 'group-2' }],
        ['mf-1', {}, { groupScopeMasterKey: 'group-1' }],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    await expectUnread(reader, 'group-1', 1);
    await page.waitForTimeout(500);
    expect(reader.receipts).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: /стрічка 2/i }).click();
    await expect(row(reader, 101)).toBeVisible();
    await expectUnread(reader, 'group-1', 0);
  });
});

test('@regression #3727 Duty: two visible columns share the read state of the same group', async ({
  browser,
  baseURL,
}) => {
  await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
    const reader = await fixture.attach(page, 'duty', 'user-2');
    fixture.add('user-1', 'Same group in both columns');
    const state = {
      messageFeeds: [
        ['mf-0', {}, { groupScopeMasterKey: 'group-1' }],
        ['mf-1', {}, { groupScopeMasterKey: 'group-1' }],
      ],
    };
    await page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
    const columns = page.locator('[data-duty-feed-column]');
    await expect(columns).toHaveCount(2);
    for (const column of await columns.all()) {
      await expect(column.locator('[data-message-id="101"]')).toBeVisible();
      await column.getByRole('button', { name: 'Розгорнути список груп' }).click();
      await expect(
        column.locator('[data-group-panel]').getByRole('button', { name: 'group-1', exact: true }),
      ).toBeVisible();
      await expect(column.locator('[data-group-unread]')).toHaveCount(0);
    }
    expect(
      reader.receipts.every(
        (receipt) => receipt.master_key === 'group-1' && receipt.cursor.message_id === 101,
      ),
    ).toBe(true);
    expect(reader.receipts.length).toBeGreaterThan(0);
  });
});

for (const newestFirst of [false, true]) {
  test(`@regression #3727 Analysis: creation-time read watermark survives reversed interception order with newestFirst=${newestFirst}`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
      const reader = await fixture.attach(page, 'analysis', 'user-2');
      await page.setViewportSize({ width: 1920, height: 420 });
      const now = Date.now();
      fixture.add('user-1', Array(30).fill('Earlier creation, later interception').join('\n'), {
        timestamp: now + 1000,
      });
      fixture.add('user-1', Array(30).fill('Later creation, earlier interception').join('\n'), {
        timestamp: now - 1000,
      });
      await page.goto(groupFeedPath('analysis', 'group-1', `&newestFirst=${newestFirst}`));
      const firstId = newestFirst ? 101 : 102;
      await expect(row(reader, firstId)).toBeVisible();
      await expect.poll(() => reader.receipts.length).toBe(1);
      expect(reader.receipts[0].cursor.message_id).toBe(firstId);
      await expectUnread(reader, 'group-1', newestFirst ? 1 : 0);
      await viewMessage(reader, newestFirst ? 102 : 101);
      await expectUnread(reader, 'group-1', 0);
      await page.reload();
      await expectUnread(reader, 'group-1', 0);
    });
  });
}

test('@regression #3727 Analysis: an arrival outside a focused history window stays unread until returning to the live feed', async ({
  browser,
  baseURL,
}) => {
  await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
    const reader = await fixture.attach(page, 'analysis', 'user-2');
    fixture.add('user-1', 'Focused history boundary');
    await page.goto(groupFeedPath('analysis', 'group-2'));
    await expectUnread(reader, 'group-1', 1);
    await selectGroup(reader, 'group-1');
    await expectUnread(reader, 'group-1', 0);
    fixture.add('user-1', 'Arrival outside focused history');
    await expectUnread(reader, 'group-1', 1);
    await expect(row(reader, 102)).toHaveCount(0);
    await expectUnreadDivider(reader, 101);
    expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101]);
    await page.goto(groupFeedPath('analysis', 'group-1'));
    await expect(row(reader, 102)).toBeVisible();
    await expectUnread(reader, 'group-1', 0);
  });
});
