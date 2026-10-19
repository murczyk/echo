import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

for (const kind of ['assigned', 'orphan', 'archived'] as const) {
  test(`@regression #3727 ${kind} group color dropdown cancels and saves without changing other settings`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    let colorKey = 'blue';
    const saves: Record<string, unknown>[] = [];
    let releaseSave!: () => void;
    const saveGate = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    const group = () => ({
      master_key: 'color-group',
      name: 'Test color group',
      sigint_zone_datasource_id: 1,
      group_master_key: 'color-group',
      interseption_kind: 'rer',
      fetch_new_messages: true,
      color_key: colorKey,
      group_stats: { activity_last_day: 0, activity_last_week: 0 },
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const responses: Record<string, unknown> = {
        '/api/system-settings/current': {
          ...systemSettingsCurrentResponse(),
          support_non_rer_interceptions: true,
        },
        '/api/datasources/list': [[1, { kind: 'signal', display_name: 'Signal' }]],
        '/api/sigint/zones/list': kind === 'assigned' ? [[1, { name: 'Test direction' }]] : [],
        '/api/sigint/zones/zone-datasources': [1],
        '/api/sigint/zones/zone-datasource-groups': { zone_datasource_groups: [group()] },
        '/api/rer-importer/orphan-signal-groups': kind === 'orphan' ? [group()] : [],
        '/api/rer-importer/archived-signal-groups': kind === 'archived' ? [group()] : [],
        '/api/rer-importer/signal-group-batch': { data: [group()] },
        '/api/rer-importer/group-stats-timeline': { data: [] },
        '/api/sigint/aor': [],
        '/api/organisms': [],
        '/api/logins': { users: [] },
      };
      if (
        path === '/api/sigint/zones/zone-datasource-group-update' ||
        path === '/api/messenger/edit-group'
      ) {
        const body = route.request().postDataJSON();
        saves.push(body);
        await saveGate;
        colorKey = body.color_key;
        await route.fulfill({ json: group() });
      } else if (path in responses) {
        await route.fulfill({ json: responses[path] });
      } else {
        await route.fallback();
      }
    });
    const openEditor = async () => {
      if (kind === 'assigned')
        await page.getByRole('tab', { name: 'Напрямок: Test direction' }).click();
      if (kind === 'archived') await page.getByRole('tab', { name: /АРХІВ/ }).click();
      await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
    };
    await page.goto('/admin/directions-neo');
    await openEditor();
    const dialog = page.getByRole('dialog');
    const dropdown = dialog.getByRole('combobox', { name: 'Колір групи' });
    await expect(dropdown).toHaveText('Синій');
    const category = dialog.getByRole('combobox', { name: 'Категорія групи' });
    await expect(category).toBeVisible();
    await expect
      .poll(async () => {
        const colorBottom = await dropdown.evaluate(
          (element) => element.closest('.MuiFormControl-root')!.getBoundingClientRect().bottom,
        );
        const categoryTop = await category.evaluate(
          (element) => element.closest('.MuiFormControl-root')!.getBoundingClientRect().top,
        );
        return categoryTop - colorBottom;
      })
      .toBeGreaterThanOrEqual(12);
    await expect(page.getByRole('listbox')).not.toBeVisible();
    if (kind !== 'archived') {
      await page.screenshot({
        path: testInfo.outputPath('color-dropdown-desktop.png'),
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: testInfo.outputPath('color-dropdown-mobile.png'),
        animations: 'disabled',
      });
      await page.setViewportSize({ width: 1280, height: 900 });
    }
    await dropdown.click();
    await expect(page.getByRole('option')).toHaveCount(16);
    await page.getByRole('listbox').press('Home');
    await page.keyboard.press('Enter');
    await expect(dropdown).toHaveText('Червоний');
    await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
    expect(saves).toHaveLength(0);
    await openEditor();
    await expect(dropdown).toHaveText('Синій');
    await dropdown.click();
    await page.getByRole('option', { name: 'Темно-фіолетовий', exact: true }).click();
    await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect.poll(() => saves.length).toBe(1);
    await expect(dropdown).toBeDisabled();
    expect(saves[0]).toMatchObject({ color_key: 'deep_purple', fetch_new_messages: true });
    releaseSave();
    await expect(dialog).not.toBeVisible();
    await page.reload();
    await openEditor();
    await expect(dropdown).toHaveText('Темно-фіолетовий');
  });
}
