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
  message.unit = 'Підрозділ з дуже довгою назвою для перевірки перенесення тексту';
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

async function installReceiptAgeFixture(page: Page, createdAt: number): Promise<void> {
  const message = minimalInboxMessage({
    messageUid: 'receipt-age-message',
    text: 'Довге повідомлення, яке займає ліві колонки картки та залишає вільний простір унизу праворуч. '.repeat(
      12,
    ),
    createdAt,
    createdAtOrder: createdAt,
  });
  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: () => ({
      ...buildInboxResponse([]),
      inbox_items: [[41, message as never]],
    }),
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
  // Regression: https://github.com/echoua/echo/issues/3324
  test('ECHO-3324 keeps text and attachments together in two card columns and adapts to its workspace @regression', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await openMessageCardPreviewHost(page, 'duty');
    await expect(page.locator('[data-duty-feed-column]')).toHaveCount(1);
    await expect(page.locator('[data-duty-feed-column]')).toHaveCSS('max-width', '960px');
    const card = page.locator('.message-card-root').first();
    const layout = card.locator('.message-card-content-layout');
    const columnCount = () =>
      layout.evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(' ').length);

    await expect.poll(columnCount).toBe(2);
    const text = card.locator('.message-card-message-text');
    const attachments = card.locator('.message-card-attachments-region');
    const textBounds = await text.boundingBox();
    const attachmentsBounds = await attachments.boundingBox();
    expect(attachmentsBounds!.x).toBe(textBounds!.x);
    expect(attachmentsBounds!.y).toBeGreaterThanOrEqual(textBounds!.y + textBounds!.height);
    const tops = await layout.evaluate((element) =>
      Array.from(element.children, (child) => Math.round(child.getBoundingClientRect().top)),
    );
    expect(new Set(tops).size).toBe(1);

    await page.getByRole('button', { name: 'Додати повідомлення' }).click();
    const editor = page.locator('[data-manage-message-presentation="embedded"]');
    await expect(editor).toBeVisible();
    await expect.poll(columnCount).toBe(1);
    await editor.getByRole('button', { name: 'Закрити', exact: true }).click();
    await expect(editor).toBeHidden();
    await expect.poll(columnCount).toBe(2);

    for (const [width, columns] of [
      [1000, 2],
      [720, 1],
      [448, 1],
      [1512, 2],
      [1920, 2],
      [2560, 2],
      [3440, 2],
    ]) {
      await page.setViewportSize({ width, height: 900 });
      await expect.poll(columnCount).toBe(columns);
    }
  });

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
    const creationTimestamp = card.locator('[data-message-card-timestamp-footer="true"]');
    const expandLabel = card.locator('.message-card-tag-expand__label');
    const expandTags = card.getByRole('button', { name: 'Показати додаткові теги', exact: true });
    await expect(expandTags).toBeVisible();
    await expect(expandTags).toHaveCSS('font-size', '12px');
    await expect(expandTags).toHaveCSS('padding', '0px 4px');
    await expect(expandTags).toHaveCSS('border-radius', '6px');

    await expect(actions).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Створити розвіддонесення' })).toBeVisible();
    await expect(actions.getByRole('button', { name: 'Більше дій' })).toBeVisible();
    const alignment = await card.evaluate((element) => {
      const cardRect = element.getBoundingClientRect();
      const cardStyle = getComputedStyle(element);
      const actionElement = element.querySelector<HTMLElement>('[aria-label="Дії повідомлення"]');
      const actionRect = actionElement?.getBoundingClientRect();
      const leftHeaderRect = element
        .querySelector<HTMLElement>('[data-message-card-header-left="true"]')
        ?.getBoundingClientRect();
      return {
        rightGap:
          cardRect.right - Number.parseFloat(cardStyle.paddingRight) - (actionRect?.right ?? 0),
        verticalCenterGap:
          (actionRect?.top ?? 0) +
          (actionRect?.height ?? 0) / 2 -
          ((leftHeaderRect?.top ?? 0) + (leftHeaderRect?.height ?? 0) / 2),
      };
    });
    expect(Math.abs(alignment.rightGap)).toBeLessThanOrEqual(2);
    expect(Math.abs(alignment.verticalCenterGap)).toBeLessThanOrEqual(2);
    expect(
      await actions
        .locator('.message-card-action-btn')
        .evaluateAll(
          (buttons) =>
            new Set(buttons.map((button) => Math.round(button.getBoundingClientRect().top))).size,
        ),
    ).toBe(1);
    await expect(creationTimestamp).toHaveCSS('font-size', '12px');
    await expect(timestampItems).toHaveCount(1);
    await expect(creationTimestamp).toBeVisible();
    await expect(expandLabel).toHaveCount(1);
    await expect(expandLabel).toBeHidden();

    const unitRow = card.locator('[data-message-card-header-unit-row="true"]');
    const unitAlignment = await unitRow.evaluate((element) => {
      const icon = element.querySelector<HTMLElement>('.message-card-header-meta__icon');
      const text = element.querySelector<HTMLElement>('.message-card-text');
      const iconRect = icon?.getBoundingClientRect();
      const textRect = text?.getBoundingClientRect();
      return {
        iconTop: iconRect?.top ?? 0,
        textTop: textRect?.top ?? 0,
        cardRight:
          element.closest<HTMLElement>('.message-card-root')?.getBoundingClientRect().right ?? 0,
        textRight: textRect?.right ?? 0,
      };
    });
    expect(Math.abs(unitAlignment.iconTop - unitAlignment.textTop)).toBeLessThanOrEqual(2);
    expect(unitAlignment.textRight).toBeLessThanOrEqual(unitAlignment.cardRight);
  });

  for (const boundary of [
    {
      name: 'day',
      now: '2026-10-24T20:50:00Z',
      createdAt: '2026-10-24T20:49:00Z',
      before: '23:49',
      after: '24.10, 23:49',
    },
    {
      name: 'year',
      now: '2026-12-31T21:50:00Z',
      createdAt: '2026-12-20T14:47:00Z',
      before: '20.12, 16:47',
      after: '20.12.2026, 16:47',
    },
  ]) {
    test(`ECHO-3324 keeps absolute Duty receipt time in its footer across the Kyiv ${boundary.name} boundary @regression`, async ({
      page,
    }, testInfo) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.clock.install({ time: new Date(boundary.now) });
      await installReceiptAgeFixture(page, Date.parse(boundary.createdAt));
      await page.goto('/rer-duty-neo?state-short=short-1');

      const card = page.locator('.message-card-root').first();
      const footer = card.locator('[data-message-card-timestamp-footer="true"]');
      await expect(footer).toHaveText(boundary.before);
      await card.screenshot({ path: testInfo.outputPath('before-boundary.png') });
      await page.clock.fastForward(10 * 60_000 + 1_000);
      await expect(footer).toHaveText(boundary.after);
      for (const width of [1440, 448, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(footer).toHaveCSS('position', 'static');
        await expect
          .poll(() =>
            card.evaluate((element) => {
              const contentBounds = element
                .querySelector('.message-card-content-layout')
                ?.getBoundingClientRect();
              const detailsBounds = element
                .querySelector('.message-card-details-region')
                ?.getBoundingClientRect();
              const footerBounds = element
                .querySelector('[data-message-card-timestamp-footer="true"]')
                ?.getBoundingClientRect();
              return (
                contentBounds != null &&
                detailsBounds != null &&
                footerBounds != null &&
                footerBounds.top >= detailsBounds.bottom &&
                footerBounds.bottom >= contentBounds.bottom - 1
              );
            }),
          )
          .toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`after-boundary-${width}.png`) });
      }
    });
  }
});
