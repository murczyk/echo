import { expect, test, type Page } from '@playwright/test';

import { installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';

const groups = [
  { master_key: 'group-a', name: 'Group Alpha', color_key: 'cyan' },
  { master_key: 'group-b', name: 'Group Beta', color_key: 'deep_purple' },
  { master_key: 'group-c', name: 'Group Gamma', color_key: 'orange' },
];

async function installMocks(page: Page, analysis: boolean) {
  const signalGroups = groups.map((group) => group.master_key);
  if (analysis) await installAnalysisNeoApiMocks(page, { signalGroups });
  else await installRerDutyShortStateMocks(page, { signalGroups, latestFrequencies: ['123.4'] });
  await page.route('**/api/rer-importer/signal-group-batch', (route) =>
    route.fulfill({ json: { data: groups } }),
  );
  await page.route('**/api/rer/analysis/stats/groups', (route) =>
    route.fulfill({
      json: {
        groups: groups.map((group) => ({ master_key: group.master_key, count: 1 })),
        group_names: groups,
      },
    }),
  );
  const readStateRequests: string[] = [];
  const inboxRequests: Record<string, unknown>[] = [];
  const catalogRequests: Record<string, unknown>[] = [];
  const detailsRequests: Record<string, unknown>[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/rer-importer/group-feed-state'))
      readStateRequests.push(request.url());
    if (new URL(request.url()).pathname === '/api/user/sigint-groups')
      catalogRequests.push(request.postDataJSON());
    if (new URL(request.url()).pathname === '/api/rer-importer/signal-group-batch')
      detailsRequests.push(request.postDataJSON());
    if (new URL(request.url()).pathname === '/api/rer-importer/get-inbox') {
      inboxRequests.push(request.postDataJSON());
    }
  });
  return { readStateRequests, inboxRequests, catalogRequests, detailsRequests };
}

function url(analysis: boolean, selectedGroups: string[]) {
  if (analysis) {
    const params = new URLSearchParams({
      freqs: '123.4',
      aors: '7',
      leftPanelOpen: 'true',
      filterPanelOpen: 'false',
    });
    selectedGroups.forEach((key) => params.append('groups', key));
    return `/rer-analysis-neo?${params}`;
  }
  const state = {
    messageFeeds: [['mf-groups', { groupsSelected: selectedGroups, freqsSelected: ['123.4'] }]],
  };
  return `/rer-duty-neo?state=${encodeURIComponent(JSON.stringify(state))}`;
}

