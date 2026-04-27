import type { Page, Route } from '@playwright/test';

export type RouteLoadSuite = 'callsigns' | 'palitra' | 'messenger' | 'duty';

export type RouteLoadMockOptions = {
  delayMs?: number;
};

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

async function fulfillJson(route: Route, body: unknown, delayMs = 0): Promise<void> {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  await route.fulfill({
    contentType: 'application/json; charset=utf-8',
    body: jsonBody(body),
  });
}

function emptyUserResponse() {
  return {
    name: 'operator',
    roles: ['Rer', 'Admin'],
    sigint_zone_id: null,
    organism_id: null,
    delta_login: null,
    goi_configured_for_organism: false,
    goi_full_access_for_organism: false,
    goi_host: null,
    goi_integrations: [],
  };
}

function emptyUserSettingsResponse() {
  return {
    tagsLayout: 'compact',
    disableAutoScroll: false,
  };
}

function emptySystemSettingsResponse() {
  return {
    id: null,
    rer_analysis_units_exact_match_only_default: false,
    rer_duty_test_enabled: false,
    rer_duty_insert_historical_interceptions: false,
    rer_duty_test_since_ms: 0,
    rer_duty_test_limit: 1,
    rer_duty_poll_interval_sec: 1,
  };
}

function emptyServerInfoResponse() {
  return {
    mode: '',
    public_host: '',
    grafana_address: '',
    feature_delta: false,
    feature_analysis_map: false,
    feature_strict_networks: false,
    version: '',
  };
}

function emptyCallsignsResponse() {
  return {
    show_load_more: false,
    callsigns: [],
  };
}

function emptySourcesResponse() {
  return {
    sources: [],
  };
}

function emptyCallsignUnitStatsResponse() {
  return {
    units: [],
  };
}

function emptyPalitraListResponse() {
  return [];
}

function emptyMyScopeResponse() {
  return {};
}

function emptyLoginsResponse() {
  return {
    users: [],
  };
}

function emptyOrganismsResponse() {
  return [];
}

function emptyAorsResponse() {
  return [];
}

function emptyMessengerAccountsResponse() {
  return {
    accounts: [],
  };
}

