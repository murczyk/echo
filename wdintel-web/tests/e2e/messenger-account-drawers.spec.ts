import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const aors = [
  { id: 1, name: 'Північ' },
  { id: 2, name: 'Південь' },
];

function account(messenger = 'signal') {
  return {
    id: 41,
    displayName: 'Наявний акаунт',
    messenger,
    phoneNumber: '+380111111111',
    canSendMessages: false,
    canReadMessages: true,
    status: messenger === 'echo_operator' ? 'paused' : 'active',
    isLinked: true,
    isImported: false,
    createdAt: 0,
    areaOfResponsibility: aors[0],
    description: 'Наявний опис',
    systemServiceName: 'existing-account',
    apiLogin: messenger === 'echo_operator' ? 'operator-login' : null,
    apiEndpoint: messenger === 'echo_operator' ? 'https://operator.example/api' : null,
  };
}

async function openAccounts(page: Page, messenger = 'signal') {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  await page.route('**/api/messenger/list', (route) =>
    route.fulfill({ json: { accounts: [account(messenger)] } }),
  );
  await page.route('**/api/sigint/aor', (route) => route.fulfill({ json: aors }));
  await page.route('**/api/messenger/accounts-stats-timeline', (route) =>
    route.fulfill({ json: { data: [] } }),
  );
  await page.route('**/api/messenger/system-service-name-availability', (route) =>
    route.fulfill({
      json: {
        system_service_name: route.request().postDataJSON().system_service_name,
        exists: false,
      },
    }),
  );
  await page.goto('/admin/messenger-neo?tab=accounts');
  await expect(page.getByRole('row', { name: /Наявний акаунт/ })).toBeVisible();
}

async function chooseAor(page: Page, name = 'Південь') {
  await page.getByRole('combobox', { name: 'Смуга відповідальності' }).click();
  await page.getByRole('option', { name, exact: true }).click();
}

async function openEdit(page: Page, name = 'Наявний акаунт') {
  await page
    .getByRole('row', { name: new RegExp(name) })
    .getByRole('button', { name: 'Дії', exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Редагувати', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Назва акаунту', exact: true })).toBeVisible();
}

