import { expect, test } from '@playwright/test';
import { openMessageCardPreviewHost } from './message-card-media-preview.fixtures';

test.describe('@regression #3612 message replies', () => {
  for (const host of ['duty', 'analysis'] as const) {
    test(`${host} preserves deleted chain rows and composes a reply in the standard editor`, async ({
      page,
    }) => {
      await openMessageCardPreviewHost(page, host);
      const card = page.locator('[data-message-id]').first();
      const id = Number(await card.getAttribute('data-message-id'));
      const screen = host === 'duty' ? 'Duty' : 'Analysis';
      const href = `/rer-${host}-neo?m=3612-original`;
      let created = false;
      let reader = false;
      let replyRequests = 0;
      let unavailable = false;
      let headDeleted = false;
      await page.route('**/api/rer-importer/message-replies', (route) => {
        replyRequests += 1;
        if (unavailable) return route.fulfill({ json: { replies: [], reply_messages: [] } });
        return route.fulfill({
          json: {
            replies: [
              {
                id: 1,
                thread_id: 11,
                original_signal_message_id: headDeleted ? null : 11,
                reply_signal_message_id: id,
                created_at: 1,
                deleted: headDeleted,
                original_deleted: headDeleted,
                reply_deleted: false,
              },
              {
                id: 2,
                thread_id: 11,
                original_signal_message_id: headDeleted ? null : 11,
                reply_signal_message_id: 21,
                created_at: 2,
                deleted: headDeleted,
                original_deleted: headDeleted,
                reply_deleted: false,
              },
              {
                id: 3,
                thread_id: 11,
                original_signal_message_id: headDeleted ? null : 11,
                reply_signal_message_id: null,
                created_at: 3,
                deleted: true,
                original_deleted: headDeleted,
                reply_deleted: true,
              },
              {
                id: 5,
                thread_id: 11,
                original_signal_message_id: headDeleted ? null : 11,
                reply_signal_message_id: 12,
                created_at: 5,
                deleted: headDeleted,
                original_deleted: headDeleted,
                reply_deleted: false,
              },
              {
                id: 6,
                thread_id: 11,
                original_signal_message_id: headDeleted ? null : 11,
                reply_signal_message_id: 31,
                created_at: 6,
                deleted: headDeleted,
                original_deleted: headDeleted,
                reply_deleted: false,
              },
              ...(created
                ? [
                    {
                      id: 4,
                      thread_id: 11,
                      original_signal_message_id: headDeleted ? null : 11,
                      reply_signal_message_id: 501,
                      created_at: 4,
                      deleted: headDeleted,
                      original_deleted: headDeleted,
                      reply_deleted: false,
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
      await expect(chain.getByRole('listitem')).toHaveCount(2);
      await chain.getByRole('button', { name: 'Усі повідомлення 6', exact: true }).click();
      const panel = page.getByRole('dialog', { name: 'Ланцюжок повідомлень', exact: true });
      await expect(panel).toContainText('Попередній оригінал');
      await expect(panel).toContainText('Другий оригінал');
      await expect(panel).toContainText('Повідомлення недоступне');
      await expect(panel.getByRole('listitem')).toHaveCount(6);
      const deletedRow = panel.getByRole('listitem').filter({ hasText: 'Повідомлення видалено' });
      await expect(deletedRow).toHaveCount(1);
      await expect(deletedRow.getByRole('link')).toHaveCount(0);
      await expect(panel.locator('[aria-current="true"]')).toContainText('Цитований оригінал');
      const originalLink = panel.getByRole('link').filter({ hasText: 'Попередній оригінал' });
      await expect(originalLink).toContainText(
        host === 'duty' ? '21.09.2026 · 18:13' : '21.09.2026 · 17:13',
      );
      const requestsBeforeTimeChange = replyRequests;
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('user-settings-updated', { detail: { messageSortBy: 'creation' } }),
        ),
      );
      await expect(originalLink).toContainText('21.09.2026 · 18:13');
      expect(replyRequests).toBe(requestsBeforeTimeChange);
      await page.route('**/api/rer-importer/inbox-item-context', (route) =>
        route.fulfill({
          json: {
            message: null,
            group_master_keys: [],
            sigint_inbox_item_ids: [],
            since_ts: null,
            till_ts: null,
          },
        }),
      );
      const originalUrl = new URL(page.url());
      await originalLink.focus();
      await originalLink.press('Enter');
      await expect(panel).toHaveCount(0);
      await expect(
        page.getByText('Повідомлення за посиланням не знайдено або воно недоступне.', {
          exact: true,
        }),
      ).toBeVisible();
      expect(page.context().pages()).toHaveLength(1);
      const currentUrl = new URL(page.url());
      originalUrl.searchParams.sort();
      currentUrl.searchParams.sort();
      expect(currentUrl.href).toBe(originalUrl.href);

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
        expect(payload.engaged_message_id).toBe(id);
        expect(payload.cited_signal_message_ids).toBeUndefined();
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
      unavailable = true;
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('echo-message-replies-poll', { detail })),
        screen,
      );
      await expect(editor.getByRole('region', { name: 'Цитоване повідомлення' })).toContainText(
        'Повідомлення недоступне',
      );
      await expect(editor.getByLabel('Завантаження цитати')).toHaveCount(0);
      unavailable = false;
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('echo-message-replies-poll', { detail })),
        screen,
      );
      await expect(editor.getByRole('region', { name: 'Цитоване повідомлення' })).toContainText(
        'Цитований оригінал',
      );
      await editor
        .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
        .fill('Моя нова відповідь');
      await editor.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect(editor).toHaveCount(0);
      await chain.getByRole('button', { name: 'Усі повідомлення 7', exact: true }).click();
      await expect(panel.getByRole('listitem')).toHaveCount(7);
      await expect(panel).toContainText('Моя нова відповідь');
      await page.keyboard.press('Escape');
      await expect(panel).toHaveCount(0);
      const user = await page.evaluate(() =>
        fetch('/api/user').then((response) => response.json()),
      );
      await page.route('**/api/user', (route) =>
        route.fulfill({ json: { ...user, roles: ['CyberViewerRestricted'] } }),
      );
      reader = true;
      await page.setViewportSize({ width: 390, height: 844 });
      await page.reload();
      if (host === 'analysis')
        await page.getByRole('button', { name: 'Закрити фільтри', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Додати повідомлення', exact: true }),
      ).toHaveCount(0);
      await card.getByRole('button', { name: 'Більше дій', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Відповісти', exact: true }).click();
      await expect(editor).toBeVisible();
      await expect(
        editor.getByRole('button', { name: 'Налаштування парсингу', exact: true }),
      ).toBeEnabled();
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('user-settings-updated', {
            detail: { messageSortBy: 'creation', messageAutoParseEnabled: false },
          }),
        ),
      );
      await editor
        .getByRole('textbox', { name: 'Текст повідомлення', exact: true })
        .fill('Відповідь читача');
      await expect(editor.getByRole('combobox', { name: 'Підрозділ', exact: true })).toBeDisabled();
      await editor.getByRole('button', { name: 'Розпарсити', exact: true }).click();
      await editor.getByRole('button', { name: 'Створити', exact: true }).click();
      await expect(editor).toHaveCount(0);
      headDeleted = true;
      await page.evaluate(
        (detail) => window.dispatchEvent(new CustomEvent('echo-message-replies-poll', { detail })),
        screen,
      );
      await chain.getByRole('button', { name: 'Усі повідомлення 7', exact: true }).click();
      await expect(panel).toContainText('Перша відповідь');
      await expect(panel).toContainText('Моя нова відповідь');
      await expect(panel).not.toContainText('Попередній оригінал');
      await expect(panel.getByText('Повідомлення видалено', { exact: true })).toHaveCount(2);
    });
  }
});
