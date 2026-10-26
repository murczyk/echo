import { expect, test, type Page } from '@playwright/test';
import type {
  NativeGroupCreateReq,
  NativeGroupDetail,
  NativeGroupUpdateReq,
} from '../../src/Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const creatorId = 'a9296db9-e633-48da-a683-04f30c929a90';

async function installNativeGroupMocks(page: Page, loseFirstCreateResponse = false) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  let group: NativeGroupDetail | null = null;
  const createRequests: NativeGroupCreateReq[] = [];
  const legacyWrites: string[] = [];
  const groupEntry = () =>
    group && {
      ...transformCamelToSnake<Record<string, unknown>>(group.settings),
      master_key: group.masterKey,
      group_master_key: group.masterKey,
      datasource_id: 1,
      sigint_zone_datasource_id: 1,
      is_group_secret: group.settings.isSecret,
      allowed_users: group.settings.userLogins,
      allowed_organism_ids: group.settings.organismIds,
      is_archived: group.isArchived,
      group_stats: { activity_last_day: 0, activity_last_week: 0 },
      group_admin_data: {
        short_note: group.settings.shortNote,
        long_note: group.settings.longNote,
      },
      areas_of_responsibility: group.settings.areaOfResponsibilityIds.map((id) => ({
        id,
        name: 'Test AOR',
      })),
    };
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/messenger/native-groups/create') {
      const request = transformSnakeToCamel<NativeGroupCreateReq>(route.request().postDataJSON());
      createRequests.push(request);
      group ??= {
        masterKey: `echo_native.${request.requestId}`,
        settings: request.settings,
        isArchived: false,
      };
      if (loseFirstCreateResponse && createRequests.length === 1) {
        await route.fulfill({
          status: 503,
          json: { error: 'Втрачено відповідь після збереження' },
        });
      } else {
        await route.fulfill({ json: transformCamelToSnake(group) });
      }
      return;
    }
    if (path === '/api/messenger/native-groups/update') {
      const request = transformSnakeToCamel<NativeGroupUpdateReq>(route.request().postDataJSON());
      if (!group || group.isArchived) throw new Error('Cannot update missing/archived group');
      group = { ...group, settings: request.settings };
      await route.fulfill({ json: transformCamelToSnake(group) });
      return;
    }
    if (
      path === '/api/rer-importer/signal-group-archive' ||
      path === '/api/rer-importer/signal-group-unarchive'
    ) {
      if (!group) throw new Error('Missing native group');
      group = {
        ...group,
        isArchived: path.endsWith('group-archive'),
        settings: { ...group.settings, zoneIds: [] },
      };
      await route.fulfill({ status: 204 });
      return;
    }
    if (
      [
        '/api/messenger/edit-group',
        '/api/sigint/zones/zone-datasource-group-update',
        '/api/sigint/zones/zone-datasource-group-add',
        '/api/sigint/zones/zone-datasource-group-delete',
      ].includes(path)
    ) {
      legacyWrites.push(path);
      await route.fulfill({ status: 400, json: { error: 'Native groups must use native API' } });
      return;
    }
    const assigned = group && !group.isArchived && group.settings.zoneIds.length > 0;
    const responses: Record<string, unknown> = {
      '/api/user': {
        id: creatorId,
        name: 'Native admin',
        roles: ['Admin', 'Rer'],
        organism_id: 1,
        sigint_zone_id: 1,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
        rer_report_eligible: false,
      },
      '/api/user/sigint-groups': assigned ? [group.masterKey] : [],
      '/api/datasources/list': [[1, { kind: 'echo_native', display_name: 'Echo Native' }]],
      '/api/sigint/zones/list': [[1, { name: 'Test direction' }]],
      '/api/sigint/zones/zone-datasources': assigned ? [1] : [],
      '/api/sigint/zones/zone-datasource-groups': {
        zone_datasource_groups: assigned ? [groupEntry()] : [],
      },
      '/api/rer-importer/orphan-signal-groups':
        group && !group.isArchived && !assigned ? [groupEntry()] : [],
      '/api/rer-importer/archived-signal-groups': group?.isArchived ? [groupEntry()] : [],
      '/api/rer-importer/signal-group-batch': { data: group ? [groupEntry()] : [] },
      '/api/rer-importer/group-stats-timeline': { data: [] },
      '/api/sigint/aor': [{ id: 1, name: 'Test AOR' }],
      '/api/organisms': [{ id: 1, name: 'Test organism', enabled: true }],
      '/api/logins': { users: [{ id: creatorId, login: 'Native admin', deleted: false }] },
      '/api/messenger/native-groups/get': transformCamelToSnake(group),
      '/api/messenger/group-creation-info': {
        created_at: Date.parse('2026-10-21T09:10:00Z'),
        created_by: 'Native admin',
      },
    };
    if (path in responses) await route.fulfill({ json: responses[path] });
    else await route.fallback();
  });
  return { createRequests, legacyWrites, getGroup: () => group };
}

async function chooseOption(page: Page, fieldName: string, option: string) {
  const field = page.getByRole('dialog').getByRole('combobox', { name: fieldName, exact: true });
  await field.fill(option);
  await page.getByRole('option', { name: option, exact: true }).click();
  await field.press('Tab');
}

