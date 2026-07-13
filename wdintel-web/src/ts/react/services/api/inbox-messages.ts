import type {
  AreaOfResponsibility,
  ContentNode,
  GroupAdminData,
  InboxMessage as InboxMessageType,
  InboxMessageMetadata,
  InboxMessageTag,
  InboxMessagesReq,
  MessageIdsReq,
  InboxMessagesRsp,
  InterseptionKind,
  MessageComment,
  MessageMediaInfo,
  MessageIdsRsp,
  SignalGroupEntry,
  SignalGroupStats,
  SignalProfilesRsp,
} from '../../../../Bindings';
import { emptyArrToNull, isNullOrUndefined, isPresent } from '../../utils/misc';
import { postJson } from './client';
import type { RequestOptions } from './client';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

const defaultGroupStats: SignalGroupStats = {
  activityLastDay: 0,
  activityLastWeek: 0,
};

function normalizeInterseptionKind(raw: Record<string, unknown>): InterseptionKind {
  const interseptionKind = raw.interseptionKind ?? raw.interseption_kind;
  if (interseptionKind === 'rer' || interseptionKind === 'other') return interseptionKind;
  return (raw.isRer ?? raw.is_rer ?? true) ? 'rer' : 'other';
}

/** Raw API response (snake_case). */
export type InboxMessagesRspRaw = {
  inbox_items: Array<[number, InboxMessageType & { group_master_key?: string | null }]>;
  callsigns: InboxMessagesRsp['callsigns'];
  signal_profiles: Record<
    string,
    {
      given_name?: string | null;
      family_name?: string | null;
      givenName?: string | null;
      familyName?: string | null;
    } | null
  >;
  signal_groups: Array<{
    master_key?: string;
    masterKey?: string;
    name?: string;
    [key: string]: unknown;
  }>;
  freq_pelengs_summary: InboxMessagesRsp['freqPelengsSummary'];
  page_limit?: number | null;
};

export type InboxMessageTagRaw = {
  id?: number;
  tag_id?: number;
  tagId?: number;
  confidence?: number;
  login?: string | null;
  model?: string | null;
  organism_id?: number | null;
  organismId?: number | null;
};

export type InboxMessageMetadataRaw = Partial<InboxMessageMetadata> & {
  color_code?: string | null;
  color_code_start_index?: number | null;
  color_code_end_index?: number | null;
  call_group_id?: string | null;
  call_group_id_start_index?: number | null;
  call_group_id_end_index?: number | null;
  call_group_name?: string | null;
  call_group_name_start_index?: number | null;
  call_group_name_end_index?: number | null;
  sender_id?: string | null;
  sender_id_start_index?: number | null;
  sender_id_end_index?: number | null;
  sender_name?: string | null;
  sender_name_start_index?: number | null;
  sender_name_end_index?: number | null;
  hash_id?: string | null;
  hash_id_start_index?: number | null;
  hash_id_end_index?: number | null;
};

export type MessageMediaInfoRaw = Partial<MessageMediaInfo> & {
  content_type?: string;
  file_name?: string | null;
  size_bytes?: number;
};

export function normalizeMessageMediaInfo(m: MessageMediaInfoRaw): MessageMediaInfo {
  const raw = m as Record<string, unknown>;
  return {
    id: String(m.id ?? raw.id ?? ''),
    contentType: String(m.contentType ?? raw.content_type ?? ''),
    fileName: (m.fileName ?? raw.file_name ?? null) as string | null,
    sizeBytes: Number(m.sizeBytes ?? raw.size_bytes ?? 0),
    href: String(m.href ?? raw.href ?? ''),
  };
}

type ContentNodeCandidate = Partial<{
  CNHighlightC: { text?: string | null };
  CNPointC: { text?: string | null; etalon?: string | null };
}>;

type InboxTextMarkedNode = NonNullable<InboxMessageType['textMarked']>[number];

function normalizeProfileEntry(
  v: InboxMessagesRspRaw['signal_profiles'][string],
): InboxMessagesRsp['signalProfiles'][string] {
  if (isNullOrUndefined(v)) return null;
  return {
    givenName: v.givenName ?? v.given_name ?? null,
    familyName: v.familyName ?? v.family_name ?? null,
  };
}

