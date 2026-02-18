import type {
  AreaOfResponsibility,
  BookmarkAddReq,
  BookmarkRmReq,
  GroupAdminData,
  ImportantAddReq,
  ImportantRmReq,
  InboxDeleteReq,
  InboxMessage as InboxMessageType,
  InboxMessageTagsAddReq,
  InboxMessageTagsRmReq,
  InboxMessagesReq,
  InboxMessagesRsp,
  RerDutyFeedFilterState,
  SavedFilterDuty,
  SavedFilterDutyUpsertReq,
  SignalGroupEntry,
  SignalGroupStats,
  SignalProfilesRsp,
  Tag,
} from '../../../../Bindings';

const defaultGroupStats: SignalGroupStats = {
  activityLastDay: 0,
  activityLastWeek: 0,
};
import { postJson, postVoid } from './client';

/** Raw API response (snake_case) */
type InboxMessagesRspRaw = {
  inbox_items: Array<[number, InboxMessageType & { group_master_key?: string | null }]>;
  callsigns: InboxMessagesRsp['callsigns'];
  signal_profiles: Record<
    string,
    { given_name?: string | null; family_name?: string | null; givenName?: string | null; familyName?: string | null } | null
  >;
  signal_groups: Array<
    { master_key?: string; masterKey?: string; name?: string; [key: string]: unknown }
  >;
  freq_pelengs_summary: InboxMessagesRsp['freqPelengsSummary'];
};

function normalizeProfileEntry(
  v: InboxMessagesRspRaw['signal_profiles'][string]
): InboxMessagesRsp['signalProfiles'][string] {
  if (v == null) return null;
  return {
    givenName: v.givenName ?? v.given_name ?? null,
    familyName: v.familyName ?? v.family_name ?? null,
  };
}

function normalizeInboxMessage(
  m: InboxMessageType & { group_master_key?: string | null; network_ids?: number[] | null; location?: string | null }
): InboxMessageType {
  const raw = m as Record<string, unknown>;
  const groupMasterKey = (m.groupMasterKey ?? raw.group_master_key ?? null) as string | null;
  const networkIds = (m.networkIds ?? raw.network_ids ?? null) as number[] | null;
  const location = (m.location ?? raw.location ?? null) as string | null;
  return { ...m, groupMasterKey, networkIds, location };
}

function normalizeSignalGroupEntry(g: InboxMessagesRspRaw['signal_groups'][number]): SignalGroupEntry {
  const raw = g as Record<string, unknown>;
  const groupStats = (raw.groupStats ?? raw.group_stats) as SignalGroupStats | undefined;
  return {
    masterKey: (g.masterKey ?? g.master_key ?? '') as string,
    name: (g.name ?? '') as string,
    ignoreOperativny: (raw.ignoreOperativny ?? raw.ignore_operativny ?? false) as boolean,
    groupStats: groupStats && typeof groupStats.activityLastDay === 'number' ? groupStats : defaultGroupStats,
    adminData: (raw.adminData ?? raw.admin_data ?? null) as GroupAdminData | null,
    areasOfResponsibility: (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null) as AreaOfResponsibility[] | null,
  };
}

function mapRsp(raw: InboxMessagesRspRaw): InboxMessagesRsp {
  const signalProfiles: InboxMessagesRsp['signalProfiles'] = {};
  for (const [k, v] of Object.entries(raw.signal_profiles ?? {})) {
    signalProfiles[k] = normalizeProfileEntry(v);
  }
  const inboxItems: InboxMessagesRsp['inboxItems'] = (raw.inbox_items ?? []).map(([id, msg]) => [
    id,
    normalizeInboxMessage(msg),
  ]);
  const signalGroups: InboxMessagesRsp['signalGroups'] = (raw.signal_groups ?? []).map(
    normalizeSignalGroupEntry
  );
  return {
    inboxItems,
    callsigns: raw.callsigns,
    signalProfiles,
    signalGroups,
    freqPelengsSummary: raw.freq_pelengs_summary,
  };
}

