import { expect, test } from '@playwright/test';
import { holdNext, row } from './group-feed-actors.fixtures';
import {
  beginReply,
  editor,
  fillReply,
  relation,
  saveReply,
  visit,
  withReplyActors,
} from './message-replies.fixtures';

test('@regression #3612 analysis: reply navigation keeps the newest message at the end without blank space', async ({
  browser,
  baseURL,
}) => {
  await withReplyActors(browser, baseURL, async (fixture, [page]) => {
    await page!.setViewportSize({ width: 1920, height: 1000 });
    const actor = await fixture.attach(page!, 'analysis', 'user-1');
    fixture.setPageLimit(20);
    const source = fixture.seed('user-2', 'Oldest source');
    for (let i = 0; i < 100; i++) fixture.seed('user-2', `History ${i}`);
    const newest = fixture.seed('user-1', 'Newest reply at the end');
    fixture.respondWithReplies([relation(1, source, newest)]);
    await visit(actor, 'group-1', '&newestFirst=false');
    await expect(row(actor, source.id)).toBeInViewport();
    await row(actor, source.id).getByRole('link').filter({ hasText: newest.text }).click();
    const target = row(actor, newest.id);
    await expect(target).toBeInViewport();
    await expect
      .poll(() =>
        target.evaluate((element) => {
          const scroller = element.closest('[data-message-feed-scroller]')!;
          return scroller.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom;
        }),
      )
      .toBeLessThan(32);
    await expect(page!.locator('[data-direct-message-anchor-spacer]')).toHaveCount(0);
    await page!.screenshot({ path: test.info().outputPath('analysis-newest-reply-landed.png') });
  });
});

