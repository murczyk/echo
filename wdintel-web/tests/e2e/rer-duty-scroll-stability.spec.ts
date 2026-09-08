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

// @test-scope regression: https://github.com/echoua/echo/pull/3268
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
  await expect
    .poll(async () => Math.abs((await readAnchorOffset(anchor)) - anchorBefore.offsetTop))
    .toBeLessThanOrEqual(1);
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
  await expect
    .poll(async () => Math.abs((await readAnchorOffset(anchor)) - settledAnchorOffset))
    .toBeLessThanOrEqual(1);

  await setBottomDistance(scroller, 0);
  await secondNewerRequestStarted.promise;
  await expect(bottomButton).toHaveCount(0);

  secondNewerResponse.resolve(buildInboxResponse([42]));
  await expect(list.locator('[data-duty-message-id="42"]')).toBeAttached();
  await expect.poll(() => readBottomDistance(scroller)).toBeLessThanOrEqual(1);
  await expect(bottomButton).toHaveCount(0);
});

// @test-scope regression: https://github.com/echoua/echo/issues/3360
test('keeps an OFF reading anchor stable while a long snackbar error is shown @smoke', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const longError = 'unbroken-server-error-'.repeat(80);
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });
  await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/plain', body: longError });
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  const list = page.locator('[data-duty-feed-list="true"]');
  await expect(list.locator('[data-duty-message-id="1"]')).toBeAttached();
  const anchorBefore = await readVisibleAnchor(scroller);
  await expect(page.getByText(longError)).toBeVisible();
  const snackbar = page.locator('.MuiSnackbar-root');
  const snackbarBox = await snackbar.boundingBox();
  expect(snackbarBox).not.toBeNull();
  expect(snackbarBox!.width).toBeLessThanOrEqual(520);
  expect(snackbarBox!.x).toBeGreaterThanOrEqual(24);
  expect(snackbarBox!.x + snackbarBox!.width).toBeLessThanOrEqual(1280);
  const closeButton = page.getByRole('button', { name: 'Закрити сповіщення' });
  await expect(closeButton).toBeVisible();
  const closeButtonBox = await closeButton.boundingBox();
  expect(closeButtonBox).not.toBeNull();
  expect(closeButtonBox!.y).toBeGreaterThanOrEqual(0);
  expect(closeButtonBox!.y + closeButtonBox!.height).toBeLessThanOrEqual(900);
  expect(
    await snackbar.evaluate((element) => {
      const alert = element.querySelector<HTMLElement>('.MuiAlert-root')!;
      return alert.scrollWidth <= alert.clientWidth;
    }),
  ).toBe(true);
  const message = snackbar.locator('.MuiAlert-message');
  expect(
    await message.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop + element.clientHeight >= element.scrollHeight;
    }),
  ).toBe(true);
  const anchor = list.locator(`[data-duty-message-id="${anchorBefore.id}"]`);
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(anchorBefore.offsetTop, 0);
  await closeButton.click();
  await expect(snackbar).toHaveCount(0);
  await expect.poll(() => readAnchorOffset(anchor)).toBeCloseTo(anchorBefore.offsetTop, 0);
});

// @test-scope regression: https://github.com/echoua/echo/issues/3400
test('keeps an unbroken snackbar error within the narrow viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const longError = 'unbroken-server-error-'.repeat(80);
  await installRerDutyShortStateMocks(page, {
    disableAutoScroll: true,
    inboxResponse: buildInboxResponse(Array.from({ length: 40 }, (_, index) => index + 1)),
  });
  await page.route('**/api/rer-importer/get-inbox-count', async (route) => {
    await route.fulfill({ status: 500, contentType: 'text/plain', body: longError });
  });

  await page.goto('/rer-duty-neo?state-short=short-1');
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  await expect(page.locator('[data-duty-message-id="1"]')).toBeAttached();
  const scrollerBox = await scroller.boundingBox();
  await expect(page.getByText(longError)).toBeVisible();
  const snackbar = page.locator('.MuiSnackbar-root');
  const snackbarBox = await snackbar.boundingBox();
  expect(snackbarBox).not.toBeNull();
  expect(snackbarBox!.width).toBeLessThanOrEqual(374);
  expect(snackbarBox!.x).toBeGreaterThanOrEqual(8);
  expect(snackbarBox!.x + snackbarBox!.width).toBeLessThanOrEqual(390);
  const closeButton = page.getByRole('button', { name: 'Закрити сповіщення' });
  await expect(closeButton).toBeVisible();
  const closeButtonBox = await closeButton.boundingBox();
  expect(closeButtonBox).not.toBeNull();
  expect(closeButtonBox!.y).toBeGreaterThanOrEqual(0);
  expect(closeButtonBox!.y + closeButtonBox!.height).toBeLessThanOrEqual(844);
  expect(
    await snackbar.evaluate((element) => {
      const alert = element.querySelector<HTMLElement>('.MuiAlert-root')!;
      return alert.scrollWidth <= alert.clientWidth;
    }),
  ).toBe(true);
  const message = snackbar.locator('.MuiAlert-message');
  expect(
    await message.evaluate((element) => {
      element.scrollTop = element.scrollHeight;
      return element.scrollTop + element.clientHeight >= element.scrollHeight;
    }),
  ).toBe(true);
  expect(await scroller.boundingBox()).toEqual(scrollerBox);
  await closeButton.click();
  await expect(snackbar).toHaveCount(0);
  expect(await scroller.boundingBox()).toEqual(scrollerBox);
});
