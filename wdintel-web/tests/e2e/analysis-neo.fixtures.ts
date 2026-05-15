import type { Page, Route } from '@playwright/test';
import { networkSettingsResponse } from './fixture-responses';

type AnalysisNeoMockOptions = {
  summaryDelayMs?: number;
  sidebarDelayMs?: number;
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

function emptyCallsignInfoBatchResponse() {
  return [];
}

function emptyLongPollResponse() {
  return {
    events: [],
    last_event_id: null,
  };
}

export async function installAnalysisNeoApiMocks(page: Page, options: AnalysisNeoMockOptions = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const resourceType = request.resourceType();
    if (resourceType !== 'fetch' && resourceType !== 'xhr') {
      await route.continue();
      return;
    }

    const url = new URL(request.url());
    const { pathname } = url;

    if (pathname === '/api/user/settings') {
      await fulfillJson(route, emptyUserSettingsResponse());
      return;
    }

    if (pathname === '/api/user/network-settings') {
      await fulfillJson(route, networkSettingsResponse());
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
      await fulfillJson(route, emptyInboxResponse());
      return;
    }

    if (pathname === '/api/rer-importer/get-inbox-map') {
      await fulfillJson(route, emptyMapResponse());
      return;
    }

    if (pathname === '/api/palitra/v2/list') {
      await fulfillJson(route, emptyPalitrasResponse());
      return;
    }

    if (pathname === '/api/sigint/units') {
      await fulfillJson(route, emptyUnitsResponse());
      return;
    }

    if (pathname === '/api/sigint/network-info-batch-id') {
      await fulfillJson(route, []);
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
