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
      [1, { id: 1, label: 'Рух', is_palitra: false }],
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

test.describe('message card visual regression', () => {
  test('ECHO-3324 anchors and resolves the mixed bot tag Popover without focus warnings', async ({
    page,
  }) => {
    const fixture = await installMixedTagVisualFixture(page);
    const consoleWarnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning' || message.type() === 'error') {
        consoleWarnings.push(message.text());
      }
    });
    await page.goto('/rer-duty-neo?state-short=short-1');

    const tag = page.locator('button').filter({ hasText: 'Рух' });
    await tag.click();
    const popover = page.getByRole('dialog', { name: 'Дії для тегу Рух' });
    await expect(popover).toBeVisible();
    await expect(popover.getByRole('button')).toHaveText(['СКАСУВАТИ', 'БОТ ПОМИЛИВСЯ']);
    const [tagBox, popoverBox] = await Promise.all([tag.boundingBox(), popover.boundingBox()]);
    expect(Math.abs((popoverBox?.x ?? 0) - (tagBox?.x ?? 0))).toBeLessThanOrEqual(8);

    await page.keyboard.press('Escape');
    await expect(popover).toBeHidden();
    await expect(tag).toBeFocused();

    await tag.click();
    await tag.click();
    await expect(popover).toBeVisible();
    await popover.getByRole('button', { name: 'БОТ ПОМИЛИВСЯ' }).click();
    await expect(popover).toBeHidden();
    expect(fixture.modelErrorRequests()).toBe(1);
    expect(consoleWarnings.join('\n')).not.toContain('Blocked aria-hidden');
  });

  test('keeps native EchoChip tone opacity contracts in the compiled stylesheet', async ({
    page,
  }) => {
    await openMessageCardPreviewHost(page, 'duty');
    const opacity = await page.evaluate(() => {
      const tones = [
        ['tag', false],
        ['tag', true],
        ['primary', false],
        ['neutral', false],
      ] as const;
      const chips = tones.map(([tone, selected]) => {
        const chip = document.createElement('span');
        chip.className = `echo-chip echo-chip--${tone}`;
        chip.dataset.selected = String(selected);
        chip.dataset.interactive = 'false';
        document.body.appendChild(chip);
        return chip;
      });
      const result = chips.map((chip) => getComputedStyle(chip).opacity);
      chips.forEach((chip) => chip.remove());
      return result;
    });

    expect(opacity).toEqual(['0.75', '1', '1', '1']);
  });

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
      if (host === 'duty') await expect.poll(rowCount).toBeGreaterThan(1);
      else await expect.poll(rowCount).toBe(1);
      const narrowCard = await buildMetrics(card);
      expect(narrowCard.scrollWidth).toBeLessThanOrEqual(narrowCard.clientWidth + 1);
      await page.setViewportSize({ width: 1280, height: 900 });
      await expect.poll(rowCount).toBe(1);
    });
  }

  for (const cardWidth of [920, 330] as const) {
    test(`ECHO-3324 keeps a ${cardWidth}px card within bounds without an empty sidebar`, async ({
      page,
    }) => {
      await page.setViewportSize({ width: 1500, height: 900 });
      await openMessageCardPreviewHost(page, 'duty');
      const card = page.locator('.message-card-root').first();
      await card.evaluate((element, width) => {
        const item = element.closest<HTMLElement>('.message-card-item');
        if (item) item.style.width = `${width}px`;
      }, cardWidth);

      const metrics = await card.evaluate((element) => {
        return {
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        };
      });

      expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      await expect(card.locator('.message-card-content-layout--with-sidebar')).toHaveCount(0);
    });

    test(`keeps the gallery square and inside a ${cardWidth}px card`, async ({ page }) => {
      await page.setViewportSize({ width: 1500, height: 900 });
      await openMessageCardPreviewHost(page, 'duty');
      const card = page.locator('.message-card-root').first();
      await card.evaluate((element, width) => {
        const item = element.closest<HTMLElement>('.message-card-item');
        if (item) item.style.width = `${width}px`;
      }, cardWidth);

      const thumbnail = card.locator('[data-picture-thumb-layout]').first();
      await expect(thumbnail).toBeVisible();
      const gallery = card.locator('.message-card-gallery');
      const [thumbnailBox, galleryBox, cardBox] = await Promise.all([
        thumbnail.boundingBox(),
        gallery.boundingBox(),
        card.boundingBox(),
      ]);
      expect(thumbnailBox?.width).toBeCloseTo(thumbnailBox?.height ?? 0, 1);
      expect((galleryBox?.x ?? 0) + (galleryBox?.width ?? 0)).toBeLessThanOrEqual(
        (cardBox?.x ?? 0) + (cardBox?.width ?? 0) + 1,
      );
    });
  }

  test('ECHO-3324 aligns metadata with tags at XL width and keeps the tagged sidebar contained when narrow', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await installTaggedVisualFixture(page);
    await page.goto('/rer-duty-neo?state-short=short-1');
    const card = page.locator('.message-card-root').first();
    const metadata = card.locator('.message-card-main > .message-card-main-section').first();
    const tags = card.locator('[data-message-card-tags="true"]');
    await expect(metadata).toBeVisible();
    await expect(tags).toBeVisible();
    const [metadataBox, tagsBox] = await Promise.all([metadata.boundingBox(), tags.boundingBox()]);
    expect(Math.abs((metadataBox?.y ?? 0) - (tagsBox?.y ?? 0))).toBeLessThanOrEqual(1);

    await card.evaluate((element) => {
      const item = element.closest<HTMLElement>('.message-card-item');
      if (item) item.style.width = '330px';
    });
    const metrics = await card.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
  });

  test('ECHO-3324 keeps shared card header, callsign, and report geometry within desktop and narrow bounds', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });

    for (const host of ['duty', 'analysis'] as const) {
      for (const cardWidth of [920, 330] as const) {
        await openMessageCardPreviewHost(page, host, { withPolishContent: true });
        const card = page.locator('.message-card-root').first();
        await card.evaluate((element, width) => {
          const item = element.closest<HTMLElement>('.message-card-item');
          if (item) item.style.width = `${width}px`;
        }, cardWidth);

        await expect(card.locator('.message-card-action-btn__icon').first()).toHaveCSS(
          'font-size',
          '16px',
        );
        const timestamps = card.locator('[data-message-card-timestamp-item="true"]');
        const metadataItems = card.locator('[data-message-card-metadata-item="true"]');
        const networkItems = card.locator('[data-message-card-network-item="true"]');
        await expect(timestamps).toHaveCount(2);
        await expect(metadataItems.first()).toBeVisible();
        await expect(networkItems).toHaveCount(2);
        expect(
          await timestamps.evaluateAll((items) => items.map((item) => item.clientHeight)),
        ).toEqual([25, 25]);
        const metadataItemCount = await metadataItems.count();
        expect(
          await metadataItems.evaluateAll((items) => items.map((item) => item.clientHeight)),
        ).toEqual(Array(metadataItemCount).fill(25));
        expect(
          await networkItems.evaluateAll((items) => items.map((item) => item.clientHeight)),
        ).toEqual([25, 25]);
        expect(
          await networkItems
            .locator('[data-message-card-metadata-icon-kind="network"]')
            .evaluateAll((items) =>
              items.map((item) => {
                const box = item.getBoundingClientRect();
                const glyph = item.querySelector('svg')?.getBoundingClientRect();
                return { width: box.width, height: box.height, glyphWidth: glyph?.width };
              }),
            ),
        ).toEqual([
          { width: 16, height: 16, glyphWidth: 18 },
          { width: 16, height: 16, glyphWidth: 18 },
        ]);
        await expect(
          card.locator('[data-message-card-metadata-icon-kind="standard"] svg').first(),
        ).toHaveCSS('font-size', '16px');
        await expect(
          card.locator('[data-message-card-metadata-icon-kind="group"] svg').first(),
        ).toHaveCSS('font-size', '18px');

        const metrics = await card.evaluate((element) => ({
          scrollWidth: element.scrollWidth,
          clientWidth: element.clientWidth,
        }));
        expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
      }
    }

    const analysisCard = page.locator('.message-card-root').first();
    const callsign = analysisCard.getByTitle('E2E-ALPHA');
    await expect(callsign).toHaveCSS('height', '24px');
    const callsignDeleteIcon = callsign.locator('svg');
    const [callsignBox, callsignDeleteBox] = await Promise.all([
      callsign.boundingBox(),
      callsignDeleteIcon.boundingBox(),
    ]);
    expect(callsignDeleteBox?.width).toBe(18);
    expect(callsignDeleteBox?.height).toBe(18);
    expect((callsignBox?.width ?? 0) - (callsignDeleteBox?.width ?? 0)).toBeGreaterThanOrEqual(24);
    await expect(analysisCard.getByText('E2E-ALPHA', { exact: true })).toHaveCSS(
      'font-size',
      '10px',
    );
    await expect(
      analysisCard.locator('[data-message-card-intelligence-report="true"]').first(),
    ).toHaveCSS('border-left-width', '3px');
  });

  for (const host of ['duty', 'analysis'] as const) {
    for (const cardWidth of [920, 330] as const) {
      test(`ECHO-3324 keeps ${host} audio within its ${cardWidth}px card geometry`, async ({
        page,
      }) => {
        await page.setViewportSize({ width: 1500, height: 900 });
        await openMessageCardPreviewHost(page, host, { revealAudio: true });
        const card = page.locator('.message-card-root').first();
        await card.evaluate((element, width) => {
          const item = element.closest<HTMLElement>('.message-card-item');
          if (item) item.style.width = `${width}px`;
        }, cardWidth);

        const audioRow = card.locator('.message-card-audio-row');
        const player = audioRow.locator('custom-audio-player');
        await expect(audioRow).toBeVisible();
        await expect(player).toBeVisible();
        await expect(card.getByText('Аудіофайл не знайдено')).toHaveCount(0);
        await expect(audioRow).toHaveCSS('height', '40px');
        const width = await audioRow.evaluate((element) => element.getBoundingClientRect().width);
        expect(width).toBeLessThanOrEqual(523);
        if (cardWidth === 330) expect(width).toBeGreaterThanOrEqual(312);
        expect(width).toBeLessThanOrEqual(cardWidth - (cardWidth <= 330 ? 16 : 32));
        await expect(card.locator('a[aria-label^="Завантажити аудіо"]')).toBeVisible();
        expect(
          await card
            .locator('a[aria-label^="Завантажити аудіо"]')
            .evaluate((element) => element.closest('.message-card-audio-row') === null),
        ).toBe(true);
      });
    }
  }

  test('ECHO-3324 keeps 24px attachment counters unclipped inside a narrow card', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await openMessageCardPreviewHost(page, 'analysis');
    const card = page.locator('.message-card-root').first();
    await card.evaluate((element) => {
      const item = element.closest<HTMLElement>('.message-card-item');
      if (item) item.style.width = '330px';
    });
    const counters = page.locator('.message-card-attachment-counters').first();
    const counter = counters.locator('.message-card-attachment-counter').first();
    await expect(counter).toHaveCSS('height', '24px');
    const metrics = await counters.evaluate((element) => ({
      scrollWidth: element.scrollWidth,
      clientWidth: element.clientWidth,
      counterScrollHeight: element.firstElementChild?.scrollHeight,
      counterClientHeight: element.firstElementChild?.clientHeight,
    }));
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth);
    expect(metrics.counterScrollHeight).toBeLessThanOrEqual(metrics.counterClientHeight ?? 0);
  });

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
