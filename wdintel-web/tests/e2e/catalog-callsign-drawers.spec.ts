import { expect, test, type Locator, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const existingCallsign = {
  id: 41,
  callsign: 'СОКІЛ',
  position: 'Командир',
  full_name: 'Іван Петренко',
  comment: 'Початковий коментар',
  unit_id: 1,
  source_id: 1,
  callsign_additional_sources: [2, 3],
  created_at: 1700000000000,
  active: true,
  developing: false,
  radio_freq: '',
};
type Write = { operation: string; payload: Record<string, unknown> };

async function installCatalogMocks(page: Page, delaySources = false) {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  const writes: Write[] = [];
  let failedCallsign: string | null = null;
  let releaseSources = () => {};
  const sourcesReady = new Promise<void>((resolve) => {
    releaseSources = resolve;
  });
  if (!delaySources) releaseSources();
  await page.route('**/api/sigint/callsigns', (route) =>
    route.fulfill({ json: { callsigns: [existingCallsign], show_load_more: false } }),
  );
  await page.route('**/api/sigint/callsign/unit-stats', (route) =>
    route.fulfill({ json: { units: [{ unit_id: 1, count: 1 }] } }),
  );
  await page.route('**/api/sigint/units/hierarchy', (route) =>
    route.fulfill({ json: { revision: 'fixture', groups: [], units: [] } }),
  );
  await page.route('**/api/sigint/sources', async (route) => {
    await sourcesReady;
    await route.fulfill({
      json: {
        sources: [
          { id: 1, name: 'РЕР', created_at: 0 },
          { id: 2, name: 'РО', created_at: 0 },
          { id: 3, name: 'Агент', created_at: 0 },
        ],
      },
    });
  });
  for (const operation of ['create', 'update']) {
    await page.route(`**/api/sigint/callsign/${operation}`, async (route) => {
      const payload = route.request().postDataJSON() as Record<string, unknown>;
      writes.push({ operation, payload });
      if (failedCallsign === payload.callsign) {
        failedCallsign = null;
        await route.fulfill({ status: 500, json: { error: 'Тестова помилка збереження' } });
        return;
      }
      await route.fulfill({
        json: {
          ...existingCallsign,
          id: operation === 'create' ? 100 + writes.length : 41,
          ...payload,
        },
      });
    });
  }
  const listResponse = page.waitForResponse('**/api/sigint/callsigns');
  await page.goto('/rer-callsigns-neo');
  await listResponse;
  if (!delaySources) await expect(page.getByRole('row', { name: /СОКІЛ/ })).toBeVisible();
  return {
    writes,
    releaseSources,
    failNextSave: (callsign: string) => {
      failedCallsign = callsign;
    },
  };
}
function drawer(page: Page, mode: 'create' | 'edit') {
  return page.locator(`[aria-labelledby="callsigns-${mode}-drawer-title"]`);
}
async function openCreate(page: Page) {
  await page.getByRole('button', { name: 'Додати позивні', exact: true }).click();
  return drawer(page, 'create');
}
async function openEdit(page: Page) {
  await page
    .getByRole('row', { name: /СОКІЛ/ })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  return drawer(page, 'edit');
}
async function selectUnit(page: Page, form: Locator) {
  await form.getByRole('combobox', { name: /Підрозділ/ }).click();
  await page.getByRole('option', { name: '1', exact: true }).click();
}
async function selectSource(page: Page, form: Locator, name: string) {
  await form.getByRole('combobox', { name: 'Основне джерело', exact: true }).click();
  await page.getByRole('option', { name, exact: true }).click();
}
function field(form: Locator, name: string) {
  return form.getByRole('textbox', { name, exact: true });
}
function button(form: Locator, name: string) {
  return form.getByRole('button', { name, exact: true });
}

test('@regression #4108 catalog create saves latest normalized fields after validation and resets cancelled drafts', async ({
  page,
}) => {
  const { writes } = await installCatalogMocks(page);
  let form = await openCreate(page);
  await expect(button(form, 'Додати')).toBeDisabled();
  await field(form, 'Позивний').fill('чернетка');
  await selectUnit(page, form);
  await field(form, 'Швидка вставка TSV').fill('неправильний\tформат');
  await expect(form.getByRole('alert')).toContainText('Швидка вставка підтримує лише TSV-формат');
  await button(form, 'Скасувати').click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(0);
  form = await openCreate(page);
  await expect(form.getByRole('alert')).toBeHidden();
  await expect(field(form, 'Швидка вставка TSV')).toHaveValue('');
  await expect(field(form, 'Позивний')).toHaveValue('');
  await expect(form.getByRole('combobox', { name: /Підрозділ/ })).toHaveValue('');
  await expect(button(form, 'Додати')).toBeDisabled();
  await selectUnit(page, form);
  await selectSource(page, form, 'РО');
  await field(form, 'Позивний').pressSequentially(' беркут ');
  await button(form, 'Додати').click();
  await expect(form.getByRole('alert')).toContainText('поле "Частота" є обов’язковим');
  expect(writes).toHaveLength(0);
  await field(form, 'Посада').fill(' Заступник ');
  await expect(form.getByRole('alert')).toBeHidden();
  await button(form, 'Додати').click();
  await expect(form.getByRole('alert')).toContainText('поле "Частота" є обов’язковим');
  expect(writes).toHaveLength(0);
  await field(form, 'ПІП').fill(' Петро Коваль ');
  await field(form, 'Коментар').fill(' Уточнено ');
  await form.getByRole('checkbox', { name: 'В дорозвідці', exact: true }).check();
  await form.getByRole('combobox', { name: 'Підтвердження', exact: true }).click();
  await page.getByRole('option', { name: 'Агент', exact: true }).click();
  await page.keyboard.press('Escape');
  await field(form, 'Частота').pressSequentially(' 145.500 ');
  await button(form, 'Додати').click();
  await expect(form).toBeHidden();
  expect(writes).toEqual([
    {
      operation: 'create',
      payload: {
        callsign: 'БЕРКУТ',
        position: 'Заступник',
        full_name: 'Петро Коваль',
        comment: 'Уточнено',
        unit_id: 1,
        source_id: 2,
        callsign_additional_sources: [3],
        developing: true,
        radio_freq: '145.500',
      },
    },
  ]);
  form = await openCreate(page);
  await expect(field(form, 'Позивний')).toHaveValue('');
  await expect(field(form, 'Частота')).toHaveValue('');
  await expect(form.getByRole('checkbox', { name: 'В дорозвідці', exact: true })).not.toBeChecked();
  await expect(form.getByRole('combobox', { name: 'Основне джерело', exact: true })).toHaveText(
    'РЕР',
  );
});

test('@regression #4108 catalog TSV duplicate hints follow edits and only failed batch rows are retried', async ({
  page,
}) => {
  const { writes, failNextSave } = await installCatalogMocks(page);
  const form = await openCreate(page);
  await selectUnit(page, form);
  await selectSource(page, form, 'Агент');
  await form.getByRole('combobox', { name: 'Підтвердження', exact: true }).click();
  await page.getByRole('option', { name: 'РЕР', exact: true }).click();
  await page.keyboard.press('Escape');
  await field(form, 'Швидка вставка TSV').fill(
    ' сокіл \t Командир \t Іван Петренко \t Перший \n невдалий \t Заступник \t Петро Коваль \t Другий ',
  );
  const callsigns = form.getByRole('textbox', { name: 'Позивний', exact: true });
  await expect(callsigns).toHaveCount(2);
  await expect(callsigns.nth(0)).toHaveValue('СОКІЛ');
  await expect(
    form.getByText('Схожі позивні знайдено: 1 у 1 рядках', { exact: true }),
  ).toBeVisible();
  await callsigns.nth(0).fill('НОВИЙ');
  await field(form, 'ПІП').nth(0).fill('Нове ім’я');
  await expect(form.getByText(/Схожі позивні знайдено:/)).toBeHidden();
  await callsigns.nth(0).fill('сокіл');
  await expect(
    form.getByText('Схожі позивні знайдено: 1 у 1 рядках', { exact: true }),
  ).toBeVisible();
  await button(form, 'Рядок').click();
  await expect(callsigns).toHaveCount(3);
  await button(form, 'Видалити рядок 3').click();
  failNextSave('НЕВДАЛИЙ');
  await button(form, 'Додати').click();
  await expect(form.getByRole('alert').filter({ hasText: 'Не вдалося додати' })).toContainText(
    'Тестова помилка збереження',
  );
  await expect(callsigns).toHaveCount(1);
  await expect(callsigns).toHaveValue('НЕВДАЛИЙ');
  await expect(form.getByRole('combobox', { name: /Підрозділ/ })).toHaveValue('1');
  await expect(form.getByRole('combobox', { name: 'Основне джерело', exact: true })).toHaveText(
    'Агент',
  );
  await expect(form.getByRole('combobox', { name: 'Підтвердження', exact: true })).toHaveText(
    'РЕР',
  );
  await expect(field(form, 'ПІП')).toHaveValue('Петро Коваль');
  expect(writes.map(({ payload }) => payload.callsign)).toEqual(['СОКІЛ', 'НЕВДАЛИЙ']);
  await callsigns.fill('виправлений');
  await field(form, 'Коментар').pressSequentially(' уточнено');
  await button(form, 'Додати').click();
  await expect(form).toBeHidden();
  expect(writes.map(({ payload }) => payload.callsign)).toEqual([
    'СОКІЛ',
    'НЕВДАЛИЙ',
    'ВИПРАВЛЕНИЙ',
  ]);
  expect(writes[2].payload).toMatchObject({
    position: 'Заступник',
    full_name: 'Петро Коваль',
    comment: 'Другий уточнено',
    unit_id: 1,
    source_id: 3,
    callsign_additional_sources: [1],
  });
});

test('@regression #4108 catalog edit preserves source changes, latest fields and retry while cancel restores saved values', async ({
  page,
}) => {
  const { writes, failNextSave } = await installCatalogMocks(page);
  let form = await openEdit(page);
  await field(form, 'Позивний').fill('чернетка');
  await button(form, 'Скасувати').click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(0);
  form = await openEdit(page);
  await expect(field(form, 'Позивний')).toHaveValue('СОКІЛ');
  await selectSource(page, form, 'РО');
  await expect(form.getByRole('combobox', { name: 'Основне джерело', exact: true })).toHaveText(
    'РО',
  );
  await expect(form.getByRole('combobox', { name: 'Підтвердження', exact: true })).toHaveText(
    'Агент',
  );
  await button(form, 'Зберегти').click();
  await expect(form.getByRole('alert')).toContainText('поле "Частота" є обов’язковим');
  expect(writes).toHaveLength(0);
  await field(form, 'Позивний').fill('');
  await field(form, 'Позивний').pressSequentially(' яструб ');
  await field(form, 'Посада').fill(' Старший ');
  await field(form, 'ПІП').fill(' Іван Коваль ');
  await field(form, 'Коментар').fill(' Чернетка коментаря ');
  await field(form, 'Частота').fill(' 146.250 ');
  await form.getByRole('checkbox', { name: 'В дорозвідці', exact: true }).check();
  failNextSave('ЯСТРУБ');
  await button(form, 'Зберегти').click();
  await expect(form.getByRole('alert')).toContainText('Тестова помилка збереження');
  await expect(field(form, 'Позивний')).toHaveValue(' ЯСТРУБ ');
  await field(form, 'Коментар').fill('');
  await field(form, 'Коментар').pressSequentially(' Остаточний коментар ');
  await button(form, 'Зберегти').click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({
    operation: 'update',
    payload: {
      id: 41,
      callsign: 'ЯСТРУБ',
      position: 'Старший',
      full_name: 'Іван Коваль',
      comment: 'Остаточний коментар',
      unit_id: 1,
      active: true,
      source_id: 2,
      callsign_additional_sources: [3],
      created_at: 1700000000000,
      developing: true,
      radio_freq: '146.250',
    },
  });
});

test('@regression #4108 catalog source bootstrap preserves an already typed create draft', async ({
  page,
}) => {
  const { releaseSources, writes } = await installCatalogMocks(page, true);
  const form = await openCreate(page);
  await field(form, 'Позивний').pressSequentially('ранній');
  await field(form, 'Коментар').fill('Введено до завантаження джерел');
  releaseSources();
  await expect(form.getByRole('combobox', { name: 'Основне джерело', exact: true })).toHaveText(
    'РЕР',
  );
  await expect(field(form, 'Позивний')).toHaveValue('РАННІЙ');
  await expect(field(form, 'Коментар')).toHaveValue('Введено до завантаження джерел');
  await selectUnit(page, form);
  await button(form, 'Додати').click();
  await expect(form).toBeHidden();
  expect(writes[0].payload).toMatchObject({
    callsign: 'РАННІЙ',
    comment: 'Введено до завантаження джерел',
    source_id: 1,
    unit_id: 1,
  });
});
