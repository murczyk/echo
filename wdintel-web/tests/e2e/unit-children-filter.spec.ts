import { expect, test } from '@playwright/test';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { buildUnitFilterOptions } from '../../src/ts/react/utils/unit-search';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

for (const analysis of [false, true]) {
  test(`@regression #3527 ${analysis ? 'Analysis' : 'Duty'} uses backend parent counts and requests their children`, async ({
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
    let catalogRecovered = false;
    let catalogRevision = '3527';
    await page.route('**/api/sigint/units', async (route) => {
      await route.fulfill({
        json: transformCamelToSnake({
          units,
          showLoadMore: false,
          totalCount: units.length,
          statusCounts: { active: units.length, inactive: 0 },
        }),
      });
    });
    const armyPath = 'group:0:Регіон|1:Округ|2:6 А';
    const brigadePath = `${armyPath}|3:__EMPTY__|4:__EMPTY__|5:27 омсбр`;
    await page.route('**/api/sigint/units/hierarchy', async (route) => {
      catalogRequests += 1;
      await catalogGate;
      if (!catalogRecovered) {
        await route.fulfill({ status: 503, body: 'Temporary catalog failure #3527' });
        return;
      }
      if (route.request().postDataJSON().known_revision === catalogRevision) {
        await route.fulfill({ json: null });
        return;
      }
      await route.fulfill({
        json: transformCamelToSnake({
          revision: catalogRevision,
          groups: [
            { id: 'group:0:Регіон', label: 'Регіон', level: 0, parentIndex: null },
            { id: 'group:0:Регіон|1:Округ', label: 'Округ', level: 1, parentIndex: 0 },
            { id: armyPath, label: '6 А', level: 2, parentIndex: 1 },
            { id: brigadePath, label: '27 омсбр', level: 5, parentIndex: 2 },
            ...units.map((unit) => ({
              id: `${brigadePath}|6:__EMPTY__|7:__EMPTY__|8:${unit.company}`,
              label: unit.company,
              level: 8,
              parentIndex: 3,
            })),
          ],
          units: units.map((unit, index) => ({
            id: unit.id,
            name: unit.name,
            groupIndex: index + 4,
          })),
        }),
      });
    });
    let countRequests = 0;
    let countOffset = 0;
    const statsEndpoint = analysis
      ? '/api/rer/analysis/stats/units'
      : '/api/rer-importer/get-inbox-unit-stats';
    if (analysis) {
      await page.route('**/api/rer/analysis/stats/units/count', async (route) => {
        await route.fulfill({ json: units.length });
      });
    }
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
          options: [
            ...units.map((unit, index) => ({
              value: `unit-id:${unit.id}`,
              label: unit.name,
              count: index + (filtered ? 2 : 5) + countOffset,
            })),
            ...[
              [armyPath, '6 А'],
              [brigadePath, '27 омсбр'],
            ].map(([path, label]) => ({
              value: `unit-parent:${path}`,
              label,
              count: (filtered ? 5 : 11) + countOffset * 2,
            })),
          ],
        },
      });
    });
    const inboxRequests: Array<{ selected_unit_ids?: number[] }> = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/rer-importer/get-inbox')
        inboxRequests.push(request.postDataJSON());
    });
    await page.goto(analysis ? '/rer-analysis-neo?filterPanelOpen=true' : '/rer-duty-neo');
    if (!analysis)
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
    if (!analysis) await expect.poll(() => countRequests).toBeGreaterThan(0);
    const initialCatalogRequests = catalogRequests;
    releaseCatalog();
    await expect(page.getByText(/Не вдалося завантажити ієрархію підрозділів/)).toBeVisible();
    await expect.poll(() => catalogRequests).toBeGreaterThan(initialCatalogRequests);
    catalogRecovered = true;
    const catalogBeforeFocus = catalogRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => catalogRequests).toBe(catalogBeforeFocus + 1);
    if (analysis) {
      await expect(page.getByRole('button', { name: /^Підрозділи/ })).toHaveText('Підрозділи4');
      await expect(page.getByRole('combobox', { name: 'Підрозділи', exact: true })).toHaveCount(0);
      await page.getByRole('button', { name: /^Підрозділи/ }).click();
    }
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
    if (analysis)
      await expect(page.getByRole('button', { name: /^Підрозділи/ })).toHaveText('Підрозділи1 з 4');
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
    const countBeforeReconciliation = countRequests;
    catalogRevision = '3527-reconciled';
    countOffset = 2;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => countRequests).toBeGreaterThan(countBeforeReconciliation);
    if (analysis) {
      await combo.click();
      await expect(page.getByRole('option', { name: /^27 омсбр/ })).toContainText('9');
    } else {
      await expect(page.getByRole('button', { name: '27 омсбр (9)', exact: true })).toBeVisible();
    }
  });
}

