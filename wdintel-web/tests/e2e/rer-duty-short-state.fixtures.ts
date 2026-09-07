import type { Page, Route } from '@playwright/test';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { networkSettingsResponse } from './fixture-responses';

type ShortStateFixtureOptions = {
  shortStateId?: string;
  shortState?: unknown;
  inboxResponse?: InboxMessagesRspRaw | null | Promise<InboxMessagesRspRaw | null>;
  inboxResponseForRequest?: (
    requestBody: unknown,
  ) => InboxMessagesRspRaw | Promise<InboxMessagesRspRaw>;
  inboxCountResponseForRequest?: (requestBody: unknown) =>
    | { quantity: number; first_element_ts: number | null }
    | Promise<{
        quantity: number;
        first_element_ts: number | null;
      }>;
  signalGroups?: string[];
  tagsResponse?: unknown[];
  networkInfoResponse?: unknown[];
  disableAutoScroll?: boolean;
  userSettingsResponse?:
    | { tagsLayout: string; disableAutoScroll: boolean }
    | Promise<{ tagsLayout: string; disableAutoScroll: boolean }>;
  userSettingsFailure?: boolean;
};

type ShortStateFixtureHandle = {
  getLastInboxRequest: () => unknown | null;
  systemSettingsReady: Promise<void>;
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
    id: 'operator',
    name: 'operator',
    roles: ['Rer', 'Admin'],
    sigint_zone_id: null,
    organism_id: null,
    delta_login: null,
    goi_configured_for_organism: false,
    goi_full_access_for_organism: false,
    goi_host: null,
    goi_integrations: [],
    last_release_seen: null,
  };
}

function emptyUserSettingsResponse(disableAutoScroll = false) {
  return {
    tagsLayout: 'compact',
    disableAutoScroll,
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
    rer_duty_test_replay_interval_sec: 1,
    short_url_enabled: false,
    support_non_rer_interceptions: false,
    default_neo_analysis: false,
    autofix_echoim_missing_messages: false,
    peleng_bounds_enabled: false,
    peleng_bounds_top_left_lat: null,
    peleng_bounds_top_left_lng: null,
    peleng_bounds_bottom_right_lat: null,
    peleng_bounds_bottom_right_lng: null,
    devices_section_enabled: false,
    sigint_comment_parsing_enabled: false,
    do_not_store_duplicate_echoim_failures: false,
    goi_association_message_uid_worker_enabled: false,
    report_chunking_hours: 1,
    limit_big_reports: false,
    enable_audio_transcription: false,
    show_classic_duty: false,
    show_classic_analysis: false,
    show_peleng_distance_to_battleline: false,
    hide_orbit_data: false,
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
  let resolveSystemSettingsReady!: () => void;
  const systemSettingsReady = new Promise<void>((resolve) => {
    resolveSystemSettingsReady = resolve;
  });

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
      if (options.userSettingsFailure) {
        await route.fulfill({ status: 500, body: 'Settings unavailable' });
        return;
      }
      await fulfillJson(
        route,
        await (options.userSettingsResponse ??
          emptyUserSettingsResponse(options.disableAutoScroll)),
      );
      return;
    }

    if (pathname === '/api/user/network-settings') {
      await fulfillJson(route, networkSettingsResponse());
      return;
    }

    if (pathname === '/api/system-settings/current') {
      await fulfillJson(route, emptySystemSettingsResponse());
      resolveSystemSettingsReady();
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
      await fulfillJson(route, options.signalGroups ?? []);
      return;
    }

    if (pathname === '/api/tags/tags-list') {
      await fulfillJson(route, options.tagsResponse ?? emptyDutyTagsResponse());
      return;
    }

    if (pathname === '/api/sigint/network-info-batch-id') {
      await fulfillJson(route, options.networkInfoResponse ?? []);
      return;
    }

    if (pathname === '/api/rer-importer/signal-group-batch') {
      await fulfillJson(route, {
        data: (options.signalGroups ?? []).map((master_key) => ({ master_key, name: master_key })),
      });
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
      const requestBody = request.postDataJSON();
      const response = options.inboxCountResponseForRequest
        ? await options.inboxCountResponseForRequest(requestBody)
        : emptyDutyInboxCountResponse();
      await fulfillJson(route, response);
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox') {
      lastInboxRequest = request.postDataJSON();
      const response = options.inboxResponseForRequest
        ? await options.inboxResponseForRequest(lastInboxRequest)
        : ((await options.inboxResponse) ?? emptyDutyInboxResponse());
      await fulfillJson(route, response);
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
    systemSettingsReady,
  };
}