/** Build request body with snake_case keys for /api/rer-importer/get-inbox */
function inboxMsgtoSnakeBody(req: InboxMessagesReq): Object {
  return {
    since_id_noninclusive: req.sinceIdNoninclusive,
    before_id_noninclusive: req.beforeIdNoninclusive,
    since_date_inclusive_ms: req.sinceDateInclusiveMs,
    till_date_inclusive_ms: req.tillDateInclusiveMs,
    only_show_unprocessed: req.onlyShowUnprocessed,
    checked_only: req.checkedOnly,
    selected_groups: req.selectedGroups,
    selected_senders: req.selectedSenders,
    denied_senders: req.deniedSenders,
    selected_freqs: req.selectedFreqs,
    selected_posts: req.selectedPosts,
    denied_posts: req.deniedPosts,
    denied_freqs: req.deniedFreqs,
    selected_callsigns: req.selectedCallsigns,
    selected_units: req.selectedUnits,
    selected_locations: req.selectedLocations,
    nolimit: req.nolimit,
    or_with_extended_form: req.orWithExtendedForm,
    load_latest: req.loadLatest,
    return_duplicates: req.returnDuplicates,
    or_bookmarked: req.orBookmarked,
    or_important: req.orImportant,
    or_with_coords: req.orWithCoords,
    newest_first: req.newestFirst,
    search: req.search,
    highlight_callsigns: req.highlightCallsigns,
    highlight_keywords: req.highlightKeywords,
    highlight_searchres: req.highlightSearchres,
    highlight_signals: req.highlightSignals,
    selected_tags: req.selectedTags,
    selected_aors: req.selectedAors,
    selected_networks: req.selectedNetworks,
    sort_by: req.sortBy,
    report_tags_only_this_unit: req.reportTagsOnlyThisUnit,
    ignore_imported_coords: req.ignoreImportedCoords,
    include_peleng_locations: req.includePelengLocations,
    units_exact_match_only: req.unitsExactMatchOnly,
    calculate_freq_pelengs_summary: req.calculateFreqPelengsSummary,
    skip_group_stats: req.skipGroupStats,
    filter_tags_option: req.filterTagsOption,
    page_id: req.pageId,
    without_model_tags: req.withoutModelTags,
  };
}

export async function fetchInboxMessages(req: InboxMessagesReq): Promise<InboxMessagesRsp> {
  const body = inboxMsgtoSnakeBody(req);
  const raw = await postJson<InboxMessagesRspRaw>('/api/rer-importer/get-inbox', body as any);
  return mapRsp(raw);
}

export type InboxMessagesDigestRsp = {
  quantity: number;
  firstElementTs: number | null;
};

export async function fetchInboxCount(
  req: InboxMessagesReq
): Promise<InboxMessagesDigestRsp> {
  const body = inboxMsgtoSnakeBody(req);
  const raw = await postJson<{ quantity: number; first_element_ts: number | null }>(
    '/api/rer-importer/get-inbox-count',
    body as any
  );
  return {
    quantity: raw.quantity,
    firstElementTs: raw.first_element_ts ?? null,
  };
}

// --- Bookmark / important / message actions ---

export async function bookmarkAdd(req: BookmarkAddReq): Promise<void> {
  await postVoid('/api/rer/bookmark/add', { message_id: req.messageId });
}

export async function bookmarkRemove(req: BookmarkRmReq): Promise<void> {
  await postVoid('/api/rer/bookmark/delete', { message_id: req.messageId });
}

export async function importantAdd(req: ImportantAddReq): Promise<void> {
  await postVoid('/api/rer/important/add', { message_id: req.messageId });
}

export async function importantRemove(req: ImportantRmReq): Promise<void> {
  await postVoid('/api/rer/important/delete', { message_id: req.messageId });
}

export async function deleteMessage(req: InboxDeleteReq): Promise<void> {
  await postVoid('/api/rer-importer/delete-message', { id: req.id });
}

export async function inboxMessageTagsAdd(req: InboxMessageTagsAddReq): Promise<void> {
  await postVoid('/api/tags/tags-add', { message_id: req.messageId, tag_id: req.tagId });
}

export async function inboxMessageTagsRm(req: InboxMessageTagsRmReq): Promise<void> {
  await postVoid('/api/tags/tags-rm', { message_id: req.messageId, tag_id: req.tagId });
}

// --- Saved filters (duty) ---

function rerDutyQueryStateWfToSnake(
  w: RerDutyFeedFilterState
): Record<string, unknown> {
  return {
    groups_selected: w.groupsSelected,
    senders_selected: w.sendersSelected,
    denied_senders: w.deniedSenders,
    freqs_selected: w.freqsSelected,
    freqs_denied: w.freqsDenied,
    posts_selected: w.postsSelected,
    posts_denied: w.postsDenied,
    last_viewed_message_id: w.lastViewedMessageId,
  };
}

