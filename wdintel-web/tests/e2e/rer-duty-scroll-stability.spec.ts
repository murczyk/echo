import { expect, test, type Locator } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

function buildInboxMessage(id: number): InboxMessage {
  return minimalInboxMessage({
    messageUid: `scroll-stability-${id}`,
    text: `Card ${id} ${'stable message content '.repeat(32)}`,
    timestamp: 1_720_000_000_000 + id * 1_000,
    groupMasterKey: 'group-1',
  });
}

function buildInboxResponse(ids: number[]): InboxMessagesRspRaw {
  return {
    inbox_items: ids.map((id) => [id, buildInboxMessage(id) as never]),
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function readSinceId(requestBody: unknown): number | null {
  const request = requestBody as {
    since_id_noninclusive?: number | null;
    sinceIdNoninclusive?: number | null;
  };
  return request.since_id_noninclusive ?? request.sinceIdNoninclusive ?? null;
}

async function setBottomDistance(scroller: Locator, distance: number) {
  await scroller.evaluate((element, requestedDistance) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - requestedDistance;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  }, distance);
}

async function readVisibleAnchor(scroller: Locator) {
  return scroller.evaluate((element) => {
    const scrollerRect = element.getBoundingClientRect();
    const anchor = Array.from(element.querySelectorAll<HTMLElement>('[data-duty-message-id]')).find(
      (item) => {
        const itemRect = item.getBoundingClientRect();
        return itemRect.bottom > scrollerRect.top && itemRect.top < scrollerRect.bottom;
      },
    );
    if (!anchor) throw new Error('No visible message anchor');
    return {
      id: Number(anchor.dataset.dutyMessageId),
      offsetTop: anchor.getBoundingClientRect().top - scrollerRect.top,
    };
  });
}

async function readAnchorOffset(anchor: Locator) {
  return anchor.evaluate((element) => {
    const scroller = element.closest('[data-duty-feed-scroller="true"]')!;
    return element.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  });
}

async function readBottomDistance(scroller: Locator) {
  return scroller.evaluate(
    (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
  );
}

test('follows only while the bottom arrow is hidden and preserves the reading anchor @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const firstNewerResponse = createDeferred<InboxMessagesRspRaw>();
  const firstNewerRequestStarted = createDeferred<void>();
  const secondNewerResponse = createDeferred<InboxMessagesRspRaw>();
  const secondNewerRequestStarted = createDeferred<void>();
  let newerRequestCount = 0;

  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        newerRequestCount += 1;
        firstNewerRequestStarted.resolve();
        return firstNewerResponse.promise;
      }
      if (readSinceId(requestBody) === 41) {
        newerRequestCount += 1;
        secondNewerRequestStarted.resolve();
        return secondNewerResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');

  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  const bottomButton = page.locator('[data-duty-feed-scroll-button]');
  await expect(scroller).toBeVisible();
  await expect(list.locator('[data-duty-message-id="40"]')).toBeAttached();
  await firstNewerRequestStarted.promise;

  await setBottomDistance(scroller, 200);
  await expect(bottomButton).toBeVisible();
  const anchorBefore = await readVisibleAnchor(scroller);

  firstNewerResponse.resolve(buildInboxResponse([41]));
  await expect(list.locator('[data-duty-message-id="41"]')).toBeAttached();
  await expect(list.locator('[data-duty-message-id]')).toHaveCount(40);

  const anchor = list.locator(`[data-duty-message-id="${anchorBefore.id}"]`);
  await expect(anchor).toBeAttached();
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(anchorBefore.offsetTop, 0);
  await expect(bottomButton).toBeVisible();
  await expect.poll(() => readBottomDistance(scroller)).toBeGreaterThan(1);

  const unreadBadge = bottomButton.locator('.MuiChip-root').filter({ hasText: /^1$/ });
  await expect(unreadBadge).toBeVisible();
  const badgeBox = await unreadBadge.boundingBox();
  expect(badgeBox).not.toBeNull();
  expect(Math.abs(badgeBox!.width - badgeBox!.height)).toBeLessThanOrEqual(1);

  await scroller.evaluate((element) => {
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.waitForTimeout(100);
  expect(newerRequestCount).toBe(1);

  const settledAnchorOffset = await readAnchorOffset(anchor);
  await list.locator('[data-duty-message-id="2"]').evaluate((element) => {
    element.style.paddingBottom = '120px';
  });
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(settledAnchorOffset, 0);

  await setBottomDistance(scroller, 0);
  await secondNewerRequestStarted.promise;
  await expect(bottomButton).toHaveCount(0);

  secondNewerResponse.resolve(buildInboxResponse([42]));
  await expect(list.locator('[data-duty-message-id="42"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await expect(bottomButton).toHaveCount(0);
});

test('#3360 does not pin an OFF feed during its initial load @smoke', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="1"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeGreaterThan(1);
  await expect.poll(() => readVisibleAnchor(scroller)).toMatchObject({ id: 1 });
});

test('#3360 does not pin an OFF feed after remounting the route', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  await expect(page.locator('[data-duty-message-id="1"]')).toBeAttached();
  await page.reload();
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="1"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeGreaterThan(1);
  await expect.poll(() => readVisibleAnchor(scroller)).toMatchObject({ id: 1 });
});

test('#3360 uses a verified nonanimated landing when reduced motion is preferred', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRerDutyShortStateMocks(page, {
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  await expect(page.locator('[data-duty-message-id="40"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
});

test('#3360 keeps an OFF feed anchored at the physical bottom when a background arrival is buffered', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const newerRequestStarted = createDeferred<void>();
  const newerResponse = createDeferred<InboxMessagesRspRaw>();
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 1, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        newerRequestStarted.resolve();
        return newerResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="40"]')).toBeAttached();
  await setBottomDistance(scroller, 0);
  const anchorBefore = await readVisibleAnchor(scroller);
  const anchor = list.locator(`[data-duty-message-id="${anchorBefore.id}"]`);
  const anchorOffset = await readAnchorOffset(anchor);
  await newerRequestStarted.promise;

  newerResponse.resolve(buildInboxResponse([41]));
  await expect(page.locator('[data-duty-feed-scroll-button]')).toBeVisible();
  await expect(list.locator('[data-duty-message-id="41"]')).toHaveCount(0);
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(anchorOffset, 0);
});

test('#3360 lets manual OFF reading reveal buffered arrivals without following them', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const newerRequestStarted = createDeferred<void>();
  const newerResponse = createDeferred<InboxMessagesRspRaw>();
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 1, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        newerRequestStarted.resolve();
        return newerResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="40"]')).toBeAttached();
  await setBottomDistance(scroller, 0);
  await newerRequestStarted.promise;
  newerResponse.resolve(buildInboxResponse([41]));
  await expect(list.locator('[data-duty-message-id="41"]')).toHaveCount(0);

  await setBottomDistance(scroller, 70);
  await expect(list.locator('[data-duty-message-id="41"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeGreaterThan(1);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(list.locator('[data-duty-message-id="1"]')).toBeAttached();
});

test('#3360 lets an OFF arrow land an explicitly requested tail page', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const arrowRequestStarted = createDeferred<void>();
  const arrowResponse = createDeferred<InboxMessagesRspRaw>();
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 1, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        arrowRequestStarted.resolve();
        return arrowResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="40"]')).toBeAttached();
  const arrow = page.getByRole('button', { name: 'Завантажити нові та перейти вниз' });
  await expect(arrow).toBeVisible();
  await arrow.click();
  await arrowRequestStarted.promise;

  arrowResponse.resolve(buildInboxResponse([41]));
  await expect(list.locator('[data-duty-message-id="41"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await setBottomDistance(scroller, 200);
  await expect(page.getByText('Завантажено нові повідомлення')).toBeVisible();
});

test('#3360 verifies an OFF arrow landing when a positive count has no newer page', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const arrowRequestStarted = createDeferred<void>();
  const arrowResponse = createDeferred<InboxMessagesRspRaw>();
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 1, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        arrowRequestStarted.resolve();
        return arrowResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  await expect(page.locator('[data-duty-message-id="40"]')).toBeAttached();
  await page.getByRole('button', { name: 'Завантажити нові та перейти вниз' }).click();
  await arrowRequestStarted.promise;

  arrowResponse.resolve(buildInboxResponse([]));
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await setBottomDistance(scroller, 200);
  await expect(page.getByText('Завантажено нові повідомлення')).toBeVisible();
});

test('#3360 uses an instant verified landing for reduced-motion arrow navigation', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 1280, height: 900 });
  const arrowRequestStarted = createDeferred<void>();
  const arrowResponse = createDeferred<InboxMessagesRspRaw>();
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => ({ quantity: 1, first_element_ts: null }),
    inboxResponseForRequest: (requestBody) => {
      if (readSinceId(requestBody) === 40) {
        arrowRequestStarted.resolve();
        return arrowResponse.promise;
      }
      if (readSinceId(requestBody) !== null) return buildInboxResponse([]);
      return buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1));
    },
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  await expect(page.locator('[data-duty-message-id="40"]')).toBeAttached();
  await page.getByRole('button', { name: 'Завантажити нові та перейти вниз' }).click();
  await arrowRequestStarted.promise;

  arrowResponse.resolve(buildInboxResponse([41]));
  await expect(page.locator('[data-duty-message-id="41"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
});

