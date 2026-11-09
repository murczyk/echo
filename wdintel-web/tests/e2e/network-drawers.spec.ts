import { expect, test } from '@playwright/test';
import {
  installNetworkDrawerMocks,
  networkDrawer,
  openNetworkAdd,
  openNetworkEdit,
} from './network-drawers.fixtures';
import { emptyNetworksListResponse } from './fixture-responses';

test('@regression #4108 network edit validates required fields, resets cancellation and retries latest fields', async ({
  page,
}) => {
  const { writes, failNextSave } = await installNetworkDrawerMocks(page, 'callsigns');
  let form = await openNetworkEdit(page);
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Чернетка');
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(0);
  form = await openNetworkEdit(page);
  const name = form.getByRole('textbox', { name: 'Назва', exact: true });
  const location = form.getByRole('textbox', {
    name: 'Район функціонування/розгортання',
    exact: true,
  });
  const save = form.getByRole('button', { name: 'Зберегти', exact: true });
  await expect(name).toHaveValue('Мережа для регресії');
  await name.fill(' ');
  await name.blur();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await name.fill('Оновлена мережа');
  await location.fill('');
  await location.blur();
  await expect(location).toHaveAttribute('aria-invalid', 'true');
  await expect(save).toBeDisabled();
  await location.fill('Новий район');
  await form.getByRole('button', { name: 'Оперативні параметри', exact: true }).click();
  for (const [label, value] of [
    ['Призначення', 'Управління'],
    ['Режим роботи радіомережі', 'Цілодобово'],
    ['Характер роботи', 'Постійний'],
    ['Період функціонування', 'Листопад'],
    ['Радіостанція', 'Motorola'],
  ]) {
    await form.getByRole('textbox', { name: label, exact: true }).fill(value);
  }
  await form.getByRole('checkbox', { name: 'Не архівувати автоматично', exact: true }).check();
  failNextSave();
  await save.click();
  await expect(form.getByRole('alert')).toContainText('Тестова помилка збереження');
  await expect(name).toHaveValue('Оновлена мережа');
  await expect(location).toHaveValue('Новий район');
  await form
    .getByRole('textbox', { name: 'Призначення', exact: true })
    .fill('Уточнене призначення');
  await save.click();
  await expect(form).toBeHidden();
  expect(writes.map((write) => write.operation)).toEqual([
    'update-network',
    'update-network',
    'network/update-posts',
    'network/update-units',
  ]);
  expect(writes[1].payload).toMatchObject({
    id: 42,
    name: 'Оновлена мережа',
    location: 'Новий район',
    area_of_responsibility_ids: [1],
    purpose: 'Уточнене призначення',
    operation_mode: 'Цілодобово',
    operation_type: 'Постійний',
    operation_period: 'Листопад',
    radio_station: 'Motorola',
    do_not_archive: true,
    status: 'NetworkActive',
  });
  expect(writes[2].payload).toEqual({ network_id: 42, post_ids: [] });
  expect(writes[3].payload).toEqual({ network_id: 42, unit_ids: [1] });
});

for (const [tab, descrType] of [
  ['justifications', 'Confirmation'],
  ['reconnaissance-signs', 'Sign'],
]) {
  test(`@regression #4108 creates ${descrType} description with latest text, frequency and failed-save retry`, async ({
    page,
  }) => {
    const { writes, failNextSave } = await installNetworkDrawerMocks(page, tab);
    let form = await openNetworkAdd(page, 'description');
    const topic = () => form.getByRole('textbox', { name: 'Тема нотатки', exact: true });
    const description = () =>
      form.getByRole('textbox', { name: 'Матеріали радіоперехоплення *', exact: true });
    await expect(form.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
    await topic().fill('Скасована тема');
    await description().fill('Скасовані матеріали');
    await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
    await expect(form).toBeHidden();
    expect(writes).toHaveLength(0);
    form = await openNetworkAdd(page, 'description');
    await expect(topic()).toHaveValue('');
    await expect(description()).toHaveValue('');
    await description().fill(' ');
    await expect(form.getByRole('button', { name: 'Створити', exact: true })).toBeDisabled();
    await topic().fill('  Нова тема  ');
    await description().fill('  Перші матеріали  ');
    await form.getByRole('combobox', { name: /Частота/ }).click();
    await page.getByRole('option', { name: '145.5000', exact: true }).click();
    failNextSave();
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form.getByRole('alert')).toContainText('Тестова помилка збереження');
    await expect(topic()).toHaveValue('  Нова тема  ');
    await expect(description()).toHaveValue('  Перші матеріали  ');
    await description().fill('  Уточнені матеріали  ');
    await form.getByRole('button', { name: 'Створити', exact: true }).click();
    await expect(form).toBeHidden();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual({
      operation: 'network/add-descriptions',
      payload: {
        network_id: 42,
        network_descriptions: [],
        frequency_descriptions: [
          {
            descr_type: descrType,
            topic: 'Нова тема',
            description: 'Уточнені матеріали',
            freq: '145.5000',
          },
        ],
      },
    });
  });
}

