import { expect, test } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { emptyNetworksListResponse, emptyUnitsListResponse } from './fixture-responses';
import {
  buildMessageCardMediaPreviewInboxResponse,
  installMessageCardMediaPreviewAssetRoutes,
} from './message-card-media-preview.fixtures';

// Regression: https://github.com/echoua/echo/issues/3324
for (const host of ['analysis', 'duty'] as const) {
  test(`#3324 keeps the important badge left of actions at every card width (${host}) @regression`, async ({
    page,
  }, testInfo) => {
    await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
    await page.setViewportSize({ width: 1920, height: 1080 });
    const response = buildMessageCardMediaPreviewInboxResponse();
    Object.assign(response.inbox_items[0][1], {
      important: true,
      aiImportant: true,
      createdAt: Date.UTC(2026, 9, 26, 12),
      unit: '108 дшп 1 пдб вБпС',
      media: [],
      images: [],
      coords: null,
    });
    if (host === 'analysis') await installAnalysisNeoApiMocks(page, { inboxResponse: response });
    else await installRerDutyShortStateMocks(page, { inboxResponse: response });
    await page.route('**/api/sigint/units', (route) =>
      route.fulfill({ json: emptyUnitsListResponse() }),
    );
    await page.route('**/api/sigint/network-list', (route) =>
      route.fulfill({ json: emptyNetworksListResponse() }),
    );
    await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo');
    await expect(
      page.getByRole('button', {
        name: host === 'analysis' ? 'analysis-tester' : 'operator',
        exact: true,
      }),
    ).toBeVisible();
    const card = page.locator('.message-card-root').first();
    const badge = card.locator('[data-message-card-important-status="true"]');
    for (const width of [390, 520, 768, 1512, 1920, 2560, 3440]) {
      await page.setViewportSize({ width, height: 1080 });
      if (host === 'analysis' && width === 390) {
        const closeFilters = page.getByRole('button', { name: 'Закрити фільтри', exact: true });
        await closeFilters.click();
        await expect(closeFilters).toBeHidden();
      }
      await expect(badge).toBeVisible();
      await expect(badge).toHaveText('Важливе');
      await expect(badge).toHaveAttribute('title', 'Позначено ШІ');
      await expect
        .poll(() =>
          card.evaluate((element) => {
            const identity = element.querySelector('.message-card-header-identity')!;
            const badge = element.querySelector('[data-message-card-important-status]')!;
            const actions = element.querySelector('[aria-label="Дії повідомлення"]')!;
            const identityBounds = identity.getBoundingClientRect();
            const badgeBounds = badge.getBoundingClientRect();
            const actionsBounds = actions.getBoundingClientRect();
            return (
              badge.contains(
                document.elementFromPoint(
                  badgeBounds.left + 1,
                  badgeBounds.top + badgeBounds.height / 2,
                ),
              ) &&
              identityBounds.right <= badgeBounds.left &&
              badgeBounds.right <= actionsBounds.left &&
              Math.abs(
                badgeBounds.top +
                  badgeBounds.height / 2 -
                  actionsBounds.top -
                  actionsBounds.height / 2,
              ) <= 1 &&
              element.scrollWidth <= element.clientWidth
            );
          }),
        )
        .toBe(true);
      if (width === 390 || width === 1920)
        await page.screenshot({
          path: testInfo.outputPath(`${host}-important-${width}.png`),
          animations: 'disabled',
        });
    }
  });

  test(`ECHO-3324 loading skeleton follows the current card layout (${host}) @regression`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
    await page.setViewportSize({ width: 1920, height: 1080 });
    const response = buildMessageCardMediaPreviewInboxResponse();
    if (host === 'analysis') {
      await installAnalysisNeoApiMocks(page, { inboxResponse: response });
    } else {
      await installRerDutyShortStateMocks(page, { inboxResponse: response });
      await page.route('**/api/sigint/units', (route) =>
        route.fulfill({ json: emptyUnitsListResponse() }),
      );
      await page.route('**/api/sigint/network-list', (route) =>
        route.fulfill({ json: emptyNetworksListResponse() }),
      );
    }
    let releaseInbox!: () => void;
    const pendingInbox = new Promise<void>((resolve) => {
      releaseInbox = resolve;
    });
    await page.route('**/api/rer-importer/get-inbox', async (route) => {
      await pendingInbox;
      await route.fulfill({ json: response });
    });
    try {
      await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo');
      await expect(
        page.getByRole('button', {
          name: host === 'analysis' ? 'analysis-tester' : 'operator',
          exact: true,
        }),
      ).toBeVisible();
      const skeleton = page.locator('[data-message-feed-skeleton-card]').first();
      for (const width of [1512, 1920, 2560, 3440, 768, 390]) {
        await page.setViewportSize({ width, height: 1080 });
        if (host === 'analysis' && width <= 768) await page.keyboard.press('Escape');
        await expect(skeleton).toBeVisible();
        await expect(skeleton.locator('.message-card-header-unit')).toBeVisible();
        await expect(skeleton.locator('.message-card-timestamp-item')).toBeVisible();
        await expect(skeleton.locator(':scope > .message-card-divider')).toBeVisible();
        await expect(skeleton.locator('.message-card-timestamp-footer')).toBeVisible();
        await expect(skeleton.locator('button, a, input')).toHaveCount(0);
        const geometry = await skeleton.evaluate((element) => {
          const style = getComputedStyle(element);
          const layout = element.querySelector('.message-card-content-layout')!;
          const main = layout.querySelector('.message-card-main')!.getBoundingClientRect();
          const details = layout
            .querySelector('.message-card-details-region')!
            .getBoundingClientRect();
          return {
            contentWidth:
              element.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            columns: getComputedStyle(layout).gridTemplateColumns.split(' ').length,
            stacked: details.top >= main.bottom,
            gap: details.left - main.right,
            overflows: element.scrollWidth > element.clientWidth,
          };
        });
        expect(geometry.overflows).toBe(false);
        expect(geometry.columns).toBe(geometry.contentWidth >= 760 ? 2 : 1);
        if (geometry.columns === 1) expect(geometry.stacked).toBe(true);
        else expect(geometry.gap).toBeCloseTo(24, 0);
        if ([1920, 390].includes(width)) {
          await skeleton.screenshot({ path: testInfo.outputPath(`${host}-${width}-skeleton.png`) });
        }
      }
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await expect(skeleton.locator('.MuiSkeleton-root').first()).toHaveCSS(
        'animation-name',
        'none',
      );
      await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'light'));
      await skeleton.screenshot({ path: testInfo.outputPath(`${host}-390-skeleton-light.png`) });
    } finally {
      releaseInbox();
    }
    await expect(page.locator('[data-message-id]').first()).toBeVisible();
    await expect(page.locator('[data-message-feed-skeleton="initial"]')).toHaveCount(0);
  });

  test(`ECHO-3324 keeps four content variants in the same responsive card layout (${host}) @regression`, async ({
    page,
  }, testInfo) => {
    test.setTimeout(90_000);
    await page.addInitScript(() => localStorage.setItem('echo-theme-mode', 'dark'));
    await page.setViewportSize({ width: 1920, height: 1080 });
    await page.clock.setFixedTime(new Date('2026-10-26T12:00:00Z'));
    const response = buildMessageCardMediaPreviewInboxResponse();
    const [firstId, original] = response.inbox_items[0];
    const message = original as unknown as Record<string, unknown>;
    const media = message.media as Array<Record<string, unknown>>;
    const variants = [
      { text: 'Довге повідомлення без вкладень. '.repeat(80), media: [] },
      { text: '', media },
      { text: 'Коротке повідомлення без вкладень.', media: [] },
      { text: 'Коротке повідомлення з вкладенням.', media: media.slice(0, 1) },
    ];
    const comment = {
      id: 1,
      messageId: firstId + 3,
      comment: 'Коментар під усім повідомленням.',
      login: 'peer',
      sigintPostName: null,
    };
    response.inbox_items = variants.map((variant, index) => [
      firstId + index,
      {
        ...message,
        ...variant,
        textMarked: index === 2 ? [{ CNTextC: { text: variant.text } }] : [],
        images: [],
        messageUid: `card-layout-${index}`,
        unit: '108 дшп 1 пдб вБпС',
        createdAt: Date.parse('2026-10-26T09:16:00Z') + index * 60_000,
        createdAtOrder: (Date.parse('2026-10-26T09:16:00Z') + index * 60_000) * 1000,
        coords: null,
        pointTokens: [],
        intelligence_reports: [],
        extendedForm: index === 2 ? 'Додаткова інформація праворуч. '.repeat(16) : null,
        messageComments: index === 3 ? [comment] : [],
      } as never,
    ]);
    await installMessageCardMediaPreviewAssetRoutes(page);
    if (host === 'analysis') {
      await installAnalysisNeoApiMocks(page, { inboxResponse: response, hideNetworks: true });
    } else {
      await installRerDutyShortStateMocks(page, { inboxResponse: response, hideNetworks: true });
      await page.route('**/api/sigint/units', (route) =>
        route.fulfill({ json: emptyUnitsListResponse() }),
      );
      await page.route('**/api/sigint/network-list', (route) =>
        route.fulfill({ json: emptyNetworksListResponse() }),
      );
    }
    await page.route('**/api/user/author-identities', (route) =>
      route.fulfill({ json: { authors: [] } }),
    );
    await page.route('**/api/rer/message/comments-batch', (route) =>
      route.fulfill({ json: { data: [{ messageId: firstId + 3, comments: [comment] }] } }),
    );
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(host === 'analysis' ? '/rer-analysis-neo' : '/rer-duty-neo');
    await expect(
      page.getByRole('button', {
        name: host === 'analysis' ? 'analysis-tester' : 'operator',
        exact: true,
      }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');

    for (const width of [1512, 1920, 2560, 3440, 768, 490, 390]) {
      await page.setViewportSize({ width, height: 1080 });
      if (host === 'duty') {
        await expect(page.locator('[data-duty-feed-column]')).toHaveCSS(
          'flex-basis',
          width < 1024 ? '100%' : 'auto',
        );
      }
      if (host === 'analysis' && width <= 768) await page.keyboard.press('Escape');
      for (const [index, variant] of variants.entries()) {
        const card = page.locator(`[data-message-id="${firstId + index}"] .message-card-root`);
        await card.scrollIntoViewIfNeeded();
        if (index === 3) {
          await expect(card.getByText(comment.comment, { exact: true })).toBeVisible();
        }
        const layout = card.locator('.message-card-content-layout');
        const main = card.locator('.message-card-main');
        const details = card.locator('.message-card-details-region');
        await expect(main).toBeVisible();
        await expect(main.locator(':scope > .message-card-divider')).toHaveCount(0);
        await expect(details).toBeVisible();
        const labelSizes = await card
          .locator('.message-card-header-row .message-card-text')
          .evaluateAll((labels) => [
            ...new Set(labels.map((label) => getComputedStyle(label).fontSize)),
          ]);
        expect(labelSizes).toEqual(['14px']);
        await expect(card.locator('.message-card-header-unit .message-card-text')).toHaveCSS(
          'font-weight',
          '500',
        );
        const metadataSizes = await card
          .locator('.message-card-metadata .message-card-text')
          .evaluateAll((labels) => [
            ...new Set(labels.map((label) => getComputedStyle(label).fontSize)),
          ]);
        expect(metadataSizes).toEqual(['14px']);
        if (variant.text) {
          const text = main.locator('[data-message-card-text-content="true"]');
          await expect(text).toHaveCSS('font-size', '14px');
          await expect(text).toHaveCSS('line-height', '21px');
        }
        const columns = await layout.evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
        );
        expect(columns).toBe(width >= 1512 ? 2 : 1);
        await expect(details).toHaveCSS('border-top-style', columns === 1 ? 'solid' : 'none');
        await expect(details).toHaveCSS('padding-top', columns === 1 ? '12px' : '0px');
        await expect(details).toHaveCSS('margin-top', columns === 1 ? '8px' : '0px');
        const [mainBox, detailsBox] = await layout.evaluate((element) =>
          ['.message-card-main', '.message-card-details-region'].map((selector) => {
            const { x, y, width, height } = element
              .querySelector(selector)!
              .getBoundingClientRect();
            return { x, y, width, height };
          }),
        );
        if (columns === 2) {
          expect(Math.abs(mainBox.y - detailsBox.y)).toBeLessThan(1);
          expect(detailsBox.x).toBeGreaterThanOrEqual(mainBox.x + mainBox.width);
          expect(mainBox.width).toBeGreaterThan(detailsBox.width);
          expect(detailsBox.x - mainBox.x - mainBox.width).toBeCloseTo(24, 0);
        } else {
          expect(detailsBox.y).toBeGreaterThanOrEqual(mainBox.y + mainBox.height);
        }
        if (variant.media.length) {
          const attachments = main.locator('.message-card-attachments-region');
          await expect(attachments).toBeVisible();
          const mediaToggle = attachments.getByRole('button', {
            name: /^(Розгорнути|Згорнути) медіа:/,
          });
          if ((await mediaToggle.getAttribute('aria-expanded')) !== 'true') {
            await mediaToggle.click();
          }
          if (index === 3) await expect(mediaToggle).toHaveAccessibleName('Згорнути медіа: 1');
          if (variant.text) {
            const positions = await main.evaluate((element) => {
              const text = element
                .querySelector('.message-card-message-text')!
                .getBoundingClientRect();
              const attachments = element
                .querySelector('.message-card-attachments-region')!
                .getBoundingClientRect();
              return {
                textX: text.x,
                textBottom: text.bottom,
                attachmentsX: attachments.x,
                attachmentsTop: attachments.top,
              };
            });
            expect(positions.attachmentsX).toBe(positions.textX);
            expect(positions.attachmentsTop - positions.textBottom).toBeGreaterThanOrEqual(16);
          } else {
            const topGap = await main.evaluate(
              (element) =>
                element.querySelector('.message-card-attachments-region')!.getBoundingClientRect()
                  .top - element.getBoundingClientRect().top,
            );
            expect(topGap).toBe(0);
          }
        } else {
          await expect(main.locator('.message-card-attachments-region')).toHaveCount(0);
        }
        await expect(card.locator(':scope > .message-card-divider')).toBeVisible();
        const footer = card.locator('[data-message-card-timestamp-footer="true"]');
        await expect(footer).toHaveText(`11:${16 + index}`);
        await expect(footer.locator('.message-card-text')).toHaveCSS('font-size', '12px');
        const footerGeometry = await card.evaluate((element) => {
          const box = (selector: string) => {
            const rect = element.querySelector(selector)!.getBoundingClientRect();
            return { top: rect.top, bottom: rect.bottom, height: rect.height };
          };
          return {
            main: box('.message-card-main'),
            details: box('.message-card-details-region'),
            footer: box('[data-message-card-timestamp-footer]'),
          };
        });
        expect(footerGeometry.footer.top).toBeGreaterThanOrEqual(footerGeometry.details.bottom);
        if (columns === 2 && index < 2) {
          expect(footerGeometry.footer.bottom).toBeCloseTo(footerGeometry.main.bottom, 0);
        } else {
          expect(footerGeometry.footer.top).toBeGreaterThanOrEqual(footerGeometry.main.bottom);
        }
        if (index === 3) {
          const comment = await card
            .getByText('Коментар під усім повідомленням.', { exact: true })
            .boundingBox();
          expect(footerGeometry.footer.top).toBeGreaterThanOrEqual(comment!.y + comment!.height);
        }
        expect(await card.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
          true,
        );
        await card.screenshot({
          path: testInfo.outputPath(`${host}-${width}-case-${index + 1}.png`),
        });
      }
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'light'));
    await page.setViewportSize({ width: 1920, height: 1080 });
    if (host === 'duty') {
      await expect(page.locator('[data-duty-feed-column]')).toHaveCSS('flex-basis', 'auto');
    }
    const lightCard = page.locator(`[data-message-id="${firstId + 3}"] .message-card-root`);
    await lightCard.screenshot({ path: testInfo.outputPath(`${host}-1920-light.png`) });
    await page.evaluate(() => {
      document.documentElement.style.fontSize = '28px';
    });
    await expect(lightCard.locator('[data-message-card-text-content="true"]')).toHaveCSS(
      'font-size',
      '28px',
    );
    await expect(lightCard.locator('[data-message-card-text-content="true"]')).toHaveCSS(
      'line-height',
      '42px',
    );
    await expect(
      lightCard.locator('[data-message-card-timestamp-footer] .message-card-text'),
    ).toHaveCSS('font-size', '24px');
    await lightCard.screenshot({ path: testInfo.outputPath(`${host}-1920-scaled-text.png`) });
    expect(errors).toEqual([]);
  });
}
