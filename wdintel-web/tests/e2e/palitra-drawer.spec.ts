import { expect, test, type Locator, type Page, type Route } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const CREATE_TITLE = 'Додати палітру';
const EDIT_TITLE = 'Редагувати палітру';
const existingPalitra = {
  id: 1,
  name: 'Палітра-1',
  folder: null,
  is_archived: false,
  color_hex: '#00bcd4',
  author: 'analysis-tester',
  source_file_name: null,
  last_uploaded_at_ts: null,
  conversion_status: 'Done',
  source_format: null,
  conversion_error: null,
  missing_in_goi: false,
  imported_from_goi: false,
  goi_owned: false,
  goi_source_refresh_retry_available: false,
  latest_changelog_warning: false,
  changelog: [],
  geometry: null,
  access_aor_id: [],
  access_organism_ids: [],
  access_logins: [{ login: 'analysis-tester' }],
};

async function installPaletteMocks(page: Page, { failFirstSave = false } = {}) {
  const writes: Array<Record<string, unknown>> = [];
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Admin'] });
  await page.route('**/api/palitra/list', (route) =>
    route.fulfill({
      json: Array.from({ length: 200 }, (_, index) => ({
        ...existingPalitra,
        id: index + 1,
        name: `Палітра-${index + 1}`,
      })),
    }),
  );
  for (const endpoint of ['/api/sigint/aor', '/api/organisms']) {
    await page.route(`**${endpoint}`, (route) => route.fulfill({ json: [] }));
  }
  await page.route('**/api/logins', (route) => route.fulfill({ json: { logins: [] } }));
  await page.route('**/api/organism/my-scope', (route) =>
    route.fulfill({ json: { organism: null, aor_ids: [], aors: [] } }),
  );
  await page.route('**/api/palitra/analyze-kmz', (route) =>
    route.fulfill({ json: { top_colors: [], filename: 'test.kmz' } }),
  );
  await page.route('**/api/palitra/v2/read/1', (route) =>
    route.fulfill({ json: { palitra: existingPalitra, geometries: [] } }),
  );
  for (const endpoint of [
    '/api/palitra/v2/create-palitra-basic',
    '/api/palitra/create-with-kmz',
    '/api/palitra/update/1',
  ]) {
    await page.route(`**${endpoint}`, async (route) => {
      const request = route.request();
      const multipart = request.headers()['content-type']?.startsWith('multipart/form-data');
      const form = multipart
        ? await new Response(request.postDataBuffer(), {
            headers: { 'content-type': request.headers()['content-type'] },
          }).formData()
        : null;
      const payload = form
        ? {
            name: form.get('name'),
            color_hex: form.get('color_hex'),
            access_type: form.get('access_type'),
            access_values: form.get('access_values'),
            filename: (form.get('kmz') as File).name,
            file_content: await (form.get('kmz') as File).text(),
          }
        : request.postDataJSON();
      writes.push(payload);
      if (failFirstSave && writes.length === 1) {
        await route.fulfill({ status: 500, body: 'Тестова помилка збереження' });
        return;
      }
      const palitra = { ...existingPalitra, ...payload, id: multipart ? 201 : 1 };
      await route.fulfill({ json: multipart ? palitra : { palitra, points: [] } });
    });
  }
  await page.goto('/rer-palitra-neo');
  await expect(page.getByRole('row', { name: /Палітра-1/ }).first()).toBeVisible();
  return writes;
}

function drawer(page: Page, title: string) {
  return page.getByRole('heading', { name: title, exact: true }).locator('..').locator('..');
}

async function importKmz(page: Page, filename = 'test.kmz') {
  await page
    .locator('input[type=file]')
    .nth(1)
    .setInputFiles({
      name: filename,
      mimeType: 'application/vnd.google-earth.kmz',
      buffer: Buffer.from('palette regression fixture'),
    });
  await expect(
    drawer(page, CREATE_TITLE).getByRole('textbox', { name: 'Назва', exact: true }),
  ).toHaveValue(filename);
}

