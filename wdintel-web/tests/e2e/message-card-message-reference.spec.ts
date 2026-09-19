import { expect, test } from '@playwright/test';

import {
  openMessageCardPreviewHost,
  type MessageCardMediaPreviewHost,
} from './message-card-media-preview.fixtures';

// Regression: https://github.com/echoua/echo/issues/3092
test.describe('@smoke @regression @message-references message-card references', () => {
  for (const host of ['analysis', 'duty'] as MessageCardMediaPreviewHost[]) {
    test(`${host} shows a linked message label and preview`, async ({ page, baseURL }) => {
      const href = new URL('/rer-analysis-neo?m=e2e-linked-message', baseURL).href;
      await openMessageCardPreviewHost(page, host, {
        messageText: `Пов’язане ${href}`,
        signalGroups: [{ master_key: 'linked-group', name: 'Пов’язана група' }],
        messageReferenceResponse: {
          message: [
            77,
            {
              message_uid: 'e2e-linked-message',
              text: 'Текст пов’язаного повідомлення',
              media: [],
              images: [],
              date: '2026-09-08',
              time: '14:30',
              timestamp: null,
              group_master_key: 'linked-group',
            },
          ],
          group_master_keys: ['linked-group'],
          sigint_inbox_item_ids: [77],
          since_ts: null,
          till_ts: null,
        },
      });

      const link = page.getByRole('link', { name: 'повідомлення', exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAttribute('href', href);

      await link.hover();

      const preview = page.getByTestId('message-summary-preview-77');
      await expect(preview).toContainText('Текст пов’язаного повідомлення');
      await expect(preview).toContainText('Пов’язана група');
      await expect(preview).toContainText('2026-09-08 14:30');

      const [linkedMessagePage] = await Promise.all([page.waitForEvent('popup'), link.click()]);
      await linkedMessagePage.waitForURL(href);
      expect(linkedMessagePage.url()).toBe(href);
      await linkedMessagePage.close();
    });

    // Regression: https://github.com/echoua/echo/pull/3397
    test(`${host} uses cached native middle-click navigation without cancelling the anchor event`, async ({
      page,
      baseURL,
    }) => {
      const href = new URL('/rer-analysis-neo?m=e2e-linked-message', baseURL).href;
      await openMessageCardPreviewHost(page, host, {
        messageText: `Пов’язане ${href}`,
        messageReferenceResponse: {
          message: [
            77,
            {
              message_uid: 'e2e-linked-message',
              text: 'Текст пов’язаного повідомлення',
              media: [],
              images: [],
              date: '2026-09-08',
              time: '14:30',
              timestamp: null,
              group_master_key: 'linked-group',
            },
          ],
          group_master_keys: ['linked-group'],
          sigint_inbox_item_ids: [77],
          since_ts: null,
          till_ts: null,
        },
      });

      const link = page.getByRole('link', { name: 'повідомлення', exact: true });
      await link.hover();
      await expect(page.getByTestId('message-summary-preview-77')).toBeVisible();
      await page.evaluate(() => {
        document.addEventListener(
          'auxclick',
          (event) => {
            const target = event.target;
            if (target instanceof Element && target.closest('a[aria-label="повідомлення"]')) {
              document.documentElement.dataset.messageReferenceAuxDefaultPrevented = String(
                event.defaultPrevented,
              );
            }
          },
          { once: true },
        );
      });

      const [linkedMessagePage] = await Promise.all([
        page.context().waitForEvent('page'),
        link.click({ button: 'middle' }),
      ]);

      await linkedMessagePage.waitForURL(href);
      expect(linkedMessagePage.url()).toBe(href);
      expect(
        await page.evaluate(
          () => document.documentElement.dataset.messageReferenceAuxDefaultPrevented,
        ),
      ).toBe('false');
      await linkedMessagePage.close();
    });

    test(`${host} shows progress and recovers when an uncached popup is blocked`, async ({
      page,
      baseURL,
    }) => {
      const href = new URL('/rer-analysis-neo?m=e2e-linked-message', baseURL).href;
      await openMessageCardPreviewHost(page, host, {
        messageText: `Пов’язане ${href}`,
        messageReferenceDelayMs: 700,
        messageReferenceResponse: {
          message: [
            77,
            {
              message_uid: 'e2e-linked-message',
              text: 'Текст пов’язаного повідомлення',
              media: [],
              images: [],
              date: '2026-09-08',
              time: '14:30',
              timestamp: null,
              group_master_key: 'linked-group',
            },
          ],
          group_master_keys: ['linked-group'],
          sigint_inbox_item_ids: [77],
          since_ts: null,
          till_ts: null,
        },
      });
      await page.evaluate(() => {
        const openWindow = window.open.bind(window);
        let blockNextPopup = true;
        window.open = (url, target, features) => {
          if (blockNextPopup) {
            blockNextPopup = false;
            return null;
          }
          return openWindow(url, target, features);
        };
      });

      const link = page.getByRole('link', { name: 'повідомлення', exact: true });
      await link.click();

      await expect(link).toHaveAttribute('aria-busy', 'true');
      await expect(
        link.getByRole('progressbar', { name: 'Перевіряємо доступність повідомлення' }),
      ).toBeVisible();

      const notification = page
        .getByRole('alert')
        .filter({ hasText: 'Не вдалося автоматично відкрити повідомлення.' });
      await expect(notification).toBeVisible();
      const [linkedMessagePage] = await Promise.all([
        page.waitForEvent('popup'),
        notification.getByRole('button', { name: 'Відкрити', exact: true }).click(),
      ]);

      await linkedMessagePage.waitForURL(href);
      expect(linkedMessagePage.url()).toBe(href);
      await linkedMessagePage.close();
    });

    test(`${host} keeps an unavailable linked message on the current page`, async ({
      page,
      baseURL,
    }) => {
      const href = new URL('/rer-analysis-neo?m=e2e-unavailable-message', baseURL).href;
      await openMessageCardPreviewHost(page, host, {
        messageText: `Недоступне ${href}`,
        messageReferenceResponse: {
          message: null,
          group_master_keys: [],
          sigint_inbox_item_ids: [],
          since_ts: null,
          till_ts: null,
        },
      });
      const currentUrl = page.url();
      let popupOpened = false;
      page.on('popup', () => {
        popupOpened = true;
      });

      await page.getByRole('link', { name: 'повідомлення', exact: true }).click();

      const unavailableMessage = 'Повідомлення видалено або у вас немає до нього доступу.';
      await expect(page.getByRole('alert').filter({ hasText: unavailableMessage })).toBeVisible();
      expect(page.url()).toBe(currentUrl);
      expect(popupOpened).toBe(false);
    });

    test(`${host} blocks middle-click navigation for an unavailable linked message`, async ({
      page,
      baseURL,
    }) => {
      const href = new URL('/rer-analysis-neo?m=e2e-unavailable-message', baseURL).href;
      await openMessageCardPreviewHost(page, host, {
        messageText: `Недоступне ${href}`,
        messageReferenceResponse: {
          message: null,
          group_master_keys: [],
          sigint_inbox_item_ids: [],
          since_ts: null,
          till_ts: null,
        },
      });
      const currentUrl = page.url();
      let popupOpened = false;
      page.on('popup', () => {
        popupOpened = true;
      });

      await page
        .getByRole('link', { name: 'повідомлення', exact: true })
        .click({ button: 'middle' });

      const unavailableMessage = 'Повідомлення видалено або у вас немає до нього доступу.';
      await expect(page.getByRole('alert').filter({ hasText: unavailableMessage })).toBeVisible();
      expect(page.url()).toBe(currentUrl);
      expect(popupOpened).toBe(false);
    });
  }
});
