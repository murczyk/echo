import { expect, test } from '@playwright/test';
import { groupFeedPath, row, selectGroup, withGroupFeedActors } from './group-feed-actors.fixtures';

for (const screen of ['analysis', 'duty'] as const) {
  test(`@regression #3727 ${screen}: shows card group metadata only in all-groups feeds`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
      const reader = await fixture.attach(page, screen, 'user-2');
      fixture.add('user-1', 'Message with group metadata');
      await page.goto(groupFeedPath(screen, 'all'));
      const message = row(reader, 101);
      const groupName = message.getByText('group-1', { exact: true });
      const groupIcon = message.locator('[data-message-card-metadata-icon-kind="group"]');
      await expect(groupName).toBeVisible();
      await expect(groupIcon).toHaveCount(1);
      await selectGroup(reader, 'group-1');
      await expect(message).toBeVisible();
      await expect(groupName).toHaveCount(0);
      await expect(groupIcon).toHaveCount(0);
      await page.reload();
      await expect(message).toBeVisible();
      await expect(groupName).toHaveCount(0);
      await selectGroup(reader, 'all');
      await expect(groupName).toBeVisible();
      await expect(groupIcon).toHaveCount(1);
    });
  });

  test(`@regression #3727 ${screen}: refreshes edited messages and removes deleted messages`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
      const reader = await fixture.attach(page, screen, 'user-2');
      const message = fixture.add('user-1', 'Original incoming text');
      await page.goto(groupFeedPath(screen, 'group-1'));
      await expect(row(reader, message.id)).toContainText('Original incoming text');
      message.text = 'Edited incoming text';
      fixture.emit(message.id);
      await expect(row(reader, message.id)).toContainText('Edited incoming text');
      message.deleted = true;
      fixture.emit(message.id);
      await expect(row(reader, message.id)).toHaveCount(0);
    });
  });
}
