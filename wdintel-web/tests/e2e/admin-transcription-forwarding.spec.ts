import { expect, test, type Page } from '@playwright/test';
import type {
  DeviceAudioForwardingEntry,
  DeviceDetails,
  RemoveDeviceAudioForwardingReq,
  UpdateDeviceReq,
} from '../../src/Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../src/ts/snake-to-camel';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const deviceId = '018f0000-0000-7000-8000-000000000000';
const details: DeviceDetails = {
  id: deviceId,
  name: 'Приймач 1',
  aors: [],
  unit: null,
  customFields: {},
  externalUrl: null,
  createdBy: 'tester',
  archived: false,
  archivedAt: null,
  createdAt: '2026-10-23T10:00:00Z',
  updatedAt: '2026-10-23T10:00:00Z',
  audioForwardingConfigured: false,
};
const firstEntry: DeviceAudioForwardingEntry = {
  deviceId,
  deviceName: 'Приймач 1',
  deviceArchived: false,
  groupMasterKey: 'echo_native.first',
  groupName: 'Група 1',
  enabled: false,
  version: 'version-1',
};

async function installMocks(page: Page) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Cyber'] });
  const state = {
    entries: [firstEntry],
    additions: [] as UpdateDeviceReq[],
    removals: [] as RemoveDeviceAudioForwardingReq[],
    conflict: false,
    listFailure: false,
  };
  await page.route('**/api/device/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith('/forwarding/list')) {
      return state.listFailure
        ? route.fulfill({ status: 503, json: { message: 'Тимчасово недоступно' } })
        : route.fulfill({
            json: transformCamelToSnake({
              items: state.entries,
              nextCursor: null,
              totalCount: state.entries.length,
              pageSize: 100,
            }),
          });
    }
    if (path === '/api/device/list') {
      return route.fulfill({
        json: transformCamelToSnake({
          list: [details],
          total: 1,
          hasMore: false,
          statusCounts: { active: 1, archived: 0 },
        }),
      });
    }
    if (path.endsWith('/audio/forwarding')) {
      return route.fulfill({
        json: transformCamelToSnake({
          version: state.entries[0]?.version ?? null,
          enabled: state.entries[0]?.enabled ?? false,
          groups: [
            {
              masterKey: 'echo_native.first',
              name: 'Група 1',
              selected: state.entries.some((entry) => entry.groupMasterKey === 'echo_native.first'),
            },
            {
              masterKey: 'echo_native.second',
              name: 'Група 2',
              selected: state.entries.some(
                (entry) => entry.groupMasterKey === 'echo_native.second',
              ),
            },
          ],
        }),
      });
    }
    if (path === '/api/device/update') {
      const request = transformSnakeToCamel<UpdateDeviceReq>(route.request().postDataJSON());
      state.additions.push(request);
      if (state.conflict)
        return route.fulfill({
          status: 409,
          json: { message: 'Налаштування пересилання змінилися' },
        });
      state.entries = [
        ...state.entries,
        { ...firstEntry, groupMasterKey: 'echo_native.second', groupName: 'Група 2' },
      ].map((entry) => ({ ...entry, version: 'version-2', enabled: true }));
      return route.fulfill({
        json: transformCamelToSnake({ ...details, audioForwardingConfigured: true }),
      });
    }
    if (path.endsWith('/forwarding/remove')) {
      const request = transformSnakeToCamel<RemoveDeviceAudioForwardingReq>(
        route.request().postDataJSON(),
      );
      state.removals.push(request);
      if (state.conflict)
        return route.fulfill({
          status: 409,
          json: { message: 'Налаштування пересилання змінилися' },
        });
      state.entries = state.entries.filter(
        (entry) => entry.groupMasterKey !== request.groupMasterKey,
      );
      return route.fulfill({ status: 204 });
    }
    return route.fallback();
  });
  return state;
}

