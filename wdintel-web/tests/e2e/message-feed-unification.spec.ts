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
  await installMessageContext(page);
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

type FourPageRequest = {
  before_id_noninclusive?: number | null;
  since_id_noninclusive?: number | null;
  newest_first?: boolean;
};

function fourPageResponse(request: FourPageRequest) {
  const firstId =
    request.before_id_noninclusive != null
      ? Math.floor((request.before_id_noninclusive - 1) / 20) * 20
      : request.since_id_noninclusive != null
        ? Math.ceil((request.since_id_noninclusive + 1) / 20) * 20
        : request.newest_first === false
          ? 120
          : 180;
  const response = messagePage(firstId);
  if (request.newest_first === false) response.inbox_items.reverse();
  return response;
}

async function installFourPages(page: Page) {
  await installAnalysisNeoApiMocks(page);
  await installMessageContext(page);
  const requests: FourPageRequest[] = [];
  await page.route('**/api/rer-importer/get-inbox-count', (route) =>
    route.fulfill({ json: { quantity: 80, first_element_ts: null } }),
  );
  await page.route('**/api/rer-importer/get-inbox', (route) => {
    const request = route.request().postDataJSON();
    requests.push(request);
    return route.fulfill({ json: fourPageResponse(request) });
  });
  return requests;
}

