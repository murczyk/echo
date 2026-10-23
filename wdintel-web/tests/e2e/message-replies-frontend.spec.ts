import { expect, test } from '@playwright/test';
import { row } from './group-feed-actors.fixtures';
import {
  beginReply,
  editor,
  relation,
  saveReply,
  visit,
  withReplyActors,
} from './message-replies.fixtures';

for (const screen of ['duty', 'analysis'] as const) {
  test(`@regression #3612 ${screen}: compact reply items open a scrolling overlay and navigate in the source feed`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      await page!.setViewportSize({ width: 1920, height: 1000 });
      const actor = await fixture.attach(page!, screen, 'user-1');
      fixture.setPageLimit(20);
      const target = fixture.seed('user-2', 'Distant original');
      for (let i = 0; i < 200; i++) fixture.seed('user-2', `History ${i}`);
      const replies = [target];
      for (let i = 1; i < 40; i++) replies.push(fixture.seed('user-2', `Reply item ${i}`));
      const current = fixture.seed('user-1', 'Current message');
      fixture.respondWithReplies(
        replies.map((reply, index) => relation(index + 1, current, reply)),
      );
      const other = fixture.seed('user-2', 'Other feed untouched', { groups: ['group-2'] });
      if (screen === 'duty') {
        const state = {
          messageFeeds: [
            ['mf-other', {}, { groupScopeMasterKey: 'group-2' }],
            ['mf-replies', {}, { groupScopeMasterKey: 'group-1' }],
          ],
        };
        await page!.goto(`/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`);
      } else await visit(actor);
      const card = row(actor, current.id);
      const chain = card.getByRole('region', { name: 'Відповіді', exact: true });
      await expect(chain.getByRole('link')).toHaveCount(2);
      await expect(row(actor, target.id)).toHaveCount(0);
      const before = await card.boundingBox();
      const url = page!.url();
      await chain.getByRole('button', { name: 'Усі 40', exact: true }).click();
      const panel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(panel).toBeVisible();
      const after = await card.boundingBox();
      expect(after!.height).toBeCloseTo(before!.height, 0);
      expect(after!.y).toBeCloseTo(before!.y, 0);
      const scroller = panel.locator('[data-reply-list]');
      expect(
        await scroller.evaluate((element) => element.scrollHeight > element.clientHeight),
      ).toBe(true);
      await panel.getByRole('link').last().scrollIntoViewIfNeeded();
      await expect(panel.getByText('Reply item 39', { exact: true })).toBeInViewport();
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-popover.png`),
        animations: 'disabled',
      });
      await panel.getByRole('link').first().scrollIntoViewIfNeeded();
      await panel.getByRole('link').first().click();
      await expect(panel).toHaveCount(0);
      await expect(row(actor, target.id)).toBeInViewport();
      expect(page!.context().pages()).toHaveLength(1);
      expect(page!.url()).toBe(url);
      if (screen === 'duty') await expect(row(actor, other.id)).toBeInViewport();
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-landed.png`),
        animations: 'disabled',
      });
      if (screen === 'duty') {
        await row(actor, target.id).getByRole('link').filter({ hasText: current.text }).click();
        await expect(row(actor, current.id)).toBeInViewport();
        await expect
          .poll(() =>
            row(actor, current.id).evaluate((element) => {
              const viewport = element.closest('[data-message-feed-scroller]')!;
              return (
                viewport.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
              );
            }),
          )
          .toBeLessThan(32);
        await page!.screenshot({
          path: test.info().outputPath('duty-newest-reply-landed.png'),
          animations: 'disabled',
        });
      }
    });
  });

  test(`@regression #3612 ${screen}: reply uses the shared side editor and clears the source outline after save`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      await page!.setViewportSize({ width: 1920, height: 1000 });
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Reply source');
      await fixture.nextCreate(actor, 'Independent reply', source.id, () => {
        const reply = fixture.add(actor.user, 'Independent reply');
        fixture.respondWithReplies([relation(1, source, reply)]);
        fixture.notify([source.id, reply.id]);
        return reply;
      });
      await visit(actor);
      await beginReply(actor, source);
      await expect(editor(actor)).toHaveAttribute('data-manage-message-presentation', 'embedded');
      await expect(
        editor(actor).getByRole('combobox', { name: 'Група', exact: true }),
      ).toBeDisabled();
      await expect(row(actor, source.id).locator('[data-message-card-root]')).toHaveCSS(
        'outline-style',
        'solid',
      );
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-editor.png`),
        animations: 'disabled',
      });
      await saveReply(actor, 'Independent reply');
      await expect(row(actor, source.id).locator('[data-message-card-root]')).not.toHaveCSS(
        'outline-style',
        'solid',
      );
      await expect(
        row(actor, source.id).getByRole('link').filter({ hasText: 'Independent reply' }),
      ).toBeVisible();
    });
  });

  test(`@regression #3612 ${screen}: filtered-out reply stays in the current tab without changing filters`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const outside = fixture.seed('user-2', 'Outside selected group', { groups: ['group-2'] });
      const current = fixture.seed('user-1', 'Visible source');
      fixture.respondWithReplies([relation(1, current, outside)]);
      await visit(actor);
      const link = row(actor, current.id).getByRole('link').filter({ hasText: outside.text });
      await expect(link).toBeVisible();
      const url = page!.url();
      await link.click();
      await expect(
        page!.getByText(
          'Повідомлення поза поточними фільтрами. Змініть фільтри, щоб побачити його.',
          { exact: true },
        ),
      ).toBeVisible();
      expect(page!.context().pages()).toHaveLength(1);
      expect(page!.url()).toBe(url);
      await expect(row(actor, outside.id)).toHaveCount(0);
      await expect(row(actor, current.id)).toBeVisible();
    });
  });
  test(`@regression #3612 ${screen}: reply respects the existing editor's unsaved draft guard`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      await page!.setViewportSize({ width: 1920, height: 1000 });
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Guarded reply source');
      await visit(actor);
      await page!.getByRole('button', { name: 'Додати повідомлення', exact: true }).first().click();
      const text = editor(actor).getByRole('textbox', { name: 'Текст повідомлення', exact: true });
      await text.fill('Keep this ordinary draft');
      await row(actor, source.id).getByRole('button', { name: 'Відповісти', exact: true }).click();
      const confirmation = page!.getByRole('dialog', {
        name: 'Відхилити незбережені зміни?',
        exact: true,
      });
      await expect(confirmation).toBeVisible();
      await confirmation
        .getByRole('button', { name: 'Продовжити редагування', exact: true })
        .click();
      await expect(text).toHaveValue('Keep this ordinary draft');
      await expect(
        editor(actor).getByRole('region', { name: 'Цитоване повідомлення' }),
      ).toHaveCount(0);
      await row(actor, source.id).getByRole('button', { name: 'Відповісти', exact: true }).click();
      await confirmation.getByRole('button', { name: 'Відхилити зміни', exact: true }).click();
      await expect(text).toBeEmpty();
      await expect(
        editor(actor).getByRole('region', { name: 'Цитоване повідомлення' }),
      ).toContainText(source.text);
      await expect(page!.locator('[data-manage-message-presentation]')).toHaveCount(1);
    });
  });

  test(`@regression #3612 ${screen}: mobile reply overlay preserves tombstones and returns keyboard focus`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      await page!.setViewportSize({ width: 390, height: 844 });
      await page!.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
      const actor = await fixture.attach(page!, screen, 'user-1');
      const deleted = fixture.seed('user-2', 'Deleted private text', { deleted: true });
      const first = fixture.seed(
        'user-2',
        'First readable reply with a very long preview that must stay inside a narrow card',
      );
      const last = fixture.seed('user-2', 'Last readable reply');
      const current = fixture.seed('user-1', 'Mobile source');
      fixture.respondWithReplies([
        relation(1, current, deleted),
        relation(2, current, first),
        relation(3, current, last),
      ]);
      await visit(actor);
      if (screen === 'analysis') {
        await page!.getByRole('button', { name: 'Закрити фільтри', exact: true }).click();
        await page!.getByRole('button', { name: 'Закрити ліву панель', exact: true }).click();
      }
      const trigger = row(actor, current.id).getByRole('button', { name: 'Усі 3', exact: true });
      await trigger.focus();
      await trigger.press('Enter');
      const panel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('listitem').first()).toContainText('Видалено');
      await expect(panel.getByRole('listitem').first().getByRole('link')).toHaveCount(0);
      await expect(panel).not.toContainText('Deleted private text');
      const bounds = await panel.boundingBox();
      expect(bounds!.x).toBeGreaterThanOrEqual(0);
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-mobile-dark.png`),
        animations: 'disabled',
      });
      await page!.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  });
}

test('@regression #3612 duty: navigating to a newest reply already loaded leaves no blank tail', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    await page!.setViewportSize({ width: 1920, height: 1000 });
    const actor = await fixture.attach(page!, 'duty', 'user-1');
    fixture.setPageLimit(40);
    const source = fixture.seed('user-2', 'Loaded original');
    for (let i = 0; i < 30; i++) fixture.seed('user-2', `Between replies ${i}`);
    const latest = fixture.seed('user-1', 'Newest loaded reply');
    fixture.respondWithReplies([relation(1, source, latest)]);
    await visit(actor);
    await row(actor, latest.id).getByRole('link').filter({ hasText: source.text }).click();
    await expect(row(actor, source.id)).toBeInViewport();
    await row(actor, source.id).getByRole('link').filter({ hasText: latest.text }).click();
    await expect(row(actor, latest.id)).toBeInViewport();
    await expect
      .poll(() =>
        row(actor, latest.id).evaluate((element) => {
          const viewport = element.closest('[data-message-feed-scroller]')!;
          return viewport.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
        }),
      )
      .toBeLessThan(32);
    await page!.screenshot({
      path: test.info().outputPath('duty-loaded-newest-reply.png'),
      animations: 'disabled',
    });
  });
});

test('@regression #3612 analysis: filters changed after a reply jump cannot retain excluded messages', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    await page!.setViewportSize({ width: 1920, height: 1000 });
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    const target = fixture.seed('user-2', 'Text-only reply target');
    const source = fixture.seed('user-1', 'Text-only source');
    fixture.respondWithReplies([relation(1, source, target)]);
    await page!.route('**/api/rer-importer/get-inbox', async (route) => {
      if (!route.request().postDataJSON().only_with_media) return route.fallback();
      await route.fulfill({
        json: {
          inbox_items: [],
          callsigns: [],
          signal_profiles: {},
          signal_groups: [],
          freq_pelengs_summary: null,
          page_limit: 20,
          around_message_messages_before: null,
          around_message_messages_after: null,
        },
      });
    });
    await visit(actor, 'group-1', '&filterPanelOpen=true');
    await row(actor, source.id).getByRole('link').filter({ hasText: target.text }).click();
    await expect(row(actor, target.id)).toBeInViewport();
    await page!.getByRole('button', { name: /^Важливе/ }).click();
    await page!.getByRole('checkbox', { name: 'З медіа', exact: true }).check();
    await expect(row(actor, target.id)).toHaveCount(0);
    await expect(row(actor, source.id)).toHaveCount(0);
    await expect(page!.getByRole('checkbox', { name: 'З медіа', exact: true })).toBeChecked();
  });
});
