import { expect, test, type Page } from '@playwright/test';
import type { SettlementAliasItem, SettlementAliasSettlement } from '../../src/Bindings';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const settlements: SettlementAliasSettlement[] = [
  { id: 101, name: 'Мирне', district: 'Перший район', region: 'Перша область' },
  { id: 202, name: 'Мирне', district: 'Другий район', region: 'Друга область' },
];

async function installAliases(page: Page, aliases: SettlementAliasItem[] = []) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/admin/ai-settlements/page', (route) =>
    route.fulfill({
      json: {
        prompt: 'Find settlements',
        promptOverridden: false,
        engines: [],
        messages: [],
        worker: { enabled: false, aiEngineId: null, groupsExcept: false, groupMasterKeys: [] },
        groups: [],
      },
    }),
  );
  await page.route('**/api/admin/ai-settlements/aliases/list', (route) =>
    route.fulfill({ json: { items: aliases, nextId: null } }),
  );
  await page.route('**/api/admin/ai-settlements/aliases/settlements', (route) =>
    route.fulfill({ json: settlements }),
  );
  await page.goto('/admin/ai/settlements');
  const admin = page.locator('admin-ai-agent');
  await expect(admin.getByRole('tab').last()).toHaveText('Словник синонімів');
  await admin.getByRole('tab', { name: 'Словник синонімів' }).click();
  return admin;
}

test('@regression #3383 creates an alias for the selected settlement and shows the saved row', async ({
  page,
}) => {
  const aliases: SettlementAliasItem[] = [];
  let savedRequest: unknown;
  const admin = await installAliases(page, aliases);
  await page.route('**/api/admin/ai-settlements/aliases/save', async (route) => {
    const req = route.request().postDataJSON();
    savedRequest = req;
    const alias: SettlementAliasItem = {
      id: '019a4aa8-0000-7000-8000-000000000008',
      settlement: settlements.find((settlement) => settlement.id === req.settlementId)!,
      text: req.text,
    };
    aliases.push(alias);
    await route.fulfill({ json: alias });
  });
  await admin.getByRole('button', { name: 'Add New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('button', { name: 'Зберегти' })).toBeDisabled();
  await dialog.getByRole('combobox', { name: 'Населений пункт' }).fill('Мир');
  await page
    .getByRole('option', { name: 'Мирне, Другий район, Друга область, #202', exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Синонім' }).fill('Стара назва');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(savedRequest).toEqual({ id: null, settlementId: 202, text: 'Стара назва' });
  const row = admin.getByRole('row').filter({ hasText: 'Стара назва' });
  await expect(row).toContainText('Мирне');
  await expect(row).toContainText('Друга область');
  await page.reload();
  await admin.getByRole('tab', { name: 'Словник синонімів' }).click();
  await expect(admin.getByRole('row').filter({ hasText: 'Стара назва' })).toBeVisible();
});

test('@regression #3383 retains alias input and reports a failed save before retry', async ({
  page,
}) => {
  let attempts = 0;
  const admin = await installAliases(page);
  await page.route('**/api/admin/ai-settlements/aliases/save', async (route) => {
    attempts += 1;
    if (attempts === 1) {
      await route.fulfill({ status: 409, json: { error: 'Синонім уже існує' } });
    } else {
      await route.fulfill({
        json: {
          id: '019a4aa8-0000-7000-8000-000000000009',
          settlement: settlements[0],
          text: 'Інша назва',
        },
      });
    }
  });
  await admin.getByRole('button', { name: 'Add New', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Населений пункт' }).fill('Мир');
  await page
    .getByRole('option', { name: 'Мирне, Перший район, Перша область, #101', exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Синонім' }).fill('Стара назва');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Синонім уже існує');
  await expect(dialog.getByRole('textbox', { name: 'Синонім' })).toHaveValue('Стара назва');
  await dialog.getByRole('textbox', { name: 'Синонім' }).fill('Інша назва');
  await expect
    .poll(async () => {
      if (attempts === 1)
        await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
      return attempts;
    })
    .toBe(2);
  await expect(dialog).not.toBeVisible();
  await expect(admin.getByRole('row').filter({ hasText: 'Інша назва' })).toBeVisible();
  expect(attempts).toBe(2);
});

test('@regression #3383 edits an alias and requires confirmation before deleting it', async ({
  page,
}) => {
  const alias: SettlementAliasItem = {
    id: '019a4aa8-0000-7000-8000-000000000008',
    settlement: settlements[0],
    text: 'Стара назва',
  };
  let deleted = false;
  const admin = await installAliases(page, [alias]);
  await page.route('**/api/admin/ai-settlements/aliases/save', async (route) => {
    const req = route.request().postDataJSON();
    expect(req.id).toBe(alias.id);
    await route.fulfill({ json: { ...alias, text: req.text } });
  });
  await page.route('**/api/admin/ai-settlements/aliases/delete', async (route) => {
    expect(route.request().postDataJSON()).toEqual({ id: alias.id });
    deleted = true;
    await route.fulfill({ json: null });
  });
  await admin
    .getByRole('row')
    .filter({ hasText: 'Стара назва' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('combobox', { name: 'Населений пункт' })).toHaveValue(
    'Мирне, Перший район, Перша область, #101',
  );
  await dialog.getByRole('textbox', { name: 'Синонім' }).fill('Нова назва');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(admin.getByRole('row').filter({ hasText: 'Нова назва' })).toBeVisible();
  await admin
    .getByRole('row')
    .filter({ hasText: 'Нова назва' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Скасувати' }).click();
  expect(deleted).toBe(false);
  await admin
    .getByRole('row')
    .filter({ hasText: 'Нова назва' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Видалити', exact: true }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(admin.getByRole('row').filter({ hasText: 'Нова назва' })).toHaveCount(0);
  expect(deleted).toBe(true);
});