async function chooseForwarding(page: Page) {
  await page.getByRole('button', { name: 'Додати пересилання', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Додати пересилання' });
  await dialog.getByRole('combobox', { name: 'Пристрій' }).fill('Приймач');
  await page.getByRole('option', { name: 'Приймач 1' }).click();
  await dialog.getByRole('combobox', { name: 'Група Echo Native' }).click();
  await page.getByRole('option', { name: 'Група 2' }).click();
  return dialog;
}

test('@regression #3646 adds and removes a forwarding from the knowledge base', async ({
  page,
}) => {
  const state = await installMocks(page);
  await page.goto('/admin/device-analytics');
  await page.getByRole('button', { name: 'Адмін', exact: true }).click();
  await page.getByText('База знань', { exact: true }).hover();
  await page.getByText('Пересилання транскрибації', { exact: true }).click();
  await expect(page).toHaveURL(/\/admin\/transcription-forwarding(?:\?|$)/);
  const table = page.getByRole('table', { name: 'Налаштовані пересилання транскрибації' });
  await expect(table).toContainText('Вимкнено');
  const dialog = await chooseForwarding(page);
  await expect(dialog).toContainText('для всіх налаштованих груп');
  await dialog.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(table).toContainText('Група 2');
  expect(state.additions[0]).toMatchObject({
    deviceId,
    audioForwarding: {
      version: 'version-1',
      enabled: true,
      addGroups: ['echo_native.second'],
      removeGroups: [],
    },
  });
  await table.getByRole('button', { name: 'Видалити пересилання Приймач 1 → Група 2' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Видалити пересилання?' });
  await confirmation.getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(table).not.toContainText('Група 2');
  await expect(table).toContainText('Група 1');
  expect(state.removals).toEqual([
    { deviceId, groupMasterKey: 'echo_native.second', version: 'version-2' },
  ]);
});

test('@regression #3646 preserves forwarding when deletion is cancelled', async ({ page }) => {
  const state = await installMocks(page);
  await page.goto('/admin/transcription-forwarding');
  const table = page.getByRole('table', { name: 'Налаштовані пересилання транскрибації' });
  await table.getByRole('button', { name: 'Видалити пересилання Приймач 1 → Група 1' }).click();
  const confirmation = page.getByRole('dialog', { name: 'Видалити пересилання?' });
  await confirmation.getByRole('button', { name: 'Скасувати' }).click();
  await expect(confirmation).toBeHidden();
  await expect(table).toContainText('Група 1');
  expect(state.removals).toHaveLength(0);
});

test('@regression #3646 keeps the form and existing forwarding after version conflicts', async ({
  page,
}) => {
  const state = await installMocks(page);
  state.conflict = true;
  await page.goto('/admin/transcription-forwarding');
  const dialog = await chooseForwarding(page);
  await dialog.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(
    dialog.getByRole('alert').filter({ hasText: 'Не вдалося додати пересилання' }),
  ).toContainText('Налаштування пересилання змінилися');
  await expect(dialog.getByRole('combobox', { name: 'Група Echo Native' })).toHaveValue('Група 2');
  await dialog.getByRole('button', { name: 'Оновити групи' }).click();
  await expect(dialog.getByRole('combobox', { name: 'Група Echo Native' })).toHaveValue('');
  await dialog.getByRole('button', { name: 'Скасувати' }).click();
  await page.getByRole('button', { name: 'Видалити пересилання Приймач 1 → Група 1' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Видалити', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(page.getByRole('table')).toContainText('Група 1');
  await expect(
    page.getByRole('alert').filter({ hasText: 'Не вдалося видалити пересилання' }),
  ).toBeVisible({ timeout: 15_000 });
});

test('@regression #3646 retries failed list requests and follows the server pagination cursor', async ({
  page,
}) => {
  const state = await installMocks(page);
  state.listFailure = true;
  await page.goto('/admin/transcription-forwarding');
  await expect(page.getByRole('table')).toHaveCount(0);
  await expect(
    page.getByRole('alert').filter({ hasText: 'Тимчасово недоступно' }).first(),
  ).toBeVisible();
  const cursors: unknown[] = [];
  await page.route('**/api/device/audio/forwarding/list', (route) => {
    const cursor = route.request().postDataJSON().cursor;
    cursors.push(cursor);
    return route.fulfill({
      json: transformCamelToSnake({
        items: [
          cursor
            ? {
                ...firstEntry,
                groupMasterKey: 'echo_native.second',
                groupName: 'Група 2',
                deviceArchived: true,
              }
            : firstEntry,
        ],
        nextCursor: cursor ? null : [deviceId, 'echo_native.first'],
        totalCount: 2,
        pageSize: 1,
      }),
    });
  });
  await page.getByRole('button', { name: 'Повторити', exact: true }).click();
  await expect(page.getByRole('table')).toContainText('Група 1');
  const pagination = page.getByRole('navigation', { name: 'Сторінки пересилань' });
  await expect(pagination).toContainText('1-1 з 2');
  await expect(page.getByRole('button', { name: 'Попередня сторінка' })).toBeDisabled();
  await page.getByRole('button', { name: 'Наступна' }).click();
  await expect(page.getByRole('table')).toContainText('Пристрій архівований');
  await expect(pagination).toContainText('2-2 з 2');
  await expect(page.getByRole('table').getByRole('cell', { name: '2', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Наступна' })).toBeDisabled();
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(pagination).toContainText('2-2 з 2');
  await page.getByRole('button', { name: 'Попередня' }).click();
  await expect(page.getByRole('table')).toContainText('Група 1');
  await expect(pagination).toContainText('1-1 з 2');
  expect(cursors).toEqual([
    null,
    [deviceId, 'echo_native.first'],
    [deviceId, 'echo_native.first'],
    null,
  ]);
});