for (const screen of ['duty', 'analysis'] as const) {
  test(`@regression #3612 ${screen}: read-only users can view chains without reply actions on desktop or mobile`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Read-only source');
      const reply = fixture.seed('user-1', 'Read-only reply');
      fixture.respondWithReplies([relation(1, source, reply)]);
      await visit(actor);
      const user = await page!.evaluate(() =>
        fetch('/api/user').then((response) => response.json()),
      );
      for (const role of ['CyberViewer', 'CyberViewerRestricted']) {
        await page!.route('**/api/user', (route) =>
          route.fulfill({ json: { ...user, roles: [role] } }),
        );
        await page!.setViewportSize({ width: 1920, height: 1000 });
        await visit(actor);
        const card = row(actor, source.id);
        await expect(card.getByRole('link').filter({ hasText: reply.text })).toBeVisible();
        await expect(card.getByRole('button', { name: 'Відповісти', exact: true })).toHaveCount(0);
        await expect(
          page!.getByRole('button', { name: 'Додати повідомлення', exact: true }),
        ).toHaveCount(0);
        await page!.setViewportSize({ width: 390, height: 844 });
        if (screen === 'analysis') {
          for (const label of ['Закрити ліву панель', 'Закрити фільтри']) {
            const close = page!.getByRole('button', { name: label, exact: true });
            if (await close.isVisible()) await close.click();
          }
        }
        await card.getByRole('button', { name: 'Більше дій', exact: true }).click();
        await expect(page!.getByRole('menu')).toBeVisible();
        await expect(page!.getByRole('menuitem', { name: 'Відповісти', exact: true })).toHaveCount(
          0,
        );
        await page!.screenshot({ path: test.info().outputPath(`${screen}-${role}-read-only.png`) });
        await page!.keyboard.press('Escape');
      }
    });
  });

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
      await expect(chain.getByRole('link').first()).toHaveText('Reply item 38');
      await expect(chain.getByRole('link').last()).toHaveText('Reply item 39');
      await expect(row(actor, target.id)).toHaveCount(0);
      const before = await card.boundingBox();
      const url = page!.url();
      const allMessages = chain.getByRole('button', { name: 'Усі повідомлення 41', exact: true });
      await allMessages.hover();
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-all-messages-hover-light.png`),
        animations: 'disabled',
      });
      await allMessages.click();
      const panel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('listitem')).toHaveCount(41);
      await expect(panel.locator('[aria-current="true"]')).toContainText(current.text);
      await expect(panel).not.toContainText('Оригінальне повідомлення');
      await expect(panel.getByRole('link').first()).toContainText(
        /\d{2}\.\d{2}\.\d{4} · \d{2}:\d{2}/,
      );
      await page!.screenshot({ path: test.info().outputPath(`${screen}-reply-stepper-top.png`) });
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
      const beforeNavigation = new URL(url);
      const afterNavigation = new URL(page!.url());
      beforeNavigation.searchParams.delete('messagesPage');
      afterNavigation.searchParams.delete('messagesPage');
      beforeNavigation.searchParams.sort();
      afterNavigation.searchParams.sort();
      expect(afterNavigation.href).toBe(beforeNavigation.href);
      if (screen === 'duty') await expect(row(actor, other.id)).toBeInViewport();
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-landed.png`),
        animations: 'disabled',
      });
      if (screen === 'duty') {
        await row(actor, target.id)
          .getByRole('button', { name: 'Усі повідомлення 41', exact: true })
          .click();
        await page!
          .getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true })
          .getByRole('link')
          .filter({ hasText: current.text })
          .click();
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

  test(`@regression #3612 ${screen}: reply navigation outline fades away and leaves the editor source outline persistent`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Temporary navigation highlight');
      const reply = fixture.seed('user-1', 'Linked reply');
      fixture.respondWithReplies([relation(1, source, reply)]);
      await visit(actor);
      const target = row(actor, source.id);
      const card = target.locator('[data-message-card-root]');
      const link = row(actor, reply.id).getByRole('link').filter({ hasText: source.text });
      await link.click();
      await expect(target).toBeInViewport();
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
      await expect
        .poll(
          () =>
            card.evaluate((element) => {
              const color = getComputedStyle(element).outlineColor;
              const alpha = color.startsWith('rgba(')
                ? Number(color.slice(color.lastIndexOf(',') + 1, -1))
                : 1;
              return alpha > 0 && alpha < 1;
            }),
          { intervals: [50] },
        )
        .toBe(true);
      await page!.screenshot({ path: test.info().outputPath(`${screen}-outline-fading.png`) });
      await expect(target).not.toHaveAttribute('data-message-feed-highlighted', 'true');
      await expect(card).not.toHaveCSS('outline-style', 'solid');
      await page!.screenshot({ path: test.info().outputPath(`${screen}-outline-cleared.png`) });
      await link.click();
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
      await expect
        .poll(() =>
          card.evaluate((element) => {
            const animation = element
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSAnimation &&
                  animation.animationName === 'message-feed-linked-highlight',
              );
            return Number(animation?.currentTime ?? 0);
          }),
        )
        .toBeGreaterThan(1200);
      await link.click();
      await expect
        .poll(() =>
          card.evaluate((element) => {
            const animation = element
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSAnimation &&
                  animation.animationName === 'message-feed-linked-highlight',
              );
            return Number(animation?.currentTime ?? Infinity);
          }),
        )
        .toBeLessThan(1000);
      if (screen === 'analysis') {
        const animationStartedAt = await card.evaluate(
          (element) =>
            element
              .getAnimations()
              .find(
                (animation) =>
                  animation instanceof CSSAnimation &&
                  animation.animationName === 'message-feed-linked-highlight',
              )?.startTime,
        );
        expect(animationStartedAt).toBeDefined();
        await page!.route('**/api/rer/bookmark/add', (route) => route.fulfill({ status: 204 }));
        await target.getByRole('button', { name: 'Додати в закладки', exact: true }).click();
        await expect(
          target.getByRole('button', { name: 'Прибрати з закладок', exact: true }),
        ).toBeVisible();
        await page!.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
            ),
        );
        expect(
          await card.evaluate(
            (element) =>
              element
                .getAnimations()
                .find(
                  (animation) =>
                    animation instanceof CSSAnimation &&
                    animation.animationName === 'message-feed-linked-highlight',
                )?.startTime,
          ),
        ).toBe(animationStartedAt);
      }
      await expect(target).not.toHaveAttribute('data-message-feed-highlighted', 'true');
      await page!.emulateMedia({ reducedMotion: 'reduce' });
      await link.click();
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
      await expect(target).not.toHaveAttribute('data-message-feed-highlighted', 'true');
      await beginReply(actor, source);
      await expect(target).toHaveAttribute('data-message-feed-highlighted', 'true');
      await expect(card).toHaveCSS('outline-style', 'solid');
      expect(
        await card.evaluate((element) =>
          element
            .getAnimations()
            .some(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.animationName === 'message-feed-linked-highlight',
            ),
        ),
      ).toBe(false);
    });
  });

  test(`@regression #3612 ${screen}: chain order uses Echo message creation time and message ID, independent of interception or relation time`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const now = Date.now();
      const root = fixture.seed('user-2', 'Original arrived later', {
        at: now - 10_000,
        timestamp: now - 60_000,
      });
      const first = fixture.seed('user-2', 'First created reply', {
        at: now - 30_000,
        timestamp: now - 10_000,
      });
      const lowId = fixture.seed('user-2', 'Equal creation lower ID', {
        at: now - 20_000,
        timestamp: now - 30_000,
      });
      const highId = fixture.seed('user-2', 'Equal creation higher ID', {
        at: lowId.at,
        timestamp: now - 40_000,
      });
      const current = fixture.seed('user-1', 'Newest member', { at: now, timestamp: now - 50_000 });
      fixture.respondWithReplies([
        relation(1, root, highId, { createdAt: now - 4_000 }),
        relation(2, root, first, { createdAt: now - 3_000 }),
        relation(3, root, lowId, { createdAt: now - 2_000 }),
        relation(4, root, current, { createdAt: now - 1_000 }),
      ]);
      await visit(actor);
      for (const basis of ['interception', 'creation'] as const) {
        await page!.evaluate(
          (messageSortBy) =>
            window.dispatchEvent(
              new CustomEvent('user-settings-updated', { detail: { messageSortBy } }),
            ),
          basis,
        );
        const chain = row(actor, current.id).getByRole('region', {
          name: 'Відповіді',
          exact: true,
        });
        const preview = chain.getByRole('listitem');
        await expect(preview).toHaveCount(2);
        await expect(preview.nth(0)).toContainText(highId.text);
        await expect(preview.nth(1)).toContainText(root.text);
        const allMessages = chain.getByRole('button', { name: /^Усі повідомлення/ });
        await expect(allMessages).toHaveText('Усі повідомлення 5');
        await allMessages.click();
        const panel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
        await expect(panel.getByRole('listitem')).toHaveCount(5);
        await expect(panel.locator('[aria-current="true"]')).toContainText(current.text);
        for (const [index, message] of [first, lowId, highId, root, current].entries()) {
          await expect(panel.getByRole('listitem').nth(index)).toContainText(message.text);
        }
        await expect(panel).not.toContainText('Оригінальне повідомлення');
        await page!.screenshot({
          path: test.info().outputPath(`${screen}-chain-${basis}-order.png`),
          animations: 'disabled',
        });
        await page!.keyboard.press('Escape');
      }
      await row(actor, root.id)
        .getByRole('button', { name: 'Усі повідомлення 5', exact: true })
        .click();
      const rootPanel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(rootPanel.getByRole('listitem')).toHaveCount(5);
      await expect(rootPanel.locator('[aria-current="true"]')).toContainText(root.text);
      await expect(rootPanel).toContainText(current.text);
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-full-thread-from-root.png`),
        animations: 'disabled',
      });
      await page!.keyboard.press('Escape');
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
      const form = editor(actor).locator('#create-message-form');
      const citation = editor(actor).getByRole('region', {
        name: 'Цитоване повідомлення',
        exact: true,
      });
      const content = editor(actor).getByRole('group', { name: /^Вміст повідомлення/ });
      await expect
        .poll(() =>
          form.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
          ),
        )
        .toBe(2);
      const citationBounds = (await citation.boundingBox())!;
      const formBounds = (await form.boundingBox())!;
      const contentBounds = (await content.boundingBox())!;
      const systemBounds = (await editor(actor)
        .getByText('Системні', { exact: true })
        .boundingBox())!;
      expect(citationBounds.width).toBeCloseTo(formBounds.width, 0);
      expect(contentBounds.y).toBeGreaterThanOrEqual(citationBounds.y + citationBounds.height);
      expect(systemBounds.y).toBeGreaterThanOrEqual(citationBounds.y + citationBounds.height);
      expect(Math.abs(contentBounds.y - systemBounds.y)).toBeLessThan(32);

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
      await page!.setViewportSize({ width: 390, height: 844 });
      await expect
        .poll(() =>
          form.evaluate(
            (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
          ),
        )
        .toBe(1);
      const narrowCitation = (await citation.boundingBox())!;
      const narrowContent = (await content.boundingBox())!;
      expect(narrowContent.y).toBeGreaterThanOrEqual(narrowCitation.y + narrowCitation.height);
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-reply-editor-narrow.png`),
        animations: 'disabled',
      });
      await page!.setViewportSize({ width: 1920, height: 1000 });
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

  test(`@regression #3612 ${screen}: repeated submit while saving sends one reply`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Single submission source');
      await fixture.nextCreate(actor, 'Only one reply', source.id, () =>
        fixture.add(actor.user, 'Only one reply'),
      );
      await visit(actor);
      await beginReply(actor, source);
      await fillReply(actor, 'Only one reply');
      const gate = holdNext(actor, 'submit');
      await editor(actor).getByRole('button', { name: 'Створити', exact: true }).click();
      await gate.started;
      await expect(
        editor(actor).getByRole('button', { name: 'Збереження...', exact: true }),
      ).toBeDisabled();
      await editor(actor)
        .locator('form')
        .evaluate(async (form) => {
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          await new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          );
        });
      expect(actor.requests.filter(({ path }) => path === '/api/1.1/submit-direct')).toHaveLength(
        1,
      );
      await page!.screenshot({
        path: test.info().outputPath('reply-submit-in-flight.png'),
        animations: 'disabled',
      });
      gate.release();
      await expect(editor(actor)).toHaveCount(0);
      await expect(row(actor, fixture.messages.at(-1)!.id)).toContainText('Only one reply');
      expect(fixture.messages.filter(({ text }) => text === 'Only one reply')).toHaveLength(1);
    });
  });

  test(`@regression #3612 ${screen}: uncertain and forbidden saves retain the draft without retrying or dropping the reply link`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page!, screen, 'user-1');
      const source = fixture.seed('user-2', 'Failure source');
      const bodies: Record<string, unknown>[] = [];
      await visit(actor);
      await beginReply(actor, source);
      await fillReply(actor, 'Keep the failed draft');
      for (const failure of ['network', 'server', 'forbidden'] as const) {
        await page!.route(
          '**/api/1.1/submit-direct',
          async (route) => {
            bodies.push(route.request().postDataJSON());
            if (failure === 'network') await route.abort('failed');
            else
              await route.fulfill({
                status: failure === 'server' ? 500 : 403,
                body: failure === 'server' ? 'Internal server error' : 'Недостатньо прав.',
              });
          },
          { times: 1 },
        );
        await editor(actor).getByRole('button', { name: 'Створити', exact: true }).click();
        await expect(editor(actor).getByRole('alert')).toBeVisible();
        await expect(
          editor(actor).getByRole('textbox', { name: 'Текст повідомлення' }),
        ).toHaveValue('Keep the failed draft');
        await expect(
          editor(actor).getByRole('button', { name: 'Створити', exact: true }),
        ).toBeEnabled();
        expect(bodies).toHaveLength(['network', 'server', 'forbidden'].indexOf(failure) + 1);
        expect(bodies.at(-1)!.engaged_message_id).toBe(source.id);
        await page!.screenshot({
          path: test.info().outputPath(`reply-${failure}-failure.png`),
          animations: 'disabled',
        });
      }
      expect(fixture.messages).toHaveLength(1);
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
      const trigger = row(actor, current.id).getByRole('button', {
        name: 'Усі повідомлення 4',
        exact: true,
      });
      await trigger.hover();
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-all-messages-hover-dark.png`),
        animations: 'disabled',
      });
      await trigger.focus();
      await trigger.press('Enter');
      const panel = page!.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(panel).toBeVisible();
      await expect(panel.getByRole('listitem')).toHaveCount(4);
      await expect(panel.locator('[aria-current="true"]')).toContainText(current.text);
      const deletedRow = panel.getByRole('listitem').filter({ hasText: 'Повідомлення видалено' });
      await expect(deletedRow).toHaveCount(1);
      await expect(deletedRow.getByRole('link')).toHaveCount(0);
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

for (const screen of ['duty', 'analysis'] as const) {
  test(`@regression #3612 ${screen}: navigation to a loaded reply is smooth and respects reduced motion`, async ({
    browser,
    baseURL,
  }) => {
    await withReplyActors(browser, baseURL, async (fixture, [page]) => {
      await page!.setViewportSize({ width: 1920, height: 1000 });
      const actor = await fixture.attach(page!, screen, 'user-1');
      fixture.setPageLimit(40);
      const source = fixture.seed('user-2', 'Loaded original');
      for (let i = 0; i < 30; i++) fixture.seed('user-2', `Between replies ${i}`);
      const latest = fixture.seed('user-1', 'Newest loaded reply');
      fixture.respondWithReplies([relation(1, source, latest)]);
      await visit(actor);
      await row(actor, latest.id).getByRole('link').filter({ hasText: source.text }).click();
      await expect(row(actor, source.id)).toBeInViewport();
      const scroller = row(actor, source.id).locator(
        'xpath=ancestor::*[@data-message-feed-scroller]',
      );
      const navigateToLatest = async () =>
        (
          await Promise.all([
            scroller.evaluate(
              (element) =>
                new Promise<number[]>((resolve) => {
                  const positions: number[] = [];
                  const start = performance.now();
                  const sample = () => {
                    positions.push(element.scrollTop);
                    if (performance.now() - start < 700) requestAnimationFrame(sample);
                    else resolve(positions);
                  };
                  requestAnimationFrame(sample);
                }),
            ),
            row(actor, source.id).getByRole('link').filter({ hasText: latest.text }).click(),
          ])
        )[0];
      const positions = await navigateToLatest();
      expect(new Set(positions.map(Math.round)).size).toBeGreaterThan(3);
      await expect(row(actor, latest.id)).toBeInViewport();
      if (screen === 'duty')
        await expect
          .poll(() =>
            row(actor, latest.id).evaluate((element) => {
              const viewport = element.closest('[data-message-feed-scroller]')!;
              return (
                viewport.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom
              );
            }),
          )
          .toBeLessThan(32);
      await page!.screenshot({
        path: test.info().outputPath(`${screen}-loaded-newest-reply.png`),
        animations: 'disabled',
      });
      await page!.emulateMedia({ reducedMotion: 'reduce' });
      await row(actor, latest.id).getByRole('link').filter({ hasText: source.text }).click();
      await expect(row(actor, source.id)).toBeInViewport();
      const reducedPositions = await navigateToLatest();
      const reducedDistance = Math.abs(reducedPositions.at(-1)! - reducedPositions[0]!);
      const largestStep = Math.max(
        ...reducedPositions.slice(1).map((top, index) => Math.abs(top - reducedPositions[index]!)),
      );
      expect(largestStep).toBeGreaterThan(reducedDistance * 0.9);
      await expect(row(actor, latest.id)).toBeInViewport();
    });
  });
}

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
