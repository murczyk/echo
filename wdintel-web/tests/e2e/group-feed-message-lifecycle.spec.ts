import { expect, test } from '@playwright/test';
import { groupFeedPath, row, selectGroup, withGroupFeedActors } from './group-feed-actors.fixtures';

for (const screen of ['analysis', 'duty'] as const) {
  for (const scope of ['group-1', 'all'] as const) {
    test(`@regression #3955 ${screen}: moves a message from ${scope} to another accessible group`, async ({
      browser,
      baseURL,
    }) => {
      await withGroupFeedActors(
        browser,
        baseURL,
        async (fixture, [page]) => {
          const reader = await fixture.attach(page, screen, 'user-1');
          const message = fixture.add('user-1', 'Message to move');
          await page.goto(groupFeedPath(screen, scope));
          const card = row(reader, message.id);
          await expect(card).toBeVisible();
          await card.getByRole('button', { name: 'Більше дій', exact: true }).click();
          await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
          const editor = page.locator('[data-manage-message-presentation]');
          const group = editor.getByRole('combobox', { name: 'Група', exact: true });
          await expect(group).toBeEnabled();
          await group.fill('group-2');
          await page.getByRole('option', { name: 'group-2', exact: true }).click();
          await editor
            .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
            .fill('Moved message');
          await editor.getByRole('button', { name: 'Зберегти', exact: true }).click();
          await expect(editor).toBeHidden();
          if (scope === 'group-1') await expect(card).toHaveCount(0);
          else await expect(card).toContainText('Moved message');
          await selectGroup(reader, 'group-2');
          await expect(card).toContainText('Moved message');
          expect(
            reader.requests.find(({ path }) => path === `/api/1.1/message/${message.id}/edit`)?.body
              .signal_group_master_key,
          ).toBe('group-2');
          expect(
            reader.requests.find(({ path }) => path === `/api/1.1/message/${message.id}/edit`)?.body
              .source_signal_group_master_key,
          ).toBe('group-1');
        },
        { userRoles: ['Rer', 'DeleteMsg'], actorCount: 1 },
      );
    });
  }

  test(`@regression #3955 ${screen}: removes a message moved by another user from the selected group`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
      const reader = await fixture.attach(page, screen, 'user-2');
      const message = fixture.add('user-1', 'Message moved by another user');
      await page.goto(groupFeedPath(screen, 'group-1'));
      await expect(row(reader, message.id)).toBeVisible();
      message.groups = ['group-2'];
      fixture.emit(message.id);
      await expect(row(reader, message.id)).toHaveCount(0);
    });
  });

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

test('@regression #3727 Analysis discovers and retains a new group from live message reconciliation', async ({
  browser,
  baseURL,
}) => {
  await withGroupFeedActors(browser, baseURL, async (fixture, [, page]) => {
    const reader = await fixture.attach(page, 'analysis', 'user-2');
    fixture.add('user-1', 'Initial message');
    await page.goto(groupFeedPath('analysis', 'all'));
    const panel = page.locator('[data-analysis-group-list]:visible');
    await expect(panel.getByRole('button', { name: 'group-1', exact: true })).toBeVisible();

    fixture.groups.push({ key: 'live-group', hidden: false, accessible: true });
    const incoming = fixture.add('user-1', 'Message from a new group', { groups: ['live-group'] });
    await expect(row(reader, incoming.id)).toContainText('Message from a new group');
    const group = panel.getByRole('button', { name: 'live-group', exact: true });
    await expect(group).toBeVisible();
    await expect
      .poll(() =>
        reader.requests.some(
          ({ path, body }) =>
            path === '/api/rer-importer/signal-group-batch' &&
            (body.groups as Array<{ master_key: string }>).some(
              ({ master_key }) => master_key === 'live-group',
            ),
        ),
      )
      .toBe(true);

    incoming.deleted = true;
    fixture.emit(incoming.id);
    await expect(row(reader, incoming.id)).toHaveCount(0);
    await expect(group).toBeVisible();
    await group.click();
    await expect(page.locator('[data-analysis-current-group] [data-group-name]')).toHaveText(
      'live-group',
    );
  });
});
