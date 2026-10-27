import { expect, test, type Page } from '@playwright/test';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

async function expectPanels(page: Page, left: boolean, filters: boolean) {
  await expect(
    page.getByRole('button', {
      name: left ? 'Згорнути ліву панель' : 'Розгорнути ліву панель',
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator('[data-analysis-filter-toggle]')).toHaveAttribute(
    'aria-expanded',
    String(filters),
  );
  await expect.poll(() => new URL(page.url()).searchParams.get('leftPanelOpen')).toBe(String(left));
  await expect
    .poll(() => new URL(page.url()).searchParams.get('filterPanelOpen'))
    .toBe(String(filters));
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
});

for (const hideNetworks of [true, false]) {
  test(`@regression #3727 Analysis panels: mobile defaults follow hideNetworks=${hideNetworks}`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 760 });
    await installAnalysisNeoApiMocks(page, { hideNetworks });
    await page.goto('/rer-analysis-neo');
    const close = page.getByRole('button', {
      name: hideNetworks ? 'Закрити ліву панель' : 'Закрити фільтри',
      exact: true,
    });
    await expect(close).toBeVisible();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('leftPanelOpen'))
      .toBe(String(hideNetworks));
    await expect
      .poll(() => new URL(page.url()).searchParams.get('filterPanelOpen'))
      .toBe(String(!hideNetworks));
    await close.click();
    await page.reload();
    await expectPanels(page, false, false);
  });

  test(`@regression #3727 Analysis panels: hideNetworks=${hideNetworks} supplies defaults, not overrides`, async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { hideNetworks });
    await page.goto('/rer-analysis-neo');
    await expectPanels(page, hideNetworks, !hideNetworks);
    await page
      .getByRole('button', {
        name: hideNetworks ? 'Згорнути ліву панель' : 'Розгорнути ліву панель',
        exact: true,
      })
      .click();
    await page.locator('[data-analysis-filter-toggle]').click();
    await expectPanels(page, !hideNetworks, hideNetworks);
    await page.reload();
    await expectPanels(page, !hideNetworks, hideNetworks);
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({ json: systemSettingsCurrentResponse({ hideNetworks: !hideNetworks }) }),
    );
    await page.reload();
    await expectPanels(page, !hideNetworks, hideNetworks);
  });

  for (const left of [true, false]) {
    for (const filters of [true, false]) {
      test(`@regression #3727 Analysis panels: URL left=${left}, filters=${filters} beats hideNetworks=${hideNetworks}`, async ({
        page,
      }) => {
        await installAnalysisNeoApiMocks(page, { hideNetworks });
        await page.goto(`/rer-analysis-neo?leftPanelOpen=${left}&filterPanelOpen=${filters}`);
        await expectPanels(page, left, filters);
      });
    }
  }

  for (const explicit of ['leftPanelOpen', 'filterPanelOpen'] as const) {
    test(`@regression #3727 Analysis panels: only missing ${explicit === 'leftPanelOpen' ? 'filter' : 'left'} state uses hideNetworks=${hideNetworks}`, async ({
      page,
    }) => {
      await installAnalysisNeoApiMocks(page, { hideNetworks });
      await page.goto(`/rer-analysis-neo?${explicit}=false`);
      await expectPanels(
        page,
        explicit === 'leftPanelOpen' ? false : hideNetworks,
        explicit === 'filterPanelOpen' ? false : !hideNetworks,
      );
    });
  }

  test(`@regression #3727 Analysis panels: delayed hideNetworks=${hideNetworks} does not undo user toggles`, async ({
    page,
  }) => {
    await installAnalysisNeoApiMocks(page, { hideNetworks });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route('**/api/system-settings/current', async (route) => {
      await gate;
      await route.fulfill({ json: systemSettingsCurrentResponse({ hideNetworks }) });
    });
    try {
      await page.goto('/rer-analysis-neo?leftPanelOpen=false');
      await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
    } finally {
      release();
    }
    await expectPanels(page, true, !hideNetworks);
    await page.reload();
    await expectPanels(page, true, !hideNetworks);
  });
}

test('@regression #3727 Analysis panels: opening the editor does not replace the filter URL preference', async ({
  page,
}) => {
  await installAnalysisNeoApiMocks(page, { hideNetworks: false });
  await page.goto('/rer-analysis-neo?filterPanelOpen=true');
  await expectPanels(page, false, true);
  await page.getByRole('button', { name: 'Додати повідомлення', exact: true }).click();
  await expect(page.locator('[data-analysis-filter-toggle]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  expect(new URL(page.url()).searchParams.get('filterPanelOpen')).toBe('true');
  await page.reload();
  await expectPanels(page, false, true);
});
