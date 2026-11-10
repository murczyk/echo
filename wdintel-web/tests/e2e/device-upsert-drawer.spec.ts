import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

const DEVICE_ID = '00000000-0000-4000-8000-000000000001';
const originalDevice = {
  id: DEVICE_ID,
  name: 'Пристрій Alpha',
  description: 'Початковий опис',
  rating: 0,
  tags: ['початковий'],
  external_url: 'https://example.test/original',
  custom_fields: { inventory_id: 'node-1' } as Record<string, string>,
  aors: [],
  unit: null,
  created_by: 'analysis-tester',
  archived: false,
  created_at: '2026-11-09T00:00:00Z',
  updated_at: '2026-11-09T00:00:00Z',
  archived_at: null,
  stats: null,
  audio_days: null,
  activity_split_files_audio: false,
};

async function installDeviceMocks(page: Page, failFirstSave = false) {
  const writes: Record<string, unknown>[] = [];
  let device = { ...originalDevice };
  await installAnalysisNeoApiMocks(page, { userRoles: ['CyberViewer', 'Cyber', 'Admin'] });
  const responses: Record<string, unknown> = {
    '/api/system-settings/current': {
      ...systemSettingsCurrentResponse(),
      devices_section_enabled: true,
    },
    '/api/device/aors': [],
    '/api/sigint/aor': [],
    '/api/device/units': { units: [] },
    '/api/device/unit-stats': { units: [] },
    '/api/device/filter-options': { aors: [], creators: [], tags: [], custom_field_keys: [] },
    '/api/device/tags': ['початковий'],
    '/api/device/audio/forwarding': { enabled: false, version: 1, groups: [] },
    '/api/device/audio/activity': { uploaded_count: 0, days: [] },
    '/api/device/analytics/tags': { tags: [] },
    '/api/device/analytics/summary': {
      total_file_count: 0,
      files_with_content_count: 0,
      analyzed_file_count: 0,
      items: [],
    },
  };
  for (const [endpoint, json] of Object.entries(responses)) {
    await page.route(`**${endpoint}`, (route) => route.fulfill({ json }));
  }
  await page.route('**/api/device/detail', (route) => route.fulfill({ json: device }));
  await page.route('**/api/device/list', (route) =>
    route.fulfill({
      json: {
        list: [device],
        total: 1,
        has_more: false,
        status_counts: { active: 1, archived: 0 },
      },
    }),
  );
  await page.route('**/api/device/update', async (route) => {
    const payload = route.request().postDataJSON();
    writes.push(payload);
    if (failFirstSave && writes.length === 1) {
      await route.fulfill({
        status: 400,
        json: { error: JSON.stringify([['name', 'Назва вже використовується']]) },
      });
      return;
    }
    device = { ...device, ...payload };
    if (payload.custom_fields) {
      device.custom_fields = { ...originalDevice.custom_fields, ...payload.custom_fields };
      for (const key of Object.keys(device.custom_fields)) {
        if (device.custom_fields[key] === null) delete device.custom_fields[key];
      }
    }
    await route.fulfill({ json: device });
  });
  return writes;
}

const drawer = (page: Page) => page.locator('[aria-labelledby="device-upsert-drawer-title"]');

async function openEdit(page: Page, location: 'list' | 'detail') {
  if (location === 'list') {
    await page
      .getByRole('row', { name: /Пристрій Alpha/ })
      .getByRole('button', { name: 'Редагувати', exact: true })
      .click();
  } else {
    await page.getByRole('button', { name: 'Редагувати пристрій', exact: true }).click();
  }
  await expect(drawer(page)).toBeVisible();
  await expect(drawer(page).getByRole('textbox', { name: 'Назва', exact: false })).toBeEnabled();
  return drawer(page);
}

for (const location of ['list', 'detail'] as const) {
  test(`@regression #4108 device ${location} saves the latest local fields and forwarding change`, async ({
    page,
  }) => {
    const writes = await installDeviceMocks(page);
    await page.goto(location === 'list' ? '/devices' : `/devices/${DEVICE_ID}`);
    const form = await openEdit(page, location);
    const name = form.getByRole('textbox', { name: /^Назва/ });
    const save = form.getByRole('button', { name: 'Зберегти', exact: true });
    await expect(save).toBeDisabled();
    await name.fill('Тимчасова назва');
    await expect(save).toBeEnabled();
    await name.fill(originalDevice.name);
    await expect(save).toBeDisabled();
    await form.getByRole('textbox', { name: 'Опис пристрою', exact: true }).fill('  Новий опис  ');
    await form.getByRole('textbox', { name: 'Зовнішнє посилання', exact: true }).fill('');
    await form.getByRole('textbox', { name: /^Ключ/ }).fill('custom_Key');
    await form.getByRole('textbox', { name: 'Значення', exact: true }).fill('Останнє значення');
    await form.getByRole('combobox', { name: 'Теги', exact: true }).fill('новий');
    await form.getByRole('combobox', { name: 'Теги', exact: true }).press('Enter');
    await form.getByLabel('Пересилати нові аудіо в групи').check();
    await name.fill('Остання назва');
    await save.click();
    await expect.poll(() => writes.length).toBe(1);
    await expect(form).toBeHidden();
    expect(writes).toEqual([
      {
        device_id: DEVICE_ID,
        name: 'Остання назва',
        description: 'Новий опис',
        external_url: null,
        custom_fields: { custom_Key: 'Останнє значення', inventory_id: null },
        tags: ['початковий', 'новий'],
        audio_forwarding: { version: 1, enabled: true, add_groups: [], remove_groups: [] },
      },
    ]);
  });

  test(`@regression #4108 device ${location} resets cancelled edits and preserves failed drafts for correction`, async ({
    page,
  }) => {
    const writes = await installDeviceMocks(page, true);
    await page.goto(location === 'list' ? '/devices' : `/devices/${DEVICE_ID}`);
    let form = await openEdit(page, location);
    await form.getByRole('textbox', { name: /^Назва/ }).fill('Відкинута назва');
    await form.getByRole('textbox', { name: 'Опис пристрою', exact: true }).fill('Не зберігати');
    await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(form).toBeHidden();
    expect(writes).toHaveLength(0);
    form = await openEdit(page, location);
    const name = form.getByRole('textbox', { name: /^Назва/ });
    const description = form.getByRole('textbox', { name: 'Опис пристрою', exact: true });
    const save = form.getByRole('button', { name: 'Зберегти', exact: true });
    await expect(name).toHaveValue(originalDevice.name);
    await expect(description).toHaveValue(originalDevice.description);
    await expect(save).toBeDisabled();
    await description.fill('Збережений після помилки опис');
    await name.fill('Конфліктна назва');
    await save.click();
    await expect(form.getByText('Назва вже використовується', { exact: true })).toBeVisible();
    await expect(name).toHaveValue('Конфліктна назва');
    await expect(description).toHaveValue('Збережений після помилки опис');
    await expect(save).toBeEnabled();
    await name.fill('');
    await name.pressSequentially('Виправлена назва', { delay: 35 });
    await expect(form.getByText('Назва вже використовується', { exact: true })).toBeHidden();
    await save.click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(form).toBeHidden();
    expect(writes).toEqual([
      {
        device_id: DEVICE_ID,
        name: 'Конфліктна назва',
        description: 'Збережений після помилки опис',
      },
      {
        device_id: DEVICE_ID,
        name: 'Виправлена назва',
        description: 'Збережений після помилки опис',
      },
    ]);
  });
}
