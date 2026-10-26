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
    response.inbox_items = variants.map((variant, index) => [
      firstId + index,
      {
        ...message,
        ...variant,
        images: [],
        messageUid: `card-layout-${index}`,
        unit: '108 дшп 1 пдб вБпС',
        createdAt: Date.parse('2026-10-26T09:16:00Z') + index * 60_000,
        createdAtOrder: (Date.parse('2026-10-26T09:16:00Z') + index * 60_000) * 1000,
        coords: null,
        pointTokens: [],
        intelligence_reports: [],
      } as never,
    ]);
    await installMessageCardMediaPreviewAssetRoutes(page);
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
      if (host === 'analysis' && width <= 768) await page.keyboard.press('Escape');
      for (const [index, variant] of variants.entries()) {
        const card = page.locator(`[data-message-id="${firstId + index}"] .message-card-root`);
        await card.scrollIntoViewIfNeeded();
        const layout = card.locator('.message-card-content-layout');
        const main = card.locator('.message-card-main');
        const details = card.locator('.message-card-details-region');
        await expect(main).toBeVisible();
        await expect(details).toBeVisible();
        const columns = await layout.evaluate(
          (element) => getComputedStyle(element).gridTemplateColumns.split(' ').length,
        );
        expect(columns).toBe(width >= 1512 ? 2 : 1);
        const mainBox = (await main.boundingBox())!;
        const detailsBox = (await details.boundingBox())!;
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
            expect(positions.attachmentsTop).toBeGreaterThanOrEqual(positions.textBottom);
          }
        } else {
          await expect(main.locator('.message-card-attachments-region')).toHaveCount(0);
        }
        await expect(card.locator(':scope > .message-card-divider')).toBeVisible();
        const footer = card.locator('[data-message-card-timestamp-footer="true"]');
        await expect(footer).toHaveText(`11:${16 + index}`);
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
    const lightCard = page.locator(`[data-message-id="${firstId + 3}"] .message-card-root`);
    await lightCard.screenshot({ path: testInfo.outputPath(`${host}-1920-light.png`) });
    expect(errors).toEqual([]);
  });
}