export function normalizeInboxMessageTag(t: InboxMessageTagRaw): InboxMessageTag {
  return {
    id: (t.id ?? 0) as number,
    tagId: (t.tagId ?? t.tag_id ?? 0) as number,
    confidence: (t.confidence ?? 0) as number,
    login: (t.login ?? null) as string | null,
    model: (t.model ?? null) as string | null,
    organismId: (t.organismId ?? t.organism_id ?? null) as number | null,
  };
}

export function normalizeInboxMessageMetadata(
  metadata: InboxMessageMetadataRaw,
): InboxMessageMetadata {
  return {
    colorCode: (metadata.colorCode ?? metadata.color_code ?? null) as string | null,
    colorCodeStartIndex: (metadata.colorCodeStartIndex ??
      metadata.color_code_start_index ??
      null) as number | null,
    colorCodeEndIndex: (metadata.colorCodeEndIndex ?? metadata.color_code_end_index ?? null) as
      number | null,
    callGroupId: (metadata.callGroupId ?? metadata.call_group_id ?? null) as string | null,
    callGroupIdStartIndex: (metadata.callGroupIdStartIndex ??
      metadata.call_group_id_start_index ??
      null) as number | null,
    callGroupIdEndIndex: (metadata.callGroupIdEndIndex ??
      metadata.call_group_id_end_index ??
      null) as number | null,
    callGroupName: (metadata.callGroupName ?? metadata.call_group_name ?? null) as string | null,
    callGroupNameStartIndex: (metadata.callGroupNameStartIndex ??
      metadata.call_group_name_start_index ??
      null) as number | null,
    callGroupNameEndIndex: (metadata.callGroupNameEndIndex ??
      metadata.call_group_name_end_index ??
      null) as number | null,
    senderId: (metadata.senderId ?? metadata.sender_id ?? null) as string | null,
    senderIdStartIndex: (metadata.senderIdStartIndex ?? metadata.sender_id_start_index ?? null) as
      number | null,
    senderIdEndIndex: (metadata.senderIdEndIndex ?? metadata.sender_id_end_index ?? null) as
      number | null,
    senderName: (metadata.senderName ?? metadata.sender_name ?? null) as string | null,
    senderNameStartIndex: (metadata.senderNameStartIndex ??
      metadata.sender_name_start_index ??
      null) as number | null,
    senderNameEndIndex: (metadata.senderNameEndIndex ?? metadata.sender_name_end_index ?? null) as
      number | null,
    hashId: (metadata.hashId ?? metadata.hash_id ?? null) as string | null,
    hashIdStartIndex: (metadata.hashIdStartIndex ?? metadata.hash_id_start_index ?? null) as
      number | null,
    hashIdEndIndex: (metadata.hashIdEndIndex ?? metadata.hash_id_end_index ?? null) as
      number | null,
  };
}

export async function fetchMessagesByIds(
  messageIds: number[],
  inboxReq?: Partial<InboxMessagesReq> | null,
  options?: RequestOptions,
): Promise<Array<[number, InboxMessageType]>> {
  const req: MessageIdsReq = {
    messageIds,
    inboxReq: inboxReq == null ? null : (inboxReq as InboxMessagesReq),
  };
  const raw = await postJson<unknown>(
    '/api/rer-importer/messages-by-id',
    transformCamelToSnake(req),
    options,
  );
  const messages = transformSnakeToCamel<MessageIdsRsp>(raw).messages ?? [];
  return messages.map(([id, message]) => [id, normalizeInboxMessage(message)]);
}

function normalizeContentNode(node: unknown): InboxTextMarkedNode | null {
  if (typeof node === 'string') return node === 'CNNewlineC' ? node : null;
  if (isNullOrUndefined(node) || typeof node !== 'object') return null;
  const candidate = node as ContentNodeCandidate;
  if (isPresent(candidate.CNHighlightC)) {
    return String(candidate.CNHighlightC.text ?? '').trim() !== ''
      ? (node as InboxTextMarkedNode)
      : null;
  }
  if (isPresent(candidate.CNPointC)) {
    const displayText = candidate.CNPointC.text ?? '';
    if (displayText.trim() === '') return null;
    if (String(candidate.CNPointC.etalon ?? '').trim() === '')
      return { CNTextC: { text: displayText } };
    return node as InboxTextMarkedNode;
  }
  return node as InboxTextMarkedNode;
}

