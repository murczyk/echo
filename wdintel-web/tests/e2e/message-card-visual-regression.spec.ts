import { expect, test } from '@playwright/test';
import type { Locator, Page } from '@playwright/test';

import type { InboxMessage } from '../../src/Bindings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { openMessageCardPreviewHost } from './message-card-media-preview.fixtures';

function buildInboxMessage(id: number): InboxMessage {
  return minimalInboxMessage({
    messageUid: `e2e-message-${id}`,
    text: `Card ${id} https://example.test/cards/${id}`,
    date: '13.07.2026',
    time: '12:34',
    freq: '123.4',
    timestamp: 1_720_000_000_000 + id * 1_000,
    groupMasterKey: 'group-1',
    sender: `Sender ${id}`,
    extendedForm: `EXT-${id}`,
    location: `Location ${id}`,
    callsigns: [`CALL${id}`],
    callsignsAlg2: [`ALT${id}`],
    messageComments: [
      {
        id: id * 10 + 1,
        messageId: id,
        comment: `Comment ${id}`,
        login: `peer-${id}`,
        sigintPostName: null,
      },
    ],
    metadata: [
      {
        colorCode: 'red',
        colorCodeStartIndex: null,
        colorCodeEndIndex: null,
        callGroupIdStartIndex: null,
        callGroupIdEndIndex: null,
        callGroupNameStartIndex: null,
        callGroupNameEndIndex: null,
        senderIdStartIndex: null,
        senderIdEndIndex: null,
        senderNameStartIndex: null,
        senderNameEndIndex: null,
        hashIdStartIndex: null,
        hashIdEndIndex: null,
        senderName: `Sender ${id}`,
        senderId: `ID-${id}`,
        callGroupName: `Group ${id}`,
        callGroupId: `group-${id}`,
        hashId: `hash-${id}`,
      },
    ],
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

function buildMetrics(locator: Locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      rect: {
        left: rect.left,
        right: rect.right,
        width: rect.width,
        top: rect.top,
        bottom: rect.bottom,
      },
      fontSize: style.fontSize,
      paddingLeft: style.paddingLeft,
      paddingRight: style.paddingRight,
      scrollbarGutter: style.scrollbarGutter,
      clientWidth: element.clientWidth,
      clientHeight: element.clientHeight,
      offsetWidth: element.offsetWidth,
      scrollWidth: element.scrollWidth,
      scrollHeight: element.scrollHeight,
      scrollTop: element.scrollTop,
    };
  });
}

async function installVisualFixture(
  page: Page,
): Promise<{ setOverflowMode: (value: boolean) => void }> {
  const compactIds = [41];
  const expandedIds = Array.from({ length: 40 }, (_, index) => index + 41);
  let overflowMode = false;

  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: () => buildInboxResponse(overflowMode ? expandedIds : compactIds),
  });

  return {
    setOverflowMode: (value: boolean) => {
      overflowMode = value;
    },
  };
}

