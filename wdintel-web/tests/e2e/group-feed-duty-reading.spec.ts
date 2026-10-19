import { expect, test } from '@playwright/test';
import {
  createMessage,
  divider,
  expectUnread,
  groupFeedPath,
  row,
  selectGroup,
  withGroupFeedActors,
} from './group-feed-actors.fixtures';

for (const origin of ['group-1', 'group-2', 'all'] as const) {
  test(`@regression #3727 Duty: reading an arrival from ${origin} clears persisted group unread state with navigation closed`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [readerPage, authorPage]) => {
      const reader = await fixture.attach(readerPage, 'duty', 'user-1');
      const author = await fixture.attach(authorPage, 'duty', 'user-2');
      for (let index = 0; index < 12; index++) {
        fixture.add(reader.user, Array(4).fill(`Own history ${index}`).join('\n'));
      }
      await readerPage.goto(
        `/rer-duty-neo?state=${encodeURIComponent(
          JSON.stringify({
            messageFeeds: [
              [
                'mf-0',
                { highlightKeywordSetId: 1 },
                { groupScopeMasterKey: origin === 'all' ? null : origin },
              ],
            ],
          }),
        )}`,
      );
      const scroller = readerPage.locator('[data-duty-feed-scroller="true"]');
      await expect(scroller).toBeVisible();
      if (origin === 'all') {
        await scroller.hover();
        await readerPage.mouse.wheel(0, -10_000);
        await expect(row(reader, 101)).toBeInViewport();
      } else if (origin === 'group-1') {
        await expect(row(reader, 112)).toBeInViewport();
      }
      await expect(readerPage.locator('[data-group-panel]')).not.toBeVisible();
      await authorPage.goto(groupFeedPath('duty', 'group-1'));
      await createMessage(author, 'New message from user 2');

      if (origin !== 'group-1') {
        await expectUnread(reader, 'group-1', 1);
        await selectGroup(reader, 'group-1');
      }
      await expect(row(reader, 113)).toBeInViewport();
      if (origin !== 'group-1') await expect(divider(reader)).toBeVisible();
      await expect
        .poll(() => reader.receipts.map((receipt) => receipt.cursor.message_id))
        .toContain(113);
      await expectUnread(reader, 'group-1', 0);
      if (origin !== 'group-1') {
        await selectGroup(reader, origin);
        await expectUnread(reader, 'group-1', 0);
        await expect(divider(reader)).toHaveCount(0);
      }
      await readerPage.reload();
      await expectUnread(reader, 'group-1', 0);
    });
  });
}