test('@regression #4108 edits an existing description and discards cancelled values', async ({
  page,
}) => {
  const { writes } = await installNetworkDrawerMocks(page, 'descriptions');
  const open = async () => {
    await page.getByRole('button', { name: /Початкова тема/ }).click();
    await page.getByRole('button', { name: 'Редагувати обґрунтування', exact: true }).click();
    return networkDrawer(page, 'description');
  };
  let form = await open();
  await expect(form.getByRole('textbox', { name: 'Тема нотатки', exact: true })).toHaveValue(
    'Початкова тема',
  );
  await form.getByRole('textbox', { name: 'Тема нотатки', exact: true }).fill('Чернетка');
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(form).toBeHidden();
  await page.getByRole('button', { name: 'Редагувати обґрунтування', exact: true }).click();
  form = networkDrawer(page, 'description');
  await expect(form.getByRole('textbox', { name: 'Тема нотатки', exact: true })).toHaveValue(
    'Початкова тема',
  );
  await form.getByRole('textbox', { name: 'Тема нотатки', exact: true }).fill('  Змінена тема  ');
  await form
    .getByRole('textbox', { name: 'Матеріали радіоперехоплення *', exact: true })
    .fill('  Змінені матеріали  ');
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(form).toBeHidden();
  expect(writes).toEqual([
    {
      operation: 'network/update-description',
      payload: {
        network_id: 42,
        description_id: 7,
        descr_type: 'Confirmation',
        topic: 'Змінена тема',
        description: 'Змінені матеріали',
        network_freq_id: null,
      },
    },
  ]);
});