export async function savedFiltersList(): Promise<SavedFilterDuty[]> {
  const raw = await postJson<Array<{ id: number; name: string; req: unknown }>>(
    '/api/rer/duty/saved-filters',
    {}
  );
  return (raw || []).map((r) => ({
    id: r.id,
    name: r.name,
    req: r.req as RerDutyFeedFilterState,
  }));
}

export async function savedFilterUpsert(
  req: SavedFilterDutyUpsertReq
): Promise<SavedFilterDuty[]> {
  const body = {
    name: req.name,
    req: rerDutyQueryStateWfToSnake(req.req),
  };
  const raw = await postJson<Array<{ id: number; name: string; req: unknown }>>(
    '/api/rer/duty/saved-filter-upsert',
    JSON.stringify(body)
  );
  return (raw || []).map((r) => ({
    id: r.id,
    name: r.name,
    req: r.req as RerDutyFeedFilterState,
  }));
}

export async function savedFilterDelete(filterId: number): Promise<void> {
  await postVoid('/api/rer/duty/saved-filter-delete', filterId);
}

// --- Filter metadata (tags, senders, frequencies, groups) ---

/** Tags list for display (tagId -> label). Fetched from POST /api/tags/tags-list. */
export async function getTagsList(): Promise<Record<number, string>> {
  const raw = await postJson<Array<[number, Tag]> | Array<{ tag_id: number; label: string }>>(
    '/api/tags/tags-list',
    {}
  );
  const map: Record<number, string> = {};
  if (Array.isArray(raw)) {
    raw.forEach((entry) => {
      if (Array.isArray(entry)) {
        const [id, tag] = entry;
        map[Number(id)] = (tag as Tag)?.label ?? `#${id}`;
      } else if (entry && typeof entry === 'object' && 'tag_id' in entry) {
        map[entry.tag_id] = entry.label ?? `#${entry.tag_id}`;
      }
    });
  }
  return map;
}

/** Latest sender profiles (UUID -> profile). */
export async function getLatestSenders(): Promise<SignalProfilesRsp> {
  const raw = await postJson<{ data: Record<string, { given_name?: string; family_name?: string; givenName?: string; familyName?: string } | null> }>(
    '/api/rer-importer/latest-senders',
    {}
  );
  const data: Record<string, SignalProfilesRsp['data'][string]> = {};
  if (raw?.data) {
    for (const [k, v] of Object.entries(raw.data)) {
      const entry = v as { given_name?: string; family_name?: string; givenName?: string; familyName?: string } | null;
      if (entry) {
        data[k] = {
          givenName: entry.givenName ?? entry.given_name ?? null,
          familyName: entry.familyName ?? entry.family_name ?? null,
        };
      } else {
        data[k] = null;
      }
    }
  }
  return { data };
}

/** Latest frequencies list. */
export async function getLatestFrequencies(): Promise<string[]> {
  const raw = await postJson<string[]>('/api/sigint/latest-frequencies', {});
  return Array.isArray(raw) ? raw : [];
}

/** User's sigint group keys (e.g. for filter dropdown). sinceDateInclusiveMs: optional ms, e.g. 2 days ago. */
export async function getUserSigintGroups(sinceDateInclusiveMs: number | null): Promise<string[]> {
  const body: Record<string, number> =
    sinceDateInclusiveMs != null ? { since_date_inclusive_ms: sinceDateInclusiveMs } : {};
  const raw = await postJson<string[]>('/api/user/sigint-groups', body);
  return Array.isArray(raw) ? raw : [];
}

/** Fetch group infos by master keys. */
export async function getGroupInfosBatch(masterKeys: string[]): Promise<SignalGroupEntry[]> {
  if (masterKeys.length === 0) return [];
  const body = {
    groups: masterKeys.map((masterKey) => ({ master_key: masterKey })),
    skip_group_stats: true,
  };
  const raw = await postJson<{ data: Array<Record<string, unknown>> }>(
    '/api/rer-importer/signal-group-batch',
    body
  );
  const arr = raw?.data ?? [];
  return arr.map((r: Record<string, unknown>) => ({
    masterKey: (r.master_key ?? r.masterKey) as string,
    name: (r.name ?? '') as string,
    ignoreOperativny: (r.ignore_operativny ?? r.ignoreOperativny ?? false) as boolean,
    groupStats: (r.group_stats ?? r.groupStats) as SignalGroupStats,
    adminData: (r.admin_data ?? r.adminData ?? null) as GroupAdminData | null,
    areasOfResponsibility: (r.areas_of_responsibility ?? r.areasOfResponsibility ?? null) as AreaOfResponsibility[] | null,
  }));
}
