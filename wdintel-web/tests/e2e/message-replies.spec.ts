import { expect, test } from '@playwright/test';
import { openMessageCardPreviewHost } from './message-card-media-preview.fixtures';

test.describe('@regression #3612 message replies', () => {
  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} preserves deleted chain rows and composes a reply in the standard editor`, async ({
      page,
      context,
    }) => {
      await openMessageCardPreviewHost(page, host);
      const card = page.locator('[data-message-id]').first();
      const id = Number(await card.getAttribute('data-message-id'));
      const screen = host === 'duty' ? 'Duty' : 'Analysis';
      const href = `/rer-${host}-neo?m=3612-original`;
      let created = false;
      let reader = false;
      let replyRequests = 0;
      await page.route('**/api/rer-importer/message-replies', (route) => {
        replyRequests += 1;
        return route.fulfill({
          json: {
            replies: [
              {
                id: 1,
                original_signal_message_id: 11,
                reply_signal_message_id: id,
                created_at: 1,
                deleted: false,
              },
              {
                id: 2,
                original_signal_message_id: id,
                reply_signal_message_id: 21,
                created_at: 2,
                deleted: false,
              },
              {
                id: 3,
                original_signal_message_id: id,
                reply_signal_message_id: null,
                created_at: 3,
                deleted: true,
              },
              {
                id: 5,
                original_signal_message_id: 12,
                reply_signal_message_id: id,
                created_at: 5,
                deleted: false,
              },
              {
                id: 6,
                original_signal_message_id: null,
                reply_signal_message_id: id,
                created_at: 6,
                deleted: false,
              },
              ...(created
                ? [
                    {
                      id: 4,
                      original_signal_message_id: id,
                      reply_signal_message_id: 501,
                      created_at: 4,
                      deleted: false,
                    },
                  ]
                : []),
            ],
            reply_messages: [
              {
                id,
                timestamp: 1_790_000_000_000,
                created_at: 1_790_003_600_000,
                preview: 'Цитований оригінал',
                href: `/rer-${host}-neo?m=${id}`,
              },
              {
                id: 11,
                timestamp: 1_790_000_000_000,
                created_at: 1_790_003_600_000,
                preview: 'Попередній оригінал',
                href,
              },
              {
                id: 21,
                timestamp: 1_790_000_000_000,
                created_at: 1_790_003_600_000,
                preview: 'Перша відповідь',
                href: `/rer-${host}-neo?m=21`,
              },
              {
                id: 12,
                timestamp: null,
                created_at: 1_790_003_600_000,
                preview: 'Другий оригінал',
                href: `/rer-${host}-neo?m=12`,
              },
              ...(created
                ? [
                    {
                      id: 501,
                      timestamp: 1_790_000_000_000,
                      created_at: 1_790_003_600_000,
                      preview: 'Моя нова відповідь',
                      href: `/rer-${host}-neo?m=501`,
                    },
                  ]
                : []),
            ],
          },
        });
      });
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('echo-message-replies-poll', { detail })),
        screen,
      );
      const chain = card.getByRole('region', { name: 'Відповіді', exact: true });
      await expect(chain).toContainText('Попередній оригінал');
      await expect(chain).toContainText('Другий оригінал');
      await expect(chain).toContainText('Повідомлення недоступне');
      await expect(
        chain.getByRole('button', { name: 'Оригінальне повідомлення', exact: true }),
      ).toHaveCount(2);
      await expect(chain.locator('blockquote').first().getByRole('button')).toHaveText(
        host === 'duty' ? '21.09 · 18:13' : '21.09 · 17:13',
      );
      await expect(chain.locator('ol > li')).toHaveCount(2);
      await expect(chain).toContainText('Видалено');
      await expect(chain.locator('ol > li').nth(1).getByRole('button')).toHaveCount(0);
      const requestsBeforeTimeChange = replyRequests;
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('user-settings-updated', {
            detail: { messageSortBy: 'creation' },
          }),
        ),
      );
      await expect(chain.locator('blockquote').first().getByRole('button')).toHaveText(
        '21.09 · 18:13',
      );
      expect(replyRequests).toBe(requestsBeforeTimeChange);

      await context.route(`**${href}`, (route) =>
        route.fulfill({ contentType: 'text/html', body: '<p>Оригінал</p>' }),
      );
      const originalLink = chain
        .getByRole('button', { name: 'Оригінальне повідомлення', exact: true })
        .first();
      await originalLink.focus();
      await originalLink.press('Enter');
      const confirmation = page.getByRole('dialog', { name: 'Відкрити повідомлення?' });
      await expect(confirmation).toBeVisible();
      const popupPromise = page.waitForEvent('popup');
      await confirmation.getByRole('button', { name: 'Відкрити', exact: true }).click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(new RegExp('m=3612-original$'));
      await popup.close();
      await expect(originalLink).toBeFocused();

      await page.route('**/api/1.1/submit-direct/parse', (route) =>
        route.fulfill({
          json: {
            text: route.request().postDataJSON().full_body,
            coords: [],
            to: [],
            locations: [],
            dmr: [],
            unit_v2: reader ? 'Protected unit' : undefined,
          },
        }),
      );
      await page.route('**/api/1.1/submit-direct', async (route) => {
        const payload = route.request().postDataJSON();
        expect(payload.cited_signal_message_ids).toEqual([id]);
        expect(payload.parent_signal_message_ids).toBeUndefined();
        if (reader) {
          expect(payload.unit).toBeUndefined();
          expect(payload.unit_id).toBeUndefined();
          expect(payload.create_unit).toBeUndefined();
        }
        created = true;
        await route.fulfill({ json: { signal_message_id: 501 } });
      });
      await card.getByRole('button', { name: 'Відповісти', exact: true }).click();
      const editor = page.locator('[data-manage-message-presentation]');
      await expect(editor).toBeVisible();
      await expect(editor.getByRole('region', { name: 'Цитоване повідомлення' })).toContainText(
        'Цитований оригінал',
      );
      await editor
        .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
        .fill('Моя нова відповідь');
      await editor.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await expect(chain.locator('ol > li')).toHaveCount(3);
      await expect(chain).toContainText('Моя нова відповідь');
      const user = await page.evaluate(() =>
        fetch('/api/user').then((response) => response.json()),
      );
      await page.route('**/api/user', (route) =>
        route.fulfill({ json: { ...user, roles: ['CyberViewerRestricted'] } }),
      );
      reader = true;
      await page.reload();
      await expect(
        page.getByRole('button', { name: 'Додати повідомлення', exact: true }),
      ).toHaveCount(0);
      await card.getByRole('button', { name: 'Відповісти', exact: true }).click();
      await expect(editor).toBeVisible();
      await editor
        .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
        .fill('Відповідь читача');
      await expect(editor.getByRole('combobox', { name: 'Підрозділ', exact: true })).toBeDisabled();
      await editor.getByRole('button', { name: 'Розпарсити', exact: true }).click();
      await editor.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect(editor).toHaveCount(0);
    });
  }
});
