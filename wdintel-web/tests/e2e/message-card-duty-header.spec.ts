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

async function installTaggedVisualFixture(page: Page): Promise<void> {
  const message = buildInboxMessage(41);
  message.tags = [1, 2, 3, 4, 5];
  message.inboxTags = [
    { id: 1, tagId: 1, confidence: 1, login: 'operator', model: null, organismId: null },
  ];
  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: () => ({
      ...buildInboxResponse([]),
      inbox_items: [[41, message as never]],
    }),
    tagsResponse: [
      [1, { id: 1, label: 'Рух', is_palitra: false, ownerOrganismId: 1 }],
      [2, { id: 2, label: 'Зв’язок', is_palitra: false }],
      [3, { id: 3, label: 'РЕБ', is_palitra: false }],
      [4, { id: 4, label: 'Артилерія', is_palitra: false }],
      [5, { id: 5, label: 'Розвідка', is_palitra: false }],
    ],
  });
}

async function installMixedTagVisualFixture(
  page: Page,
): Promise<{ modelErrorRequests: () => number }> {
  const message = buildInboxMessage(41);
  message.tags = [1];
  message.inboxTags = [
    { id: 1, tagId: 1, confidence: 1, login: 'operator', model: null, organismId: null },
    { id: 2, tagId: 1, confidence: 0.92, login: null, model: 'bot', organismId: null },
  ];
  let modelErrorRequestCount = 0;
  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: () => ({
      ...buildInboxResponse([]),
      inbox_items: [[41, message as never]],
    }),
    tagsResponse: [[1, { id: 1, label: 'Рух', is_palitra: false }]],
  });
  await page.route('**/api/tags/tags-rm', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/tags/tags-add', (route) => route.fulfill({ status: 200, body: '' }));
  await page.route('**/api/tags/tag-model-error', (route) => {
    modelErrorRequestCount += 1;
    return route.fulfill({ status: 200, body: '' });
  });
  return { modelErrorRequests: () => modelErrorRequestCount };
}

test.describe('message card Duty header @regression', () => {
  // Regression: https://github.com/echoua/echo/issues/3570
  test('#3570 keeps the narrow Duty header compact and right-aligned @regression', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 412, height: 915 });
    await installTaggedVisualFixture(page);
    await page.goto('/rer-duty-neo?state-short=short-1');

    const card = page.locator('.message-card-root').first();
    await card.evaluate((element) => {
      const item = element.closest<HTMLElement>('.message-card-item');
      if (item) item.style.width = '330px';
    });
    const actions = card.locator('[aria-label="Дії повідомлення"]');
    const timestampItems = card.locator('[data-message-card-timestamp-item="true"]');
    const creationTimestamp = timestampItems.first().locator('.message-card-text');
    const expandLabel = card.locator('.message-card-tag-expand__label');

    await expect(actions).toBeVisible();
    const alignment = await card.evaluate((element) => {
      const cardRect = element.getBoundingClientRect();
      const cardStyle = getComputedStyle(element);
      const actionElement = element.querySelector<HTMLElement>('[aria-label="Дії повідомлення"]');
      const actionRect = actionElement?.getBoundingClientRect();
      return {
        rightGap:
          cardRect.right - Number.parseFloat(cardStyle.paddingRight) - (actionRect?.right ?? 0),
        topGap: (actionRect?.top ?? 0) - cardRect.top - Number.parseFloat(cardStyle.paddingTop),
      };
    });
    expect(Math.abs(alignment.rightGap)).toBeLessThanOrEqual(2);
    expect(Math.abs(alignment.topGap)).toBeLessThanOrEqual(2);
    expect(
      await actions
        .locator('.message-card-action-btn')
        .evaluateAll(
          (buttons) =>
            new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
        ),
    ).toBe(1);
    await expect(creationTimestamp).toHaveCSS('font-size', '12px');
    expect(
      await timestampItems.evaluateAll((items) => {
        const [creation, interception] = items.map((item) => item.getBoundingClientRect());
        return (interception?.top ?? 0) - (creation?.bottom ?? 0);
      }),
    ).toBeLessThanOrEqual(1);
    const metadataSpacing = await card.evaluate((element) => {
      const timestamps = element.querySelectorAll<HTMLElement>(
        '[data-message-card-timestamp-item="true"]',
      );
      const interception = timestamps.item(timestamps.length - 1).getBoundingClientRect();
      const metadataRows = new Map<number, { top: number; bottom: number }>();
      element
        .querySelectorAll<HTMLElement>(
          '.message-card-content [data-message-card-metadata-item="true"]',
        )
        .forEach((item) => {
          const rect = item.getBoundingClientRect();
          const rowKey = Math.round(rect.top);
          const row = metadataRows.get(rowKey);
          metadataRows.set(rowKey, {
            top: Math.min(row?.top ?? rect.top, rect.top),
            bottom: Math.max(row?.bottom ?? rect.bottom, rect.bottom),
          });
        });
      const [firstRow, secondRow] = [...metadataRows.values()].toSorted(
        (left, right) => left.top - right.top,
      );
      return {
        headerToMetadata: (firstRow?.top ?? 0) - interception.bottom,
        betweenMetadataRows: (secondRow?.top ?? 0) - (firstRow?.bottom ?? 0),
      };
    });
    expect(
      Math.abs(metadataSpacing.headerToMetadata - metadataSpacing.betweenMetadataRows),
    ).toBeLessThanOrEqual(1);
    expect(
      await creationTimestamp.evaluate((element) => {
        const textRange = document.createRange();
        textRange.selectNodeContents(element);
        return textRange.getClientRects().length;
      }),
    ).toBe(1);
    await expect(expandLabel).toHaveCount(1);
    await expect(expandLabel).toBeHidden();
  });
});