test('@regression #3646 native group creation, access editing, archive and restore use the native lifecycle', async ({
  page,
}) => {
  const state = await installNativeGroupMocks(page);
  await page.goto('/admin/directions-neo');
  await page.getByRole('button', { name: 'Створити групу', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Назва групи' }).fill('Native test group');
  await expect(dialog.getByRole('checkbox', { name: 'Приватна група' })).toBeChecked();
  await expect(
    dialog.getByRole('checkbox', { name: 'Отримувати нові повідомлення з месенджера' }),
  ).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Створити групу', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(
    page.getByText(
      'Групу збережено. За поточними налаштуваннями доступу її повідомлення вам недоступні.',
    ),
  ).toBeVisible();
  expect(state.createRequests[0].settings).toMatchObject({
    adminLogins: [creatorId],
    userLogins: [creatorId],
    colorKey: 'blue_grey',
    zoneIds: [],
    areaOfResponsibilityIds: [],
    isSecret: true,
    interseptionKind: 'rer',
    disableNetworkAssignment: false,
    isAviationGroup: false,
  });
  await page
    .getByRole('row')
    .filter({ hasText: 'Native test group' })
    .getByRole('button', { name: 'Native test group', exact: true })
    .click();
  await expect(
    page.locator('dt').filter({ hasText: 'Створив групу' }).locator('..').locator('dd'),
  ).toHaveText('Native admin');
  await expect(
    page.locator('dt').filter({ hasText: 'Дата створення' }).locator('..').locator('dd'),
  ).toContainText('2026');
  await page.getByRole('button', { name: 'До списку груп', exact: true }).click();
  const masterKey = state.getGroup()?.masterKey;
  await page
    .getByRole('row')
    .filter({ hasText: 'Native test group' })
    .getByRole('button', { name: 'Редагувати', exact: true })
    .click();
  await dialog.getByRole('textbox', { name: 'Назва групи' }).fill('Native renamed');
  await dialog.getByRole('combobox', { name: 'Колір групи' }).click();
  await page.getByRole('option', { name: 'Бірюзовий', exact: true }).click();
  await chooseOption(page, 'Дозволені організми', 'Test organism');
  await chooseOption(page, 'Напрямки', 'Test direction');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(
    dialog.getByText(
      'Вкажіть назву, щонайменше одного адміністратора та смугу для вибраних напрямків.',
    ),
  ).toBeVisible();
  await chooseOption(page, 'Смуги відповідальності', 'Test AOR');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByText('Групу збережено. Ви маєте доступ до її повідомлень.')).toBeVisible();
  expect(state.getGroup()?.masterKey).toBe(masterKey);
  expect(state.getGroup()?.settings).toMatchObject({
    colorKey: 'cyan',
    organismIds: [1],
    zoneIds: [1],
    areaOfResponsibilityIds: [1],
    adminLogins: [creatorId],
  });
  await page.getByRole('tab', { name: 'Напрямок: Test direction' }).click();
  const row = page.getByRole('row').filter({ hasText: 'Native renamed' });
  await row.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await expect(dialog.getByRole('textbox', { name: 'Назва групи' })).toHaveValue('Native renamed');
  await dialog.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await row.getByRole('button', { name: 'Дії', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Архівувати', exact: true }).click();
  await dialog.getByRole('button', { name: 'Архівувати', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('tab', { name: /АРХІВ/ }).click();
  await page.getByRole('button', { name: 'Переглянути налаштування', exact: true }).click();
  await expect(dialog.getByText('Для редагування розархівуйте групу.')).toBeVisible();
  await expect(dialog.getByRole('textbox', { name: 'Назва групи' })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Зберегти', exact: true })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Закрити', exact: true }).click();
  await page
    .getByRole('row')
    .filter({ hasText: 'Native renamed' })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Розархівувати', exact: true }).click();
  await dialog.getByRole('button', { name: 'Розархівувати', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await page.getByRole('tab', { name: 'Орфан групи', exact: true }).click();
  await expect(page.getByRole('row').filter({ hasText: 'Native renamed' })).toBeVisible();
  expect(state.getGroup()?.settings.zoneIds).toEqual([]);
  expect(state.legacyWrites).toEqual([]);
});

test('@regression #3646 retry after a lost create response reuses the operation ID', async ({
  page,
}) => {
  const state = await installNativeGroupMocks(page, true);
  await page.goto('/admin/directions-neo');
  await page.getByRole('button', { name: 'Створити групу', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Назва групи' }).fill('Retry group');
  await dialog.getByRole('button', { name: 'Створити групу', exact: true }).click();
  await expect(dialog.getByText(/Втрачено відповідь після збереження/)).toBeVisible();
  await page.getByRole('button', { name: 'Закрити сповіщення', exact: true }).click();
  await dialog.getByRole('button', { name: 'Створити групу', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByRole('row').filter({ hasText: 'Retry group' })).toBeVisible();
  expect(state.createRequests).toHaveLength(2);
  expect(state.createRequests[1].requestId).toBe(state.createRequests[0].requestId);
  expect(state.legacyWrites).toEqual([]);
});
