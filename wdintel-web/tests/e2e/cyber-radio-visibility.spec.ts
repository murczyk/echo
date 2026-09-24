import { expect, test, type Page } from '@playwright/test';
import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

async function useRoles(page: Page, roles: string[]) {
  await page.route('**/api/user', (route) =>
    route.fulfill({
      json: {
        id: 'operator',
        name: 'operator',
        roles,
        sigint_zone_id: null,
        organism_id: null,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
      },
    }),
  );
}

// Regression: https://github.com/echoua/echo/issues/3568
test.describe('Cyber radio visibility @regression #3568', () => {
  for (const width of [390, 820, 1440]) {
    for (const host of ['duty', 'analysis'] as const) {
      test(`@smoke #3568 Cyber ${host} keeps messages and hides radio UI at ${width}px`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        const inboxResponse = createLoadedInboxResponse();
        if (host === 'duty') await installRerDutyShortStateMocks(page, { inboxResponse });
        else await installAnalysisNeoApiMocks(page, { inboxResponse });
        await useRoles(page, ['Cyber', 'UnitsEditor']);
        const radioRequests: string[] = [];
        page.on('request', (request) => {
          if (
            /\/(latest-frequencies|stats\/freqs|stats\/metadata|summary-table)(\?|$)/.test(
              request.url(),
            )
          )
            radioRequests.push(request.url());
        });
        await page.goto(`/rer-${host === 'duty' ? 'duty' : 'analysis'}-neo`);
        await expect(
          page.getByText('Analysis summary fixture message', { exact: true }),
        ).toBeVisible();
        await expect(
          page.locator('[data-message-card-metadata-item]').filter({ hasText: '123.4' }),
        ).toHaveCount(0);
        await expect(page.getByRole('tab', { name: /Підсумкова таблиця|Частоти/ })).toHaveCount(0);
        if (host === 'duty') {
          await page.getByRole('button', { name: 'Фільтри', exact: true }).click();
          await expect(page.getByLabel('Панель фільтрів')).toBeVisible();
          await expect(page.getByLabel('Панель фільтрів').getByText(/частот|пост/i)).toHaveCount(0);
        }
        expect(radioRequests).toEqual([]);
      });
    }
  }

  test('@smoke #3568 Cyber direct frequency URL redirects home', async ({ page }) => {
    await installRerDutyShortStateMocks(page);
    await useRoles(page, ['Cyber']);
    await page.goto('/rer-freqs');
    await expect(page).toHaveURL(/\/$/);
  });

  for (const roles of [['Rer'], ['Rer', 'Cyber'], ['Admin'], ['Full', 'Cyber']]) {
    test(`#3568 ${roles.join('+')} retains radio controls`, async ({ page }) => {
      await installRerDutyShortStateMocks(page, { inboxResponse: createLoadedInboxResponse() });
      await useRoles(page, roles);
      await page.goto('/rer-duty-neo');
      await expect(
        page.locator('[data-message-card-metadata-item]').filter({ hasText: '123.4' }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Фільтри', exact: true }).click();
      await expect(
        page.getByLabel('Панель фільтрів').getByRole('heading', { name: 'Частота', exact: true }),
      ).toBeVisible();
    });
  }

  for (const host of ['duty', 'analysis']) {
    test(`#3568 Cyber classic ${host} hides radio filters`, async ({ page }) => {
      await installRerDutyShortStateMocks(page);
      if (host === 'analysis') await installAnalysisNeoApiMocks(page);
      await useRoles(page, ['Cyber', 'UnitsEditor']);
      await page.goto(`/rer-${host}`);
      await expect(page.locator('body')).not.toContainText('NAMING ERROR');
      await expect(page.locator('app-navbar')).toBeAttached();
      await expect(page.getByText('частота', { exact: true })).toHaveCount(0);
      if (host === 'analysis') {
        await expect(page.getByText('мережі', { exact: true })).toHaveCount(0);
      }
      await expect(page.getByText('метадані', { exact: true })).toHaveCount(0);
      await expect(page.getByText(/^(пост|пости)$/)).toHaveCount(0);
      await expect(page.getByTitle('підсумкова таблиця', { exact: true })).toHaveCount(0);
    });
  }

  test('#3568 Rer classic analysis retains frequency and network filters', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T12:00:00Z'));
    await installRerDutyShortStateMocks(page);
    await installAnalysisNeoApiMocks(page);
    await useRoles(page, ['Rer']);
    const countersRequest = page.waitForRequest('**/api/rer/analysis/stats/count');
    await page.goto('/rer-analysis');
    const request = (await countersRequest).postDataJSON();
    expect(request.till_date_noninclusive_ms - request.since_date_inclusive_ms).toBe(
      24 * 60 * 60 * 1000,
    );
    await expect(page.getByText('частоти', { exact: true })).toBeVisible();
    await expect(page.getByText('мережі', { exact: true })).toBeVisible();
  });

  for (const enabled of [true, false]) {
    test(`#3568 Duty minus menu follows the system flag: ${enabled}`, async ({ page }) => {
      await installRerDutyShortStateMocks(page, {
        inboxResponse: createLoadedInboxResponse(),
        dutyExcludeMenuEnabled: enabled,
      });
      await page.goto('/rer-duty-neo');
      await expect(
        page.getByText('Analysis summary fixture message', { exact: true }),
      ).toBeVisible();
      const minus = page.getByRole('button', { name: 'Виключити…', exact: true });
      if (enabled) {
        await expect(minus).toBeVisible();
        await minus.click();
        await expect(
          page.getByRole('menuitem').filter({ hasText: 'Виключити групу' }),
        ).toBeVisible();
      } else {
        await expect(minus).toHaveCount(0);
      }
    });
  }

  test('#3568 bare Rer Analysis navigation requests and displays today', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T12:00:00Z'));
    await installAnalysisNeoApiMocks(page);
    await useRoles(page, ['Rer']);
    const countersRequest = page.waitForRequest('**/api/rer/analysis/stats/count');
    await page.goto('/rer-analysis-neo');
    const request = (await countersRequest).postDataJSON();
    expect(request.till_date_noninclusive_ms - request.since_date_inclusive_ms).toBe(
      24 * 60 * 60 * 1000,
    );
    await expect(page.getByRole('textbox', { name: /^Інтервал:/ })).toHaveValue(
      '23.09 00:00 — 24.09 00:00',
    );
    await expect(page.getByRole('heading', { name: 'Частоти', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Мережі', exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Смуги', exact: true })).toBeVisible();
    await expect(page).toHaveURL(/fromDateTime=2026-09-23T00%3A00/);
  });

  test('#3568 bare non-Rer Analysis navigation requests and displays 90 days', async ({ page }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T12:00:00Z'));
    await installAnalysisNeoApiMocks(page);
    await useRoles(page, ['Cyber']);
    const countersRequest = page.waitForRequest('**/api/rer/analysis/stats/count');
    await page.goto('/rer-analysis-neo');
    const request = (await countersRequest).postDataJSON();
    expect(request.till_date_noninclusive_ms - request.since_date_inclusive_ms).toBe(
      90 * 24 * 60 * 60 * 1000,
    );
    await expect(page.getByRole('textbox', { name: /^Інтервал:/ })).toHaveValue(
      '26.06 00:00 — 24.09 00:00',
    );
    await expect(page.getByRole('heading', { name: 'Частоти', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Мережі', exact: true })).toHaveCount(0);
    await expect(page).toHaveURL(/fromDateTime=2026-06-26T00%3A00/);
  });
});
