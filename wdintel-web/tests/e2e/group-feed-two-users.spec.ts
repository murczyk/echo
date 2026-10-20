import { expect, test } from '@playwright/test';
import {
  createMessage,
  divider,
  expectUnread,
  expectUnreadDivider,
  groupFeedPath,
  row,
  selectGroup,
  withGroupFeedActors,
} from './group-feed-actors.fixtures';

for (const authorScreen of ['analysis', 'duty'] as const) {
  for (const readerScreen of ['analysis', 'duty'] as const) {
    for (const authorScope of ['group-1', 'all'] as const) {
      for (const readerScope of ['group-1', 'group-2', 'all'] as const) {
        test(`@regression #3727 ${authorScreen} → ${readerScreen}: author in ${authorScope}, reader in ${readerScope}`, async ({
          browser,
          baseURL,
        }) => {
          await withGroupFeedActors(browser, baseURL, async (fixture, [authorPage, readerPage]) => {
            const author = await fixture.attach(authorPage, authorScreen, 'user-1');
            const reader = await fixture.attach(readerPage, readerScreen, 'user-2');
            await readerPage.goto(groupFeedPath(readerScreen, readerScope));
            await expectUnread(reader, 'group-1', 0);
            await readerPage.keyboard.press('Escape');
            await authorPage.goto(groupFeedPath(authorScreen, authorScope));
            await createMessage(author, 'Message from user 1', authorScope === 'all');

            await expect(row(author, 101)).toContainText('Message from user 1');
            await expectUnread(author, 'group-1', 0);
            await expectUnread(author, 'all', 0);
            await expect(divider(author)).toHaveCount(0);
            expect(author.receipts).toEqual([]);

            if (readerScope === 'group-2') {
              await expectUnread(reader, 'group-1', 1);
              await expect(row(reader, 101)).toHaveCount(0);
              await expect(divider(reader)).toHaveCount(0);
              await selectGroup(reader, 'group-1');
              await expectUnreadDivider(reader);
            }
            await expect(row(reader, 101)).toContainText('Message from user 1');
            await expectUnread(reader, 'group-1', 0);
            await expect(readerPage.locator('[data-message-feed-highlighted]')).toHaveCount(0);
            expect(reader.receipts.map((receipt) => receipt.master_key)).toEqual(['group-1']);
            expect(author.receipts).toEqual([]);
          });
        });
      }
    }
  }
}