test('@regression #4108 frequency create validates, resets cancellation and saves dates, encryption and keys after retry', async ({
  page,
}) => {
  const { writes, failNextSave } = await installNetworkDrawerMocks(page, 'frequencies');
  await page.route('**/api/sigint/encryptions-list', (route) =>
    route.fulfill({
      json: [
        { id: 1, name: 'Без шифрування' },
        { id: 2, name: 'AES-256' },
      ],
    }),
  );
  await page.route('**/api/sigint/keys', (route) =>
    route.fulfill({
      json: {
        keys: [
          {
            id: 3,
            key: 'ABCDEF',
            description: 'Ключ мережі',
            encryption_id: 2,
            sigint_network_id: 42,
            sigint_network_freq_ids: [],
          },
        ],
      },
    }),
  );
  await page.reload();
  let form = await openNetworkAdd(page, 'freq-create');
  const frequency = () => form.getByRole('textbox', { name: 'Частота *', exact: true });
  const save = () => form.getByRole('button', { name: 'Зберегти', exact: true });
  await expect(save()).toBeDisabled();
  await frequency().fill('149.0000');
  await form.getByRole('button', { name: 'DMR', exact: true }).click();
  await form.getByRole('button', { name: 'AES-256', exact: true }).click();
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(0);
  form = await openNetworkAdd(page, 'freq-create');
  await expect(frequency()).toHaveValue('');
  await expect(form.getByRole('textbox', { name: /Активна з/ })).toHaveValue('');
  await frequency().fill('invalid');
  await frequency().blur();
  await expect(frequency()).toHaveAttribute('aria-invalid', 'true');
  await expect(save()).toBeDisabled();
  await frequency().fill('145.6000');
  const activeFrom = form.getByRole('textbox', { name: /Активна з/ });
  await activeFrom.fill('01.11.2026');
  await activeFrom.locator('..').getByRole('button', { name: 'Відкрити календар' }).click();
  await page.getByRole('button', { name: 'ОК', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ОК', exact: true })).toHaveCount(0);
  await form.getByRole('button', { name: 'Неактивна', exact: true }).click();
  const activeTo = form.getByRole('textbox', { name: /Активна по/ });
  await activeTo.fill('05.11.2026');
  await activeTo.locator('..').getByRole('button', { name: 'Відкрити календар' }).click();
  await page.getByRole('button', { name: 'ОК', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ОК', exact: true })).toHaveCount(0);
  await expect(save()).toBeDisabled();
  await form.getByRole('button', { name: 'AES-256', exact: true }).click();
  await form.getByPlaceholder('Пошук і вибір ключів').click();
  await page.getByRole('option', { name: 'Ключ мережі • ABCDEF', exact: true }).click();
  await page.keyboard.press('Escape');
  failNextSave();
  await save().click();
  await expect(form.getByRole('alert')).toContainText('Тестова помилка збереження');
  await expect(frequency()).toHaveValue('145.6000');
  await expect(activeFrom).toHaveValue('01.11.2026');
  await expect(activeTo).toHaveValue('05.11.2026');
  await expect(form.getByText('Ключ мережі • ABCDEF', { exact: true })).toBeVisible();
  await frequency().fill('145.7000');
  await save().click();
  await expect(form).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes[1]).toEqual({
    operation: 'network/v2/add-freq',
    payload: {
      network_id: 42,
      freq_rec: {
        freq: '145.7000',
        modulation: 'DMR',
        encryption_id: 2,
        encryption_key_ids: [3],
        description: null,
        active_from: Date.UTC(2026, 10, 1),
        active_to: Date.UTC(2026, 10, 5),
      },
    },
  });
});

test('@regression #4108 shared network create saves the latest drawer values from the list page', async ({
  page,
}) => {
  await installNetworkDrawerMocks(page, 'callsigns');
  await page.route('**/api/sigint/aor', (route) =>
    route.fulfill({ json: [{ id: 1, name: 'Тестова смуга' }] }),
  );
  await page.route('**/api/sigint/network-list', (route) =>
    route.fulfill({ json: emptyNetworksListResponse() }),
  );
  const requests: Array<Record<string, any>> = [];
  await page.route('**/api/sigint/create-network', (route) => {
    requests.push(route.request().postDataJSON());
    return route.fulfill({ json: { id: 42 } });
  });
  await page.goto('/rer-networks-neo');
  await page.getByRole('button', { name: 'Створити мережу', exact: true }).click();
  const form = networkDrawer(page, 'edit');
  const create = form.getByRole('button', { name: 'Створити', exact: true });
  await expect(create).toBeDisabled();
  await form.getByRole('combobox', { name: /Смуги/ }).click();
  await page.getByRole('option', { name: 'Тестова смуга', exact: true }).click();
  await page.keyboard.press('Escape');
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('  Нова мережа  ');
  await form
    .getByRole('textbox', { name: 'Район функціонування/розгортання', exact: true })
    .fill('  Новий район  ');
  await form.getByRole('textbox', { name: 'Частота', exact: true }).fill('145.8000');
  const activeFrom = form.getByRole('textbox', { name: /Активна з/ });
  await activeFrom.fill('01.11.2026');
  await activeFrom.locator('..').getByRole('button', { name: 'Відкрити календар' }).click();
  await page.getByRole('button', { name: 'ОК', exact: true }).click();
  await expect(page.getByRole('button', { name: 'ОК', exact: true })).toHaveCount(0);
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page).toHaveURL(/\/rer-networks-neo\/42/);
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    name: 'Нова мережа',
    location: 'Новий район',
    area_of_responsibility_ids: [1],
    freqs: [{ freq: '145.8000', modulation: 'DMR', active_from: Date.UTC(2026, 10, 1) }],
  });
});
