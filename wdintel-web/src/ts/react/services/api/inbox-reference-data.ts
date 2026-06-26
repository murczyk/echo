import type {
  AnalysisStatsReq,
  AreaOfResponsibility,
  GroupAdminData,
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

/** Tags list for display (tagId -> label). Fetched from POST /api/tags/tags-list. */
export async function getTagsMapForDisplay(options?: RequestOptions): Promise<Record<number, Tag>> {
  const raw = await postJson<Array<[number, Tag]>>('/api/tags/tags-list', {}, options);
  const map: Record<number, Tag> = {};
  for (const [i, tagRecord] of Object.entries(raw)) {
    const nTag = transformSnakeToCamel<Tag>(tagRecord[1]);
    map[Number(tagRecord[0])] = nTag;
  }
  return map;
}

/** Latest sender profiles (UUID -> profile). */
export async function getLatestSenders(options?: RequestOptions): Promise<SignalProfilesRsp> {
  const raw = await postJson<{ data: Record<string, { given_name?: string; family_name?: string; givenName?: string; familyName?: string } | null> }>(
    '/api/rer-importer/latest-senders',
    {},
    options,
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
    selectedLocations: null,
    selectedAors: null,
    orWithExtendedForm: null,
    orBookmarked: null,
    orImportant: null,
    orWithCoords: null,
    orWithoutCoords: null,
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
  const raw = await postJson<PostStatsRsp>('/api/rer/analysis/stats/posts', snakeBody, options);
  const posts = raw?.posts ?? [];
  return posts.map((p) => p.post);
}

/** User's sigint group keys (e.g. for filter dropdown). sinceDateInclusiveMs: optional ms, e.g. 2 days ago. */
export async function getUserSigintGroups(sinceDateInclusiveMs: number | null, options?: RequestOptions): Promise<string[]> {
  const body: Record<string, number> = isPresent(sinceDateInclusiveMs) ? { since_date_inclusive_ms: sinceDateInclusiveMs } : {};
  const raw = await postJson<string[]>('/api/user/sigint-groups', body, options);
  return Array.isArray(raw) ? raw : [];
}

/** Group details from master keys. */
export async function getGroupInfosBatch(masterKeys: string[], options?: RequestOptions): Promise<SignalGroupEntry[]> {
  if (masterKeys.length === 0) return [];
  const body = {
    groups: masterKeys.map((masterKey) => ({ master_key: masterKey })),
    skip_group_stats: true,
  };
  const raw = await postJson<{ data: Array<Record<string, unknown>> }>('/api/rer-importer/signal-group-batch', body, options);
  const arr = raw?.data ?? [];
  return arr.map((r: Record<string, unknown>) => ({
    masterKey: (r.master_key ?? r.masterKey) as string,
    name: (r.name ?? '') as string,
    ignoreOperativny: (r.ignore_operativny ?? r.ignoreOperativny ?? false) as boolean,
    isRer: (r.is_rer ?? r.isRer ?? true) as boolean,
    groupStats: (r.group_stats ?? r.groupStats) as SignalGroupStats,
    adminData: (r.admin_data ?? r.adminData ?? null) as GroupAdminData | null,
    areasOfResponsibility: (r.areas_of_responsibility ?? r.areasOfResponsibility ?? null) as AreaOfResponsibility[] | null,
  }));
}
