import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

function sigintUnit(id: number, active = true, hasOrbit = false) {
  return {
    id,
    name: `3113 підрозділ ${String(id).padStart(2, '0')}`,
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
    active,
    comment: '',
    orbit_note: null,
    present_in_orbit: true,
    is_deduplicate_candidate: null,
    combat_type_id: null,
    combat_type_name: null,
    created_at: 0,
    created_by_login_id: 'tester',
    has_orbit: hasOrbit,
    orbit_unit_ids: hasOrbit ? ['orbit-linked'] : [],
    orbit_unit_generative_names: [],
  };
}

test('#3113 administers all unlinked units through the default first tab @regression', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin'] });
  let units = Array.from({ length: 21 }, (_, index) => sigintUnit(index + 1, index !== 20));
  units.push(sigintUnit(22, true, true));
  const listRequests: Record<string, unknown>[] = [];
  const links: Record<string, unknown>[] = [];
  const merges: Record<string, unknown>[] = [];

  await page.route('**/api/sigint/units', (route) => {
    const req = route.request().postDataJSON();
    const filtered = units.filter(
      (unit) =>
        (req.include_inactive || unit.active) &&
        (req.filter_has_orbit === null || unit.has_orbit === req.filter_has_orbit),
    );
    if (req.filter_has_orbit === false) listRequests.push(req);
    const offset = req.offset ?? 0;
    return route.fulfill({
      json: {
        units: filtered.slice(offset, offset + (req.limit ?? filtered.length)),
        total_count: filtered.length,
        show_load_more: false,
        status_counts: {
          active: filtered.filter((unit) => unit.active).length,
          inactive: filtered.filter((unit) => !unit.active).length,
        },
      },
    });
  });
  await page.route('**/api/sigint/unit/attachment-unit-ids', (route) =>
    route.fulfill({ json: { unit_ids: [] } }),
  );
  await page.route('**/api/admin/unit-duplicates', (route) =>
    route.fulfill({ json: { units: [] } }),
  );
  await page.route('**/api/sigint/unit/orbit-link-candidates', (route) => {
    expect(route.request().postDataJSON().unit_id).toBe(21);
    return route.fulfill({
      json: {
        units: [
          {
            unit_id: 'orbit-21',
            full_name: 'Orbit підрозділ 21',
            generative_unit_name_full: 'Orbit підрозділ 21',
            operational_unit_name_full: '',
          },
        ],
      },
    });
  });
  await page.route('**/api/sigint/unit/orbit-link', (route) => {
    const req = route.request().postDataJSON();
    links.push(req);
    units = units.map((unit) =>
      unit.id === req.sigint_unit_id ? { ...unit, has_orbit: true } : unit,
    );
    return route.fulfill({ status: 200, body: '' });
  });
  await page.route('**/api/sigint/unit/delete-duplicate', (route) => {
    const req = route.request().postDataJSON();
    merges.push(req);
    units = units.filter((unit) => unit.id !== req.clone_to_delete_id);
    return route.fulfill({ json: 3113 });
  });
  await page.route('**/api/bgtask/3113/status-and-logs?*', (route) =>
    route.fulfill({
      json: {
        running: false,
        loglines: [],
        finished_with_error: null,
        finished_with_error_code: null,
        progress: 100,
      },
    }),
  );

  await page.goto('/admin/units');
  const unlinkedTab = page.getByRole('tab', { name: 'Відсутні в Orbit' });
  await expect(page.getByRole('tab').first()).toHaveText('Відсутні в Orbit');
  await expect(unlinkedTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('1-20 з 21', { exact: true })).toBeVisible();
  expect(listRequests.at(-1)).toMatchObject({
    include_inactive: true,
    filter_active: null,
    filter_has_orbit: false,
    limit: 20,
    offset: 0,
  });
  await expect(page.getByText('3113 підрозділ 22', { exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: 'Наступна сторінка' }).click();
  const inactiveRow = page.getByRole('row').filter({ hasText: '3113 підрозділ 21' });
  await expect(inactiveRow).toContainText('Неактивний');
  expect(listRequests.at(-1)?.offset).toBe(20);
  await inactiveRow.getByRole('button', { name: 'Прив’язати до Orbit', exact: true }).click();
  const orbitDialog = page.getByRole('dialog');
  await expect(orbitDialog.getByText('Orbit підрозділ 21', { exact: true }).first()).toBeVisible();
  await orbitDialog.getByRole('button', { name: "Прив'язати", exact: true }).click();
  await expect(orbitDialog).toHaveCount(0);
  await expect(page.getByText('1-20 з 20', { exact: true })).toBeVisible();
  await expect(page.getByText('3113 підрозділ 21', { exact: true })).toHaveCount(0);
  expect(links).toEqual([{ sigint_unit_id: 21, orbit_unit_id: 'orbit-21' }]);

  const originalRow = page.getByRole('row').filter({ hasText: '3113 підрозділ 01' });
  await originalRow.getByRole('button', { name: 'Об’єднати дублікати', exact: true }).click();
  const mergeDialog = page.getByRole('dialog');
  const duplicateSelect = mergeDialog.getByRole('combobox', { name: 'Підрозділ-дублікат' });
  await duplicateSelect.click();
  await page.getByRole('option', { name: '3113 підрозділ 02', exact: true }).click();
  await mergeDialog.getByRole('button', { name: 'Об’єднати', exact: true }).click();
  await expect(mergeDialog).toHaveCount(0);
  await expect(page.getByText('1-19 з 19', { exact: true })).toBeVisible();
  await expect(page.getByText('3113 підрозділ 02', { exact: true })).toHaveCount(0);
  expect(merges).toEqual([{ original_id: 1, clone_to_delete_id: 2 }]);

  await page.getByRole('tab', { name: 'Дублікати підрозділів', exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/units\?tab=duplicates$/);
  await page.goBack();
  await expect(unlinkedTab).toHaveAttribute('aria-selected', 'true');
  await page.goto('/admin/units?tab=duplicates');
  await expect(
    page.getByRole('tab', { name: 'Дублікати підрозділів', exact: true }),
  ).toHaveAttribute('aria-selected', 'true');
  await page.goto('/admin/units?tab=invalid');
  await expect(page).toHaveURL(/\/admin\/units\?tab=unlinked$/);
  await expect(unlinkedTab).toHaveAttribute('aria-selected', 'true');
});
