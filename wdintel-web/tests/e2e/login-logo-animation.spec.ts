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
test('ECHO-3633 periodically flips the login logo like a coin @regression', async ({ page }) => {
  await page.clock.install();
  await openLogin(page);

  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');
  const frontLogo = coin.locator('.logo-coin__face--front img');
  const backLogo = coin.locator('.logo-coin__face--back img');
  await expect(coin).toBeVisible();
  await expect(disc).toHaveCSS('transition-duration', '0.52s');
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');

  const frontBox = await frontLogo.boundingBox();
  const backBox = await backLogo.boundingBox();
  expect(frontBox).not.toBeNull();
  expect(backBox).not.toBeNull();
  expect(backBox!.width).toBeLessThan(frontBox!.width);

  await page.clock.runFor(2999);
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');
  await page.clock.runFor(1);
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'back');
  await expect
    .poll(() =>
      disc.evaluate((element) => {
        const transition = element
          .getAnimations()
          .find((animation) => animation instanceof CSSTransition);
        return transition?.effect?.getTiming().duration ?? null;
      }),
    )
    .toBe(520);

  await coin.evaluate(async (element) => {
    const animations = element.getAnimations({ subtree: true });
    animations.forEach((animation) => animation.finish());
    await Promise.allSettled(animations.map((animation) => animation.finished));
  });
  await page.clock.runFor(2999);
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'back');
  await page.clock.runFor(1);
  await expect(coin).toHaveAttribute('data-logo-coin-side', 'front');
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 centers the combined login logo @regression', async ({ page }) => {
  await openLogin(page);

  const triggerBox = await page.locator('.logo-coin-trigger').boundingBox();
  const coinBox = await page.locator('.logo-coin__disc').boundingBox();
  const wordmarkBox = await page
    .locator('.logo-coin-trigger img[src="/img/echo-logo-white.svg"]')
    .boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(coinBox).not.toBeNull();
  expect(wordmarkBox).not.toBeNull();

  const visibleLeft = Math.min(coinBox!.x, wordmarkBox!.x);
  const visibleRight = Math.max(coinBox!.x + coinBox!.width, wordmarkBox!.x + wordmarkBox!.width);
  const visibleCenter = (visibleLeft + visibleRight) / 2;
  const containerCenter = triggerBox!.x + triggerBox!.width / 2;

  expect(visibleCenter).toBeCloseTo(containerCenter, 1);
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 gradually flips the login logo on hover @regression', async ({ page }) => {
  await openLogin(page);

  const trigger = page.locator('.logo-coin-trigger');
  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');

  await coin.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
  });
  await expect
    .poll(() =>
      disc.evaluate((element) => {
        const transform = getComputedStyle(element).transform;
        return new DOMMatrixReadOnly(transform).m11;
      }),
    )
    .toBeGreaterThan(0.9);

  await trigger.hover();
  expect(
    await disc.evaluate((element) => {
      const transform = getComputedStyle(element).transform;
      return new DOMMatrixReadOnly(transform).m11;
    }),
  ).toBeGreaterThan(-0.9);
  await expect
    .poll(() =>
      disc.evaluate((element) => {
        const transform = getComputedStyle(element).transform;
        return new DOMMatrixReadOnly(transform).m11;
      }),
    )
    .toBeLessThan(-0.9);
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 finishes each hover flip before starting the next one @regression', async ({
  page,
}) => {
  await openLogin(page);

  const trigger = page.locator('.logo-coin-trigger');
  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');

  await coin.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
  });
  await trigger.hover();
  await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Logo flip transition did not start');
    transition.pause();
    transition.currentTime = 100;
  });

  await page.mouse.move(0, 0);
  const firstFlipTarget = await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition || !(transition.effect instanceof KeyframeEffect)) {
      throw new Error('Logo flip transition was interrupted');
    }
    const keyframes = transition.effect.getKeyframes();
    const transform = String(keyframes.at(-1)?.transform);
    return new DOMMatrixReadOnly(transform).m11;
  });

  expect(firstFlipTarget).toBeLessThan(-0.9);

  await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Logo flip transition did not finish');
    transition.currentTime = 510;
    transition.play();
  });
  await expect
    .poll(() =>
      disc.evaluate((element) => {
        const transition = element
          .getAnimations()
          .find((animation) => animation instanceof CSSTransition);
        if (!transition || !(transition.effect instanceof KeyframeEffect)) return null;
        const keyframes = transition.effect.getKeyframes();
        const transform = String(keyframes.at(-1)?.transform);
        return new DOMMatrixReadOnly(transform).m11;
      }),
    )
    .toBeGreaterThan(0.9);
  await expect
    .poll(() =>
      disc.evaluate((element) => {
        const transition = element
          .getAnimations()
          .find((animation) => animation instanceof CSSTransition);
        return transition?.effect?.getTiming().duration ?? null;
      }),
    )
    .toBe(520);
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 uses the same motion for timed and hover flips @regression', async ({ page }) => {
  await page.clock.install();
  await openLogin(page);

  const trigger = page.locator('.logo-coin-trigger');
  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');

  await page.clock.runFor(3000);
  const timedMatrix = await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Timed logo flip transition did not start');
    transition.pause();
    transition.currentTime = 260;
    return Array.from(new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array());
  });

  await page.reload();
  await trigger.hover();
  const hoverMatrix = await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Logo flip transition did not start');
    transition.pause();
    transition.currentTime = 260;
    return Array.from(new DOMMatrixReadOnly(getComputedStyle(element).transform).toFloat64Array());
  });

  expect(hoverMatrix).toHaveLength(timedMatrix.length);
  hoverMatrix.forEach((value, index) => expect(value).toBeCloseTo(timedMatrix[index], 2));
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 keeps the login logo centered during a timed flip @regression', async ({
  page,
}) => {
  await page.clock.install();
  await openLogin(page);

  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');

  const frontCenter = await disc.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });
  await page.clock.runFor(3000);
  const backCenter = await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Timed logo flip transition did not start');
    transition.pause();
    transition.currentTime = 260;

    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

  await expect(disc).toBeVisible();
  expect(backCenter.x).toBeCloseTo(frontCenter.x, 1);
  expect(backCenter.y).toBeCloseTo(frontCenter.y, 1);
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 keeps the login logo centered during a hover flip @regression', async ({
  page,
}) => {
  await openLogin(page);

  const trigger = page.locator('.logo-coin-trigger');
  const coin = page.locator('.logo-coin--auto');
  const disc = coin.locator('.logo-coin__disc');

  await coin.evaluate((element) => {
    for (const animation of element.getAnimations({ subtree: true })) {
      animation.pause();
      animation.currentTime = 0;
    }
  });
  const frontCenter = await disc.evaluate((element) => {
    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

  await trigger.hover();
  const flipCenter = await disc.evaluate((element) => {
    const transition = element
      .getAnimations()
      .find((animation) => animation instanceof CSSTransition);
    if (!transition) throw new Error('Logo flip transition did not start');
    transition.pause();
    transition.currentTime = 260;

    const box = element.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  });

  expect(flipCenter.x).toBeCloseTo(frontCenter.x, 1);
  expect(flipCenter.y).toBeCloseTo(frontCenter.y, 1);
});

// Regression: https://github.com/echoua/echo/issues/3633
test('ECHO-3633 uses a crossfade when reduced motion is requested @regression', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await openLogin(page);

  const trigger = page.locator('.logo-coin-trigger');
  const coin = page.locator('.logo-coin--auto');
  await expect(coin.locator('.logo-coin__idle')).toHaveCSS('animation-name', 'none');
  await expect(coin.locator('.logo-coin__face--front')).toHaveCSS('opacity', '1');
  await expect(coin.locator('.logo-coin__face--back')).toHaveCSS('opacity', '0');

  await trigger.hover();
  await expect(coin.locator('.logo-coin__face--front')).toHaveCSS('opacity', '0');
  await expect(coin.locator('.logo-coin__face--back')).toHaveCSS('opacity', '1');
});
