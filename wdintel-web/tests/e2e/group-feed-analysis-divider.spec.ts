import { expect, test } from '@playwright/test';
import {
  divider,
  expectUnread,
  groupFeedPath,
  row,
  withGroupFeedActors,
} from './group-feed-actors.fixtures';

for (const scope of ['group-1', 'all'] as const) {
  test(`@regression #3727 Analysis: hides the unread divider by default in ${scope} without disabling read receipts`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [page]) => {
      const reader = await fixture.attach(page, 'analysis', 'user-1');
      fixture.add('user-2', 'Incoming message still becomes read');
      await page.goto(groupFeedPath('analysis', scope));
      await expect(row(reader, 101)).toBeVisible();
      await expectUnread(reader, 'group-1', 0);
      await expect(divider(reader)).toHaveCount(0);
      expect(reader.receipts.map((receipt) => receipt.cursor.message_id)).toEqual([101]);
    });
  });
}
