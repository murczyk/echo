import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

const COMBAT_TYPE_ID = '252ce8b6-e411-4cba-8d03-6d7e5cc6db75';
const COMBAT_TYPE_NAME = 'Мотострілецькі війська';

for (const path of ['/rer-units-neo', '/rer-units/1']) {
  test(`#3113 assigns and clears combat type at ${path} @regression`, async ({ page }) => {
    await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'UnitsEditor'] });
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({
        json: {
          ...systemSettingsCurrentResponse(),
          rer_report_enabled: false,
          ai_position_highlights_enabled: false,
        },
      }),
    );
    let unit = {
      id: 1,
      name: '3113 підрозділ',
      other: '',
      team_or_crew: '',
      section: '',
      squad: '',
      platoon: '',
      company: '',
      battalion: '',
      regiment: '',
      brigade: '',
      division: '',
      corps: '',
      army: '',
      military_district: '',
      army_region: '',
      active: true,
      comment: '',
      orbit_note: null,
      present_in_orbit: null,
      is_deduplicate_candidate: null,
      combat_type_id: null as string | null,
      combat_type_name: null as string | null,
      created_at: 0,
      created_by_login_id: 'tester',
      has_orbit: false,
      orbit_unit_ids: [],
      orbit_unit_generative_names: [],
    };
    const updates: Record<string, unknown>[] = [];
    await page.route('**/api/sigint/unit/combat-types', (route) =>
      route.fulfill({
        json: { combat_types: [{ id: COMBAT_TYPE_ID, name: COMBAT_TYPE_NAME }] },
      }),
    );
    await page.route('**/api/sigint/units', (route) =>
      route.fulfill({
        json: {
          units: [unit],
          total_count: 1,
          show_load_more: false,
          status_counts: { active: 1, inactive: 0 },
        },
      }),
    );
    await page.route('**/api/sigint/unit/details', (route) =>
      route.fulfill({
        json: {
          unit,
          attachments: [],
          labels: [],
          orbit_units: [],
          can_link_orbit_unit: false,
          can_create_device_network: false,
          can_edit_unit_labels: false,
        },
      }),
    );
    await page.route('**/api/sigint/unit/update', async (route) => {
      const values = route.request().postDataJSON();
      updates.push(values);
      unit = {
        ...unit,
        ...values,
        combat_type_name: values.combat_type_id ? COMBAT_TYPE_NAME : null,
      };
      await route.fulfill({ json: unit });
    });
    await page.route('**/api/sigint/unit/attachment-unit-ids', (route) =>
      route.fulfill({ json: { unit_ids: [] } }),
    );
    await page.goto(path);
    if (path === '/rer-units-neo') {
      await expect(page.getByRole('columnheader', { name: /Види та роди ЗС/ })).toBeVisible();
    }
    async function openEditor() {
      if (path !== '/rer-units-neo')
        await page.getByRole('button', { name: 'Дії з даними підрозділу' }).click();
      await page.getByRole('button', { name: /Редагувати$/ }).click();
    }
    await openEditor();
    await page.getByRole('combobox', { name: 'Види та роди ЗС' }).click();
    await page.getByRole('option', { name: COMBAT_TYPE_NAME, exact: true }).click();
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => updates.at(-1)?.combat_type_id).toBe(COMBAT_TYPE_ID);
    await openEditor();
    await expect(page.getByRole('combobox', { name: 'Види та роди ЗС' })).toContainText(
      COMBAT_TYPE_NAME,
    );
    await page.getByRole('combobox', { name: 'Види та роди ЗС' }).click();
    await page.getByRole('option', { name: 'Не визначено', exact: true }).click();
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => updates.at(-1)?.combat_type_id).toBeNull();
  });
}
