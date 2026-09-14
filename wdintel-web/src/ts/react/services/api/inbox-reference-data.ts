import type {
  AnalysisStatsReq,
  AreaOfResponsibility,
  GroupAdminData,
  InterseptionKind,
  PostStatsRsp,
  SignalGroupEntry,
  SignalGroupStats,
  SignalProfilesRsp,
  Tag,
} from '../../../../Bindings';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';
import { isPresent } from '../../utils/misc';
import { postJson } from './client';
import type { RequestOptions } from './client';

type RawSignalProfile = {
  given_name?: string;
  family_name?: string;
  givenName?: string;
  familyName?: string;
};

type RawSignalProfilesRsp = {
  data?: Record<string, RawSignalProfile | null>;
};

function normalizeSignalProfiles(raw: RawSignalProfilesRsp): SignalProfilesRsp {
  const data: Record<string, SignalProfilesRsp['data'][string]> = {};
  for (const [key, entry] of Object.entries(raw.data ?? {})) {
    data[key] = entry
      ? {
          givenName: entry.givenName ?? entry.given_name ?? null,
          familyName: entry.familyName ?? entry.family_name ?? null,
        }
      : null;
  }
  return { data };
}

function normalizeInterseptionKind(raw: Record<string, unknown>): InterseptionKind {
  const interseptionKind = raw.interseptionKind ?? raw.interseption_kind;
  if (interseptionKind === 'rer' || interseptionKind === 'other') return interseptionKind;
  return (raw.is_rer ?? raw.isRer ?? true) ? 'rer' : 'other';
}

type RawTagPair = [number, Tag | Record<string, unknown>];

export type TagsForDisplay = {
  tagsMap: Record<number, Tag>;
  tagsOrder: number[];
};

function normalizeTagsForDisplay(raw: RawTagPair[] | null | undefined): TagsForDisplay {
  const tagsMap: Record<number, Tag> = {};
  const tagsOrder: number[] = [];

  for (const item of raw ?? []) {
    if (!Array.isArray(item) || item.length < 2) continue;
    const tagId = Number(item[0]);
    if (!Number.isFinite(tagId)) continue;
    tagsMap[tagId] = transformSnakeToCamel<Tag>(item[1]);
    tagsOrder.push(tagId);
  }

  return { tagsMap, tagsOrder };
}

/** Tags list for display. Fetched from POST /api/tags/tags-list in backend-provided order. */
export async function getTagsForDisplay(options?: RequestOptions): Promise<TagsForDisplay> {
  const raw = await postJson<RawTagPair[]>('/api/tags/tags-list', {}, options);
  return normalizeTagsForDisplay(raw);
}

/** Tags map for legacy callers. Use getTagsForDisplay() when visible order matters. */
export async function getTagsMapForDisplay(options?: RequestOptions): Promise<Record<number, Tag>> {
  const { tagsMap } = await getTagsForDisplay(options);
  return tagsMap;
}

/** Latest sender profiles (UUID -> profile). */
export async function getLatestSenders(options?: RequestOptions): Promise<SignalProfilesRsp> {
  const raw = await postJson<RawSignalProfilesRsp>('/api/rer-importer/latest-senders', {}, options);
  return normalizeSignalProfiles(raw);
}

/** Sender profiles for the requested UUIDs. */
export async function getSignalProfilesBatch(
  uuids: string[],
  options?: RequestOptions,
): Promise<SignalProfilesRsp> {
  if (uuids.length === 0) return { data: {} };
  const raw = await postJson<RawSignalProfilesRsp>(
    '/api/rer-importer/signal-profile-batch',
    { profiles: uuids.map((uuid) => ({ uuid })) },
    options,
  );
  return normalizeSignalProfiles(raw);
}

/** Latest frequencies list. */
export async function getLatestFrequencies(): Promise<string[]> {
  const raw = await postJson<string[]>('/api/sigint/latest-frequencies', {});
  return Array.isArray(raw) ? raw : [];
}

/** Posts list for duty filter (from analysis stats). */
export async function getPostsList(options?: RequestOptions): Promise<string[]> {
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
    selectedUnitIds: null,
    selectedDeviceNames: null,
    selectedLocations: null,
    selectedAors: null,
    orWithExtendedForm: null,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    orWithoutCoords: null,
    search: null,
    selectedTags: null,
    deniedTags: null,
    tagPresence: null,
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
    messageTimeBasis: null,
  };
  const snakeBody = transformCamelToSnake<AnalysisStatsReq>(body);
  const raw = await postJson<PostStatsRsp>('/api/rer/analysis/stats/posts', snakeBody, options);
  const posts = raw?.posts ?? [];
  return posts.map((p) => p.post);
}

/** User's sigint group keys (e.g. for filter dropdown). sinceDateInclusiveMs: optional ms, e.g. 2 days ago. */
export async function getUserSigintGroups(
  sinceDateInclusiveMs: number | null,
  options?: RequestOptions,
): Promise<string[]> {
  const body: Record<string, number> = isPresent(sinceDateInclusiveMs)
    ? { since_date_inclusive_ms: sinceDateInclusiveMs }
    : {};
  const raw = await postJson<string[]>('/api/user/sigint-groups', body, options);
  return Array.isArray(raw) ? raw : [];
}

/** Group details from master keys. */
export async function getGroupInfosBatch(
  masterKeys: string[],
  options?: RequestOptions,
): Promise<SignalGroupEntry[]> {
  if (masterKeys.length === 0) return [];
  const body = {
    groups: masterKeys.map((masterKey) => ({ master_key: masterKey })),
    skip_group_stats: true,
  };
  const raw = await postJson<{ data: Array<Record<string, unknown>> }>(
    '/api/rer-importer/signal-group-batch',
    body,
    options,
  );
  const arr = raw?.data ?? [];
  return arr.map((r: Record<string, unknown>) => ({
    masterKey: (r.master_key ?? r.masterKey) as string,
    name: (r.name ?? '') as string,
    ignoreOperativny: (r.ignore_operativny ?? r.ignoreOperativny ?? false) as boolean,
    interseptionKind: normalizeInterseptionKind(r),
    disableNetworkAssignment: (r.disable_network_assignment ??
      r.disableNetworkAssignment ??
      false) as boolean,
    isAviationGroup: (r.is_aviation_group ?? r.isAviationGroup ?? false) as boolean,
    groupStats: (r.group_stats ?? r.groupStats) as SignalGroupStats,
    adminData: (r.admin_data ?? r.adminData ?? null) as GroupAdminData | null,
    areasOfResponsibility: (r.areas_of_responsibility ?? r.areasOfResponsibility ?? null) as
      AreaOfResponsibility[] | null,
  }));
}