test.describe('message card visual regression', () => {
  test('keeps exclusion-menu labels readable at 14px', async ({ page }) => {
    await openMessageCardPreviewHost(page, 'duty');

    await page.getByRole('button', { name: 'Виключити…' }).click();
    const menu = page.getByRole('menu', { name: 'Виключення з фільтрів' });
    const menuItems = menu.locator('.MuiMenuItem-root');
    const firstMenuItem = menuItems.first();
    await expect(firstMenuItem).toBeVisible();
    await expect(firstMenuItem).toHaveCSS('font-size', '14px');
    await expect(firstMenuItem).toContainText('Виключити');
    const menuItemWidth = await firstMenuItem.evaluate((item) => ({
      clientWidth: item.clientWidth,
      scrollWidth: item.scrollWidth,
    }));
    expect(menuItemWidth.scrollWidth).toBeLessThanOrEqual(menuItemWidth.clientWidth);

    await firstMenuItem.focus();
    await page.keyboard.press('ArrowDown');
    await expect(menuItems.nth(1)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
  });

  for (const host of ['duty', 'analysis'] as const) {
    test(`keeps ${host} toolbar rows responsive through viewport changes`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await openMessageCardPreviewHost(page, host);
      const card = page.locator('.message-card-root').first();
      const buttons = card.locator('[aria-label="Дії повідомлення"] .message-card-action-btn');
      await expect(buttons.first()).toBeVisible();
      const rowCount = () =>
        buttons.evaluateAll(
          (elements) =>
            new Set(elements.map((element) => Math.round(element.getBoundingClientRect().top)))
              .size,
        );

      expect(await rowCount()).toBe(1);
      await page.setViewportSize({ width: 360, height: 900 });
      await expect.poll(rowCount).toBeGreaterThan(1);
      const narrowCard = await buildMetrics(card);
      expect(narrowCard.scrollWidth).toBeLessThanOrEqual(narrowCard.clientWidth + 1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(rowCount).toBe(1);
    });
  }

  for (const viewportWidth of [360, 768, 1023, 1025, 1280]) {
    test(`keeps theme-relative typography at ${viewportWidth}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewportWidth, height: 960 });
      await installRerDutyShortStateMocks(page, {
        inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
        inboxResponseForRequest: () => buildInboxResponse([41, 42, 43, 44, 45]),
      });

      await page.goto('/rer-duty-neo?state-short=short-1');

      const card = page.locator('.message-card-root').first();
      await expect(card).toBeVisible();

      const cardRootFontSize = await card.evaluate((node) => getComputedStyle(node).fontSize);
      expect(cardRootFontSize).toBe('14px');
      await expect(card.locator('.MuiTypography-caption')).toHaveCount(0);

      const link = card.locator('a').first();
      await expect(link).toBeVisible();
      await expect(link).toHaveText(/https:\/\/example\.test\/cards\/41/);
      await expect(link).toHaveCSS('font-size', cardRootFontSize);

      const visibleContentChecks = [
        ['time', card.getByText('12:34')],
        ['date', card.getByText('13.07.2026')],
        ['frequency', card.getByText('123.4')],
        ['location', card.getByText('Location 41')],
        ['extended form', card.getByText('EXT-41')],
        ['comment author', card.getByText('peer-41')],
        ['comment body', card.getByText('Comment 41')],
        ['message body', card.getByText(/Card 41/)],
      ] as const;
      for (const [, locator] of visibleContentChecks) {
        await expect(locator).toBeVisible();
        await expect(locator).toHaveCSS('font-size', '14px');
      }
    });
  }

  for (const viewportWidth of [360, 768, 1280]) {
    test(`keeps scrollbar spacing stable at ${viewportWidth}px`, async ({ page }) => {
      await page.setViewportSize({ width: viewportWidth, height: 900 });
      const { setOverflowMode } = await installVisualFixture(page);
      await page.goto('/rer-duty-neo?state-short=short-1');

      const scroller = page.locator('[data-duty-feed-scroller="true"]');
      const list = page.locator('[data-duty-feed-list="true"]');
      const anchorCard = page.locator('.message-card-root').filter({ hasText: 'Card 41' }).first();

      await expect(scroller).toBeVisible();
      await expect(list).toBeVisible();

      const compactMetrics = {
        scroller: await buildMetrics(scroller),
        list: await buildMetrics(list),
        card: await buildMetrics(anchorCard),
      };

      expect(compactMetrics.scroller.scrollbarGutter).toBe('stable');
      expect(Number.parseFloat(compactMetrics.scroller.paddingLeft)).toBeCloseTo(12, 1);
      expect(compactMetrics.card.rect.width).toBeGreaterThan(0);
      const compactUsableRightEdge =
        compactMetrics.scroller.rect.right -
        (compactMetrics.scroller.offsetWidth - compactMetrics.scroller.clientWidth);
      expect(Math.abs(compactMetrics.card.rect.right - compactUsableRightEdge)).toBeLessThanOrEqual(
        2,
      );
      expect(Math.abs(compactMetrics.list.rect.right - compactUsableRightEdge)).toBeLessThanOrEqual(
        2,
      );
      expect(compactMetrics.scroller.scrollWidth).toBeLessThanOrEqual(
        compactMetrics.scroller.clientWidth + 1,
      );

      setOverflowMode(true);
      await page.reload();

      const expandedMetrics = {
        scroller: await buildMetrics(scroller),
        list: await buildMetrics(list),
        card: await buildMetrics(anchorCard),
      };

      expect(expandedMetrics.scroller.scrollbarGutter).toBe('stable');
      expect(Number.parseFloat(expandedMetrics.scroller.paddingLeft)).toBeCloseTo(12, 1);
      expect(expandedMetrics.scroller.scrollHeight).toBeGreaterThan(
        expandedMetrics.scroller.clientHeight,
      );
      expect(expandedMetrics.card.rect.width).toBeCloseTo(compactMetrics.card.rect.width, 1);
      expect(expandedMetrics.scroller.clientWidth).toBe(compactMetrics.scroller.clientWidth);
      expect(expandedMetrics.scroller.scrollWidth).toBeLessThanOrEqual(
        expandedMetrics.scroller.clientWidth + 1,
      );
      const expandedUsableRightEdge =
        expandedMetrics.scroller.rect.right -
        (expandedMetrics.scroller.offsetWidth - expandedMetrics.scroller.clientWidth);
      expect(
        Math.abs(expandedMetrics.card.rect.right - expandedUsableRightEdge),
      ).toBeLessThanOrEqual(2);
      expect(
        Math.abs(expandedMetrics.list.rect.right - expandedUsableRightEdge),
      ).toBeLessThanOrEqual(2);
    });
  }
});