async function installMessageContext(page: Page) {
  await page.route('**/api/rer-importer/inbox-item-context', (route) => {
    const reference = route.request().postDataJSON().message_uid;
    const id = Number(/^feed-unification-(\d+)$/.exec(reference)?.[1]);
    const response = Number.isFinite(id) ? messagePage(Math.ceil(id / 20) * 20) : null;
    const message = response?.inbox_items.find(([, item]) => item.messageUid === reference) ?? null;
    return route.fulfill({ json: { message } });
  });
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
  for (const newestFirst of [true, false]) {
    test(`Analysis keeps a bounded window in both scroll directions (${newestFirst ? 'newest' : 'oldest'} first)`, async ({
      page,
    }) => {
      const requests = await installFourPages(page);
      const reverseRequest = (request: FourPageRequest) =>
        newestFirst
          ? request.since_id_noninclusive === 160
          : request.before_id_noninclusive === 121;
      let releaseReverse!: () => void;
      const pendingReverse = new Promise<void>((resolve) => {
        releaseReverse = resolve;
      });
      await page.route('**/api/rer-importer/get-inbox', async (route) => {
        const request = route.request().postDataJSON() as FourPageRequest;
        if (!reverseRequest(request)) return route.fallback();
        requests.push(request);
        await pendingReverse;
        return route.fulfill({ json: fourPageResponse(request) });
      });
      await page.goto(`/rer-analysis-neo?newestFirst=${newestFirst}`);
      const scroller = page.locator('[data-analysis-message-scroller]');
      await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
      for (const nextPage of [2, 3]) {
        await scroller.locator('[data-message-feed-skeleton="below"]').scrollIntoViewIfNeeded();
        await expect.poll(() => requests.length).toBeGreaterThanOrEqual(nextPage);
        await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
      }
      const firstId = newestFirst ? 180 : 101;
      const thirdId = newestFirst ? 140 : 141;
      await expect(scroller.locator(`[data-message-id="${firstId}"]`)).not.toBeAttached();
      await expect(scroller.locator(`[data-message-id="${thirdId}"]`)).toBeAttached();

      await scroller.locator('[data-message-feed-skeleton="above"]').scrollIntoViewIfNeeded();
      await expect.poll(() => requests.some(reverseRequest)).toBe(true);
      const anchor = await visibleAnchor(scroller);
      releaseReverse();
      await expect(scroller.locator(`[data-message-id="${firstId}"]`)).toBeAttached();
      await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
      await expect(scroller.locator(`[data-message-id="${thirdId}"]`)).not.toBeAttached();
      await expect
        .poll(async () =>
          scroller.locator(`[data-message-id="${anchor.id}"]`).evaluate((card, offset) => {
            const viewport = card.closest('[data-analysis-message-scroller]')!;
            return Math.abs(
              card.getBoundingClientRect().top - viewport.getBoundingClientRect().top - offset,
            );
          }, anchor.offset),
        )
        .toBeLessThanOrEqual(1);

      await scroller.evaluate((element) => {
        element.scrollTop = 0;
        element.dispatchEvent(new Event('scroll', { bubbles: true }));
      });
      await expect.poll(() => new URL(page.url()).searchParams.get('messagesPage')).toBeNull();
      const pageCounter = page.getByRole('button', {
        name: 'Перейти до першої або останньої сторінки',
      });
      await expect(pageCounter).toContainText('1-20 з 80');

      const nextPage = page.getByRole('button', { name: 'Наступна сторінка', exact: true });
      await nextPage.click();
      await expect(pageCounter).toContainText('21-40 з 80');
      const requestCount = requests.length;
      await nextPage.click();
      await expect(pageCounter).toContainText('41-60 з 80');
      await expect.poll(() => new URL(page.url()).searchParams.get('messagesPage')).toBe('3');
      expect(requests.length).toBeGreaterThan(requestCount);
      await expect(scroller.locator('[data-message-id]')).toHaveCount(40);

      await pageCounter.click();
      await page.getByRole('menuitem', { name: 'Остання сторінка' }).click();
      await expect(pageCounter).toContainText('61-80 з 80');
      await pageCounter.click();
      await page.getByRole('menuitem', { name: 'Перша сторінка' }).click();
      await expect(pageCounter).toContainText('1-20 з 80');
      await expect(scroller.locator(`[data-message-id="${firstId}"]`)).toBeAttached();
      await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    });
  }

  test('Analysis keeps a bounded window while scrolling', async ({ page }) => {
    const requests = await installFourPages(page);
    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    await scroller.locator('[data-message-feed-skeleton="below"]').scrollIntoViewIfNeeded();
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    await scroller.locator('[data-message-feed-skeleton="below"]').scrollIntoViewIfNeeded();
    await expect(scroller.locator('[data-message-id="121"]')).toBeAttached();
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    await expect(scroller.locator('[data-message-id="180"]')).not.toBeAttached();
    expect(requests.some((request) => request.before_id_noninclusive === 141)).toBe(true);
  });

  test('Analysis loads the next page without moving the reading anchor', async ({ page }) => {
    const requests = await installPages(page);
    let releasePage!: () => void;
    const pendingPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      const request = route.request().postDataJSON();
      if (request.before_id_noninclusive !== 141) {
        return route.fallback();
      }
      requests.push(request);
      await pendingPage;
      return route.fulfill({ json: messagePage(140) });
    });
    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    const edgeLoader = scroller.locator('[data-message-feed-skeleton="below"]');
    await edgeLoader.scrollIntoViewIfNeeded();
    await expect(edgeLoader).toBeInViewport();
    const anchor = await visibleAnchor(scroller);
    releasePage();
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

  test('Analysis defers an edge page commit until wheel input settles', async ({ page }) => {
    await installPages(page);
    let releasePage!: () => void;
    const pendingPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      if (route.request().postDataJSON().before_id_noninclusive !== 141) {
        return route.fallback();
      }
      await pendingPage;
      return route.fulfill({ json: messagePage(140) });
    });

    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    const edgeLoader = scroller.locator('[data-message-feed-skeleton="below"]');
    await edgeLoader.scrollIntoViewIfNeeded();
    await expect(edgeLoader).toHaveAttribute('role', 'status');
    await edgeLoader.scrollIntoViewIfNeeded();
    await expect(edgeLoader).toBeInViewport();
    const anchor = await visibleAnchor(scroller);
    const wheelTimer = await scroller.evaluate((element) => {
      const wheel = () =>
        element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 }));
      wheel();
      return window.setInterval(wheel, 30);
    });
    try {
      releasePage();
      await page.waitForTimeout(80);
      await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
      await expect(edgeLoader).toBeAttached();
    } finally {
      releasePage();
      await scroller.evaluate((_, timer) => window.clearInterval(timer), wheelTimer);
    }
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
    await expect.poll(async () => (await visibleAnchor(scroller)).id).toBe(anchor.id);
    await expect
      .poll(async () => Math.abs((await visibleAnchor(scroller)).offset - anchor.offset))
      .toBeLessThanOrEqual(1);
  });

  test('Analysis loads the next page when its in-flow skeleton becomes visible', async ({
    page,
  }) => {
    await installPages(page);
    let releasePage!: () => void;
    const pendingPage = new Promise<void>((resolve) => {
      releasePage = resolve;
    });
    let pageRequested = false;
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      if (route.request().postDataJSON().before_id_noninclusive !== 141) {
        return route.fallback();
      }
      pageRequested = true;
      await pendingPage;
      return route.fulfill({ json: messagePage(140) });
    });

    await page.goto('/rer-analysis-neo');
    const scroller = page.locator('[data-analysis-message-scroller]');
    await expect(scroller.locator('[data-message-id]')).toHaveCount(20);
    const edgeLoader = scroller.locator('[data-message-feed-skeleton="below"]');
    await expect(edgeLoader).toBeAttached();
    await scroller.evaluate((element) => {
      element.scrollTop = element.scrollHeight - element.clientHeight - 300;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    try {
      expect(pageRequested).toBe(false);
      await edgeLoader.scrollIntoViewIfNeeded();
      await expect(edgeLoader).toBeInViewport();
      await expect.poll(() => pageRequested).toBe(true);
      await expect(edgeLoader.locator('[data-message-feed-skeleton-card]')).toHaveCount(1);
      expect(
        await scroller.evaluate((element) => {
          const lastCard = Array.from(
            element.querySelectorAll<HTMLElement>('[data-message-id]'),
          ).at(-1);
          const skeleton = element.querySelector<HTMLElement>(
            '[data-message-feed-skeleton="below"]',
          );
          return Boolean(
            lastCard &&
            skeleton &&
            skeleton.getBoundingClientRect().top >= lastCard.getBoundingClientRect().bottom,
          );
        }),
      ).toBe(true);
    } finally {
      releasePage();
    }
    await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
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
      await installMessageContext(page);
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
      await expect(scroller.locator('[data-message-feed-skeleton="above"]')).toBeAttached();
      await expect(scroller.locator('[data-message-feed-skeleton="below"]')).toBeAttached();
      for (const edge of ['above', 'below'] as const) {
        const edgeLoader = scroller.locator(`[data-message-feed-skeleton="${edge}"]`);
        await edgeLoader.scrollIntoViewIfNeeded();
        await expect(edgeLoader).toBeInViewport();
        const anchor = await visibleAnchor(scroller);
        const direction = (edge === 'above') === newestFirst ? 'later' : 'earlier';
        await expect.poll(() => pending.has(direction)).toBe(true);
        pending.get(direction)!();
        await expect(scroller.locator('[data-message-id]')).toHaveCount(40);
        await expect
          .poll(async () => {
            const offset = await scroller
              .locator(`[data-message-id="${anchor.id}"]`)
              .evaluate((element) => {
                const viewport = element.closest('[data-analysis-message-scroller]')!;
                return element.getBoundingClientRect().top - viewport.getBoundingClientRect().top;
              });
            return Math.abs(offset - anchor.offset);
          })
          .toBeLessThanOrEqual(1);
      }
      const ids = await scroller
        .locator('[data-message-id]')
        .evaluateAll((elements) =>
          elements.map((element) => element.getAttribute('data-message-id')),
        );
      expect(new Set(ids).size).toBe(40);
      expect(requests.some((request) => request.before_id_noninclusive === 121)).toBe(true);
      expect(requests.some((request) => request.since_id_noninclusive === 140)).toBe(true);
    });
  }
});
