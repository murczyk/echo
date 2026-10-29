import { expect, test } from '@playwright/test';
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