function normalizeTextMarked(
  textMarked: InboxMessageType['textMarked'],
): InboxMessageType['textMarked'] {
  if (isNullOrUndefined(textMarked) || !Array.isArray(textMarked)) return null;
  return textMarked.flatMap((node) => {
    const normalizedNode = normalizeContentNode(node);
    return isPresent(normalizedNode) ? [normalizedNode] : [];
  });
}

function normalizePointTokens(
  pointTokens: InboxMessageType['pointTokens'],
): InboxMessageType['pointTokens'] {
  if (isNullOrUndefined(pointTokens) || !Array.isArray(pointTokens)) return null;
  return pointTokens.filter((pointToken) => String(pointToken.etalon ?? '').trim() !== '');
}

function normalizeInboxMessage(
  m: InboxMessageType & {
    group_master_key?: string | null;
    network_ids?: number[] | null;
    location?: string | null;
    extended_form?: string | null;
    message_comments?: InboxMessageType['messageComments'] | null;
    inbox_tags?: InboxMessageTagRaw[] | null;
    metadata?: InboxMessageMetadataRaw[] | null;
    text_marked?: InboxMessageType['textMarked'];
    point_tokens?: InboxMessageType['pointTokens'];
  },
): InboxMessageType {
  const raw = m as Record<string, unknown>;
  const groupMasterKey = (m.groupMasterKey ?? raw.group_master_key ?? null) as string | null;
  const networkIds = (m.networkIds ?? raw.network_ids ?? null) as number[] | null;
  const location = (m.location ?? raw.location ?? null) as string | null;
  const extendedForm = (m.extendedForm ?? raw.extended_form ?? null) as string | null;
  const rawMessageComments = m.messageComments ?? raw.message_comments ?? [];
  const messageComments = Array.isArray(rawMessageComments)
    ? transformSnakeToCamel<MessageComment[]>(rawMessageComments)
    : [];
  const rawInboxTags = (raw.inbox_tags ?? m.inboxTags ?? null) as
    InboxMessageTagRaw[] | null | undefined;
  const inboxTags: InboxMessageType['inboxTags'] =
    isPresent(rawInboxTags) && Array.isArray(rawInboxTags)
      ? rawInboxTags.map(normalizeInboxMessageTag)
      : null;
  const rawMetadata = (raw.metadata ?? m.metadata ?? null) as
    InboxMessageMetadataRaw[] | null | undefined;
  const metadata: InboxMessageType['metadata'] =
    isPresent(rawMetadata) && Array.isArray(rawMetadata)
      ? rawMetadata.map(normalizeInboxMessageMetadata)
      : [];
  const textMarked = normalizeTextMarked(
    (raw.text_marked ?? m.textMarked ?? null) as InboxMessageType['textMarked'],
  );
  const rawPointTokens = (raw.point_tokens ??
    m.pointTokens ??
    null) as InboxMessageType['pointTokens'];
  const pointTokens = normalizePointTokens(rawPointTokens);
  const rawMedia = (raw.media ?? m.media ?? null) as MessageMediaInfoRaw[] | null | undefined;
  const media: InboxMessageType['media'] =
    isPresent(rawMedia) && Array.isArray(rawMedia)
      ? rawMedia.map(normalizeMessageMediaInfo)
      : (m.media ?? []);
  return {
    ...m,
    groupMasterKey,
    networkIds,
    location,
    extendedForm,
    messageComments,
    inboxTags,
    metadata,
    textMarked,
    pointTokens,
    media,
  };
}