function emptyDutyInboxResponse() {
  return {
    inbox_items: [],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

function emptyDutyInboxCountResponse() {
  return {
    quantity: 0,
    first_element_ts: null,
  };
}

function emptyDutyLatestSendersResponse() {
  return {
    data: {},
  };
}

function emptyDutyTagsResponse() {
  return [];
}

function emptyDutySavedFiltersResponse() {
  return [];
}

function emptyDutyPostStatsResponse() {
  return {
    posts: [],
  };
}

function emptyDutySignalGroupBatchResponse() {
  return {
    data: [],
  };
}

function emptyDutyLongPollResponse() {
  return {
    events: [],
    last_event_id: null,
  };
}

async function routeCallsingsApi(route: Route, pathname: string, delayMs: number): Promise<boolean> {
  if (pathname === '/api/user') {
    await fulfillJson(route, emptyUserResponse());
    return true;
  }

  if (pathname === '/api/sigint/units') {
    await fulfillJson(route, { units: [] });
    return true;
  }

  if (pathname === '/api/sigint/sources') {
    await fulfillJson(route, emptySourcesResponse());
    return true;
  }

  if (pathname === '/api/sigint/callsign/unit-stats') {
    await fulfillJson(route, emptyCallsignUnitStatsResponse());
    return true;
  }

  if (pathname === '/api/sigint/callsigns') {
    await fulfillJson(route, emptyCallsignsResponse(), delayMs);
    return true;
  }

  return false;
}

async function routePalitraApi(route: Route, pathname: string, delayMs: number): Promise<boolean> {
  if (pathname === '/api/user') {
    await fulfillJson(route, emptyUserResponse());
    return true;
  }

  if (pathname === '/api/palitra/list') {
    await fulfillJson(route, emptyPalitraListResponse(), delayMs);
    return true;
  }

  if (pathname === '/api/organism/my-scope') {
    await fulfillJson(route, emptyMyScopeResponse());
    return true;
  }

  if (pathname === '/api/logins') {
    await fulfillJson(route, emptyLoginsResponse());
    return true;
  }

  if (pathname === '/api/organisms') {
    await fulfillJson(route, emptyOrganismsResponse());
    return true;
  }

  if (pathname === '/api/sigint/aor') {
    await fulfillJson(route, emptyAorsResponse());
    return true;
  }

  if (pathname === '/api/organism/list-logins') {
    await fulfillJson(route, []);
    return true;
  }

  return false;
}

async function routeMessengerApi(route: Route, pathname: string, delayMs: number): Promise<boolean> {
  if (pathname === '/api/user') {
    await fulfillJson(route, emptyUserResponse());
    return true;
  }

  if (pathname === '/api/messenger/list') {
    await fulfillJson(route, emptyMessengerAccountsResponse(), delayMs);
    return true;
  }

  if (pathname === '/api/sigint/aor') {
    await fulfillJson(route, emptyAorsResponse());
    return true;
  }

  if (pathname === '/api/logins') {
    await fulfillJson(route, emptyLoginsResponse());
    return true;
  }

  return false;
}

async function routeDutyApi(route: Route, pathname: string, delayMs: number): Promise<boolean> {
  if (pathname === '/api/user') {
    await fulfillJson(route, emptyUserResponse());
    return true;
  }

  if (pathname === '/api/user/settings') {
    await fulfillJson(route, emptyUserSettingsResponse());
    return true;
  }

  if (pathname === '/api/system-settings/current') {
    await fulfillJson(route, emptySystemSettingsResponse());
    return true;
  }

  if (pathname === '/api-public/server-info') {
    await fulfillJson(route, emptyServerInfoResponse());
    return true;
  }

  if (pathname === '/api/rer-importer/latest-senders') {
    await fulfillJson(route, emptyDutyLatestSendersResponse());
    return true;
  }

  if (pathname === '/api/sigint/latest-frequencies') {
    await fulfillJson(route, []);
    return true;
  }

  if (pathname === '/api/rer-analysis/stats/posts') {
    await fulfillJson(route, emptyDutyPostStatsResponse());
    return true;
  }

  if (pathname === '/api/user/sigint-groups') {
    await fulfillJson(route, []);
    return true;
  }

  if (pathname === '/api/tags/tags-list') {
    await fulfillJson(route, emptyDutyTagsResponse());
    return true;
  }

  if (pathname === '/api/rer-importer/signal-group-batch') {
    await fulfillJson(route, emptyDutySignalGroupBatchResponse());
    return true;
  }

  if (pathname === '/api/rer/duty/saved-filters') {
    await fulfillJson(route, emptyDutySavedFiltersResponse());
    return true;
  }

  if (pathname === '/api/rer-importer/get-inbox-count') {
    await fulfillJson(route, emptyDutyInboxCountResponse());
    return true;
  }

  if (pathname === '/api/rer-importer/get-inbox') {
    await fulfillJson(route, emptyDutyInboxResponse(), delayMs);
    return true;
  }

  if (pathname === '/api/event-stream/long-poll') {
    await fulfillJson(route, emptyDutyLongPollResponse());
    return true;
  }

  return false;
}

export async function installRouteLoadComparisonMocks(
  page: Page,
  suite: RouteLoadSuite,
  options: RouteLoadMockOptions = {},
): Promise<void> {
  const delayMs = options.delayMs ?? 0;

  const handleApiRoute = async (route: Route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (resourceType !== 'fetch' && resourceType !== 'xhr') {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    const { pathname } = url;

    if (suite === 'callsigns' && (await routeCallsingsApi(route, pathname, delayMs))) return;
    if (suite === 'palitra' && (await routePalitraApi(route, pathname, delayMs))) return;
    if (suite === 'messenger' && (await routeMessengerApi(route, pathname, delayMs))) return;
    if (suite === 'duty' && (await routeDutyApi(route, pathname, delayMs))) return;

    await fulfillJson(route, {});
  };

  await page.route('**/api/**', handleApiRoute);
  await page.route('**/api-public/**', handleApiRoute);
}
