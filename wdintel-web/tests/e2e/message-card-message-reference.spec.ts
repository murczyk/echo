import { expect, test } from '@playwright/test';

import {
  openMessageCardPreviewHost,
  type MessageCardMediaPreviewHost,
} from './message-card-media-preview.fixtures';

test.describe('@smoke @message-references message-card references', () => {
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

    test(`${host} opens an available linked message with a middle click`, async ({
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

      const [linkedMessagePage] = await Promise.all([
        page.waitForEvent('popup'),
        page.getByRole('link', { name: 'повідомлення', exact: true }).click({ button: 'middle' }),
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
