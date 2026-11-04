import { expect, test } from '@playwright/test';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { buildUnitFilterOptions } from '../../src/ts/react/utils/unit-search';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

for (const analysis of [false, true]) {
  test(`@regression #3527 ${analysis ? 'Analysis' : 'Duty'} aggregates parents locally and requests their children`, async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    if (analysis) await installAnalysisNeoApiMocks(page);
    else await installRerDutyShortStateMocks(page, { latestFrequencies: ['123.4'] });
    const template = buildUnitFilterOptions([])[0];
    const units = [21, 22].map((id, index) => ({
      ...template,
      id,
      name: `${index + 1} мср 27 омсбр`,
      armyRegion: 'Регіон',
      militaryDistrict: 'Округ',
      army: '6 А',
      brigade: '27 омсбр',
      company: `${index + 1} мср`,
    }));
    let releaseCatalog!: () => void;
    const catalogGate = new Promise<void>((resolve) => {
      releaseCatalog = resolve;
    });
    let catalogRequests = 0;
    let catalogReleased = false;
    await page.route('**/api/sigint/units', async (route) => {
      if (route.request().postDataJSON().include_inactive) {
        const initialRequest = !catalogReleased;
        catalogRequests += 1;
        await catalogGate;
        if (initialRequest) {
          await route.fulfill({ status: 503, body: 'Temporary catalog failure #3527' });
          return;
        }
      }
      await route.fulfill({
        json: transformCamelToSnake({
          units,
          showLoadMore: false,
          totalCount: units.length,
          statusCounts: { active: units.length, inactive: 0 },
        }),
      });
    });
    let countRequests = 0;
    let countOffset = 0;
    const statsEndpoint = analysis
      ? '/api/rer/analysis/stats/units'
      : '/api/rer-importer/get-inbox-unit-stats';
    await page.route(`**${statsEndpoint}`, async (route) => {
      countRequests += 1;
      const filtered = route.request().postDataJSON().selected_freqs?.length > 0;
      await route.fulfill({
        json: {
          units: units.map((unit, index) => ({
            unit_id: unit.id,
            name: unit.name,
            count: index + (filtered ? 2 : 5) + countOffset,
          })),
        },
      });
    });
    const inboxRequests: Array<{ selected_unit_ids?: number[] }> = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/rer-importer/get-inbox')
        inboxRequests.push(request.postDataJSON());
    });
    await page.goto(analysis ? '/rer-analysis-neo?filterPanelOpen=true' : '/rer-duty-neo');
    if (analysis) await page.getByRole('button', { name: /^Підрозділи/ }).click();
    else
      await page
        .getByRole('button', { name: /^Фільтри/ })
        .first()
        .click();
    await expect(page.getByRole('checkbox', { name: 'включаючи дочірні підрозділи' })).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('progressbar', { name: 'Завантаження ієрархії підрозділів' }),
    ).toHaveCount(0);
    await expect.poll(() => catalogRequests).toBeGreaterThan(0);
    await expect.poll(() => countRequests).toBeGreaterThan(0);
    const initialCatalogRequests = catalogRequests;
    catalogReleased = true;
    releaseCatalog();
    await expect(page.getByText(/Не вдалося завантажити ієрархію підрозділів/)).toBeVisible();
    await expect.poll(() => catalogRequests).toBeGreaterThan(initialCatalogRequests);
    const countBeforeSelection = countRequests;
    const combo = analysis
      ? page.getByRole('combobox', { name: 'Підрозділи', exact: true })
      : page
          .locator('[aria-label="Панель фільтрів"]')
          .getByText('Підрозділи', { exact: true })
          .locator('../..')
          .getByRole('combobox');
    await combo.click();
    const parent = page.getByRole('option', { name: /^27 омсбр/ });
    await expect(parent).toContainText('11');
    await expect(page.getByRole('option', { name: /^6 А/ })).toContainText('11');
    await expect(page.getByRole('option', { name: /Регіон|Округ/ })).toHaveCount(0);
    expect(countRequests).toBe(countBeforeSelection);
    await parent.click();
    await combo.press('Escape');
    await combo.blur();
    await expect
      .poll(() => inboxRequests.at(-1)?.selected_unit_ids?.slice().sort())
      .toEqual([21, 22]);
    await page.reload();
    if (analysis) await page.getByRole('button', { name: /^Підрозділи/ }).click();
    else
      await page
        .getByRole('button', { name: /^Фільтри/ })
        .first()
        .click();
    await expect(page.getByRole('checkbox', { name: 'включаючи дочірні підрозділи' })).toHaveCount(
      0,
    );
    await expect
      .poll(() => inboxRequests.at(-1)?.selected_unit_ids?.slice().sort())
      .toEqual([21, 22]);
    const countBeforeFrequency = countRequests;
    if (analysis) await page.getByRole('button', { name: /^Частоти/ }).click();
    const frequency = analysis
      ? page.getByRole('combobox', { name: 'Частоти', exact: true })
      : page
          .locator('[aria-label="Панель фільтрів"]')
          .getByText('Частота', { exact: true })
          .locator('xpath=ancestor::div[.//input[@role="combobox"]][1]')
          .getByRole('combobox');
    await frequency.click();
    await page.getByRole('option', { name: /^123.4/ }).click();
    if (analysis) await frequency.press('Escape');
    await frequency.blur();
    await expect.poll(() => countRequests).toBeGreaterThan(countBeforeFrequency);
    if (analysis) {
      await combo.click();
      await expect(page.getByRole('option', { name: /^27 омсбр/ })).toContainText('5');
      await combo.press('Escape');
      await combo.blur();
    } else {
      await expect(page.getByRole('button', { name: '27 омсбр (5)', exact: true })).toBeVisible();
      countOffset = 1;
      await page.evaluate(() =>
        window.dispatchEvent(
          new CustomEvent('echo-inbox-changed', {
            detail: { messageIds: [99999] },
          }),
        ),
      );
      await expect(page.getByRole('button', { name: '27 омсбр (7)', exact: true })).toBeVisible({
        timeout: 10000,
      });
    }
  });
}
