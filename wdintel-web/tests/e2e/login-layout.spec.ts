import { expect, test, type Page, type Route } from '@playwright/test';

function fulfillJson(route: Route, body: unknown, status = 200) {
  return route.fulfill({
    status,
    contentType: 'application/json; charset=utf-8',
    body: JSON.stringify(body),
  });
}

async function openLogin(
  page: Page,
  {
    width,
    height,
    theme,
    delta = true,
  }: { width: number; height: number; theme: 'light' | 'dark'; delta?: boolean },
) {
  await page.setViewportSize({ width, height });
  await page.addInitScript((themeMode) => {
    localStorage.setItem('echo-theme-mode', themeMode);
  }, theme);
  await page.route('**/api-public/server-info', (route) =>
    fulfillJson(route, {
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
  await page.route('**/api/user', (route) => fulfillJson(route, {}, 401));
  await page.goto('/login');
}

for (const target of [
  { name: 'desktop light', width: 1920, height: 936, theme: 'light' as const },
  { name: 'desktop dark', width: 1920, height: 936, theme: 'dark' as const },
  { name: 'mobile light', width: 390, height: 844, theme: 'light' as const },
  { name: 'mobile dark', width: 390, height: 844, theme: 'dark' as const },
]) {
  test(`ECHO-3633 matches the ${target.name} login composition @regression`, async ({ page }) => {
    await openLogin(page, target);

    const shell = page.locator('.login-page');
    const brand = page.locator('.login-brand');
    const action = page.getByRole('button', { name: 'увійти з delta' });
    const attribution = page.locator('.login-attribution');
    const attributionLogo = attribution.locator('img');
    const markFace = page.locator('.logo-coin__face--front');
    const mark = page.locator('.logo-coin__face--front img');
    const wordmark = page.locator('.login-wordmark');

    await expect(shell).toBeVisible();
    await expect(shell).toHaveAttribute('data-login-theme', target.theme);
    await expect(mark).toHaveAttribute('src', '/img/login-echo-mark.svg');
    await expect(wordmark).toHaveAttribute('src', '/img/login-echo-wordmark.svg');
    await expect
      .poll(() =>
        markFace.evaluate((element) => {
          const style = getComputedStyle(element);
          return [style.backgroundColor, style.borderTopWidth, style.borderRadius];
        }),
      )
      .toEqual(['rgba(0, 0, 0, 0)', '0px', '50%']);
    await expect(attributionLogo).toHaveAttribute(
      'src',
      target.theme === 'dark'
        ? '/img/login-attribution-dark.svg'
        : '/img/login-attribution-light.svg',
    );

    const backgroundImage = await shell.evaluate(
      (element) => getComputedStyle(element).backgroundImage,
    );
    expect(backgroundImage).toContain(
      target.theme === 'dark' ? 'linear-gradient' : 'radial-gradient',
    );
    expect(backgroundImage).toContain(
      target.theme === 'dark' ? 'rgb(37, 37, 37)' : 'rgb(250, 250, 250)',
    );

    await expect
      .poll(() => wordmark.evaluate((element) => getComputedStyle(element).filter))
      .toBe(target.theme === 'dark' ? 'none' : 'invert(1)');

    const brandBox = await brand.boundingBox();
    const actionBox = await action.boundingBox();
    const attributionBox = await attribution.boundingBox();
    const attributionLogoBox = await attributionLogo.boundingBox();
    expect(brandBox).not.toBeNull();
    expect(actionBox).not.toBeNull();
    expect(attributionBox).not.toBeNull();
    expect(attributionLogoBox).not.toBeNull();

    expect(brandBox!.x + brandBox!.width / 2).toBeCloseTo(target.width / 2, 0);
    expect(actionBox!.x + actionBox!.width / 2).toBeCloseTo(target.width / 2, 0);

    if (target.width > 600) {
      expect(brandBox!.y).toBeCloseTo(222, 0);
      expect(actionBox!.width).toBeCloseTo(340, 0);
      expect(attributionBox!.x).toBeCloseTo(68, 0);
      expect(target.height - (attributionBox!.y + attributionBox!.height)).toBeCloseTo(80, 0);
      expect(attributionLogoBox!.width).toBeCloseTo(60, 0);
    } else {
      expect(brandBox!.y).toBeCloseTo(226, 0);
      expect(actionBox!.width).toBeCloseTo(brandBox!.width, 0);
      expect(attributionBox!.x + attributionBox!.width / 2).toBeCloseTo(target.width / 2, 0);
      expect(attributionLogoBox!.width).toBeCloseTo(44, 0);
    }
  });
}

test('ECHO-3633 keeps credential login immediately available without Delta @regression', async ({
  page,
}) => {
  await openLogin(page, { width: 390, height: 844, theme: 'light', delta: false });

  await expect(page.locator('#login')).toBeVisible();
  await expect(page.locator('input[type="password"]')).toBeVisible();
  await expect(page.getByRole('button', { name: 'увійти', exact: true })).toBeVisible();
});

for (const theme of ['light', 'dark'] as const) {
  test(`ECHO-3633 styles credential disclosure in ${theme} mode @regression`, async ({ page }) => {
    await openLogin(page, { width: 390, height: 844, theme });

    const panel = page.locator('.login-panel--credentials');
    await expect(panel).toHaveAttribute('inert', '');
    await page.getByRole('button', { name: 'або увійти з логіном' }).click();

    await expect(panel).not.toHaveAttribute('inert', '');
    await expect(page.locator('#login')).toHaveClass(/login-input/);
    await expect(page.locator('#login')).toBeFocused();
    await expect(page.getByRole('button', { name: 'увійти', exact: true })).toHaveClass(
      /login-primary-action/,
    );

    const inputBox = await page.locator('#login').boundingBox();
    const panelInnerBox = await page.locator('.login-creds-panel__inner').boundingBox();
    const submitBox = await page.getByRole('button', { name: 'увійти', exact: true }).boundingBox();
    expect(inputBox).not.toBeNull();
    expect(panelInnerBox).not.toBeNull();
    expect(submitBox).not.toBeNull();
    expect(inputBox!.x - panelInnerBox!.x).toBeGreaterThanOrEqual(5);
    expect(
      panelInnerBox!.x + panelInnerBox!.width - (inputBox!.x + inputBox!.width),
    ).toBeGreaterThanOrEqual(5);
    expect(
      panelInnerBox!.y + panelInnerBox!.height - (submitBox!.y + submitBox!.height),
    ).toBeGreaterThanOrEqual(5);
  });
}

test('ECHO-3633 preserves invalid input styling @regression', async ({ page }) => {
  await openLogin(page, { width: 390, height: 844, theme: 'light', delta: false });

  const input = page.locator('#login');
  await input.evaluate((element) => element.classList.add('is-invalid'));

  const expectedBorderColor = await input.evaluate((element) => {
    const colorProbe = document.createElement('span');
    colorProbe.style.color = 'var(--bs-form-invalid-border-color)';
    element.parentElement!.append(colorProbe);
    const color = getComputedStyle(colorProbe).color;
    colorProbe.remove();
    return color;
  });
  await expect
    .poll(() => input.evaluate((element) => getComputedStyle(element).borderColor))
    .toBe(expectedBorderColor);
  await expect
    .poll(() => input.evaluate((element) => getComputedStyle(element).backgroundImage))
    .not.toBe('none');
  expect(
    await input.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingRight)),
  ).toBeGreaterThanOrEqual(33);

  await input.focus();
  await expect
    .poll(() => input.evaluate((element) => getComputedStyle(element).boxShadow))
    .toContain('rgba(220, 53, 69, 0.25)');
});
