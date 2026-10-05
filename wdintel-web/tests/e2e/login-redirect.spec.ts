import { expect, test, type Page, type Route } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';

const MESSAGE_ID = '01a10624-3a80-7972-9fbf-ea5eb1a9cb36';
const DESTINATION = `/rer-analysis-neo?m=${MESSAGE_ID}&source=http://example.test/a?x%3D1%26y%3D2#message`;

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
}

async function installLoginFlow(
  page: Page,
  {
    delta = false,
    loginResponse = 'Authenticated' as unknown,
    failPassword = false,
    failDelta = false,
    authenticated = false,
  } = {},
) {
  await installAnalysisNeoApiMocks(page);
  const arrivals: string[] = [];
  let deltaDestination: string | null = null;
  page.on('request', (request) => {
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      const url = new URL(request.url());
      arrivals.push(`${url.pathname}${url.search}`);
    }
  });
  await page.route('**/api-public/server-info', (route) =>
    json(route, {
      mode: '',
      public_host: '',
      grafana_address: '',
      feature_delta: delta,
      feature_analysis_map: false,
      feature_strict_networks: false,
      feature_my_admin_groups_edit: false,
      version: '',
    }),
  );
  await page.route('**/api-public/changelog*', (route) => json(route, []));
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.fallback();
    switch (url.pathname) {
      case '/api/user':
        if (!authenticated) return json(route, {}, 401);
        return route.fallback();
      case '/api/user/login':
        if (failPassword) {
          failPassword = false;
          return json(route, {}, 401);
        }
        authenticated = loginResponse === 'Authenticated';
        return json(route, loginResponse);
      case '/api/user/confirm-2fa':
        authenticated = true;
        return json(route, null);
      case '/api/user/logout': {
        const query = new URLSearchParams();
        const redirect = url.searchParams.get('redirect');
        if (redirect !== null) query.set('redirect', redirect);
        return route.fulfill({ status: 302, headers: { Location: `/login?${query}` } });
      }
      case '/api/fetch-redirect-url':
        deltaDestination = url.searchParams.get('redirect');
        return json(route, { url: `${url.origin}/__delta-provider?state=test-state` });
      case '/api/delta-redirect': {
        const query = new URLSearchParams();
        if (failDelta) {
          failDelta = false;
          query.set('api_error', 'err_delta_login_4536');
          if (deltaDestination !== null) query.set('redirect', deltaDestination);
          return route.fulfill({ status: 302, headers: { Location: `/login?${query}` } });
        }
        authenticated = true;
        return route.fulfill({ status: 302, headers: { Location: deltaDestination ?? '/' } });
      }
      default:
        if (!authenticated) return json(route, {}, 401);
        return route.fallback();
    }
  });
  await page.route('**/__delta-provider?*', (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<script>location.replace("/api/delta-redirect?code=test-code&state=test-state")</script>',
    }),
  );
  return { arrivals, deltaDestination: () => deltaDestination };
}

async function submitPassword(page: Page, delta = false) {
  if (delta) await page.getByRole('button', { name: 'або увійти з логіном' }).click();
  await page.locator('#login').fill('operator');
  await page.locator('input[type="password"]').fill('password');
  await page.getByRole('button', { name: 'увійти', exact: true }).click();
}

async function expectDestination(page: Page, arrivals: string[]) {
  await expect.poll(() => arrivals).toContain(DESTINATION.split('#')[0]);
  await expect(page).toHaveURL(
    (url) =>
      url.pathname === '/rer-analysis-neo' &&
      url.searchParams.get('m') === MESSAGE_ID &&
      url.searchParams.get('source') === 'http://example.test/a?x=1&y=2' &&
      url.hash === '#message',
  );
}

// Regression: https://github.com/echoua/echo/issues/3665
for (const delta of [false, true]) {
  test(`@regression #3665 password login restores a protected link with Delta ${delta ? 'enabled' : 'disabled'}`, async ({
    page,
  }) => {
    const flow = await installLoginFlow(page, { delta, failPassword: true });
    await page.goto(DESTINATION);
    await expect(page).toHaveURL(
      (url) => url.pathname === '/login' && url.searchParams.get('redirect') === DESTINATION,
    );
    await submitPassword(page, delta);
    await expect(page.getByText('Невірний логін або пароль')).toBeVisible();
    await page.getByRole('button', { name: 'увійти', exact: true }).click();
    await expectDestination(page, flow.arrivals);
  });
}

for (const setup of [false, true]) {
  test(`@regression #3665 password login restores the link after 2FA ${setup ? 'setup' : 'verification'}`, async ({
    page,
  }) => {
    const payload = {
      challenge_id: 'redirect-challenge',
      ...(setup ? { qr_base64: '', manual_key: 'JBSWY3DPEHPK3PXP' } : {}),
    };
    const flow = await installLoginFlow(page, {
      loginResponse: { [setup ? 'Needs2faSetup' : 'Needs2fa']: payload },
    });
    await page.goto(DESTINATION);
    await submitPassword(page);
    await page.getByLabel('6-значний код').fill('123456');
    await page.getByRole('button', { name: 'підтвердити' }).click();
    await expectDestination(page, flow.arrivals);
  });
}

test('@regression #3665 Delta login preserves the link through a provider failure and retry', async ({
  page,
}) => {
  const flow = await installLoginFlow(page, { delta: true, failDelta: true });
  await page.goto(DESTINATION);
  await page.getByRole('button', { name: 'увійти з delta' }).click();
  await expect(page).toHaveURL(
    (url) => url.pathname === '/login' && url.searchParams.get('redirect') === DESTINATION,
  );
  await expect(
    page.getByText('Помилка на стороні Delta. Будь ласка, зверніться до адміністратора.'),
  ).toBeVisible();
  expect(flow.deltaDestination()).toBe(DESTINATION);
  await page.getByRole('button', { name: 'увійти з delta' }).click();
  await expectDestination(page, flow.arrivals);
});

test('@regression #3665 an authenticated login visit restores a legacy same-origin absolute destination', async ({
  page,
}) => {
  const flow = await installLoginFlow(page, { authenticated: true });
  const origin = new URL(test.info().project.use.baseURL as string).origin;
  await page.goto(`/login?${new URLSearchParams({ redirect: `${origin}${DESTINATION}` })}`);
  await expectDestination(page, flow.arrivals);
});

for (const redirect of [
  undefined,
  'https://external.test/',
  '//external.test/',
  '/\\external.test/',
  '/login?redirect=%2Flogin',
  '/ignored/../login',
]) {
  test(`@regression #3665 password login safely defaults home for ${redirect ?? 'no destination'}`, async ({
    page,
  }) => {
    await installLoginFlow(page);
    await page.goto(
      redirect === undefined ? '/login' : `/login?${new URLSearchParams({ redirect })}`,
    );
    await submitPassword(page);
    await expect(page).toHaveURL((url) => url.pathname === '/');
  });
}
