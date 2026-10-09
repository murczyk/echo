import { expect, test, type Page } from '@playwright/test';
import { createLoadedInboxResponse, installAnalysisNeoApiMocks } from './analysis-neo.fixtures';
import { installRerDutyShortStateMocks } from './rer-duty-short-state.fixtures';
import { toLegacyRerAnalysisQueryState } from '../../src/ts/rer-analysis-query-state-legacy';
import type { InboxMessage, Network } from '../../src/Bindings';
import { transformCamelToSnake } from '../../src/ts/snake-to-camel';
import { systemSettingsCurrentResponse } from './fixture-responses';

const dutyNetwork: Network = {
  id: 7,
  name: 'Duty recovery network',
  freqs: [],
  unitIds: null,
  aorIds: [],
  location: '',
  radioStation: null,
  createdAt: 0,
  purpose: null,
  operationMode: null,
  operationType: null,
  operationPeriod: null,
  lastActivityAt: null,
  lastUpdatedAt: 0,
  lastUpdatedBy: null,
  activeFrom: null,
  activeTo: null,
  postIds: [],
  descriptions: [],
  deleted: false,
  doNotArchive: false,
  unitMask: [],
  status: 'NetworkActive',
};

function createClassicDutyNetworkInbox() {
  const inbox = createLoadedInboxResponse();
  const message: InboxMessage = {
    ...inbox.inbox_items[0][1],
    messageUuid: null,
    coordsWithLocality: [],
    createdAt: null,
    createdAtOrder: null,
    hasDateInHeader: false,
    unitIds: [],
    networkIds: [7],
    networkName: null,
    deviceName: null,
    parentMessages: [],
    intelligenceReports: [],
  };
  return transformCamelToSnake<typeof inbox>({
    ...inbox,
    poll_cursor_id: null,
    inbox_items: [[101, message]],
  });
}

async function useRoles(page: Page, roles: string[], ready: Promise<void> = Promise.resolve()) {
  await page.route('**/api/user', async (route) => {
    await ready;
    await route.fulfill({
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
        rer_report_eligible: false,
      },
    });
  });
}

function classicDutyState() {
  return {
    waterfalls: ['wf-0', 'wf-1'].map((id, index) => [
      id,
      {
        groups_selected: [`group-${index}`],
        groups_denied: null,
        senders_selected: [],
        denied_senders: ['sender-1'],
        freqs_selected: ['152.7500', '136.2330', ''],
        freqs_denied: ['150.0000'],
        posts_selected: ['post-1'],
        posts_denied: [],
        units_selected: null,
        units_denied: null,
        selected_unit_ids: null,
        denied_unit_ids: null,
        selected_device_names: null,
        denied_device_names: null,
        units_exact_match_only: null,
        last_viewed_message_id: 31199037 + index,
        highlight_keywords_enabled: null,
        highlight_keyword_set_id: null,
      },
    ]),
  };
}

