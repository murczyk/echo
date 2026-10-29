import { expect, test } from '@playwright/test';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { minimalInboxMessage } from '../../src/ts/react/routes/rer-duty-neo/inbox-message-mocks';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

for (const roles of [['Rer'], ['Rer', 'DeleteMsg'], ['Admin']]) {
  test(`#3894 Duty message deletion respects ${roles.join('+')} permissions @regression`, async ({
    page,
  }) => {
    const deletedIds: number[] = [];
    await page.setViewportSize({ width: 1600, height: 1000 });
    await installRerDutyShortStateMocks(page, {
      userRoles: roles,
      shortState: {
        waterfalls: ['mf-0', 'mf-1'].map((id) => [id, { groupsSelected: ['group-1'] }]),
      },
      inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
      inboxResponseForRequest: () => ({
        inbox_items: [[41, minimalInboxMessage({ text: 'Message to delete' }) as never]],
        callsigns: [],
        signal_profiles: {},
        signal_groups: [],
        freq_pelengs_summary: null,
        page_limit: 20,
      }),
    });
    await page.route('**/api/rer-importer/delete-message', async (route) => {
      deletedIds.push(route.request().postDataJSON().id);
      await route.fulfill({ json: null });
    });
    await page.goto('/rer-duty-neo?state-short=short-1');
    const cards = page.locator('[data-duty-message-id="41"]');
    await expect(cards).toHaveCount(2);
    const card = cards.first();
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Більше дій' }).click();
    await expect(page.getByRole('menuitem', { name: 'Редагувати', exact: true })).toBeVisible();
    const deleteAction = page.getByRole('menuitem', { name: 'Видалити', exact: true });
    if (roles.length === 1 && roles[0] === 'Rer') {
      await expect(deleteAction).toHaveCount(0);
      expect(deletedIds).toEqual([]);
      return;
    }
    await expect(deleteAction).toBeVisible();
    await deleteAction.click();
    const confirmation = page.getByRole('dialog', { name: 'Видалити повідомлення?' });
    await expect(confirmation).toBeVisible();
    expect(deletedIds).toEqual([]);
    await confirmation.getByRole('button', { name: 'Скасувати' }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(card).toBeVisible();
    expect(deletedIds).toEqual([]);
    await card.getByRole('button', { name: 'Більше дій' }).click();
    await deleteAction.click();
    await confirmation.getByRole('button', { name: 'Видалити', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(cards).toHaveCount(0);
    expect(deletedIds).toEqual([41]);
  });
}

for (const disableAutoScroll of [true, false]) {
  test(`#3894 deletion preserves another feed's historical position and return to latest with auto-scroll ${disableAutoScroll ? 'OFF' : 'ON'} @regression`, async ({
    page,
  }) => {
    const deletedIds = new Set<number>();
    const response = (ids: number[]): InboxMessagesRspRaw => ({
      inbox_items: ids
        .filter((id) => !deletedIds.has(id))
        .map((id) => [
          id,
          minimalInboxMessage({
            text: `Message ${id} ${'History content '.repeat(32)}`,
            createdAt: 1_720_000_000_000 + id * 1_000,
            timestamp: 1_720_000_000_000 + id * 1_000,
            groupMasterKey: 'group-1',
          }) as never,
        ]),
      callsigns: [],
      signal_profiles: {},
      signal_groups: [],
      freq_pelengs_summary: null,
      page_limit: 20,
    });
    await page.setViewportSize({ width: 1600, height: 1000 });
    await installRerDutyShortStateMocks(page, {
      disableAutoScroll,
      shortState: {
        waterfalls: ['mf-0', 'mf-1'].map((id) => [id, { groupsSelected: ['group-1'] }]),
      },
      inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
      inboxResponseForRequest: (requestBody) => {
        const request = requestBody as {
          before_id_noninclusive?: number;
          since_id_noninclusive?: number;
        };
        if (request.before_id_noninclusive === 21)
          return response(Array.from({ length: 20 }, (_, i) => i + 1));
        if (request.since_id_noninclusive === 40)
          return response(Array.from({ length: 20 }, (_, i) => i + 41));
        if (request.before_id_noninclusive != null || request.since_id_noninclusive != null)
          return response([]);
        return response(Array.from({ length: 40 }, (_, i) => i + 21));
      },
    });
    await page.route('**/api/rer-importer/delete-message', async (route) => {
      deletedIds.add(route.request().postDataJSON().id);
      await route.fulfill({ json: null });
    });
    await page.goto('/rer-duty-neo?state-short=short-1');
    const columns = page.locator('[data-duty-feed-column]');
    const source = columns.nth(0);
    const history = columns.nth(1);
    const scroller = history.locator('[data-duty-feed-scroller="true"]');
    await expect(source.locator('[data-duty-message-id="60"]')).toBeInViewport();
    await expect(history.locator('[data-duty-message-id="60"]')).toBeInViewport();
    await scroller.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await expect(history.locator('[data-duty-message-id="1"]')).toBeAttached();
    await expect(history.locator('[data-duty-message-id="59"]')).toHaveCount(0);
    const anchor = history.locator('[data-duty-message-id="21"]');
    await expect(anchor).toBeInViewport();
    const anchorOffset = () =>
      anchor.evaluate(
        (element) =>
          element.getBoundingClientRect().top -
          element.closest('[data-duty-feed-scroller]')!.getBoundingClientRect().top,
      );
    const before = await anchorOffset();
    await source
      .locator('[data-duty-message-id="59"]')
      .getByRole('button', { name: 'Більше дій' })
      .click();
    await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
    const confirmation = page.getByRole('dialog', { name: 'Видалити повідомлення?' });
    await confirmation.getByRole('button', { name: 'Видалити', exact: true }).click();
    await expect(confirmation).not.toBeVisible();
    await expect(page.locator('[data-duty-message-id="59"]')).toHaveCount(0);
    await expect.poll(async () => Math.abs((await anchorOffset()) - before)).toBeLessThanOrEqual(1);
    await expect(anchor).toBeInViewport();
    await history.getByRole('button', { name: 'Завантажити нові та перейти вниз' }).click();
    await expect(history.locator('[data-duty-message-id="60"]')).toBeInViewport();
    await expect(history.locator('[data-duty-message-id="59"]')).toHaveCount(0);
    await expect
      .poll(() =>
        scroller.evaluate(
          (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
        ),
      )
      .toBeLessThanOrEqual(1);
  });
}

test('#3894 deleting a direct-link historical tail does not request empty newer pages @regression', async ({
  page,
}) => {
  const uuid = '019a4aa8-0000-7000-8000-000000000041';
  let deleted = false;
  const newerSinceIds: number[] = [];
  const response = (ids: number[]): InboxMessagesRspRaw => ({
    inbox_items: ids
      .filter((id) => !deleted || id !== 60)
      .map((id) => [
        id,
        minimalInboxMessage({
          messageUuid: id === 41 ? uuid : null,
          text: `Historical message ${id} ${'History '.repeat(40)}`,
          createdAt: 1_720_000_000_000 + id * 1_000,
          timestamp: 1_720_000_000_000 + id * 1_000,
          groupMasterKey: 'group-1',
        }) as never,
      ]),
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRerDutyShortStateMocks(page, {
    inboxCountResponseForRequest: () => ({ quantity: 0, first_element_ts: null }),
    inboxResponseForRequest: (body) => {
      const request = body as { before_id_noninclusive?: number; since_id_noninclusive?: number };
      if (request.before_id_noninclusive === 41)
        return response(Array.from({ length: 20 }, (_, i) => i + 21));
      if (request.since_id_noninclusive === 41)
        return response(Array.from({ length: 19 }, (_, i) => i + 42));
      if (request.since_id_noninclusive != null) {
        newerSinceIds.push(request.since_id_noninclusive);
        return response([]);
      }
      if (request.before_id_noninclusive != null) return response([]);
      return response(Array.from({ length: 20 }, (_, i) => i + 41));
    },
  });
  await page.route('**/api/rer-importer/inbox-item-context', (route) =>
    route.fulfill({
      json: {
        message: response([41]).inbox_items[0],
        group_master_keys: ['group-1'],
        sigint_inbox_item_ids: [41],
        since_ts: null,
        till_ts: null,
      },
    }),
  );
  await page.route('**/api/rer-importer/messages-by-id-with-metadata', (route) =>
    route.fulfill({ json: response([41]) }),
  );
  await page.route('**/api/rer-importer/delete-message', async (route) => {
    deleted = true;
    await route.fulfill({ json: null });
  });
  await page.goto(`/rer-duty-neo?m=${uuid}`);
  const scroller = page.locator('[data-duty-feed-scroller="true"]');
  await expect(page.locator('[data-duty-message-id="41"]')).toBeInViewport();
  await scroller.focus();
  await scroller.press('End');
  await expect(page.locator('[data-duty-message-id="60"]')).toBeInViewport();
  await page
    .locator('[data-duty-message-id="60"]')
    .getByRole('button', { name: 'Більше дій' })
    .click();
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: 'Видалити повідомлення?' });
  await confirmation.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(confirmation).not.toBeVisible();
  await expect(page.locator('[data-duty-message-id="60"]')).toHaveCount(0);
  await expect(page.locator('[data-message-feed-skeleton="below"]')).toHaveCount(0);
  await scroller.evaluate((element) => {
    element.scrollTop = element.scrollHeight - element.clientHeight - 500;
    element.dispatchEvent(new Event('scroll', { bubbles: true }));
  });
  await page.getByRole('button', { name: 'Завантажити нові та перейти вниз' }).click();
  await expect(page.locator('[data-duty-message-id="59"]')).toBeInViewport();
  await expect
    .poll(() =>
      scroller.evaluate(
        (element) => element.scrollHeight - element.clientHeight - element.scrollTop,
      ),
    )
    .toBeLessThanOrEqual(1);
  expect(newerSinceIds).not.toContain(59);
});
