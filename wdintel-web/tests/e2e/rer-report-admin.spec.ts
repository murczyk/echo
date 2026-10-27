import { expect, test } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { systemSettingsCurrentResponse } from './fixture-responses';

for (const width of [375, 1200]) {
  // Regression: https://github.com/echoua/echo/issues/3598
  test(`@regression #3598 preserves loaded RER settings after metadata fails (${width}px)`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Admin', 'Rer'] });
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({
        json: { ...systemSettingsCurrentResponse(), rer_report_enabled: true },
      }),
    );
    await page.route('**/api/logins', (route) => route.fulfill({ json: { users: [] } }));
    await page.route('**/api/admin/rer-report/access-list', (route) =>
      route.fulfill({ json: { login_ids: [] } }),
    );
    let metadataFails = true;
    await page.route('**/api/admin/rer-report/metadata', (route) =>
      route.fulfill(
        metadataFails ? { status: 500, body: 'Metadata unavailable' } : { json: { items: [] } },
      ),
    );
    await page.goto('/admin/all-reports?tab=rer-report&globalFilter=unit');

    const toggle = page.getByRole('checkbox', { name: 'enable rer report' });
    await expect(toggle).toBeChecked();
    await expect(toggle).toBeEnabled();
    await expect(page.getByRole('button', { name: 'Додати новий' })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Повторити завантаження' })).toBeVisible();
    expect(new URL(page.url()).searchParams.get('globalFilter')).toBe('unit');

    metadataFails = false;
    await page.getByRole('button', { name: 'Повторити завантаження' }).click();
    await expect(page.getByRole('button', { name: 'Повторити завантаження' })).toBeHidden();
    await expect(page.getByRole('button', { name: 'Додати новий' })).toBeEnabled();
    await expect(toggle).toBeChecked();
    await page.getByRole('button', { name: 'Додати новий' }).click();
    await expect(page.getByRole('dialog', { name: 'Додати метадані РЕР' })).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
