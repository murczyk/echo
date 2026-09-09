import type { Page, Route } from '@playwright/test';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { networkSettingsResponse } from './fixture-responses';

type AnalysisNeoMockOptions = {
  enableAudioTranscription?: boolean;
  summaryDelayMs?: number;
  sidebarDelayMs?: number;
  inboxDelayMs?: number;
  inboxResponse?: InboxMessagesRspRaw | null;
  signalGroups?: string[];
  networkInfoResponse?: unknown[];
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

function emptyCountResponse() {
  return {
    count_overall: 2,
    count_selected: 1,
    groups_count: 0,
    senders_count: 0,
    freqs_count: 1,
    posts_count: 0,
    callsigns_count: 0,
    units_count: 0,
    units_exact_matches_count: 0,
    units_non_exact_matches_count: 0,
    locations_count: 0,
    tags_count: 0,
    aors_count: 0,
    networks_count: 0,
  };
}

function emptyInboxResponse() {
  return {
    inbox_items: [],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

export function createEmptyInboxResponse(): InboxMessagesRspRaw {
  return emptyInboxResponse();
}

export function createLoadedInboxResponse(): InboxMessagesRspRaw {
  return {
    inbox_items: [
      [
        101,
        {
          messageUid: 'analysis-summary-e2e-message',
          text: 'Analysis summary fixture message',
          media: [],
          images: [],
          imageRecognized: [],
          date: '13.07.2026',
          time: '12:34',
          freq: '123.4',
          coords: null,
          callsigns: [],
          callsignsAlg2: [],
          checked: false,
          important: false,
          bookmarked: false,
          timestamp: 1_720_000_000_000,
          groupMasterKey: 'analysis-summary-e2e-group',
          sender: 'Analysis Sender',
          extendedForm: null,
          messageComments: [],
          post: null,
          postId: null,
          unit: 'Analysis Unit',
          callsignTokens: null,
          signalTokens: null,
          pointTokens: null,
          noHeadersBody: null,
          keywordTokens: null,
          textMarked: null,
          datasourceId: null,
          location: null,
          tags: null,
          networkIds: null,
          inboxTags: null,
          metadata: [],
        } as never,
      ],
    ],
    callsigns: [],
    signal_profiles: {},
    signal_groups: [],
    freq_pelengs_summary: null,
    page_limit: 20,
  };
}

export function createOverflowingInboxResponse(): InboxMessagesRspRaw {
  const response = createLoadedInboxResponse();
  const [, message] = response.inbox_items[0];
  return {
    ...response,
    inbox_items: Array.from({ length: 20 }, (_, index) => [
      101 + index,
      {
        ...message,
        messageUid: `analysis-narrow-e2e-message-${index}`,
        text: `Analysis narrow fixture message ${index}`,
      },
    ]) as InboxMessagesRspRaw['inbox_items'],
  };
}

function emptyFreqsResponse() {
  return {
    freqs: [
      {
        freq: '123.4',
        count: 1,
        is_new: false,
      },
    ],
  };
}

function emptySummaryResponse() {
  return {
    rows: [
      {
        freq: '123.4',
        count: 1,
        callsigns: ['ALPHA'],
        units: ['1'],
        locations: ['Kyiv'],
        coords: [],
        locality_coords: [],
      },
    ],
  };
}

function emptyUnitsResponse() {
  return {
    show_load_more: false,
    units: [
      {
        id: 1,
        company: '',
        battalion: '',
        regiment: '',
        division: '',
        army: '',
        comment: '',
        name: '1',
        active: true,
        created_at: 0,
        created_by: 'e2e',
      },
    ],
  };
}

function emptyNetworksResponse() {
  return {
    networks: [],
    network_names: [],
  };
}

function emptyMapResponse() {
  return {
    network_units: [],
    points: [],
  };
}

function emptyPalitrasResponse() {
  return [];
}

function emptySavedFiltersResponse() {
  return [];
}

function emptyUserSettingsResponse() {
  return {
    tagsLayout: 'compact',
    disableAutoScroll: false,
  };
}

function emptySystemSettingsResponse(enableAudioTranscription = false) {
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
    enable_audio_transcription: enableAudioTranscription,
    show_classic_duty: false,
    show_classic_analysis: false,
    show_peleng_distance_to_battleline: false,
    hide_orbit_data: false,
  };
}

function emptyCallsignInfoBatchResponse() {
  return [];
}

function emptyLongPollResponse() {
  return {
    events: [],
    last_event_id: null,
  };
}

export async function installAnalysisNeoApiMocks(
  page: Page,
  options: AnalysisNeoMockOptions = {},
): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (resourceType !== 'fetch' && resourceType !== 'xhr') {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === '/api/user') {
      await fulfillJson(route, {
        id: 'analysis-tester',
        name: 'analysis-tester',
        roles: ['Rer'],
        sigint_zone_id: null,
        organism_id: null,
        delta_login: null,
        goi_configured_for_organism: false,
        goi_full_access_for_organism: false,
        goi_host: null,
        goi_integrations: [],
        last_release_seen: null,
      });
      return;
    }

    if (pathname === '/api/system-settings/current') {
      await fulfillJson(route, emptySystemSettingsResponse(options.enableAudioTranscription));
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

    if (pathname === '/api/tags/tags-list') {
      await fulfillJson(route, []);
      return;
    }

    if (pathname === '/api/user/sigint-groups') {
      await fulfillJson(route, options.signalGroups ?? []);
      return;
    }

    if (pathname === '/api/rer-importer/signal-group-batch') {
      await fulfillJson(route, {
        data: (options.signalGroups ?? []).map((master_key) => ({ master_key, name: master_key })),
      });
      return;
    }

    if (pathname === '/api/rer/analysis/saved-filters') {
      await fulfillJson(route, emptySavedFiltersResponse());
      return;
    }

    if (pathname === '/api/rer/analysis/stats/count') {
      await fulfillJson(route, emptyCountResponse());
      return;
    }

    if (pathname === '/api/rer/analysis/stats/freqs') {
      await fulfillJson(route, emptyFreqsResponse());
      return;
    }

    if (pathname === '/api/rer/analysis/stats/groups') {
      await fulfillJson(route, { groups: [], group_names: [] });
      return;
    }

    if (pathname === '/api/rer/analysis/stats/senders') {
      await fulfillJson(route, { senders: [], sender_names: {} });
      return;
    }

    if (pathname === '/api/rer/analysis/stats/callsigns') {
      await fulfillJson(route, { callsigns: [] }, options.sidebarDelayMs);
      return;
    }

    if (pathname === '/api/rer/analysis/stats/units') {
      await fulfillJson(route, { units: [] }, options.sidebarDelayMs);
      return;
    }

    if (pathname === '/api/rer/analysis/stats/locations') {
      await fulfillJson(route, { locations: [] }, options.sidebarDelayMs);
      return;
    }

    if (pathname === '/api/rer/analysis/stats/tags') {
      await fulfillJson(route, { tags: [] });
      return;
    }

    if (pathname === '/api/rer/analysis/stats/networks') {
      await fulfillJson(route, { networks: [], network_names: [] });
      return;
    }

    if (pathname === '/api/rer/analysis/stats/aors') {
      await fulfillJson(route, { aors: [], aor_names: [] });
      return;
    }

    if (pathname === '/api/rer/analysis/stats/metadata') {
      await fulfillJson(route, { ccs: [], senders: [], receivers: [], hashes: [] });
      return;
    }

    if (pathname === '/api/rer/analysis/summary-table-freq') {
      await fulfillJson(route, emptySummaryResponse(), options.summaryDelayMs);
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox') {
      await fulfillJson(
        route,
        options.inboxResponse ?? createEmptyInboxResponse(),
        options.inboxDelayMs,
      );
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox-map') {
      await fulfillJson(route, emptyMapResponse());
      return;
    }

    if (pathname === '/api/palitra/v2/list-map') {
      await fulfillJson(route, emptyPalitrasResponse());
      return;
    }

    if (pathname === '/api/sigint/units') {
      await fulfillJson(route, emptyUnitsResponse());
      return;
    }

    if (pathname === '/api/sigint/network-info-batch-id') {
      await fulfillJson(route, options.networkInfoResponse ?? []);
      return;
    }

    if (pathname === '/api/rer/callsign-info-batch') {
      await fulfillJson(route, emptyCallsignInfoBatchResponse(), options.sidebarDelayMs);
      return;
    }

    if (pathname === '/api/rer/analysis/new-callsigns') {
      await fulfillJson(route, { not_seen_24h: [], not_seen_7days: [], not_seen_30days: [] });
      return;
    }

    if (pathname === '/api/event-stream/long-poll') {
      await fulfillJson(route, emptyLongPollResponse());
      return;
    }

    if (pathname === '/api/sigint/freqs/daily') {
      await fulfillJson(route, { daily: [] });
      return;
    }

    await fulfillJson(route, {});
  });
}
