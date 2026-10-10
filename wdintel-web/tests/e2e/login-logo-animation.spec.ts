import { expect, test, type Page, type Route } from '@playwright/test';

function fulfillJson(route: Route, body: unknown) {
  return route.fulfill({
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function openLogin(page: Page) {
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
  await page.goto('/login');
}

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 keeps the login logo static while retaining both faces @regression', async ({
  page,
}) => {
  await page.clock.install();
  await openLogin(page);

  const brand = page.locator('.login-brand');
  const coin = brand.locator('.logo-coin');
  await expect(brand).not.toHaveClass(/logo-coin-trigger/);
  await expect(coin).not.toHaveClass(/logo-coin--auto/);
  await expect(coin.locator('.logo-coin__face--front img')).toHaveCount(1);
  await expect(coin.locator('.logo-coin__face--back img')).toHaveCount(1);
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');

  await page.clock.runFor(6000);
  await brand.hover();
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 centers the combined login logo @regression', async ({ page }) => {
  await openLogin(page);

  const brandBox = await page.locator('.login-brand').boundingBox();
  const coinBox = await page.locator('.logo-coin__disc').boundingBox();
  const wordmarkBox = await page.locator('.login-wordmark').boundingBox();
  expect(brandBox).not.toBeNull();
  expect(coinBox).not.toBeNull();
  expect(wordmarkBox).not.toBeNull();

  const visibleLeft = Math.min(coinBox!.x, wordmarkBox!.x);
  const visibleRight = Math.max(coinBox!.x + coinBox!.width, wordmarkBox!.x + wordmarkBox!.width);
  const visibleCenter = (visibleLeft + visibleRight) / 2;
  const containerCenter = brandBox!.x + brandBox!.width / 2;

  expect(visibleCenter).toBeCloseTo(containerCenter, 1);
});
