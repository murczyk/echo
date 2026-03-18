import type {
  AnalysisStatsReq,
  AreaOfResponsibility,
  BookmarkAddReq,
  BookmarkRmReq,
  GroupAdminData,
  ImportantAddReq,
  ImportantRmReq,
  InboxCommentSaveReq,
  InboxDeleteReq,
  InboxMessage as InboxMessageType,
  InboxMessageTag,
  InboxMessageTagsAddReq,
  InboxMessageTagsRmReq,
  InboxMessagesReq,
  InboxMessagesRsp,
  PostStatsRsp,
  RerDutyQueryStateWf as RerDutyFeedFilterState,
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
import { transformSnakeToCamel, transformCamelToSnake } from '../../../snake-to-camel';
import { emptyArrToNull } from '../../utils/misc';
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

type InboxMessageTagRaw = {
  id?: number;
  tag_id?: number;
  tagId?: number;
  confidence?: number;
  login?: string | null;
  model?: string | null;
  organism_id?: number | null;
  organismId?: number | null;
};

function normalizeInboxMessageTag(t: InboxMessageTagRaw): InboxMessageTag {
  return {
    id: (t.id ?? 0) as number,
    tagId: (t.tagId ?? t.tag_id ?? 0) as number,
    confidence: (t.confidence ?? 0) as number,
    login: (t.login ?? null) as string | null,
    model: (t.model ?? null) as string | null,
    organismId: (t.organismId ?? t.organism_id ?? null) as number | null,
  };
}

function normalizeInboxMessage(
  m: InboxMessageType & {
    group_master_key?: string | null;
    network_ids?: number[] | null;
    location?: string | null;
    extended_form?: string | null;
    inbox_tags?: InboxMessageTagRaw[] | null;
    text_marked?: InboxMessageType['textMarked'];
    point_tokens?: InboxMessageType['pointTokens'];
  }
): InboxMessageType {
  const raw = m as Record<string, unknown>;
  const groupMasterKey = (m.groupMasterKey ?? raw.group_master_key ?? null) as string | null;
  const networkIds = (m.networkIds ?? raw.network_ids ?? null) as number[] | null;
  const location = (m.location ?? raw.location ?? null) as string | null;
  const extendedForm = (m.extendedForm ?? raw.extended_form ?? null) as string | null;
  const rawInboxTags = (raw.inbox_tags ?? m.inboxTags ?? null) as InboxMessageTagRaw[] | null | undefined;
  const inboxTags: InboxMessageType['inboxTags'] =
    rawInboxTags != null && Array.isArray(rawInboxTags)
      ? rawInboxTags.map(normalizeInboxMessageTag)
      : null;
  const textMarked = (raw.text_marked ?? m.textMarked ?? null) as InboxMessageType['textMarked'];
  const rawPointTokens = (raw.point_tokens ?? m.pointTokens ?? null) as InboxMessageType['pointTokens'];
  const pointTokens =
    rawPointTokens != null && Array.isArray(rawPointTokens) ? rawPointTokens : null;
  return { ...m, groupMasterKey, networkIds, location, extendedForm, inboxTags, textMarked, pointTokens };
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
    selected_groups: emptyArrToNull(req.selectedGroups),
    selected_senders: emptyArrToNull(req.selectedSenders),
    denied_senders: emptyArrToNull(req.deniedSenders),
    selected_freqs: emptyArrToNull(req.selectedFreqs),
    selected_posts: emptyArrToNull(req.selectedPosts),
    denied_posts: emptyArrToNull(req.deniedPosts),
    denied_freqs: emptyArrToNull(req.deniedFreqs),
    selected_callsigns: emptyArrToNull(req.selectedCallsigns),
    selected_units: emptyArrToNull(req.selectedUnits),
    selected_locations: emptyArrToNull(req.selectedLocations),
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
    highlight_points: req.highlightPoints,
    selected_tags: emptyArrToNull(req.selectedTags),
    selected_aors: emptyArrToNull(req.selectedAors),
    selected_networks: emptyArrToNull(req.selectedNetworks),
    metadata_cc: req.metadataCc,
    metadata_sender: req.metadataSender,
    metadata_receiver: req.metadataReceiver,
    metadata_hash: req.metadataHash,
    only_with_metadata: req.onlyWithMetadata,
    without_metadata: req.withoutMetadata,
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

export async function commentSave(req: InboxCommentSaveReq): Promise<void> {
  await postVoid('/api/rer-importer/comment-save', {
    message_id: req.messageId,
    comment: req.comment,
  });
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
): Record<string, string[] | number | null> {
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
    body
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
export async function getTagsMapForDisplay(): Promise<Record<number, Tag>> {
  const raw = await postJson<Array<[number, Tag]>>('/api/tags/tags-list', {});
  const map: Record<number, Tag> = {};
  for (const [i, tagRecord] of Object.entries(raw)) {
    const nTag = transformSnakeToCamel<Tag>(tagRecord[1]);
    map[Number(tagRecord[0])] = nTag;
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

/** Posts list for duty filter (from analysis stats). */
export async function getPostsList(): Promise<string[]> {
  const now = Date.now();
  const sinceMs = now - 14 * 24 * 60 * 60 * 1000;
  const tillMs = now + 24 * 60 * 60 * 1000;
  const body: AnalysisStatsReq = {
    sinceDateInclusiveMs: sinceMs,
    tillDateNoninclusiveMs: tillMs,
    selectedGroups: null,
    selectedSenders: null,
    selectedFreqs: null,
    selectedPosts: null,
    selectedCallsigns: null,
    selectedUnits: null,
    selectedLocations: null,
    selectedAors: null,
    orWithExtendedForm: null,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    search: null,
    selectedTags: null,
    selectedNetworks: null,
    withoutNetwork: null,
    metadataCc: null,
    metadataSender: null,
    metadataReceiver: null,
    metadataHash: null,
    onlyWithMetadata: null,
    withoutMetadata: null,
    includePelengLocations: null,
    unitsExactMatchOnly: null,
    filterTagsOption: null,
    withoutModelTags: null,
    reportTagsOnlyThisUnit: null,
  };
  const snakeBody = transformCamelToSnake<AnalysisStatsReq>(body);
  const raw = await postJson<PostStatsRsp>('/api/rer/analysis/stats/posts', snakeBody);
  const posts = raw?.posts ?? [];
  return posts.map((p) => p.post);
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
