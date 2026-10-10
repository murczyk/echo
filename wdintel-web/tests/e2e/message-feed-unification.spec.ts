import { expect, test, type Locator, type Page } from '@playwright/test';
import {
  createOverflowingInboxResponse,
  installAnalysisNeoApiMocks,
} from './analysis-neo.fixtures';

function messagePage(firstId: number) {
  const response = createOverflowingInboxResponse();
  return {
    ...response,
    inbox_items: response.inbox_items.map(([, message], index) => [
      firstId - index,
      {
        ...message,
        messageUid: `feed-unification-${firstId - index}`,
        text: `Feed message ${firstId - index} ${'reading context '.repeat(24)}`,
      },
    ]) as typeof response.inbox_items,
  };
}

async function installPages(page: Page) {
  await installAnalysisNeoApiMocks(page);
  const requests: Array<{
    before_id_noninclusive?: number | null;
    since_id_noninclusive?: number | null;
    newest_first?: boolean;
  }> = [];
  await page.route('**/api/rer-importer/get-inbox-count', (route) =>
    route.fulfill({ json: { quantity: 60, first_element_ts: null } }),
  );
  await page.route('**/api/rer-importer/get-inbox', (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    const response = messagePage(
      request.before_id_noninclusive === 141
        ? 140
        : request.before_id_noninclusive === 121
          ? 120
          : 160,
    );
    if (request.around_message_ref) response.inbox_items.reverse();
    return route.fulfill({ json: response });
  });
  return requests;
}

async function visibleAnchor(scroller: Locator) {
  return scroller.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-message-id]')).find(
      (card) => card.getBoundingClientRect().bottom > top,
    );
    if (!anchor) throw new Error('No visible message');
    return { id: anchor.dataset.messageId, offset: anchor.getBoundingClientRect().top - top };
  });
}