// Regression: https://github.com/echoua/echo/issues/3568
test.describe('Cyber radio visibility @regression #3568', () => {
  for (const roles of [
    ['Rer'],
    ['Rer', 'Cyber'],
    ['Admin'],
    ['Full'],
    ['Cyber'],
    ['CyberViewer'],
  ]) {
    test(`@smoke #3568 classic Duty saved filters wait for ${roles.join('+')} permissions`, async ({
      page,
    }) => {
      await installRerDutyShortStateMocks(page);
      let releaseUser!: () => void;
      const ready = new Promise<void>((resolve) => {
        releaseUser = resolve;
      });
      await useRoles(page, roles, ready);
      const inboxRequests: Record<string, unknown>[] = [];
      const radioRequests: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/rer-importer/get-inbox') {
          inboxRequests.push(request.postDataJSON());
        }
        if (/\/(latest-frequencies|stats\/posts)(\?|$)/.test(request.url())) {
          radioRequests.push(request.url());
        }
      });
      const state = classicDutyState();
      const userRequested = page.waitForRequest('**/api/user');
      await page.goto(`/rer-duty?state=${encodeURIComponent(JSON.stringify(state))}`);
      await userRequested;
      await expect(page.getByRole('status').filter({ hasText: 'Loading...' })).toBeVisible();
      await expect(page.locator('button').filter({ has: page.locator('i.bi-gear') })).toHaveCount(
        0,
      );
      expect(inboxRequests).toEqual([]);
      expect(radioRequests).toEqual([]);
      expect(JSON.parse(new URL(page.url()).searchParams.get('state')!)).toEqual(state);
      releaseUser();

      const radioAllowed = roles.some((role) => ['Rer', 'Full', 'Admin'].includes(role));
      const settings = page.locator('button').filter({ has: page.locator('i.bi-gear') });
      await expect(settings).toHaveCount(2);
      await settings.nth(0).click();
      await settings.nth(1).click();
      await expect(page.getByText('частота', { exact: true })).toHaveCount(radioAllowed ? 2 : 0);
      await expect(page.getByText('пост', { exact: true })).toHaveCount(radioAllowed ? 2 : 0);
      await expect.poll(() => inboxRequests.length).toBeGreaterThanOrEqual(2);
      for (let index = 0; index < 2; index++) {
        const request = inboxRequests.find(
          (body) => JSON.stringify(body.selected_groups) === JSON.stringify([`group-${index}`]),
        );
        expect(request).toMatchObject({
          selected_freqs: radioAllowed ? ['152.7500', '136.2330', ''] : null,
          denied_freqs: radioAllowed ? ['150.0000'] : null,
          selected_posts: radioAllowed ? ['post-1'] : null,
          denied_senders: ['sender-1'],
          before_id_noninclusive: 31199037 + index,
        });
      }
      if (radioAllowed) await expect.poll(() => radioRequests.length).toBe(4);
      else expect(radioRequests).toEqual([]);
      expect(JSON.parse(new URL(page.url()).searchParams.get('state')!)).toEqual(state);

      inboxRequests.length = 0;
      await page.reload();
      await expect.poll(() => inboxRequests.length).toBeGreaterThanOrEqual(2);
      expect(
        inboxRequests.every(
          (body) =>
            JSON.stringify(body.selected_freqs) ===
            JSON.stringify(radioAllowed ? ['152.7500', '136.2330', ''] : null),
        ),
      ).toBe(true);
    });
  }

  test('#3568 classic Duty recovers from a failed user lookup without unfiltered requests', async ({
    page,
  }) => {
    await installRerDutyShortStateMocks(page);
    await page.route('**/api/user', (route) => route.fulfill({ status: 500, body: 'Unavailable' }));
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/get-inbox')) requests.push(request.url());
    });
    await page.goto(`/rer-duty?state=${encodeURIComponent(JSON.stringify(classicDutyState()))}`);
    const retry = page.getByRole('button', { name: 'Повторити завантаження користувача' });
    await expect(retry).toBeVisible();
    expect(requests).toEqual([]);
    await expect(
      page.getByText('Помилка завантаження користувача', { exact: true }).first(),
    ).toBeVisible();
    await useRoles(page, ['Rer']);
    await retry.click();
    await expect(page.locator('button').filter({ has: page.locator('i.bi-gear') })).toHaveCount(2);
    await expect.poll(() => requests.length).toBeGreaterThan(0);
  });

  test('#3568 classic Duty expired authentication returns to login without inbox requests', async ({
    page,
  }) => {
    await installRerDutyShortStateMocks(page);
    await page.route('**/api/user', (route) =>
      route.fulfill({ status: 401, body: 'Unauthorized' }),
    );
    await page.route(/\/api\/user\/logout(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 302, headers: { location: '/login' } }),
    );
    const requests: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/get-inbox')) requests.push(request.url());
    });
    await page.goto(`/rer-duty?state=${encodeURIComponent(JSON.stringify(classicDutyState()))}`);
    await expect(page).toHaveURL(/\/login(?:\?|$)/);
    expect(requests).toEqual([]);
  });

  for (const width of [390, 820, 1440]) {
    test(`#3568 classic Duty blank page and authenticated navigation retain radio filters at ${width}px`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await installRerDutyShortStateMocks(page);
      await useRoles(page, ['Rer']);
      await page.goto('/rer-duty');
      const settings = page.locator('button').filter({ has: page.locator('i.bi-gear') });
      await settings.focus();
      await settings.press('Enter');
      await expect(page.getByText('частота', { exact: true })).toBeVisible();
      await page.evaluate(() => {
        history.pushState({}, '', '/');
        dispatchEvent(new PopStateEvent('popstate'));
      });
      await page.goBack();
      await settings.focus();
      await settings.press('Enter');
      await expect(page.getByText('частота', { exact: true })).toBeVisible();
      if (width === 1440) {
        await page.getByTitle('нова колонка', { exact: true }).click();
        await expect(settings).toHaveCount(2);
        await settings.nth(1).click();
        await expect(page.getByText('частота', { exact: true })).toHaveCount(2);
      }
    });
  }

  // https://github.com/echoua/echo/issues/3568
  for (const neo of [false, true]) {
    for (const role of ['Rer', 'Cyber']) {
      for (const enabled of [true, false]) {
        test(`@smoke #3568 ${neo ? 'Neo' : 'classic'} Analysis AOR filter setting ${enabled} preserves ${role} saved selections`, async ({
          page,
        }) => {
          await installRerDutyShortStateMocks(page);
          await installAnalysisNeoApiMocks(page, { analysisAorFilterEnabled: enabled });
          await useRoles(page, [role]);
          const query = neo
            ? 'aors=7'
            : `state=${encodeURIComponent(JSON.stringify(toLegacyRerAnalysisQueryState({ aorsSelected: ['7'] })))}`;
          const endpoint = neo
            ? '**/api/rer/analysis/stats/count'
            : '**/api/rer-importer/get-inbox';
          const filteredRequest = page.waitForRequest(endpoint);
          await page.goto(`/rer-analysis${neo ? '-neo' : ''}?${query}`);
          expect((await filteredRequest).postDataJSON().selected_aors).toEqual([7]);
          const filter = neo
            ? page.getByRole('heading', { name: 'Смуги', exact: true })
            : page.getByText('смуги', { exact: true });
          if (enabled) await expect(filter).toBeVisible();
          else await expect(filter).toHaveCount(0);
          const reloadedRequest = page.waitForRequest(endpoint);
          await page.reload();
          expect((await reloadedRequest).postDataJSON().selected_aors).toEqual([7]);
          if (enabled) await expect(filter).toBeVisible();
          else await expect(filter).toHaveCount(0);
        });
      }
    }
  }

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
      if (host === 'duty') {
        await page
          .locator('button')
          .filter({ has: page.locator('i.bi-gear') })
          .click();
      }
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

  // Regression: https://github.com/echoua/echo/issues/3598
  test('#3598 ignores restored network filters without network-only requests in classic Analysis', async ({
    page,
  }) => {
    await page.clock.setFixedTime(new Date('2026-09-23T12:00:00Z'));
    const inbox = createClassicDutyNetworkInbox();
    await installRerDutyShortStateMocks(page, { hideNetworks: true, inboxResponse: inbox });
    await installAnalysisNeoApiMocks(page, { hideNetworks: true, inboxResponse: inbox });
    await useRoles(page, ['Rer']);
    const networkRequests: string[] = [];
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        path === '/api/rer/analysis/stats/networks' ||
        path === '/api/sigint/network-info-batch-id'
      ) {
        networkRequests.push(path);
      }
    });
    const inboxRequest = page.waitForRequest('**/api/rer-importer/get-inbox');
    const state = toLegacyRerAnalysisQueryState({ networksSelected: ['7'], withoutNetwork: true });
    await page.goto(`/rer-analysis?state=${encodeURIComponent(JSON.stringify(state))}`);
    const request = (await inboxRequest).postDataJSON();

    expect(request.selected_networks).toBeNull();
    expect(request.without_network).toBe(false);
    await expect(page.getByText('частоти', { exact: true })).toBeVisible();
    await expect(page.getByText('мережі', { exact: true })).toHaveCount(0);
    await expect(page.locator('app-navbar')).toBeAttached();
    await page.waitForTimeout(250);
    expect(networkRequests).toEqual([]);
  });

  for (const hideNetworks of [true, false]) {
    test(`#3598 classic Duty resumes deferred hydration only when networks are visible: ${hideNetworks}`, async ({
      page,
    }) => {
      const inbox = createClassicDutyNetworkInbox();
      await installRerDutyShortStateMocks(page, {
        inboxResponse: inbox,
        networkInfoResponse: [transformCamelToSnake(dutyNetwork)],
      });
      await useRoles(page, ['Rer']);
      let releaseSettings!: () => void;
      const settingsReady = new Promise<void>((resolve) => {
        releaseSettings = resolve;
      });
      await page.route('**/api/system-settings/current', async (route) => {
        await settingsReady;
        await route.fulfill({ json: systemSettingsCurrentResponse({ hideNetworks }) });
      });
      const networkRequests: string[] = [];
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/sigint/network-info-batch-id') {
          networkRequests.push(request.url());
        }
      });
      await page.goto('/rer-duty');
      await expect(
        page.getByText('Analysis summary fixture message', { exact: true }),
      ).toBeVisible();
      await expect(page.getByText('Analysis Unit', { exact: true })).toBeVisible();
      expect(networkRequests).toEqual([]);
      releaseSettings();
      if (hideNetworks) {
        await page.waitForTimeout(1500);
        expect(networkRequests).toEqual([]);
        await expect(page.getByText('Analysis Unit', { exact: true })).toBeVisible();
      } else {
        await expect.poll(() => networkRequests.length).toBe(1);
        await expect(page.getByText(/Duty recovery network/)).toBeVisible();
      }
    });
  }

  test('#3598 classic Duty retries failed network hydration after a cooldown', async ({ page }) => {
    const inbox = createClassicDutyNetworkInbox();
    await installRerDutyShortStateMocks(page, { inboxResponse: inbox });
    await useRoles(page, ['Rer']);
    let networkRequests = 0;
    await page.route('**/api/sigint/network-info-batch-id', async (route) => {
      networkRequests += 1;
      await route.fulfill(
        networkRequests === 1
          ? { status: 503, json: {} }
          : { json: [transformCamelToSnake(dutyNetwork)] },
      );
    });
    await page.goto('/rer-duty');
    await expect.poll(() => networkRequests).toBe(1);
    await page.waitForTimeout(1500);
    expect(networkRequests).toBe(1);
    await expect(page.getByText(/Duty recovery network/)).toBeVisible({ timeout: 10000 });
    expect(networkRequests).toBe(2);
    await page.waitForTimeout(1500);
    expect(networkRequests).toBe(2);
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
