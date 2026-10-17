import { expect, test } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

test('@regression #3610 sending settings preserve sender order and paginate delivery history', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const settings = { enabled: false, senderDatasourceIds: [] as number[] };
  const historyRequests: Array<string | null> = [];
  await page.route('**/api/messenger/list', (route) =>
    route.fulfill({
      json: {
        accounts: [
          {
            id: 1,
            display_name: 'Signal sender',
            messenger: 'signal',
            phone_number: '+380111111111',
            can_send_messages: true,
            can_read_messages: false,
            status: 'active',
            is_linked: true,
          },
          {
            id: 2,
            display_name: 'WhatsApp sender',
            messenger: 'whatsapp',
            phone_number: '+380222222222',
            can_send_messages: true,
            status: 'active',
            is_linked: true,
          },
          {
            id: 3,
            display_name: 'Read only',
            messenger: 'signal',
            can_send_messages: false,
            status: 'active',
            is_linked: true,
          },
        ],
      },
    }),
  );
  await page.route('**/api/messenger/alerts/settings', async (route) => {
    if (route.request().method() === 'PUT') Object.assign(settings, route.request().postDataJSON());
    await route.fulfill({ json: settings });
  });
  await page.route('**/api/messenger/alerts/history', async (route) => {
    const before = route.request().postDataJSON().beforeId;
    historyRequests.push(before);
    await route.fulfill({
      json: {
        entries: Array.from({ length: before ? 1 : 20 }, (_, index) => ({
          id: `${before ? 'old' : 'new'}-${index}`,
          recipientLogin: before ? 'Older recipient' : `Recipient ${index + 1}`,
          recipientProfileId: 'recipient@lid',
          messageUrl: 'https://echo.example/rer-analysis-neo?m=message-1',
          status: 'sent',
          senderName: 'WhatsApp sender',
          attemptedSenderIds: [2],
          error: null,
          createdAt: 1,
          sentAt: 2,
        })),
        nextBeforeId: before ? null : 'older-cursor',
      },
    });
  });
  await page.goto('/admin/messenger-neo?tab=sending');
  await expect(page.getByRole('tab').nth(1)).toHaveText('Відправка');
  await expect(
    page.getByText('Відправка вимкнена: не вибрано месенджер для відправки.'),
  ).toBeVisible();
  await page.getByRole('checkbox', { name: 'Надсилати згадки у важливих повідомленнях' }).check();
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => settings.enabled).toBe(true);
  await expect(
    page.getByText('Відправка вимкнена: не вибрано месенджер для відправки.'),
  ).toBeVisible();
  const senders = page.getByRole('combobox', { name: 'Месенджери для відправки' });
  await senders.click();
  await expect(page.getByRole('option', { name: /Read only/ })).toHaveCount(0);
  await page.getByRole('option', { name: /Signal sender/ }).click();
  await senders.click();
  await page.getByRole('option', { name: /WhatsApp sender/ }).click();
  await page.getByRole('button', { name: /Підняти WhatsApp sender/ }).click();
  await page.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect.poll(() => settings.senderDatasourceIds).toEqual([2, 1]);
  await expect(
    page.getByText('Відправка вимкнена: не вибрано месенджер для відправки.'),
  ).toHaveCount(0);
  await expect(page.getByText('Recipient 20', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Наступна сторінка' }).click();
  await expect(page.getByText('Older recipient', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Наступна сторінка' })).toBeDisabled();
  await page.getByRole('button', { name: 'Оновити', exact: true }).click();
  await expect(page.getByText('Recipient 1', { exact: true })).toBeVisible();
  expect(historyRequests).toEqual([null, 'older-cursor', null]);
});

test('@regression #3610 personal messenger alerts default off and report failed preference saves', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Rer'] });
  let optedIn: boolean | null = null;
  let failSave = false;
  await page.route('**/api/user/messenger-alerts', async (route) => {
    if (route.request().method() === 'PUT') {
      if (failSave) {
        await route.fulfill({ status: 500, json: { error: 'Alert settings unavailable' } });
        return;
      }
      optedIn = route.request().postDataJSON().receiveAlertsInMessenger;
    }
    await route.fulfill({ json: { receiveAlertsInMessenger: optedIn } });
  });
  await page.goto('/settings-neo?section=profile');
  const alerts = page.getByRole('checkbox', { name: 'Отримувати сповіщення в месенджері' });
  await expect(alerts).toBeEnabled();
  await expect(alerts).not.toBeChecked();
  await alerts.click();
  await expect.poll(() => optedIn).toBe(true);
  await expect(alerts).toBeChecked();
  failSave = true;
  await alerts.click();
  await expect(
    page.getByText(/Помилка збереження сповіщень: Alert settings unavailable/).first(),
  ).toBeVisible();
  await expect(alerts).toBeChecked();
});

test('@regression #3610 admins link a messenger profile when creating a user and can clear it when editing', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
  const writes: Array<Record<string, unknown>> = [];
  let login: Record<string, unknown> | null = null;
  await page.route('**/api/logins', (route) =>
    route.fulfill({ json: { users: login ? [login] : [] } }),
  );
  await page.route('**/api/sigint/zones/list', (route) =>
    route.fulfill({ json: [[1, { name: 'Test zone' }]] }),
  );
  await page.route('**/api/organisms', (route) =>
    route.fulfill({ json: [{ id: 1, name: 'Test organization', enabled: true }] }),
  );
  await page.route('**/api/users/messenger-profiles', (route) =>
    route.fulfill({
      json: { data: { 'profile-3610': { given_name: 'Messenger', family_name: 'Recipient' } } },
    }),
  );
  await page.route('**/api/login/create-delta', async (route) => {
    const request = route.request().postDataJSON();
    writes.push(request);
    login = {
      ...request,
      id: 'user-3610',
      deleted: false,
      created_at: 1,
      organism_enabled: true,
      organism_name: 'Test organization',
      sigint_zone_name: 'Test zone',
      delta_login: request.login,
    };
    await route.fulfill({ json: login });
  });
  await page.route('**/api/login/update', async (route) => {
    const request = route.request().postDataJSON();
    writes.push(request);
    login = { ...login, ...request };
    await route.fulfill({ json: login });
  });
  await page.goto('/admin/users-neo');
  await page.getByRole('button', { name: 'Додати користувача', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Логін', exact: true }).fill('messenger-recipient');
  await dialog.getByRole('combobox', { name: 'Зона' }).click();
  await page.getByRole('option', { name: 'Test zone' }).click();
  await dialog.getByRole('combobox', { name: 'Організм' }).click();
  await page.getByRole('option', { name: 'Test organization' }).click();
  await dialog.getByRole('combobox', { name: 'Профіль в месенджері' }).click();
  await page.getByRole('option', { name: 'Messenger Recipient (profile-3610)' }).click();
  await dialog.getByRole('button', { name: 'Додати', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[0].signal_profile_id).toBe('profile-3610');
  await page.getByRole('button', { name: 'Редагувати', exact: true }).click();
  await expect(dialog.getByRole('combobox', { name: 'Профіль в месенджері' })).toHaveValue(
    'Messenger Recipient (profile-3610)',
  );
  await dialog.getByRole('combobox', { name: 'Профіль в месенджері' }).fill('');
  await dialog.getByRole('button', { name: 'Зберегти', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes[1].signal_profile_id).toBeNull();
});