for (const analysis of [false, true]) {
  const routeName = analysis ? 'Analysis' : 'Duty';
  for (const width of [390, 1500]) {
    for (const theme of ['light', 'dark']) {
      test(`@regression #3727 ${routeName} shares group widgets and legacy filters (${width}px, ${theme})`, async ({
        page,
      }) => {
        await page.setViewportSize({ width, height: 900 });
        await page.addInitScript((mode) => localStorage.setItem('echo-theme-mode', mode), theme);
        const mocks = await installMocks(page, analysis);
        await page.goto(url(analysis, ['group-a', 'group-b', 'group-c']));
        const identity = page.locator(
          analysis ? '[data-analysis-current-group]' : '[data-group-island]',
        );
        await expect(identity.locator('[data-group-name]')).toHaveText('Group Alpha + 2 ін.');
        await expect(identity.getByTestId('GroupOutlinedIcon')).toBeVisible();

        const openGroups = async () => {
          if (analysis) {
            if (!(await page.locator('[data-analysis-group-list]:visible').count())) {
              await page.getByRole('button', { name: 'Розгорнути ліву панель' }).click();
            }
          } else {
            await page.getByRole('button', { name: 'Розгорнути список груп' }).click();
          }
          return page.locator(
            analysis ? '[data-analysis-group-list]:visible' : '[data-group-panel]',
          );
        };
        let panel = await openGroups();
        await expect(panel.locator('[aria-current="true"]')).toHaveCount(0);
        await expect(panel.locator('[data-selected="true"]')).toHaveCount(0);
        await expect
          .poll(() => mocks.inboxRequests.at(-1)?.selected_groups)
          .toEqual(['group-a', 'group-b', 'group-c']);
        const alphaColor = await panel
          .getByRole('button', { name: 'Group Alpha', exact: true })
          .locator('[data-group-avatar]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        const beta = panel.getByRole('button', { name: 'Group Beta', exact: true });
        const betaColor = await beta
          .locator('[data-group-avatar]')
          .evaluate((element) => getComputedStyle(element).backgroundColor);
        await beta.click();
        await expect(identity.locator('[data-group-name]')).toHaveText('Group Beta');
        await expect(identity.locator('[data-group-avatar]')).toHaveCSS(
          'background-color',
          betaColor,
        );
        await expect(identity.getByTestId('GroupOutlinedIcon')).toHaveCount(0);
        await expect.poll(() => mocks.inboxRequests.at(-1)?.selected_groups).toEqual(['group-b']);
        expect(mocks.inboxRequests.at(-1)?.selected_freqs).toEqual(['123.4']);
        if (analysis) expect(mocks.inboxRequests.at(-1)?.selected_aors).toEqual([7]);

        panel = await openGroups();
        await panel.getByRole('button', { name: 'Всі групи', exact: true }).click();
        await expect(identity.locator('[data-group-name]')).toHaveText('Всі групи');
        await expect.poll(() => mocks.inboxRequests.at(-1)?.selected_groups).toBeNull();
        expect(mocks.inboxRequests.at(-1)?.selected_freqs).toEqual(['123.4']);
        if (analysis) expect(mocks.inboxRequests.at(-1)?.selected_aors).toEqual([7]);

        await page.mouse.move(width - 1, 899);
        await expect(page.getByRole('tooltip')).toHaveCount(0);
        await page.getByRole('button', { name: 'Фільтри (активні)', exact: true }).click();
        let input;
        if (analysis) {
          const filters = page.locator('[data-analysis-filters-scroll-container]:visible');
          await filters.getByRole('button', { name: /^Групи/ }).click();
          input = filters.getByRole('combobox', { name: 'Групи' });
        } else {
          input = page.getByLabel('Панель фільтрів').getByRole('combobox').first();
        }
        await input.fill('Alpha');
        await page.getByRole('option', { name: /Group Alpha/ }).click();
        await input.press('Tab');
        await expect(identity.locator('[data-group-name]')).toHaveText('Group Alpha');
        await expect(identity.locator('[data-group-avatar]')).toHaveCSS(
          'background-color',
          alphaColor,
        );
        await expect(identity.getByTestId('GroupOutlinedIcon')).toHaveCount(0);
        await input.fill('Gamma');
        await page.getByRole('option', { name: /Group Gamma/ }).click();
        await input.press('Tab');
        await expect(identity.locator('[data-group-name]')).toHaveText('Group Alpha + 1 ін.');
        await expect(identity.getByTestId('GroupOutlinedIcon')).toBeVisible();
        await page.reload();
        await expect(identity.locator('[data-group-name]')).toHaveText('Group Alpha + 1 ін.');
        expect(mocks.readStateRequests).toEqual([]);
        expect(mocks.catalogRequests.at(-1)).toMatchObject({
          since_date_inclusive_ms: expect.any(Number),
        });
        expect(mocks.detailsRequests.length).toBeGreaterThan(0);
        expect(mocks.detailsRequests.every((request) => request.skip_group_stats === true)).toBe(
          true,
        );
      });
    }
  }

  test(`@regression #3727 ${routeName} handles unknown group visibility during delayed and failed details requests`, async ({
    page,
  }) => {
    const mocks = await installMocks(page, analysis);
    let releaseDetails!: () => void;
    const pendingDetails = new Promise<void>((resolve) => {
      releaseDetails = resolve;
    });
    let failing = true;
    await page.route('**/api/rer-importer/signal-group-batch', async (route) => {
      if (failing) {
        await pendingDetails;
        await route.fulfill({ status: 500, json: {} });
        return;
      }
      await route.fulfill({
        json: {
          data: groups.map((group) => ({
            ...group,
            ignore_operativny: group.master_key === 'group-b',
          })),
        },
      });
    });
    await page.goto(url(analysis, []));
    if (!analysis) await page.getByRole('button', { name: 'Розгорнути список груп' }).click();
    const panel = page.locator(
      analysis ? '[data-analysis-group-list]:visible' : '[data-group-panel]',
    );
    await expect.poll(() => mocks.detailsRequests.length).toBeGreaterThan(0);
    await expect(panel.getByRole('status')).toContainText('Завантажуємо групи');
    await expect(panel.locator('[data-group-list-item]')).toHaveCount(analysis ? 4 : 1);
    releaseDetails();
    await expect(panel.getByRole('alert')).toContainText(
      'Не вдалося завантажити назви деяких груп.',
    );
    await expect(panel.locator('[data-group-list-item]')).toHaveCount(analysis ? 4 : 1);
    failing = false;
    await panel.getByRole('button', { name: 'Повторити', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Group Alpha', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Group Gamma', exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Group Beta', exact: true })).toHaveCount(
      analysis ? 1 : 0,
    );
    expect(mocks.readStateRequests).toEqual([]);
  });

  test(`@regression #3727 ${routeName} hydrates a selected historical group with no messages after retry`, async ({
    page,
  }) => {
    const historical = { master_key: 'historical', name: 'Historical Group', color_key: 'red' };
    const mocks = await installMocks(page, analysis);
    await page.route('**/api/user/sigint-groups', (route) => route.fulfill({ json: ['group-a'] }));
    let failing = true;
    await page.route('**/api/rer-importer/signal-group-batch', (route) => {
      const keys = route
        .request()
        .postDataJSON()
        .groups.map((group) => group.master_key);
      if (keys.includes(historical.master_key) && failing) {
        return route.fulfill({ status: 500, json: {} });
      }
      return route.fulfill({
        json: { data: [...groups, historical].filter((group) => keys.includes(group.master_key)) },
      });
    });
    await page.goto(url(analysis, [historical.master_key]));
    if (!analysis) await page.getByRole('button', { name: 'Розгорнути список груп' }).click();
    const panel = page.locator(
      analysis ? '[data-analysis-group-list]:visible' : '[data-group-panel]',
    );
    await expect(panel.getByRole('alert')).toContainText(
      'Не вдалося завантажити назви деяких груп.',
    );
    failing = false;
    await panel.getByRole('button', { name: 'Повторити', exact: true }).click();
    const historicalButton = panel.getByRole('button', { name: historical.name, exact: true });
    await expect(historicalButton).toHaveAttribute('aria-current', 'true');
    const identity = page.locator(
      analysis ? '[data-analysis-current-group]' : '[data-group-island]',
    );
    await expect(identity.locator('[data-group-name]')).toHaveText(historical.name);
    await expect.poll(() => mocks.inboxRequests.at(-1)?.selected_groups).toEqual(['historical']);
    expect(mocks.detailsRequests.every((request) => request.skip_group_stats === true)).toBe(true);
    expect(mocks.readStateRequests).toEqual([]);
    await page.reload();
    await expect(identity.locator('[data-group-name]')).toHaveText(historical.name);
  });

  test(`@regression #3727 ${routeName} retries a failed legacy catalog without querying group read state`, async ({
    page,
  }) => {
    const mocks = await installMocks(page, analysis);
    let requests = 0;
    let failing = true;
    await page.route('**/api/user/sigint-groups', (route) => {
      requests += 1;
      return failing
        ? route.fulfill({ status: 500, json: {} })
        : route.fulfill({ json: groups.map((group) => group.master_key) });
    });
    await page.goto(url(analysis, []));
    if (!analysis) await page.getByRole('button', { name: 'Розгорнути список груп' }).click();
    const panel = page.locator(
      analysis ? '[data-analysis-group-list]:visible' : '[data-group-panel]',
    );
    await expect(panel.getByRole('alert')).toContainText('Не вдалося завантажити список груп.');
    failing = false;
    const requestsBeforeRetry = requests;
    await panel.getByRole('button', { name: 'Повторити', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Group Alpha', exact: true })).toBeVisible();
    expect(requests).toBe(requestsBeforeRetry + 1);
    expect(mocks.readStateRequests).toEqual([]);
  });
}
