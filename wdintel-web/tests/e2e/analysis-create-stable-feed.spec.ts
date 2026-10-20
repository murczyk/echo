import { expect, test } from '@playwright/test';
import {
  groupFeedPath,
  holdNext,
  row,
  settleResponse,
  viewMessage,
  withGroupFeedActors,
} from './group-feed-actors.fixtures';

for (const position of ['start', 'middle', 'paged'] as const) {
  test(`@regression #3727 Analysis: creating a message at the ${position} keeps the feed visible without a loading skeleton`, async ({
    browser,
    baseURL,
  }) => {
    await withGroupFeedActors(browser, baseURL, async (fixture, [page]) => {
      const actor = await fixture.attach(page, 'analysis', 'user-1');
      if (position === 'paged') fixture.setPageLimit(20);
      for (let index = 0; index < (position === 'paged' ? 60 : 12); index++) {
        fixture.add(actor.user, Array(10).fill(`Existing message ${index}`).join('\n'));
      }
      await page.goto(groupFeedPath('analysis', 'group-1', '&newestFirst=true'));
      const scroller = page.locator('[data-analysis-message-scroller]');
      const anchorId = position === 'start' ? 112 : position === 'middle' ? 106 : 151;
      await expect(row(actor, anchorId)).toBeAttached();
      if (position !== 'start') await viewMessage(actor, anchorId);
      await expect(page.getByRole('button', { name: 'Оновити', exact: true })).toBeEnabled();
      await page.getByRole('button', { name: 'Додати повідомлення', exact: true }).click();
      const input = page.getByRole('textbox', { name: 'Текст повідомлення' });
      await input.click();
      await input.fill('New own message');
      await expect(input).toHaveValue('New own message');
      const submit = page.getByRole('button', { name: 'Створити', exact: true });
      await expect(submit).toBeEnabled();
      await expect(row(actor, anchorId)).toBeInViewport();
      const anchor = await row(actor, anchorId).elementHandle();
      const offset = () =>
        row(actor, anchorId).evaluate((element) => {
          const viewport = element.closest('[data-analysis-message-scroller]')!;
          return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
        });
      const offsetBefore = await offset();
      const skeletons =
        position === 'paged'
          ? scroller.locator(
              '[data-message-feed-skeleton="initial"], [data-message-feed-skeleton="refresh"]',
            )
          : scroller.locator('[data-message-feed-skeleton]');
      await scroller.evaluate((element) => {
        element.setAttribute('data-test-creation-skeleton-seen', 'false');
        const observer = new MutationObserver(() => {
          if (
            element.querySelector(
              '[data-message-feed-skeleton="initial"], [data-message-feed-skeleton="refresh"]',
            )
          ) {
            element.setAttribute('data-test-creation-skeleton-seen', 'true');
            observer.disconnect();
          }
        });
        observer.observe(element, { childList: true, subtree: true });
      });
      const gate = holdNext(actor, 'inbox');
      const submitted = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/1.1/submit-direct') && response.status() === 200,
      );
      void submitted.catch(() => {});
      const refreshed = page.waitForResponse((response) =>
        response.url().endsWith('/api/rer-importer/get-inbox'),
      );
      void refreshed.catch(() => {});
      try {
        await submit.click();
        await gate.started;
        await settleResponse(actor, submitted);
        await expect(skeletons).toHaveCount(0);
        expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
        await expect(scroller).toHaveAttribute('aria-busy', 'true');
        if (position === 'middle')
          expect(Math.abs((await offset()) - offsetBefore)).toBeLessThan(1);
        if (position === 'paged') {
          const inboxRequests = () =>
            actor.requests.filter(({ path }) => path.endsWith('/get-inbox')).length;
          const beforeScroll = inboxRequests();
          await scroller.hover();
          await page.mouse.wheel(0, 100_000);
          await page.waitForTimeout(500);
          expect(inboxRequests()).toBe(beforeScroll);
          await page.mouse.wheel(0, -8);
        }
      } finally {
        gate.release();
      }
      await settleResponse(actor, refreshed);
      await expect(scroller).toHaveAttribute('aria-busy', 'false');
      await expect(scroller).toHaveAttribute('data-test-creation-skeleton-seen', 'false');
      await expect(skeletons).toHaveCount(0);
      if (position === 'middle') {
        await expect.poll(async () => Math.abs((await offset()) - offsetBefore)).toBeLessThan(1);
        expect(await anchor!.evaluate((element) => element.isConnected)).toBe(true);
      } else if (position === 'start') {
        await expect(row(actor, 113)).toBeInViewport();
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBe(0);
      } else {
        await scroller.hover();
        await page.mouse.wheel(0, 100_000);
        await expect(row(actor, 130)).toBeAttached();
        const ids = await scroller
          .locator('[data-message-id]')
          .evaluateAll((elements) =>
            elements.map((element) => element.getAttribute('data-message-id')),
          );
        expect(new Set(ids).size).toBe(ids.length);
      }
    });
  });
}
