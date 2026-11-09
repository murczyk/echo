import { expect, test, type Page, type Route } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const CREATE_TITLE = 'Створити позивний мережі';
const EDIT_TITLE = 'Редагувати позивний мережі';

const network = {
  id: 42,
  name: 'Callsign drawer network',
  location: '',
  freqs: [],
  unit_ids: [1],
  aor_ids: [],
  post_ids: [],
  descriptions: [],
  created_at: 0,
  radio_station: null,
  purpose: null,
  operation_mode: null,
  operation_type: null,
  operation_period: null,
  last_activity_at: null,
  last_updated_at: 0,
  last_updated_by: null,
  active_from: null,
  active_to: null,
  deleted: false,
  do_not_archive: false,
  unit_mask: [],
  status: 'NetworkActive',
};

const existingCallsign = {
  id: 7,
  network_id: 42,
  callsign: 'СОКІЛ',
  known_callsign_id: null,
  position: 'Командир',
  comment: 'Початковий коментар',
  full_name: 'Іван Петренко',
  unit_id: 1,
  unit_name: '1',
  source_id: 1,
  radio_freq: null,
  created_at: 0,
  active: true,
  developing: false,
  message_count: 0,
  last_datetime: null,
  freqs: null,
  unit_developing: false,
  main_radio_station: true,
  command_control: false,
};

async function installDrawerMocks(page: Page, { unitIds = [1], failFirstSave = false } = {}) {
  const writes: Array<{ operation: string; payload: Record<string, unknown> }> = [];
  let callsigns = [existingCallsign];
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  for (const endpoint of ['aor', 'posts', 'encryptions-list']) {
    await page.route(`**/api/sigint/${endpoint}`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/api/sigint/network-info-one', (route) =>
    route.fulfill({ json: { ...network, unit_ids: unitIds } }),
  );
  await page.route('**/api/sigint/sources', (route) =>
    route.fulfill({
      json: {
        sources: [
          { id: 1, name: 'OSINT', created_at: 0 },
          { id: 2, name: 'РЕР', created_at: 0 },
        ],
      },
    }),
  );
  await page.route('**/api/sigint/network-callsigns-list', (route) =>
    route.fulfill({ json: { callsigns: [] } }),
  );
  await page.route('**/api/sigint/network-callsigns/list', (route) =>
    route.fulfill({ json: { network_callsigns: callsigns } }),
  );
  await page.route('**/api/sigint/network-callsign/**', async (route) => {
    const operation = new URL(route.request().url()).pathname.split('/').at(-1)!;
    const payload = route.request().postDataJSON();
    writes.push({ operation, payload });
    if (failFirstSave && writes.length === 1) {
      await route.fulfill({ status: 500, json: { error: 'Тестова помилка збереження' } });
      return;
    }
    const callsign = { ...existingCallsign, ...payload, id: payload.id ?? 8 };
    callsigns =
      operation === 'create'
        ? [...callsigns, callsign]
        : callsigns.map((row) => (row.id === callsign.id ? callsign : row));
    await route.fulfill({ json: callsign });
  });
  await page.goto('/rer-networks-neo/42?tab=callsigns');
  await expect(page.getByRole('row', { name: /СОКІЛ/ }).first()).toBeVisible();
  return writes;
}

function drawer(page: Page, title = CREATE_TITLE) {
  return page.getByRole('heading', { name: title, exact: true }).locator('..').locator('..');
}

async function openCreate(page: Page) {
  await page.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeVisible();
  return drawer(page);
}

async function openEdit(page: Page) {
  await page
    .getByRole('row', { name: /СОКІЛ/ })
    .first()
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати позивний', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeVisible();
  return drawer(page, EDIT_TITLE);
}

test('@regression #4108 creates a developing callsign without source or unit and resets a cancelled draft', async ({
  page,
}) => {
  const writes = await installDrawerMocks(page, { unitIds: [] });
  let form = await openCreate(page);
  const save = () => form.getByRole('button', { name: 'Зберегти', exact: true });
  await expect(save()).toBeDisabled();
  await form.getByRole('textbox', { name: 'Позивний *', exact: true }).fill('Чернетка');
  await form.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Не зберігати');
  await form.getByRole('button', { name: 'Головна радіостанція', exact: true }).click();
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(0);

  form = await openCreate(page);
  await expect(form.getByRole('textbox', { name: 'Позивний *', exact: true })).toHaveValue('');
  await expect(form.getByRole('textbox', { name: 'Коментар', exact: true })).toHaveValue('');
  await form.getByRole('textbox', { name: 'Позивний *', exact: true }).fill('барс');
  await form.getByRole('textbox', { name: 'Посада', exact: true }).fill('  Оператор  ');
  await form.getByRole('textbox', { name: 'ПІП', exact: true }).fill('  Петро Іваненко  ');
  await form.getByRole('textbox', { name: 'Коментар', exact: true }).fill('  Новий коментар  ');
  await expect(save()).toBeEnabled();
  await save().click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      operation: 'create',
      payload: {
        network_id: 42,
        callsign: 'БАРС',
        position: 'Оператор',
        full_name: 'Петро Іваненко',
        comment: 'Новий коментар',
        source_id: null,
        radio_freq: null,
        unit_id: null,
        unit_developing: false,
        developing: true,
        main_radio_station: false,
        command_control: false,
      },
    },
  ]);
  await expect(page.getByRole('row', { name: /БАРС/ }).first()).toBeVisible();
});