// Regression: https://github.com/echoua/echo/issues/3689
test.describe('Message feed unification @regression', () => {
  test('Analysis accumulates pages without moving the reading anchor', async ({ page }) => {
    const requests = await installPages(page);
    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 300;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    const anchor = await visibleAnchor(scroller);
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    await expect(scroller.locator('[data-message-id="160"]')).toBeAttached();
    await expect(scroller.locator('[data-message-id="121"]')).toBeAttached();
    await expect.poll(async () => (await visibleAnchor(scroller)).id).toBe(anchor.id);
    await expect
      .poll(async () => Math.abs((await visibleAnchor(scroller)).offset - anchor.offset))
      .toBeLessThanOrEqual(1);
    expect(requests.filter((request) => request.before_id_noninclusive === 141)).toHaveLength(1);
    expect(requests.at(-1)).toMatchObject({
      before_id_noninclusive: 141,
      since_id_noninclusive: null,
      newest_first: true,
    });
  });

  test('Analysis scrolls between loaded pages without fetching them again', async ({ page }) => {
    const requests = await installPages(page);
    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    const secondPage = scroller.locator('[data-message-id="140"]');
    await secondPage.evaluate((element) => {
      const scroller = element.closest('ul')!.parentElement!;
      scroller.scrollTop +=
        element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(
      page.getByRole('button', { name: 'Попередня сторінка', exact: true }),
    ).toBeEnabled();
    const requestCount = requests.length;
    await page.getByRole('button', { name: 'Попередня сторінка', exact: true }).click();
    await expect
      .poll(() => scroller.evaluate((element) => element.scrollTop))
      .toBeLessThanOrEqual(1);
    await page.getByRole('button', { name: 'Наступна сторінка', exact: true }).click();
    await expect
      .poll(() =>
        secondPage.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().top -
              element.closest('ul')!.parentElement!.getBoundingClientRect().top,
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(requests).toHaveLength(requestCount);
  });

  test('Analysis keeps a focused target centered through viewport resizing', async ({ page }) => {
    await installPages(page);
    await page.goto('/rer-analysis-neo?m=feed-unification-150');
    const scroller = page.locator('[data-analysis-message-scroller]');
    const target = scroller.locator('[data-message-id="150"] [data-message-card-root]');
    await expect(target).toBeVisible();
    const centerError = () =>
      target.evaluate((card) => {
        const container = card.closest('[data-analysis-message-scroller]')!;
        const cardRect = card.getBoundingClientRect();
        const viewport = container.getBoundingClientRect();
        return Math.abs(cardRect.top + cardRect.height / 2 - viewport.top - viewport.height / 2);
      });
    await expect.poll(centerError).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(centerError).toBeLessThanOrEqual(1);
    await scroller.hover();
    await page.mouse.wheel(0, -500);
    await expect.poll(centerError).toBeGreaterThan(100);
    await page.setViewportSize({ width: 1100, height: 844 });
    await expect.poll(centerError).toBeGreaterThan(100);
  });

  test('Analysis fetches an unloaded page and aligns its first message', async ({ page }) => {
    const requests = await installPages(page);
    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    await page.getByRole('button', { name: 'Наступна сторінка', exact: true }).click();
    const firstMessage = scroller.locator('[data-message-id="140"]');
    await expect(firstMessage).toBeVisible();
    await expect
      .poll(() =>
        firstMessage.evaluate((element) =>
          Math.abs(
            element.getBoundingClientRect().top -
              element.closest('ul')!.parentElement!.getBoundingClientRect().top,
          ),
        ),
      )
      .toBeLessThanOrEqual(1);
    expect(requests.at(-1)).toMatchObject({ before_id_noninclusive: 141, newest_first: true });
  });

  test('Analysis centers an exhausted context boundary with shared scroll space', async ({
    page,
  }) => {
    await installPages(page);
    await page.goto('/rer-analysis-neo?m=feed-unification-141');
    const scroller = page.locator('[data-analysis-message-scroller]');
    const target = scroller.locator('[data-message-id="141"] [data-message-card-root]');
    await expect(target).toBeVisible();
    const centerError = () =>
      target.evaluate((card) => {
        const viewport = card.closest('[data-analysis-message-scroller]')!.getBoundingClientRect();
        const rect = card.getBoundingClientRect();
        return Math.abs(rect.top + rect.height / 2 - viewport.top - viewport.height / 2);
      });
    await expect.poll(centerError).toBeLessThanOrEqual(1);
    await expect(scroller.locator('[data-direct-message-anchor-spacer]')).toBeAttached();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(centerError).toBeLessThanOrEqual(1);
  });

  for (const newestFirst of [true, false]) {
    test(`Analysis retains its reading anchor while loading both focused edges (${newestFirst ? 'newest' : 'oldest'} first)`, async ({
      page,
    }) => {
      await installAnalysisNeoApiMocks(page);
      const requests: Array<{ before_id_noninclusive?: number; since_id_noninclusive?: number }> =
        [];
      const pending = new Map<string, () => void>();
      await page.route('**/api/rer-importer/get-inbox', async (route) => {
        const request = route.request().postDataJSON();
        requests.push(request);
        if (request.around_message_ref) {
          const response = messagePage(140);
          response.inbox_items.reverse();
          await route.fulfill({
            json: {
              ...response,
              around_message_messages_before: 29,
              around_message_messages_after: 30,
            },
          });
          return;
        }
        const earlier = request.before_id_noninclusive === 121;
        const later = request.since_id_noninclusive === 140;
        if (!earlier && !later) {
          await route.fulfill({ json: { ...messagePage(140), inbox_items: [] } });
          return;
        }
        await new Promise<void>((resolve) => pending.set(earlier ? 'earlier' : 'later', resolve));
        const response = messagePage(earlier ? 120 : 160);
        if (later) response.inbox_items.reverse();
        await route.fulfill({ json: response });
      });
      await page.goto(`/rer-analysis-neo?m=feed-unification-130&newestFirst=${newestFirst}`);
      const scroller = page.locator('[data-analysis-message-scroller]');
      await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
      await scroller.hover();
      await page.mouse.wheel(0, -80);
      for (const edge of ['above', 'below'] as const) {
        await scroller.evaluate((element, edge) => {
          element.scrollTop =
            edge === 'above' ? 1 : element.scrollHeight - element.clientHeight - 1;
          element.dispatchEvent(new Event('scroll', { bubbles: true }));
        }, edge);
        const anchor = await visibleAnchor(scroller);
        const direction = (edge === 'above') === newestFirst ? 'later' : 'earlier';
        await expect.poll(() => pending.has(direction)).toBe(true);
        pending.get(direction)!();
        await expect(scroller.locator('[data-message-id]')).toHaveCount(edge === 'above' ? 40 : 60);
        await expect.poll(async () => (await visibleAnchor(scroller)).id).toBe(anchor.id);
        await expect
          .poll(async () => Math.abs((await visibleAnchor(scroller)).offset - anchor.offset))
          .toBeLessThanOrEqual(1);
      }
      const ids = await scroller
        .locator('[data-message-id]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-message-id')),
        );
      expect(new Set(ids).size).toBe(60);
      expect(requests.some((request) => request.before_id_noninclusive === 121)).toBe(true);
      expect(requests.some((request) => request.since_id_noninclusive === 140)).toBe(true);
    });
  }
});
