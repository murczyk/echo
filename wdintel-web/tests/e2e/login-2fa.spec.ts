import { expect, test, type Page, type Route } from '@playwright/test';

const CHALLENGE_ID = '2fa-challenge-3464';
const MANUAL_KEY = 'JBSWY3DPEHPK3PXP';

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function installLoginMocks(page: Page, loginResponse: unknown) {
  await page.route('**/api-public/server-info', (route) =>
    fulfillJson(route, {
      mode: '',
      public_host: '',
      grafana_address: '',
      feature_delta: false,
      feature_analysis_map: false,
      feature_strict_networks: false,
      feature_my_admin_groups_edit: false,
      version: '',
    }),
  );
  await page.route('**/api/user/login', (route) => fulfillJson(route, loginResponse));
}

async function submitCredentials(page: Page) {
  await page.goto('/login');
  await page.locator('#login').fill('operator');
  await page.locator('input[type="password"]').fill('password');
  await page.getByRole('button', { name: 'увійти' }).click();
}

function needs2faSetup() {
  return {
    Needs2faSetup: {
      challenge_id: CHALLENGE_ID,
      qr_base64:
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADElEQVR42mNk+M/wHwAF/gL+DKJ6wAAAAABJRU5ErkJggg==',
      manual_key: MANUAL_KEY,
    },
  };
}

// @test-scope regression: https://github.com/echoua/echo/issues/3464
test('@smoke ECHO-3464 guides first-time 2FA setup and preserves confirmation data', async ({
  page,
}) => {
  await installLoginMocks(page, needs2faSetup());
  let confirmationBody: unknown;
  await page.route('**/api/user/confirm-2fa', async (route) => {
    confirmationBody = route.request().postDataJSON();
    await fulfillJson(route, null);
  });

  await submitCredentials(page);

  const heading = page.getByRole('heading', { name: 'Налаштуйте двофакторну автентифікацію' });
  await expect(heading).toBeFocused();
  await expect(page.getByRole('listitem')).toHaveText([
    /Microsoft Authenticator, Google Authenticator, Authy або Duo Mobile/,
    /відскануйте QR-код/,
    /Введіть нижче 6-значний код/,
  ]);
  await expect(
    page.getByAltText('QR-код для налаштування двофакторної автентифікації'),
  ).toBeVisible();
  await expect(page.getByText(MANUAL_KEY)).toBeVisible();
  await expect(page.getByText('Не надсилайте QR-код або ключ іншим людям.')).toBeVisible();
  await expect(page.getByLabel('6-значний код')).toHaveAttribute('placeholder', '000000');

  await page.getByLabel('6-значний код').fill('123456');
  await page.getByRole('button', { name: 'підтвердити' }).click();
  await expect
    .poll(() => confirmationBody)
    .toEqual({ challenge_id: CHALLENGE_ID, token: '123456' });
});

// @test-scope regression: https://github.com/echoua/echo/issues/3464
test('ECHO-3464 keeps returning-user verification concise and focused', async ({ page }) => {
  await installLoginMocks(page, { Needs2fa: { challenge_id: CHALLENGE_ID } });

  await submitCredentials(page);

  await expect(page.getByRole('heading', { name: 'Підтвердіть вхід' })).toBeVisible();
  await expect(
    page.getByText('Введіть 6-значний код із застосунку-автентифікатора.'),
  ).toBeVisible();
  await expect(page.getByLabel('6-значний код')).toBeFocused();
  await expect(
    page.getByAltText('QR-код для налаштування двофакторної автентифікації'),
  ).toHaveCount(0);
  await expect(page.getByText(MANUAL_KEY)).toHaveCount(0);
  await expect(page.getByText('Не надсилайте QR-код або ключ іншим людям.')).toHaveCount(0);
});

// @test-scope regression: https://github.com/echoua/echo/issues/3464
test('ECHO-3464 keeps first-time 2FA controls reachable on a short mobile screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 360, height: 640 });
  await installLoginMocks(page, needs2faSetup());

  await submitCredentials(page);

  expect(
    await page.locator('html').evaluate((element) => element.scrollWidth <= window.innerWidth),
  ).toBe(true);
  for (const locator of [
    page.getByRole('heading', { name: 'Налаштуйте двофакторну автентифікацію' }),
    page.getByAltText('QR-код для налаштування двофакторної автентифікації'),
    page.getByLabel('6-значний код'),
    page.getByRole('button', { name: 'підтвердити' }),
    page.getByRole('button', { name: 'назад' }),
  ]) {
    await locator.scrollIntoViewIfNeeded();
    await expect(locator).toBeInViewport();
  }
});
