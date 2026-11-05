import { expect, test } from '@playwright/test';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { buildUnitFilterOptions } from '../../src/ts/react/utils/unit-search';
import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { emptyNetworksListResponse, systemSettingsCurrentResponse } from './fixture-responses';

for (const screen of ['callsigns', 'callsigns-fallback', 'networks', 'devices']) {
  test(`@regression #4028 ${screen} distinguishes own records from the subtree across layouts`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width: 1500, height: 1000 });
    await installAnalysisNeoApiMocks(page, { userRoles: ['Rer', 'Cyber'] });
    const devices = screen === 'devices';
    const callsigns = screen.startsWith('callsigns');
    const template = buildUnitFilterOptions([])[0];
    const units = [
      { ...template, id: 21, name: '6 А', army: '6 А' },
      { ...template, id: 22, name: '6 А child', army: '6 А', company: '1 мср' },
      { ...template, id: 23, name: 'Zero unit', army: '6 А', company: '2 мср' },
    ];
    const counts = [2, 3, 0];
    const unitList = transformCamelToSnake({
      units,
      totalCount: units.length,
      showLoadMore: false,
      statusCounts: { active: units.length, inactive: 0 },
    });
    await page.route('**/api/system-settings/current', (route) =>
      route.fulfill({
        json: {
          ...systemSettingsCurrentResponse(),
          devices_section_enabled: true,
        },
      }),
    );
    await page.route('**/api/sigint/units', (route) => route.fulfill({ json: unitList }));
    await page.route('**/api/device/units', (route) => route.fulfill({ json: unitList }));
    await page.route('**/api/sigint/sources', (route) => route.fulfill({ json: { sources: [] } }));
    await page.route('**/api/device/filter-options', (route) =>
      route.fulfill({ json: { aors: [], creators: [], tags: [], custom_field_keys: [] } }),
    );
    await page.route('**/api/sigint/aor', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sigint/posts', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sigint/encryptions-list', (route) => route.fulfill({ json: [] }));
    await page.route('**/api/sigint/units/hierarchy', (route) =>
      route.fulfill({
        json:
          screen === 'callsigns-fallback'
            ? null
            : transformCamelToSnake({
                revision: '4028',
                groups: [
                  { id: 'army', label: '6 А', level: 2, parentIndex: null },
                  { id: 'company-1', label: '1 мср', level: 8, parentIndex: 0 },
                  { id: 'company-2', label: '2 мср', level: 8, parentIndex: 0 },
                ],
                units: units.map((unit, index) => ({
                  id: unit.id,
                  name: unit.name,
                  groupIndex: index,
                })),
              }),
      }),
    );
    const statsPath = devices
      ? '/api/device/unit-stats'
      : callsigns
        ? '/api/sigint/callsign/unit-stats'
        : '/api/sigint/network/unit-stats';
    await page.route(`**${statsPath}`, (route) =>
      route.fulfill({
        json: {
          units: units.map((unit, index) =>
            devices
              ? { unit: { id: unit.id, name: unit.name }, count: counts[index] }
              : { unit_id: unit.id, count: counts[index] },
          ),
        },
      }),
    );
    const requests: Array<Record<string, unknown>> = [];
    const listPath = devices
      ? '/api/device/list'
      : callsigns
        ? '/api/sigint/callsigns'
        : '/api/sigint/network-list';
    await page.route(`**${listPath}`, (route) => {
      requests.push(route.request().postDataJSON());
      return route.fulfill({
        json: devices
          ? { list: [], total: 0, has_more: false, status_counts: { active: 0, archived: 0 } }
          : callsigns
            ? { callsigns: [], show_load_more: false }
            : emptyNetworksListResponse(),
      });
    });
    await page.goto(
      devices ? '/devices' : callsigns ? '/rer-callsigns-neo?units_sidebar=1' : '/rer-networks-neo',
    );
    if (!callsigns)
      await page.getByRole('button', { name: 'Розгорнути ліву панель', exact: true }).click();
    const countLabel = devices ? 'пристроїв' : callsigns ? 'позивних' : 'мереж';
    const items = devices ? 'пристрої' : callsigns ? 'позивні' : 'мережі';
    const tree = page.getByRole('list', { name: 'Дерево підрозділів' });
    const parent = tree.getByRole('button', {
      name: `Фільтрувати за гілкою 6 А, ${countLabel} 5`,
      exact: true,
    });
    const own = tree.getByRole('button', {
      name: `Власні ${items} підрозділу 6 А: 2; натисніть для перегляду`,
      exact: true,
    });
    await expect(parent).toBeVisible();
    await expect(own).toHaveCSS('background-color', 'rgb(102, 187, 106)');
    await expect(own).toHaveCSS('color', 'rgb(0, 0, 0)');
    const grey = parent.getByText('5', { exact: true });
    const greyBox = await grey.boundingBox();
    const ownBox = await own.boundingBox();
    expect(greyBox!.x).toBeLessThan(ownBox!.x);
    await own.focus();
    await own.press('Enter');
    await expect
      .poll(() => requests.at(-1))
      .toMatchObject(devices ? { unit_ids: [21] } : { filter_unit_id: 21, filter_unit: null });
    if (callsigns) {
      await page.reload();
      await expect.poll(() => requests.at(-1)?.filter_unit_id).toBe(21);
      await expect(own).toBeVisible();
    }
    await grey.click();
    await expect
      .poll(() => requests.at(-1))
      .toMatchObject(
        devices ? { unit_ids: [21, 22, 23] } : { filter_unit_id: null, filter_unit_army: '6 А' },
      );
    await expect(
      tree.getByRole('button', {
        name: `Фільтрувати за підрозділом 6 А, ${countLabel} 2`,
        exact: true,
      }),
    ).toHaveCount(0);
    const child = tree.getByRole('button', {
      name: `Фільтрувати за підрозділом 1 мср, ${countLabel} 3`,
      exact: true,
    });
    await expect(child).toBeVisible();
    await expect(child.getByText('3', { exact: true })).toHaveCount(0);
    await expect(
      tree.getByRole('button', {
        name: `Власні ${items} підрозділу 1 мср: 3; натисніть для перегляду`,
        exact: true,
      }),
    ).toBeVisible();
    await tree
      .getByRole('button', {
        name: `Власні ${items} підрозділу 1 мср: 3; натисніть для перегляду`,
        exact: true,
      })
      .click();
    await expect
      .poll(() => requests.at(-1))
      .toMatchObject(devices ? { unit_ids: [22] } : { filter_unit_id: 22, filter_unit: null });
    await expect(child).toBeVisible();
    await child.click();
    await expect
      .poll(() => requests.at(-1))
      .toMatchObject(
        devices ? { unit_ids: [22] } : { filter_unit_id: null, filter_unit_company: '1 мср' },
      );
    await grey.click();
    const zero = tree.getByRole('button', {
      name: `Фільтрувати за підрозділом 2 мср, ${countLabel} 0`,
      exact: true,
    });
    await expect(zero.getByText('0', { exact: true })).toBeVisible();
    await expect(
      tree.getByRole('button', { name: new RegExp(`Власні ${items} підрозділу 2 мср`) }),
    ).toHaveCount(0);
    const legend = page.getByRole('button', { name: 'Пояснення лічильників підрозділів' });
    await legend.hover();
    await expect(page.getByRole('tooltip')).toContainText(
      `Власні ${items} підрозділу; натисніть для перегляду`,
    );
    await expect(page.getByRole('tooltip')).toContainText(`Всі ${items}`);
    await parent.hover();
    for (const width of [768, 390]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect(parent).toBeVisible();
      await expect(own).toBeVisible();
      const counterBox = await own.boundingBox();
      expect(counterBox!.x + counterBox!.width).toBeLessThanOrEqual(width);
      await page.screenshot({
        path: testInfo.outputPath(`${screen}-${width}.png`),
        animations: 'disabled',
      });
    }
    await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
    await expect(own).toHaveCSS('background-color', 'rgb(102, 187, 106)');
    await expect(own).toHaveCSS('color', 'rgb(0, 0, 0)');
    await page.keyboard.press('Tab');
    await legend.focus();
    await expect(page.getByRole('tooltip')).toContainText(
      `Власні ${items} підрозділу; натисніть для перегляду`,
    );
    await page.screenshot({
      path: testInfo.outputPath(`${screen}-dark.png`),
      animations: 'disabled',
    });
    const search = page.getByRole('textbox', { name: 'Пошук підрозділу у дереві статистики' });
    await search.fill('6 А child');
    await expect(
      tree.getByRole('button', { name: `Фільтрувати за гілкою 6 А, ${countLabel} 3`, exact: true }),
    ).toBeVisible();
    await expect(own).toHaveCount(0);
  });
}