test('@regression #4108 validates catalog source, unit and RO frequency before saving all fields', async ({
  page,
}) => {
  const writes = await installDrawerMocks(page, { unitIds: [] });
  const form = await openCreate(page);
  const save = form.getByRole('button', { name: 'Зберегти', exact: true });
  await form.getByRole('textbox', { name: 'Позивний *', exact: true }).fill('КАТАЛОГ');
  await form.getByRole('button', { name: 'Каталог', exact: true }).click();
  await expect(save).toBeDisabled();
  await form.getByRole('button', { name: 'РЕР', exact: true }).click();
  const frequency = form.getByRole('textbox', { name: 'Частота *', exact: true });
  await expect(save).toBeDisabled();
  await frequency.fill('invalid');
  await frequency.blur();
  await expect(frequency).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await frequency.fill('145.5000');
  await expect(save).toBeDisabled();
  await form.getByRole('combobox', { name: /Підрозділ/ }).click();
  await form.getByRole('combobox', { name: /Підрозділ/ }).fill('1');
  await page.getByRole('option', { name: '1', exact: true }).click();
  await expect(save).toBeEnabled();
  await form.getByRole('button', { name: 'РЕР', exact: true }).click();
  await expect(form.getByTestId('network-callsign-source-error')).toBeVisible();
  await expect(save).toBeDisabled();
  await form.getByRole('button', { name: 'РЕР', exact: true }).click();
  await form.getByRole('checkbox', { name: 'В дорозвідці', exact: true }).check();
  await form.getByRole('button', { name: 'Ланка управління', exact: true }).click();
  await form.getByRole('button', { name: 'Без маркера', exact: true }).click();
  await form.getByRole('button', { name: 'Головна радіостанція', exact: true }).click();
  await save.click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      operation: 'create',
      payload: {
        network_id: 42,
        callsign: 'КАТАЛОГ',
        position: null,
        full_name: null,
        comment: null,
        source_id: 2,
        radio_freq: '145.5000',
        unit_id: 1,
        unit_developing: true,
        developing: false,
        main_radio_station: true,
        command_control: false,
      },
    },
  ]);
});