async function openCreate(page: Page) {
  await page.getByRole('button', { name: CREATE_TITLE, exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeVisible();
  await importKmz(page);
  return drawer(page, CREATE_TITLE);
}

async function openEdit(page: Page) {
  await page
    .getByRole('row', { name: /Палітра-1/ })
    .first()
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeVisible();
  return drawer(page, EDIT_TITLE);
}

async function addLogin(form: Locator, login: string) {
  const input = form.getByRole('combobox', { name: 'Логіни', exact: true });
  await input.fill(login);
  await input.press('Enter');
}

test('@regression #4108 imports a KMZ and discards a cancelled palette creation draft', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  let form = await openCreate(page);
  await expect(form.getByRole('button', { name: 'Додати', exact: true })).toBeDisabled();
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Не зберігати');
  await addLogin(form, 'discarded-login');
  await form.getByRole('tab', { name: 'Розширений', exact: true }).click();
  await form.getByLabel('Колір', { exact: true }).fill('#112233');
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(0);

  await page.getByRole('button', { name: CREATE_TITLE, exact: true }).click();
  form = drawer(page, CREATE_TITLE);
  await expect(form.getByRole('button', { name: 'Обрати файл', exact: true })).toBeVisible();
  await expect(form.getByRole('button', { name: 'Далі', exact: true })).toBeDisabled();
  await importKmz(page);
  await expect(form.getByRole('tab', { name: 'Базовий', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(form.getByText('discarded-login', { exact: true })).toHaveCount(0);
  await addLogin(form, 'analysis-tester');
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Нова палітра');
  await form.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      name: 'Нова палітра',
      color_hex: '#00bcd4',
      access_type: 'logins',
      access_values: 'analysis-tester',
      filename: 'test.kmz',
      file_content: 'palette regression fixture',
    },
  ]);
});

test('@regression #4108 saves the latest palette creation name, custom color and access in multipart data', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  const form = await openCreate(page);
  await form.getByRole('tab', { name: 'Розширений', exact: true }).click();
  await form.getByLabel('Колір', { exact: true }).fill('#123456');
  await addLogin(form, 'palette-reader');
  const name = form.getByRole('textbox', { name: 'Назва', exact: true });
  await name.fill('');
  await expect(form.getByRole('button', { name: 'Додати', exact: true })).toBeDisabled();
  await name.pressSequentially('Оновлена палітра');
  await form.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      name: 'Оновлена палітра',
      color_hex: '#123456',
      access_type: 'logins',
      access_values: 'palette-reader',
      filename: 'test.kmz',
      file_content: 'palette regression fixture',
    },
  ]);
});

test('@regression #4108 preserves palette access when replacing the KMZ after editing its draft', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  const form = await openCreate(page);
  await addLogin(form, 'palette-reader');
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Чернетка');
  await form.getByRole('button', { name: 'Назад', exact: true }).click();
  await page.route('**/api/palitra/analyze-kmz', (route) =>
    route.fulfill({ json: { top_colors: [], filename: 'replacement.kmz' } }),
  );
  await importKmz(page, 'replacement.kmz');
  await expect(form.getByText('palette-reader', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      name: 'replacement.kmz',
      color_hex: '#00bcd4',
      access_type: 'logins',
      access_values: 'palette-reader',
      filename: 'replacement.kmz',
      file_content: 'palette regression fixture',
    },
  ]);
});

