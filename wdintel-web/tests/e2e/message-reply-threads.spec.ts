import { expect, test } from '@playwright/test';
import { holdNext, row, selectGroup } from './group-feed-actors.fixtures';
import {
  beginReply,
  closeThread,
  detachReply,
  editor,
  expectThread,
  member,
  relation,
  openThread,
  saveReply,
  scrollThread,
  visit,
  withReplyActors,
} from './message-replies.fixtures';

for (const screen of ['duty', 'analysis'] as const) {
  test(`@reply #3612 E1 ${screen}: first reply stays in the original group and links both cards`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      for (const scope of ['group-1', 'all'] as const) {
        const source = fixture.seed('user-2', `Original ${scope}`, {
          groups: ['group-1', 'group-2'],
        });
        let replyId = 0;
        await fixture.nextCreate(actor, `Reply ${scope}`, source.id, () => {
          const reply = fixture.add(actor.user, `Reply ${scope}`);
          replyId = reply.id;
          fixture.respondWithReplies([relation(1, source, reply)]);
          fixture.notify([source.id, reply.id]);
          return reply;
        });
        await visit(actor, scope);
        if (scope === 'all') await selectGroup(actor, 'all');
        await beginReply(actor, source);
        const card = row(actor, source.id).locator('[data-message-card-root]');
        await expect(card).toHaveCSS('outline-style', 'solid');
        await expect(
          editor(actor).getByRole('combobox', { name: 'Група', exact: true }),
        ).toHaveValue('group-1');
        await expect(
          editor(actor).getByRole('combobox', { name: 'Група', exact: true }),
        ).toBeDisabled();
        await expect(
          editor(actor).getByRole('textbox', { name: 'Текст повідомлення', exact: true }),
        ).toBeEmpty();
        await saveReply(actor, `Reply ${scope}`);
        await expect(row(actor, replyId)).toContainText(`Reply ${scope}`);
        await expect(card).not.toHaveCSS('outline-style', 'solid');
        const reply = fixture.messages.find(({ id }) => id === replyId)!;
        const panel = await openThread(actor, reply, 2);
        await expectThread(panel, [`Original ${scope}`, `Reply ${scope}`]);
        await panel.getByText(`Original ${scope}`, { exact: true }).click();
        await expect(panel).toHaveCount(0);
        await expect(row(actor, source.id)).toBeInViewport();
        const reverse = await openThread(actor, source, 2);
        await reverse.getByText(`Reply ${scope}`, { exact: true }).click();
        await expect(row(actor, replyId)).toBeInViewport();
        await expect(row(actor, replyId).getByText('group-2', { exact: true })).toHaveCount(0);
      }
    });
  });

  test(`@reply #3612 E2 ${screen}: reply to an intelligence report is an ordinary message`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const original = fixture.seed('user-2', 'Intelligence source');
      const report = fixture.seed('user-2', 'Grouped intelligence report');
      fixture.setMessageFields(report, { parentMessages: [member(original).summary] });
      await fixture.nextCreate(actor, 'Ordinary reply', report.id, () => {
        const reply = fixture.add(actor.user, 'Ordinary reply');
        fixture.respondWithReplies([relation(1, report, reply)]);
        fixture.notify([report.id, reply.id]);
        return reply;
      });
      await visit(actor);
      await beginReply(actor, report);
      await saveReply(actor, 'Ordinary reply');
      const reply = fixture.messages.at(-1)!;
      const panel = await openThread(actor, reply, 2);
      await expectThread(panel, ['Grouped intelligence report', 'Ordinary reply']);
      await expect(panel.getByText('Intelligence source', { exact: true })).toHaveCount(0);
      await closeThread(actor);
      await expect(row(actor, report.id)).toContainText('Intelligence source');
      await expect(
        row(actor, reply.id).getByText('Intelligence source', { exact: true }),
      ).toHaveCount(0);
      expect(
        actor.requests.filter(({ path }) => path === '/api/1.1/submit-direct').at(-1)!.body
          .parent_signal_message_ids ?? [],
      ).toEqual([]);
    });
  });

  test(`@reply #3612 E4 ${screen}: separate threads in the same group do not mix`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const a = fixture.seed('user-1', 'A original');
      const b = fixture.seed('user-2', 'B original');
      let aReply!: import('./group-feed-actors.fixtures').Message;
      await fixture.nextCreate(actor, 'A reply', a.id, () => {
        const reply = fixture.add(actor.user, 'A reply');
        aReply = reply;
        fixture.respondWithReplies([relation(1, a, reply)]);
        fixture.notify([a.id, reply.id]);
        return reply;
      });
      await visit(actor);
      await beginReply(actor, a);
      await saveReply(actor, 'A reply');
      await fixture.nextCreate(actor, 'B reply', b.id, () => {
        const reply = fixture.add(actor.user, 'B reply');
        fixture.respondWithReplies([relation(1, a, aReply), relation(2, b, reply)]);
        fixture.notify([b.id, reply.id]);
        return reply;
      });
      await beginReply(actor, b);
      await saveReply(actor, 'B reply');
      const first = await openThread(actor, a, 2);
      await expectThread(first, ['A original', 'A reply']);
      await closeThread(actor);
      await expectThread(await openThread(actor, b, 2), ['B original', 'B reply']);
    });
  });

  test(`@reply #3612 E6 ${screen}: overlay pages a long thread and ignores a stale page after live detach`, async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(60_000);
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      fixture.setPageLimit(20);
      const first = fixture.seed('user-1', 'Thread 001');
      for (let i = 0; i < 10_000; i++) fixture.seed('user-2', `History ${i}`);
      const messages = [first];
      for (let i = 2; i <= 100; i++)
        messages.push(fixture.seed('user-2', `Thread ${String(i).padStart(3, '0')}`));
      const current = messages.at(-1)!;
      fixture.respondWithReplies(
        messages.slice(1).map((message, index) => relation(index + 1, messages[index]!, message)),
      );
      const other = fixture.seed('user-2', 'Other column stays here', { groups: ['group-2'] });
      if (screen === 'duty') {
        const state = {
          messageFeeds: [
            ['mf-other', {}, { groupScopeMasterKey: 'group-2' }],
            ['mf-thread', {}, { groupScopeMasterKey: 'group-1' }],
          ],
        };
        await actor.page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
      } else await visit(actor);
      await expect(row(actor, current.id)).toBeVisible();
      await expect(row(actor, first.id)).toHaveCount(0);
      const currentRow = row(actor, current.id);
      await expect(currentRow.getByRole('link').filter({ hasText: /Thread \d{3}/ })).toHaveCount(2);
      const before = (await currentRow.boundingBox())!;
      const openPages = actor.page.context().pages().length;
      const panel = await openThread(actor, current, 100);
      const after = (await currentRow.boundingBox())!;
      expect(after.height).toBeCloseTo(before.height, 0);
      expect(after.y).toBeCloseTo(before.y, 0);
      await expect(panel.getByRole('listitem')).toHaveCount(25);
      await expect(panel.getByRole('listitem').first()).toContainText('Thread 001');
      await expect(panel.getByRole('listitem').last()).toContainText('Thread 025');
      await scrollThread(panel);
      await expect(panel.getByText('Thread 050', { exact: true })).toBeAttached();
      const pending = holdNext(actor, 'reply-metadata');
      await scrollThread(panel);
      await expect(panel.getByText('Thread 050', { exact: true })).toBeInViewport();
      await pending.started;
      const remaining = messages.filter((message) => message.id !== messages[59]!.id);
      fixture.respondWithReplies(
        remaining.slice(1).map((message, index) => relation(index + 1, remaining[index]!, message)),
      );
      fixture.clearReplies(messages[59]!);
      fixture.notify([messages[59]!.id]);
      await expect(currentRow.getByRole('button', { name: 'Усі 99', exact: true })).toBeVisible();
      pending.release();
      await expect(panel.getByText('Thread 075', { exact: true })).toBeAttached();
      await expect(panel.getByText('Thread 060', { exact: true })).toHaveCount(0);
      await expect(panel.getByText('Thread 050', { exact: true })).toBeAttached();
      await expect(panel.getByText('Thread 050', { exact: true })).toBeInViewport();
      const visibleTexts = await panel.getByRole('listitem').allTextContents();
      expect(new Set(visibleTexts).size).toBe(visibleTexts.length);
      await closeThread(actor);
      const reopened = await openThread(actor, current, 99);
      await reopened.getByText('Thread 001', { exact: true }).click();
      await expect(reopened).toHaveCount(0);
      await expect(row(actor, first.id)).toBeInViewport();
      const count = await actor.page
        .locator(
          screen === 'duty'
            ? '[data-duty-feed-column][data-duty-feed-id="mf-thread"] [data-duty-message-id]'
            : '[data-message-id]',
        )
        .count();
      expect(count).toBeLessThanOrEqual(40);
      expect(actor.page.context().pages()).toHaveLength(openPages);
      if (screen === 'duty') {
        const otherColumn = actor.page.locator(
          '[data-duty-feed-column][data-duty-feed-id="mf-other"]',
        );
        await expect(otherColumn.locator(`[data-duty-message-id="${other.id}"]`)).toBeVisible();
        await expect(otherColumn.locator('[data-duty-message-id]')).toHaveCount(1);
        await expect(
          actor.page
            .locator('[data-duty-feed-column][data-duty-feed-id="mf-thread"]')
            .locator(`[data-duty-message-id="${first.id}"]`),
        ).toBeInViewport();
      }
      const atRoot = await openThread(actor, first, 99);
      await actor.page.mouse.click(1, 1);
      await expect(atRoot).toHaveCount(0);
    });
  });

  test(`@reply #3612 E7 ${screen}: excluded replies are listed without changing the active filters`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page, otherPage]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const peer = await fixture.attach(
        otherPage!,
        screen === 'duty' ? 'analysis' : 'duty',
        'user-2',
      );
      const source = fixture.seed('user-1', 'Visible source');
      const excluded = fixture.seed('user-2', 'Other sender reply', {
        timestamp: Date.now() - 3 * 86_400_000,
      });
      fixture.respondWithReplies([relation(1, source, excluded)]);
      if (screen === 'analysis') await visit(actor, 'all', '&search=Visible');
      else {
        const state = {
          messageFeeds: [['mf-0', { sendersSelected: ['user-1'] }, { groupScopeMasterKey: null }]],
        };
        await actor.page.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
      }
      await visit(peer);
      await expect(row(actor, source.id)).toBeVisible();
      await expect(row(actor, excluded.id)).toHaveCount(0);
      const url = actor.page.url();
      const panel = await openThread(actor, source, 2);
      const filters = actor.requests
        .filter(({ path }) => path === '/api/rer-importer/get-inbox')
        .at(-1)!.body;
      expect(filters).toMatchObject(
        screen === 'analysis' ? { search: 'Visible' } : { selected_senders: ['user-1'] },
      );
      const item = panel.getByRole('listitem').filter({ hasText: 'Other sender reply' });
      await expect(item).toContainText('Поза поточними фільтрами');
      await item.getByText('Other sender reply', { exact: true }).click();
      await expect(actor.page.getByText(/змін.*фільтр/i).first()).toBeVisible();
      expect(actor.page.url()).toBe(url);
      await expect(row(actor, excluded.id)).toHaveCount(0);
      if (await panel.isVisible()) await closeThread(actor);
      await fixture.nextCreate(peer, 'New excluded reply', source.id, () => {
        const reply = fixture.add(peer.user, 'New excluded reply');
        fixture.respondWithReplies([relation(1, source, excluded), relation(2, source, reply)]);
        fixture.notify([source.id, reply.id]);
        return reply;
      });
      await beginReply(peer, source);
      await saveReply(peer, 'New excluded reply');
      const updated = await openThread(actor, source, 3);
      await expect(
        updated.getByRole('listitem').filter({ hasText: 'New excluded reply' }),
      ).toContainText('Поза поточними фільтрами');
      await expect(row(actor, fixture.messages.at(-1)!.id)).toHaveCount(0);
      expect(actor.page.url()).toBe(url);
      await closeThread(actor);
      if (screen === 'analysis') {
        const reply = fixture.messages.at(-1)!;
        fixture.respondWithReplies([]);
        const from = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
        const till = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
        await visit(actor, 'all', `&fromDateTime=${from}T00:00&toDateTime=${till}T23:59`);
        const dateUrl = actor.page.url();
        await expect(row(actor, excluded.id)).toHaveCount(0);
        const datePanel = await openThread(actor, source, 3);
        await expect(
          datePanel.getByRole('listitem').filter({ hasText: 'Other sender reply' }),
        ).toContainText('Поза поточними фільтрами');
        await datePanel.getByText('Other sender reply', { exact: true }).click();
        await expect(actor.page.getByText(/змін.*фільтр/i).first()).toBeVisible();
        expect(actor.page.url()).toBe(dateUrl);
        await expect(row(actor, excluded.id)).toHaveCount(0);
        if (await datePanel.isVisible()) await closeThread(actor);
      }
      await selectGroup(actor, 'group-2');
      await expect(row(actor, source.id)).toHaveCount(0);
    });
  });

  test(`@reply #3612 E12 ${screen}: removing the source keeps the draft and creates an independent message`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Wrong source');
      await fixture.nextCreate(actor, 'Independent draft', null, () =>
        fixture.add(actor.user, 'Independent draft'),
      );
      await visit(actor);
      await beginReply(actor, source);
      await editor(actor)
        .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
        .fill('Independent draft');
      await detachReply(actor);
      await expect(
        editor(actor).getByRole('textbox', { name: 'Текст повідомлення', exact: true }),
      ).toHaveValue('Independent draft');
      await expect(editor(actor).getByText('Wrong source', { exact: true })).toHaveCount(0);
      await expect(
        editor(actor).getByRole('combobox', { name: 'Група', exact: true }),
      ).toBeEnabled();
      await saveReply(actor, 'Independent draft');
      await expect(row(actor, fixture.messages.at(-1)!.id)).toContainText('Independent draft');
      await expect(row(actor, source.id).getByRole('button', { name: /^Усі \d+$/ })).toHaveCount(0);
      await expect(
        row(actor, fixture.messages.at(-1)!.id).getByRole('button', { name: /^Усі \d+$/ }),
      ).toHaveCount(0);
    });
  });
}
