import type { Page, Route } from '@playwright/test';
import { networkSettingsResponse } from './fixture-responses';

type ShortStateFixtureOptions = {
  shortStateId?: string;
  shortState?: unknown;
};

type ShortStateFixtureHandle = {
  getLastInboxRequest: () => unknown | null;
};

function jsonBody(body: unknown): string {
  return JSON.stringify(body);
}

async function fulfillJson(route: Route, body: unknown): Promise<void> {
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

function serverInfoResponse() {
  return {
    mode: 'debug',
    public_host: 'echo.localhost',
    grafana_address: 'https://echo.localhost/grafana',
    feature_delta: true,
    feature_analysis_map: true,
    feature_strict_networks: false,
    version: 'test',
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

function defaultShortState() {
  return {
    waterfalls: [
      [
        'mf-0',
        {
          groups_selected: ['group-1'],
          senders_selected: null,
          denied_senders: null,
          freqs_selected: null,
          freqs_denied: null,
          posts_selected: null,
          posts_denied: null,
          last_viewed_message_id: null,
        },
      ],
    ],
  };
}

export async function installRerDutyShortStateMocks(
  page: Page,
  options: ShortStateFixtureOptions = {},
): Promise<ShortStateFixtureHandle> {
  const shortStateId = options.shortStateId ?? 'short-1';
  const shortState = options.shortState ?? defaultShortState();
  let lastInboxRequest: unknown | null = null;

  const handleApiRoute = async (route: Route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (resourceType !== 'fetch' && resourceType !== 'xhr') {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === '/api/user') {
      await fulfillJson(route, emptyUserResponse());
      return;
    }

    if (pathname === '/api/user/settings') {
      await fulfillJson(route, emptyUserSettingsResponse());
      return;
    }

    if (pathname === '/api/user/network-settings') {
      await fulfillJson(route, networkSettingsResponse());
      return;
    }

    if (pathname === '/api/system-settings/current') {
      await fulfillJson(route, emptySystemSettingsResponse());
      return;
    }

    if (pathname === '/api-public/server-info') {
      await fulfillJson(route, serverInfoResponse());
      return;
    }

    if (pathname === '/api/rer-importer/latest-senders') {
      await fulfillJson(route, emptyDutyLatestSendersResponse());
      return;
    }

    if (pathname === '/api/sigint/latest-frequencies') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/api/rer/analysis/stats/posts') {
      await fulfillJson(route, emptyDutyPostStatsResponse());
      return;
    }

    if (pathname === '/api/user/sigint-groups') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/api/tags/tags-list') {
      await fulfillJson(route, emptyDutyTagsResponse());
      return;
    }

    if (pathname === '/api/rer-importer/signal-group-batch') {
      await fulfillJson(route, emptyDutySignalGroupBatchResponse());
      return;
    }

    if (pathname === '/api/rer/duty/saved-filters') {
      await fulfillJson(route, emptyDutySavedFiltersResponse());
      return;
    }

    if (pathname === '/api/rer-duty/filters/get') {
      const payload = request.postDataJSON() as { id?: string } | null;
      if (payload?.id && payload.id !== shortStateId) {
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }
      await fulfillJson(route, { state: shortState });
      return;
    }

    if (pathname === '/api/rer-duty/filters/create') {
      await fulfillJson(route, { id: shortStateId });
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox-count') {
      await fulfillJson(route, emptyDutyInboxCountResponse());
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox') {
      lastInboxRequest = request.postDataJSON();
      await fulfillJson(route, emptyDutyInboxResponse());
      return;
    }

    if (pathname === '/api/event-stream/long-poll') {
      await fulfillJson(route, emptyDutyLongPollResponse());
      return;
    }

    await fulfillJson(route, {});
  };

  await page.route('**/api/**', handleApiRoute);
  await page.route('**/api-public/**', handleApiRoute);

  return {
    getLastInboxRequest: () => lastInboxRequest,
  };
}