test('@regression #4108 saves selected KMZ colors with the latest palette suffixes', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  await page.route('**/api/palitra/analyze-kmz', (route) =>
    route.fulfill({
      json: {
        filename: 'test.kmz',
        top_colors: [
          { color_hex: '#112233', count: 10, suggested_suffix: 'Перший' },
          { color_hex: '#445566', count: 5, suggested_suffix: 'Другий' },
          { color_hex: '#778899', count: 2, suggested_suffix: 'Третій' },
        ],
      },
    }),
  );
  const form = await openCreate(page);
  await form.getByRole('tab', { name: 'Розширений', exact: true }).click();
  const suffixes = form.getByRole('textbox', { name: 'Суфікс', exact: true });
  await expect(suffixes.nth(0)).toHaveValue('Перший');
  await expect(suffixes.nth(1)).toHaveValue('Другий');
  await expect(suffixes.nth(2)).toHaveValue('Третій');
  await form.getByRole('button', { name: 'Зняти всі', exact: true }).click();
  await addLogin(form, 'palette-reader');
  await expect(form.getByRole('button', { name: 'Додати', exact: true })).toBeDisabled();
  await form.getByRole('button', { name: 'Обрати всі', exact: true }).click();
  await form.getByRole('checkbox', { name: /#445566/ }).uncheck();
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Базова назва');
  await suffixes.nth(0).fill('');
  await suffixes.nth(0).pressSequentially('Останній суфікс');
  await suffixes.nth(2).fill('');
  await form.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(2);
  expect(writes).toEqual(
    expect.arrayContaining([
      {
        name: 'Базова назва Останній суфікс',
        color_hex: '#112233',
        access_type: 'logins',
        access_values: 'palette-reader',
        filename: 'test.kmz',
        file_content: 'palette regression fixture',
      },
      {
        name: 'Базова назва',
        color_hex: '#778899',
        access_type: 'logins',
        access_values: 'palette-reader',
        filename: 'test.kmz',
        file_content: 'palette regression fixture',
      },
    ]),
  );
});

test('@regression #4108 keeps imported palette fields when access references arrive after KMZ analysis', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  let pendingScope: Route | null = null;
  await page.route('**/api/organism/my-scope', (route) => {
    pendingScope = route;
  });
  await page.route('**/api/organisms', (route) =>
    route.fulfill({ json: [{ id: 42, name: 'Підрозділ палітри' }] }),
  );
  await page.route('**/api/palitra/analyze-kmz', (route) =>
    route.fulfill({
      json: { filename: 'test.kmz', top_colors: [{ color_hex: '#112233', count: 10 }] },
    }),
  );
  await page.reload();
  await expect(page.getByRole('button', { name: CREATE_TITLE, exact: true })).toBeEnabled();
  const form = await openCreate(page);
  await expect(form.getByRole('textbox', { name: 'Назва', exact: true })).toBeDisabled();
  await expect.poll(() => Boolean(pendingScope)).toBe(true);
  await pendingScope!.fulfill({
    json: { organism: { id: 42, name: 'Підрозділ палітри' }, aor_ids: [], aors: [] },
  });
  await expect(form.getByRole('textbox', { name: 'Назва', exact: true })).toBeEnabled();
  await expect(form.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue('test.kmz');
  await expect(form.getByRole('radio', { name: 'Підрозділи', exact: true })).toBeChecked();
  await expect(form.getByText('Підрозділ палітри', { exact: true })).toBeVisible();
  await form.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(page.getByRole('heading', { name: CREATE_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      name: 'test.kmz',
      color_hex: '#112233',
      access_type: 'organisms',
      access_values: '42',
      filename: 'test.kmz',
      file_content: 'palette regression fixture',
    },
  ]);
});

test('@regression #4108 restores a cancelled palette edit and saves the latest name, color and access', async ({
  page,
}) => {
  const writes = await installPaletteMocks(page);
  let form = await openEdit(page);
  await expect(form.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue('Палітра-1');
  await expect(form.getByLabel('Колір', { exact: true })).toHaveValue('#00bcd4');
  await expect(form.getByText('analysis-tester', { exact: true })).toBeVisible();
  await form.getByRole('textbox', { name: 'Назва', exact: true }).fill('Не зберігати');
  await form.getByLabel('Колір', { exact: true }).fill('#112233');
  await addLogin(form, 'discarded-login');
  await form.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeHidden();
  expect(writes).toHaveLength(0);

  form = await openEdit(page);
  await expect(form.getByRole('textbox', { name: 'Назва', exact: true })).toHaveValue('Палітра-1');
  await expect(form.getByLabel('Колір', { exact: true })).toHaveValue('#00bcd4');
  await expect(form.getByText('discarded-login', { exact: true })).toHaveCount(0);
  await form.getByLabel('Колір', { exact: true }).fill('#654321');
  await addLogin(form, 'palette-reader');
  const name = form.getByRole('textbox', { name: 'Назва', exact: true });
  await name.fill('');
  await expect(form.getByRole('button', { name: 'Зберегти', exact: true })).toBeDisabled();
  await name.pressSequentially('Змінена палітра');
  await form.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(page.getByRole('heading', { name: EDIT_TITLE, exact: true })).toBeHidden();
  expect(writes).toEqual([
    {
      name: 'Змінена палітра',
      color_hex: '#654321',
      access: { ByLogins: { logins: ['analysis-tester', 'palette-reader'] } },
      source_file_name: null,
      last_uploaded_at_ts: null,
    },
  ]);
});

for (const mode of ['create', 'edit'] as const) {
  test(`@regression #4108 retains a failed palette ${mode} draft and retries the latest input`, async ({
    page,
  }) => {
    const writes = await installPaletteMocks(page, { failFirstSave: true });
    const form = await (mode === 'create' ? openCreate(page) : openEdit(page));
    if (mode === 'create') await addLogin(form, 'analysis-tester');
    const name = form.getByRole('textbox', { name: 'Назва', exact: true });
    await name.fill('Перша спроба');
    const save = form.getByRole('button', {
      name: mode === 'create' ? 'Додати' : 'Зберегти',
      exact: true,
    });
    await save.click();
    await expect(page.getByText(/Тестова помилка збереження/)).toBeVisible();
    await expect(name).toHaveValue('Перша спроба');
    await expect(save).toBeEnabled();
    await name.fill('Повторна спроба');
    await save.click();
    await expect(
      page.getByRole('heading', {
        name: mode === 'create' ? CREATE_TITLE : EDIT_TITLE,
        exact: true,
      }),
    ).toBeHidden();
    expect(writes).toHaveLength(2);
    expect(writes[0]).toMatchObject({ name: 'Перша спроба', color_hex: '#00bcd4' });
    expect(writes[1]).toMatchObject({ name: 'Повторна спроба', color_hex: '#00bcd4' });
  });
}