test('#3360 releases an arrow loading state when a pending count navigation is cancelled', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const countRequestStarted = createDeferred<void>();
  const countResponse = createDeferred<{ quantity: number; first_element_ts: null }>();
  let holdCount = false;
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxCountResponseForRequest: () => {
      if (!holdCount) return { quantity: 0, first_element_ts: null };
      countRequestStarted.resolve();
      return countResponse.promise;
    },
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const arrow = page.getByRole('button', { name: 'Завантажити нові та перейти вниз' });
  await expect(page.locator('[data-duty-message-id="40"]')).toBeAttached();
  holdCount = true;
  await arrow.click();
  await countRequestStarted.promise;
  await expect(arrow).toBeDisabled();

  await setBottomDistance(scroller, 0);
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await page.waitForTimeout(100);
  await scroller.evaluate((element) => {
    element.scrollTop = 0;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await expect(arrow).toBeEnabled();
  countResponse.resolve({ quantity: 1, first_element_ts: null });
  await expect(arrow).toBeEnabled();
});

test('#3360 keeps an OFF reading anchor stable while a polling error is shown @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });
  await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/plain', body: 'poll failed' });
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="1"]')).toBeAttached();
  const anchorBefore = await readVisibleAnchor(scroller);
  await expect(page.getByText(/poll failed/i)).toBeVisible();
  const anchor = list.locator(`[data-duty-message-id="${anchorBefore.id}"]`);
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(anchorBefore.offsetTop, 0);
});