test('@regression #4108 Signal link submits latest fields, retries, refreshes QR and completes linking', async ({
  page,
}) => {
  await openAccounts(page);
  const links: unknown[] = [];
  const qrRequests: unknown[] = [];
  const polls: unknown[] = [];
  let linked = false;
  await page.route('**/api/messenger/link', async (route) => {
    links.push(route.request().postDataJSON());
    if (links.length === 1) {
      await route.fulfill({ status: 500, json: { error: 'Тимчасова помилка прив’язки' } });
      return;
    }
    await route.fulfill({
      json: { account: { ...account(), id: 42, displayName: 'Остання назва', isLinked: false } },
    });
  });
  await page.route('**/api/messenger/qr', async (route) => {
    qrRequests.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        qr_code_base64: `data:image/png;base64,${qrRequests.length === 1 ? 'AAAA' : 'BBBB'}`,
      },
    });
  });
  await page.route('**/api/messenger/is-linked', async (route) => {
    polls.push(route.request().postDataJSON());
    await route.fulfill({ json: { is_linked: linked } });
  });
  await page.getByRole('button', { name: "Прив'язати новий", exact: true }).click();
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(
    page.getByText('Назва акаунту має бути мінімум 2 символи', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Потрібно вибрати смугу відповідальності', { exact: true }),
  ).toBeVisible();
  expect(links).toEqual([]);
  const name = page.getByRole('textbox', { name: 'Назва акаунту', exact: true });
  await name.fill('Проміжна назва');
  await name.fill('Остання назва');
  await expect(page.getByRole('textbox', { name: 'Назва systemd unit', exact: true })).toHaveValue(
    'ostannya-nazva',
  );
  await page.getByRole('combobox', { name: 'Режим Signal CLI' }).click();
  await page.getByRole('option', { name: 'Native', exact: true }).click();
  await page.getByRole('textbox', { name: 'Номер телефону', exact: true }).fill('+380999999999');
  await page
    .getByRole('textbox', { name: "Опис (необов'язково)", exact: true })
    .fill('  Останній опис  ');
  await chooseAor(page);
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(page.getByText(/Помилка прив'язування акаунту: Тимчасова помилка/)).toBeVisible();
  await expect(name).toHaveValue('Остання назва');
  await expect(page.getByRole('button', { name: "Прив'язати", exact: true })).toBeEnabled();
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(page.getByRole('img', { name: 'QR code', exact: true })).toHaveAttribute(
    'src',
    'data:image/png;base64,AAAA',
  );
  expect(links).toEqual(
    Array(2).fill({
      phone: '+380999999999',
      messenger: 'signal',
      display_name: 'Остання назва',
      system_service_name: 'ostannya-nazva',
      signal_cli_mode: 'Native',
      description: 'Останній опис',
      aor_id: 2,
    }),
  );
  await page.getByRole('button', { name: 'Оновити QR код', exact: true }).click();
  await expect(page.getByRole('img', { name: 'QR code', exact: true })).toHaveAttribute(
    'src',
    'data:image/png;base64,BBBB',
  );
  linked = true;
  await expect(page.getByText("Акаунт успішно прив'язано", { exact: true })).toBeVisible({
    timeout: 6000,
  });
  expect(qrRequests).toEqual([{ account_id: 42 }, { account_id: 42 }]);
  expect(polls).toContainEqual({ account_id: 42 });
  await page.getByRole('button', { name: 'Закрити', exact: true }).click();
  await expect(name).toHaveCount(0);
  await expect(page.getByRole('row', { name: /Остання назва/ })).toBeVisible();
});

test('@regression #4108 link cancellation resets drafts and WhatsApp preserves an edited service name through conflict retry', async ({
  page,
}) => {
  await openAccounts(page);
  const links: unknown[] = [];
  let conflict = true;
  await page.route('**/api/messenger/system-service-name-availability', (route) =>
    route.fulfill({
      json: {
        system_service_name: route.request().postDataJSON().system_service_name,
        exists: conflict,
      },
    }),
  );
  await page.route('**/api/messenger/link', async (route) => {
    links.push(route.request().postDataJSON());
    await route.fulfill({ json: { account: { ...account('whatsapp'), id: 42, isLinked: false } } });
  });
  await page.route('**/api/messenger/qr', (route) =>
    route.fulfill({ json: { qr_code_base64: 'data:image/png;base64,AAAA' } }),
  );
  await page.route('**/api/messenger/is-linked', (route) =>
    route.fulfill({ json: { is_linked: false } }),
  );
  const name = page.getByRole('textbox', { name: 'Назва акаунту', exact: true });
  const unit = page.getByRole('textbox', { name: 'Назва systemd unit', exact: true });
  await page.getByRole('button', { name: "Прив'язати новий", exact: true }).click();
  await name.fill('Скасована назва');
  await unit.fill('discarded-unit');
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await page.getByRole('button', { name: "Прив'язати новий", exact: true }).click();
  await expect(name).toHaveValue('');
  await expect(unit).toHaveValue('');
  await expect(page.getByRole('textbox', { name: 'Номер телефону', exact: true })).toHaveValue('');
  await page.getByRole('combobox', { name: 'Тип месенджера' }).click();
  await expect(page.getByRole('option')).toHaveText(['Signal', 'WhatsApp']);
  await page.getByRole('option', { name: 'WhatsApp', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Режим Signal CLI' })).toHaveCount(0);
  await expect(page.getByText('echo-whatsapp-bot@', { exact: true })).toBeVisible();
  await name.fill('WhatsApp draft');
  await unit.fill('Custom Unit');
  await chooseAor(page);
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(
    page.getByText('Дозволені лише малі латинські літери, цифри та дефіс', { exact: true }),
  ).toBeVisible();
  expect(links).toEqual([]);
  await unit.fill('custom-unit');
  await name.fill('WhatsApp final');
  await expect(unit).toHaveValue('custom-unit');
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(
    page.getByText('Systemd unit «echo-whatsapp-bot@custom-unit» вже існує', { exact: true }),
  ).toBeVisible();
  expect(links).toEqual([]);
  conflict = false;
  await page.getByRole('button', { name: "Прив'язати", exact: true }).click({ delay: 450 });
  await expect(page.getByRole('img', { name: 'QR code', exact: true })).toBeVisible();
  expect(links).toEqual([
    {
      phone: '',
      messenger: 'whatsapp',
      display_name: 'WhatsApp final',
      system_service_name: 'custom-unit',
      signal_cli_mode: 'Normal',
      description: null,
      aor_id: 2,
    },
  ]);
  await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
  await page.getByRole('button', { name: "Прив'язати новий", exact: true }).click();
  await expect(name).toHaveValue('');
  await expect(unit).toHaveValue('');
  await expect(page.getByRole('combobox', { name: 'Режим Signal CLI' })).toHaveText('Normal (JVM)');
});

for (const messenger of ['signal', 'echo_operator']) {
  test(`@regression #4108 ${messenger} editing validates, discards cancellation and retries latest permissions without changing connection settings`, async ({
    page,
  }) => {
    await openAccounts(page, messenger);
    const edits: unknown[] = [];
    await page.route('**/api/messenger/edit', async (route) => {
      edits.push(route.request().postDataJSON());
      await route.fulfill(
        edits.length === 1
          ? { status: 500, json: { error: 'Тимчасова помилка збереження' } }
          : { status: 204 },
      );
    });
    const name = page.getByRole('textbox', { name: 'Назва акаунту', exact: true });
    const description = page.getByRole('textbox', { name: "Опис (необов'язково)", exact: true });
    const read = page.getByRole('checkbox', { name: 'Читати повідомлення', exact: true });
    const send = page.getByRole('checkbox', { name: 'Надсилати повідомлення', exact: true });
    await openEdit(page);
    await name.fill('Скасована зміна');
    await description.fill('Скасований опис');
    await read.uncheck();
    await send.check();
    await chooseAor(page);
    await page.getByRole('button', { name: 'Скасувати', exact: true }).click();
    expect(edits).toEqual([]);
    await openEdit(page);
    await expect(name).toHaveValue('Наявний акаунт');
    await expect(description).toHaveValue('Наявний опис');
    await expect(read).toBeChecked();
    await expect(send).not.toBeChecked();
    await expect(page.getByRole('combobox', { name: 'Смуга відповідальності' })).toHaveText(
      'Північ',
    );
    await name.fill('x');
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click({ delay: 450 });
    await expect(
      page.getByText('Назва акаунту має бути мінімум 2 символи', { exact: true }),
    ).toBeVisible();
    expect(edits).toEqual([]);
    await name.fill('Проміжна назва');
    await name.fill('Остання зміна');
    await description.fill('  Оновлений опис  ');
    await read.uncheck();
    await send.check();
    await chooseAor(page);
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click({ delay: 450 });
    await expect(
      page.getByText('Помилка редагування акаунту: Тимчасова помилка збереження', { exact: true }),
    ).toBeVisible();
    await expect(name).toHaveValue('Остання зміна');
    await expect(page.getByRole('button', { name: 'Зберегти', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click({ delay: 450 });
    await expect(name).toHaveCount(0);
    const source = account(messenger);
    expect(edits).toEqual(
      Array(2).fill({
        account_id: 41,
        aor_id: 2,
        is_active: messenger === 'signal',
        can_read_messages: false,
        can_send_messages: true,
        display_name: 'Остання зміна',
        description: 'Оновлений опис',
        api_login: source.apiLogin,
        api_endpoint: source.apiEndpoint,
      }),
    );
    await expect(page.getByRole('row', { name: /Остання зміна/ })).toBeVisible();
    await openEdit(page, 'Остання зміна');
    await expect(description).toHaveValue('Оновлений опис');
    await expect(read).not.toBeChecked();
    await expect(send).toBeChecked();
    await description.fill('   ');
    await page.getByRole('button', { name: 'Зберегти', exact: true }).click({ delay: 450 });
    await expect(name).toHaveCount(0);
    expect(edits.at(-1)).toMatchObject({ description: null });
  });
}
