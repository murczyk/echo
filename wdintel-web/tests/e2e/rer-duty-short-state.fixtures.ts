import type { Page, Route } from '@playwright/test';
import type { MessageTimeBasis } from '../../src/ts/react/services/api/user-settings';
import type { InboxMessagesRspRaw } from '../../src/ts/react/services/api/inbox-messages';
import { networkSettingsResponse, systemSettingsCurrentResponse } from './fixture-responses';

type ShortStateFixtureOptions = {
  enableAudioTranscription?: boolean;
  dutyExcludeMenuEnabled?: boolean;
  analysisAorFilterEnabled?: boolean;
  rerReportEligible?: boolean;
  rerReportEnabled?: boolean;
  hideNetworks?: boolean;
  systemSettingsFailure?: boolean;
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
  keywordSets?: unknown[];
  latestFrequencies?: string[];
  userSettingsResponse?:
    | { tagsLayout: string; disableAutoScroll: boolean; messageSortBy?: MessageTimeBasis }
    | Promise<{ tagsLayout: string; disableAutoScroll: boolean; messageSortBy?: MessageTimeBasis }>;
  userSettingsFailure?: boolean;
};

type ShortStateFixtureHandle = {
  getLastInboxRequest: () => unknown | null;
  getSavedFilters: () => Array<{ id: number; name: string; req: unknown }>;
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

function emptyUserResponse(rerReportEligible = false) {
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
    rer_report_eligible: rerReportEligible,
  };
}

function emptyUserSettingsResponse(disableAutoScroll = false) {
  return {
    tagsLayout: 'compact',
    disableAutoScroll,
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
    feature_my_admin_groups_edit: false,
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
          groupsSelected: ['group-1'],
          sendersSelected: null,
          deniedSenders: null,
          freqsSelected: null,
          freqsDenied: null,
          postsSelected: null,
          postsDenied: null,
          lastViewedMessageId: null,
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
  let currentShortState = options.shortState ?? defaultShortState();
  let currentSavedFilters: Array<{ id: number; name: string; req: unknown }> = [];
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

    if (pathname === '/api/rer-importer/message-replies') {
      await fulfillJson(route, { replies: [], reply_messages: [] });
      return;
    }

    if (pathname === '/api/user') {
      await fulfillJson(route, emptyUserResponse(options.rerReportEligible));
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
      if (options.systemSettingsFailure) {
        resolveSystemSettingsReady();
        await route.fulfill({ status: 500, body: 'System settings unavailable' });
        return;
      }
      await fulfillJson(
        route,
        systemSettingsCurrentResponse({
          enableAudioTranscription: options.enableAudioTranscription,
          shortUrlEnabled: true,
          dutyExcludeMenuEnabled: options.dutyExcludeMenuEnabled,
          analysisAorFilterEnabled: options.analysisAorFilterEnabled,
          rerReportEnabled: options.rerReportEnabled,
          hideNetworks: options.hideNetworks,
        }),
      );
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
      await fulfillJson(route, options.latestFrequencies ?? []);
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

    if (pathname === '/api/organism/keyword-sets') {
      await fulfillJson(route, options.keywordSets ?? []);
      return;
    }

    if (pathname === '/api/rer/duty/saved-filters') {
      await fulfillJson(route, currentSavedFilters);
      return;
    }

    if (pathname === '/api/rer/duty/saved-filter-upsert') {
      const data = request.postDataJSON() as { name: string; req: unknown };
      const existing = currentSavedFilters.find((savedFilter) => savedFilter.name === data.name);
      if (existing) {
        currentSavedFilters = currentSavedFilters.map((savedFilter) =>
          savedFilter.id === existing.id ? { ...savedFilter, req: data.req } : savedFilter,
        );
      } else {
        const nextId = Math.max(0, ...currentSavedFilters.map(({ id }) => id)) + 1;
        currentSavedFilters = [
          ...currentSavedFilters,
          { id: nextId, name: data.name, req: data.req },
        ];
      }
      await fulfillJson(route, currentSavedFilters);
      return;
    }

    if (pathname === '/api/rer/duty/saved-filter-rename') {
      const data = request.postDataJSON() as { id: number; name: string };
      currentSavedFilters = currentSavedFilters.map((savedFilter) =>
        savedFilter.id === data.id ? { ...savedFilter, name: data.name } : savedFilter,
      );
      await fulfillJson(route, {});
      return;
    }

    if (pathname === '/api/rer/duty/saved-filter-delete') {
      const id = Number(request.postDataJSON());
      currentSavedFilters = currentSavedFilters.filter((f) => f.id !== id);
      await fulfillJson(route, {});
      return;
    }

    if (pathname === '/api/rer/important/add') {
      await fulfillJson(route, { important: true });
      return;
    }

    if (pathname === '/api/rer/important/delete') {
      await fulfillJson(route, { important: false });
      return;
    }

    if (pathname === '/api/rer-importer/delete-message') {
      await fulfillJson(route, {});
      return;
    }

    if (pathname === '/api/rer-duty/filters/get') {
      const payload = request.postDataJSON() as { id?: string } | null;
      if (payload?.id && payload.id !== shortStateId) {
        await route.fulfill({ status: 404, body: 'Not found' });
        return;
      }
      await fulfillJson(route, { state: currentShortState });
      return;
    }

    if (pathname === '/api/rer-duty/filters/create') {
      const payload = request.postDataJSON() as { state?: unknown } | null;
      if (payload?.state) {
        currentShortState = payload.state;
      }
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
    getSavedFilters: () => currentSavedFilters,
    systemSettingsReady,
  };
}
