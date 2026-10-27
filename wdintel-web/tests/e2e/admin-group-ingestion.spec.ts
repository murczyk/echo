import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

for (const assigned of [true, false]) {
  test(`@regression #3610 ${assigned ? 'assigned' : 'orphan'} group ingestion setting persists`, async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    let fetchNewMessages: boolean | null = null;
    const saves: Record<string, unknown>[] = [];
    const group = () => ({
      master_key: 'ingestion-group',
      name: 'Ingestion group',
      sigint_zone_datasource_id: 1,
      group_master_key: 'ingestion-group',
      interseption_kind: 'rer',
      fetch_new_messages: fetchNewMessages,
      group_stats: { activity_last_day: 0, activity_last_week: 0 },
    });
    await page.route('**/api/**', async (route) => {
      const path = new URL(route.request().url()).pathname;
      const responses: Record<string, unknown> = {
        '/api/datasources/list': [[1, { kind: 'signal', display_name: 'Signal' }]],
        '/api/sigint/zones/list': assigned ? [[1, { name: 'Test direction' }]] : [],
        '/api/sigint/zones/zone-datasources': [1],
        '/api/sigint/zones/zone-datasource-groups': { zone_datasource_groups: [group()] },
        '/api/rer-importer/orphan-signal-groups': assigned ? [] : [group()],
        '/api/rer-importer/archived-signal-groups': [],
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
        fetchNewMessages = body.fetch_new_messages;
        await route.fulfill({ json: group() });
      } else if (path in responses) {
        await route.fulfill({ json: responses[path] });
      } else {
        await route.fallback();
      }
    });
    const openEditor = async () => {
      if (assigned) await page.getByRole('tab', { name: 'Напрямок: Test direction' }).click();
      await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
    };
    await page.goto('/admin/directions-neo');
    await openEditor();
    const dialog = page.getByRole('dialog');
    const toggle = dialog.getByRole('checkbox', {
      name: 'Отримувати нові повідомлення з месенджера',
    });
    await expect(toggle).toBeChecked();
    await toggle.uncheck();
    await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(saves[0]).toMatchObject({ fetch_new_messages: false });
    await page.reload();
    await openEditor();
    await expect(toggle).not.toBeChecked();
    await toggle.check();
    await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(saves[1]).toMatchObject({ fetch_new_messages: true });
  });
}