test('@regression #3527 Callsigns uses the cached tree for counts, group filters and search', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1500, height: 1000 });
  await installAnalysisNeoApiMocks(page);
  const template = buildUnitFilterOptions([])[0];
  const units = [21, 22, 23].map((id, index) => ({
    ...template,
    id,
    name: id === 23 ? 'Uncached unit' : `${index + 1} мср 27 омсбр`,
    army: 'Old army',
    brigade: 'Old brigade',
    company: `${index + 1} мср`,
  }));
  await page.route('**/api/sigint/units', (route) =>
    route.fulfill({
      json: transformCamelToSnake({
        units,
        showLoadMore: false,
        totalCount: units.length,
        statusCounts: { active: units.length, inactive: 0 },
      }),
    }),
  );
  await page.route('**/api/sigint/sources', (route) => route.fulfill({ json: { sources: [] } }));
  await page.route('**/api/sigint/callsign/unit-stats', (route) =>
    route.fulfill({
      json: {
        units: [
          { unit_id: 21, count: 2 },
          { unit_id: 22, count: 3 },
          { unit_id: 23, count: 4 },
        ],
      },
    }),
  );
  const callsignRequests: Array<{
    filter_unit_army: string | null;
    filter_unit_brigade: string | null;
  }> = [];
  await page.route('**/api/sigint/callsigns', async (route) => {
    callsignRequests.push(route.request().postDataJSON());
    await route.fulfill({ json: { callsigns: [], show_load_more: false } });
  });
  let hierarchyRevision = 'callsigns-3527';
  let armyLabel = '6 А';
  const hierarchyRequests: Array<string | null> = [];
  await page.route('**/api/sigint/units/hierarchy', async (route) => {
    const revision = route.request().postDataJSON().known_revision;
    hierarchyRequests.push(revision);
    const armyPath = `group:2:${armyLabel}`;
    const brigadePath = `${armyPath}|3:__EMPTY__|4:__EMPTY__|5:27 омсбр`;
    await route.fulfill({
      json:
        revision === hierarchyRevision
          ? null
          : transformCamelToSnake({
              revision: hierarchyRevision,
              groups: [
                { id: armyPath, label: armyLabel, level: 2, parentIndex: null },
                { id: brigadePath, label: '27 омсбр', level: 5, parentIndex: 0 },
                ...units.slice(0, 2).map((unit) => ({
                  id: `${brigadePath}|6:__EMPTY__|7:__EMPTY__|8:${unit.company}`,
                  label: unit.company,
                  level: 8,
                  parentIndex: 1,
                })),
              ],
              units: units.slice(0, 2).map((unit, index) => ({
                id: unit.id,
                name: unit.id === 22 ? 'Renamed child' : unit.name,
                groupIndex: index + 2,
              })),
            }),
    });
  });
  await page.goto('/rer-callsigns-neo?units_sidebar=1');
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за гілкою 6 А, позивних 5', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: 'Фільтрувати за підрозділом Uncached unit, позивних 4',
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Розгорнути гілку 6 А', exact: true }).click();
  await page
    .getByRole('button', { name: 'Фільтрувати за гілкою 27 омсбр, позивних 5', exact: true })
    .click();
  await expect
    .poll(() => callsignRequests.at(-1))
    .toMatchObject({
      filter_unit_army: '6 А',
      filter_unit_brigade: '27 омсбр',
    });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => hierarchyRequests.at(-1)).toBe('callsigns-3527');
  const search = page.getByRole('textbox', { name: 'Пошук підрозділу у дереві статистики' });
  await search.fill('6 А');
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за гілкою 6 А, позивних 5', exact: true }),
  ).toBeVisible();
  await search.fill('Renamed child');
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за гілкою 6 А, позивних 3', exact: true }),
  ).toBeVisible();
  await search.fill('');
  hierarchyRevision = 'callsigns-3527-updated';
  armyLabel = '7 А';
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за гілкою 7 А, позивних 5', exact: true }),
  ).toBeVisible();
  await page.getByRole('textbox', { name: 'Пошук підрозділу у дереві статистики' }).fill('2 мср');
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за гілкою 7 А, позивних 3', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Фільтрувати за підрозділом 2 мср, позивних 3', exact: true }),
  ).toBeVisible();
});