test('@regression #4108 edits the selected callsign and discards unsaved edits on reopen', async ({
  page,
}) => {
  const writes = await installDrawerMocks(page);
  let form = await openEdit(page);
  await expect(form.getByRole('textbox', { name: 'Позивний *', exact: true })).toHaveValue('СОКІЛ');
  await expect(form.getByRole('textbox', { name: 'Посада', exact: true })).toHaveValue('Командир');
  await expect(form.getByRole('textbox', { name: 'ПІП', exact: true })).toHaveValue(
    'Іван Петренко',
  );
  await form.getByRole('textbox', { name: 'Посада', exact: true }).fill('Не зберігати');
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(0);
  form = await openEdit(page);
  await expect(form.getByRole('textbox', { name: 'Посада', exact: true })).toHaveValue('Командир');
  await form.getByRole('textbox', { name: 'Позивний *', exact: true }).fill('сокіл-2');
  await form.getByRole('textbox', { name: 'Посада', exact: true }).fill('Оператор');
  await form.getByRole('textbox', { name: 'ПІП', exact: true }).fill('Петро Іваненко');
  await form.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Змінено');
  await form.getByRole('button', { name: 'В дорозвідці', exact: true }).click();
  await form.getByRole('button', { name: 'OSINT', exact: true }).click();
  await form.getByRole('combobox', { name: /Підрозділ/ }).click();
  await page.getByRole('option', { name: 'Не вказано', exact: true }).click();
  await form.getByRole('button', { name: 'Ланка управління', exact: true }).click();
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      operation: 'update',
      payload: {
        id: 7,
        network_id: 42,
        callsign: 'СОКІЛ-2',
        position: 'Оператор',
        full_name: 'Петро Іваненко',
        comment: 'Змінено',
        source_id: null,
        radio_freq: null,
        unit_id: null,
        unit_developing: false,
        developing: true,
        main_radio_station: false,
        command_control: true,
      },
    },
  ]);
  await expect(page.getByRole('row', { name: /СОКІЛ-2/ }).first()).toBeVisible();
});

test('@regression #4108 retains a failed draft and retries with the latest input', async ({
  page,
}) => {
  const writes = await installDrawerMocks(page, { failFirstSave: true });
  const form = await openCreate(page);
  await expect(form.getByRole('combobox', { name: /Підрозділ/ })).toHaveValue('1');
  await form.getByRole('textbox', { name: 'Позивний *', exact: true }).fill('БАРС');
  await form.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Перша спроба');
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(form.getByRole('alert')).toContainText('Тестова помилка збереження');
  await expect(form.getByRole('textbox', { name: 'Позивний *', exact: true })).toHaveValue('БАРС');
  await expect(form.getByRole('textbox', { name: 'Коментар', exact: true })).toHaveValue(
    'Перша спроба',
  );
  await form.getByRole('textbox', { name: 'Коментар', exact: true }).fill('Друга спроба');
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes[0].payload).toMatchObject({
    callsign: 'БАРС',
    comment: 'Перша спроба',
    unit_id: 1,
  });
  expect(writes[1].payload).toMatchObject({
    callsign: 'БАРС',
    comment: 'Друга спроба',
    unit_id: 1,
  });
});

test('@regression #4108 prevents editing or dismissing a drawer while saving', async ({ page }) => {
  await installDrawerMocks(page);
  const pending: Route[] = [];
  await page.route('**/api/sigint/network-callsign/create', (route) => {
    pending.push(route);
  });
  const form = await openCreate(page);
  const callsign = form.getByRole('textbox', { name: 'Позивний *', exact: true });
  await callsign.fill('БАРС');
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => pending.length).toBe(1);
  await expect(callsign).toBeDisabled();
  await expect(form.getByRole('button', { name: 'Скасувати', exact: true })).toBeDisabled();
  await expect(form.getByRole('button', { name: /Збереження/ })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeVisible();
  expect(pending).toHaveLength(1);
  await pending[0].fulfill({ json: { ...existingCallsign, id: 8, callsign: 'БАРС' } });
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
});