function normalizeSignalGroupEntry(
  g: InboxMessagesRspRaw['signal_groups'][number],
): SignalGroupEntry {
  const raw = g as Record<string, unknown>;
  const groupStats = (raw.groupStats ?? raw.group_stats) as SignalGroupStats | undefined;
  return {
    masterKey: (g.masterKey ?? g.master_key ?? '') as string,
    name: (g.name ?? '') as string,
    ignoreOperativny: (raw.ignoreOperativny ?? raw.ignore_operativny ?? false) as boolean,
    interseptionKind: normalizeInterseptionKind(raw),
    disableNetworkAssignment: (raw.disableNetworkAssignment ??
      raw.disable_network_assignment ??
      false) as boolean,
    groupStats:
      groupStats && typeof groupStats.activityLastDay === 'number' ? groupStats : defaultGroupStats,
    adminData: (raw.adminData ?? raw.admin_data ?? null) as GroupAdminData | null,
    areasOfResponsibility: (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null) as
      AreaOfResponsibility[] | null,
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
    normalizeSignalGroupEntry,
  );
  return {
    inboxItems,
    callsigns: raw.callsigns,
    signalProfiles,
    signalGroups,
    freqPelengsSummary: raw.freq_pelengs_summary,
    pageLimit: raw.page_limit ?? null,
  };
}

/** Build request body with snake_case keys for /api/rer-importer/get-inbox. */
export function inboxMsgtoSnakeBody(req: InboxMessagesReq): object {
  return {
    since_id_noninclusive: req.sinceIdNoninclusive,
    before_id_noninclusive: req.beforeIdNoninclusive,
    since_date_inclusive_ms: req.sinceDateInclusiveMs,
    till_date_inclusive_ms: req.tillDateInclusiveMs,
    only_show_unprocessed: req.onlyShowUnprocessed,
    checked_only: req.checkedOnly,
    selected_groups: emptyArrToNull(req.selectedGroups),
    denied_groups: emptyArrToNull(req.deniedGroups),
    selected_senders: emptyArrToNull(req.selectedSenders),
    denied_senders: emptyArrToNull(req.deniedSenders),
    selected_freqs: emptyArrToNull(req.selectedFreqs),
    selected_posts: emptyArrToNull(req.selectedPosts),
    denied_posts: emptyArrToNull(req.deniedPosts),
    denied_freqs: emptyArrToNull(req.deniedFreqs),
    selected_callsigns: emptyArrToNull(req.selectedCallsigns),
    selected_units: emptyArrToNull(req.selectedUnits),
    denied_units: emptyArrToNull(req.deniedUnits),
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
    highlight_keyword_set_id: req.highlightKeywordSetId,
    highlight_searchres: req.highlightSearchres,
    highlight_signals: req.highlightSignals,
    highlight_points: req.highlightPoints,
    selected_tags: emptyArrToNull(req.selectedTags),
    denied_tags: emptyArrToNull(req.deniedTags),
    tag_presence: req.tagPresence,
    selected_aors: emptyArrToNull(req.selectedAors),
    selected_networks: emptyArrToNull(req.selectedNetworks),
    metadata_cc: req.metadataCc,
    metadata_sender: req.metadataSender,
    metadata_receiver: req.metadataReceiver,
    metadata_hash: req.metadataHash,
    only_with_metadata: req.onlyWithMetadata,
    without_metadata: req.withoutMetadata,
    only_with_media: req.onlyWithMedia,
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

export async function fetchInboxMessages(
  req: InboxMessagesReq,
  options?: RequestOptions,
): Promise<InboxMessagesRsp> {
  const body = inboxMsgtoSnakeBody(req);
  const raw = await postJson<InboxMessagesRspRaw>(
    '/api/rer-importer/get-inbox',
    body as any,
    options,
  );
  return mapRsp(raw);
}

export type InboxMessagesDigestRsp = {
  quantity: number;
  firstElementTs: number | null;
};

export async function fetchInboxCount(
  req: InboxMessagesReq,
  options?: RequestOptions,
): Promise<InboxMessagesDigestRsp> {
  const body = inboxMsgtoSnakeBody(req);
  const raw = await postJson<{ quantity: number; first_element_ts: number | null }>(
    '/api/rer-importer/get-inbox-count',
    body as any,
    options,
  );
  return {
    quantity: raw.quantity,
    firstElementTs: raw.first_element_ts ?? null,
  };
}
