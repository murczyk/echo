import {
  AreaOfResponsibility,
  BatchSignalGroupReq,
  Datasource,
  OrphanSignalGroupEntry,
  SigintZone,
  SignalGroupEntry,
  SignalGroupStats,
  ZoneDatasourceGroup,
  ZoneDatasourceGroupAddReq,
  ZoneDatasourceGroupAddRsp,
  ZoneDatasourceGroupUpdateReq,
  ZoneDatasourceGroupsReq,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';

type DatasourceLike = {
  kind?: string;
  displayName?: string;
  display_name?: string;
  signalPhone?: string | null;
  signal_phone?: string | null;
  enabled?: boolean | null;
};

type SigintZoneLike = {
  name?: string;
  createdAt?: number;
  created_at?: number;
};

type GroupAdminDataLike = {
  shortNote?: string | null;
  short_note?: string | null;
  longNote?: string | null;
  long_note?: string | null;
};

type SignalGroupStatsLike = {
  activityLastDay?: number;
  activity_last_day?: number;
  activityLastWeek?: number;
  activity_last_week?: number;
};

type SignalGroupEntryLike = {
  masterKey?: string;
  master_key?: string;
  name?: string;
  ignoreOperativny?: boolean;
  ignore_operativny?: boolean;
  groupStats?: SignalGroupStatsLike | null;
  group_stats?: SignalGroupStatsLike | null;
  adminData?: GroupAdminDataLike | null;
  admin_data?: GroupAdminDataLike | null;
  areasOfResponsibility?: AreaOfResponsibilityLike[] | null;
  areas_of_responsibility?: AreaOfResponsibilityLike[] | null;
};

type OrphanSignalGroupEntryLike = {
  masterKey?: string;
  master_key?: string;
  name?: string;
  ignoreOperativny?: boolean;
  ignore_operativny?: boolean;
  datasourceId?: number | null;
  datasource_id?: number | null;
  createdAt?: number;
  created_at?: number;
  groupStats?: SignalGroupStatsLike | null;
  group_stats?: SignalGroupStatsLike | null;
  groupAdminData?: GroupAdminDataLike | null;
  group_admin_data?: GroupAdminDataLike | null;
  areasOfResponsibility?: AreaOfResponsibilityLike[] | null;
  areas_of_responsibility?: AreaOfResponsibilityLike[] | null;
};

type AreaOfResponsibilityLike = {
  id?: number;
  name?: string;
  description?: string | null;
  isTopLevel?: boolean;
  is_top_level?: boolean;
  leftBound?: number | string | null;
  left_bound?: number | string | null;
  rightBound?: number | string | null;
  right_bound?: number | string | null;
  leftCoordinates?: AorCoordinatesLike | null;
  left_coordinates?: AorCoordinatesLike | null;
  rightCoordinates?: AorCoordinatesLike | null;
  right_coordinates?: AorCoordinatesLike | null;
  createdAt?: number;
  created_at?: number;
};

type AorCoordinatesLike = {
  latitude?: number | string | null;
  longitude?: number | string | null;
  settlement?: string | null;
};

type ZoneDatasourceGroupLike = {
  sigintZoneDatasourceId?: number;
  sigint_zone_datasource_id?: number;
  groupMasterKey?: string;
  group_master_key?: string;
  isGroupSecret?: boolean;
  is_group_secret?: boolean;
  allowedUsers?: string[] | null;
  allowed_users?: string[] | null;
  shortNote?: string | null;
  short_note?: string | null;
  longNote?: string | null;
  long_note?: string | null;
  areasOfResponsibility?: AreaOfResponsibilityLike[] | null;
  areas_of_responsibility?: AreaOfResponsibilityLike[] | null;
};

type ZoneDatasourceGroupListRspLike = {
  zoneDatasourceGroups?: ZoneDatasourceGroupLike[] | null;
  zone_datasource_groups?: ZoneDatasourceGroupLike[] | null;
};

type ZoneDatasourceGroupAddRspLike = {
  zoneId?: number;
  zone_id?: number;
  datasourceId?: number;
  datasource_id?: number;
  groupMasterKey?: string;
  group_master_key?: string;
  groupName?: string | null;
  group_name?: string | null;
  zoneDatasourceGroup?: ZoneDatasourceGroupLike;
  zone_datasource_group?: ZoneDatasourceGroupLike;
};

type SignalGroupsRspLike = {
  data?: SignalGroupEntryLike[] | null;
};

type DatasourcePair = [number, Datasource];
type ZonePair = [number, SigintZone];

type ZoneDatasourceGroupAddReqBody = {
  zone_id: number;
  datasource_id: number;
  is_secret: boolean;
  master_key: string;
  user_logins: string[];
  short_note: string | null;
  long_note: string | null;
};

type ZoneDatasourceGroupUpdateReqBody = {
  id: number;
  is_secret: boolean;
  user_logins: string[];
  short_note: string | null;
  long_note: string | null;
  area_of_responsibility_id: number | null;
  area_of_responsibility_ids: number[] | null;
};

type ZoneDatasourceGroupsReqBody = {
  zone_id: number;
  datasource_id: number;
};

type BatchSignalGroupReqBody = {
  groups: { master_key: string }[];
};

function normalizeNumber(value: number | string | null | undefined): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

function normalizeCoordinates(raw: AorCoordinatesLike | null | undefined) {
  if (!raw) return null;
  return {
    latitude: normalizeNumber(raw.latitude),
    longitude: normalizeNumber(raw.longitude),
    settlement: raw.settlement ?? null,
  };
}

function normalizeAor(raw: AreaOfResponsibilityLike): AreaOfResponsibility {
  return {
    id: raw.id ?? 0,
    name: raw.name ?? '',
    description: raw.description ?? null,
    isTopLevel: raw.isTopLevel ?? raw.is_top_level ?? false,
    leftBound: normalizeNumber(raw.leftBound ?? raw.left_bound),
    rightBound: normalizeNumber(raw.rightBound ?? raw.right_bound),
    leftCoordinates: normalizeCoordinates(raw.leftCoordinates ?? raw.left_coordinates),
    rightCoordinates: normalizeCoordinates(raw.rightCoordinates ?? raw.right_coordinates),
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
  };
}

function normalizeSignalGroupStats(raw: SignalGroupStatsLike | null | undefined): SignalGroupStats {
  return {
    activityLastDay: raw?.activityLastDay ?? raw?.activity_last_day ?? 0,
    activityLastWeek: raw?.activityLastWeek ?? raw?.activity_last_week ?? 0,
  };
}

function normalizeGroupAdminData(raw: GroupAdminDataLike | null | undefined) {
  if (!raw) return null;
  const shortNote = raw.shortNote ?? raw.short_note ?? null;
  const longNote = raw.longNote ?? raw.long_note ?? null;
  if (!shortNote && !longNote) return null;
  return { shortNote, longNote };
}

function normalizeSignalGroupEntry(raw: SignalGroupEntryLike): SignalGroupEntry {
  return {
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    name: raw.name ?? '',
    ignoreOperativny: raw.ignoreOperativny ?? raw.ignore_operativny ?? false,
    groupStats: normalizeSignalGroupStats(raw.groupStats ?? raw.group_stats),
    adminData: normalizeGroupAdminData(raw.adminData ?? raw.admin_data),
    areasOfResponsibility: (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null)?.map(normalizeAor) ?? null,
  };
}

function normalizeOrphanSignalGroupEntry(raw: OrphanSignalGroupEntryLike): OrphanSignalGroupEntry {
  return {
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    name: raw.name ?? '',
    ignoreOperativny: raw.ignoreOperativny ?? raw.ignore_operativny ?? false,
    datasourceId: raw.datasourceId ?? raw.datasource_id ?? null,
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
    groupStats: normalizeSignalGroupStats(raw.groupStats ?? raw.group_stats),
    groupAdminData: normalizeGroupAdminData(raw.groupAdminData ?? raw.group_admin_data),
    areasOfResponsibility: (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null)?.map(normalizeAor) ?? null,
  };
}

function normalizeZoneDatasourceGroup(raw: ZoneDatasourceGroupLike): ZoneDatasourceGroup {
  return {
    sigintZoneDatasourceId: raw.sigintZoneDatasourceId ?? raw.sigint_zone_datasource_id ?? 0,
    groupMasterKey: raw.groupMasterKey ?? raw.group_master_key ?? '',
    isGroupSecret: raw.isGroupSecret ?? raw.is_group_secret ?? false,
    allowedUsers: raw.allowedUsers ?? raw.allowed_users ?? [],
    shortNote: raw.shortNote ?? raw.short_note ?? null,
    longNote: raw.longNote ?? raw.long_note ?? null,
    areasOfResponsibility: (raw.areasOfResponsibility ?? raw.areas_of_responsibility ?? null)?.map(normalizeAor) ?? null,
  };
}

function normalizeDatasource(raw: DatasourceLike): Datasource {
  return {
    kind: raw.kind ?? '',
    displayName: raw.displayName ?? raw.display_name ?? '',
    signalPhone: raw.signalPhone ?? raw.signal_phone ?? null,
    enabled: raw.enabled ?? null,
  };
}

function normalizeDatasourcePair(raw: unknown): DatasourcePair | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const id = Number(raw[0]);
    const datasource = normalizeDatasource((raw[1] ?? {}) as DatasourceLike);
    return [id, datasource];
  }
  if (raw && typeof raw === 'object') {
    const asRecord = raw as { id?: number; datasource?: DatasourceLike };
    if (asRecord.id !== undefined && asRecord.datasource) {
      return [asRecord.id, normalizeDatasource(asRecord.datasource)];
    }
  }
  return null;
}

function normalizeZonePair(raw: unknown): ZonePair | null {
  if (Array.isArray(raw) && raw.length >= 2) {
    const id = Number(raw[0]);
    const zoneRaw = (raw[1] ?? {}) as SigintZoneLike;
    return [
      id,
      {
        name: zoneRaw.name ?? '',
        createdAt: zoneRaw.createdAt ?? zoneRaw.created_at ?? 0,
      },
    ];
  }
  if (raw && typeof raw === 'object') {
    const asRecord = raw as { id?: number; zone?: SigintZoneLike };
    if (asRecord.id !== undefined && asRecord.zone) {
      return [
        asRecord.id,
        {
          name: asRecord.zone.name ?? '',
          createdAt: asRecord.zone.createdAt ?? asRecord.zone.created_at ?? 0,
        },
      ];
    }
  }
  return null;
}

function toZoneDatasourceGroupsReqBody(req: ZoneDatasourceGroupsReq): ZoneDatasourceGroupsReqBody {
  return {
    zone_id: req.zoneId,
    datasource_id: req.datasourceId,
  };
}

function toZoneDatasourceGroupAddReqBody(req: ZoneDatasourceGroupAddReq): ZoneDatasourceGroupAddReqBody {
  return {
    zone_id: req.zoneId,
    datasource_id: req.datasourceId,
    is_secret: req.isSecret,
    master_key: req.masterKey,
    user_logins: req.userLogins,
    short_note: req.shortNote ?? null,
    long_note: req.longNote ?? null,
  };
}

function toZoneDatasourceGroupUpdateReqBody(req: ZoneDatasourceGroupUpdateReq): ZoneDatasourceGroupUpdateReqBody {
  return {
    id: req.id,
    is_secret: req.isSecret,
    user_logins: req.userLogins,
    short_note: req.shortNote ?? null,
    long_note: req.longNote ?? null,
    area_of_responsibility_id: req.areaOfResponsibilityId ?? null,
    area_of_responsibility_ids: req.areaOfResponsibilityIds ?? null,
  };
}

function toBatchSignalGroupReqBody(req: BatchSignalGroupReq): BatchSignalGroupReqBody {
  return {
    groups: req.groups.map((group) => ({ master_key: group.masterKey })),
  };
}

function normalizeSignalGroupsRsp(raw: SignalGroupsRspLike): SignalGroupEntry[] {
  return (raw.data ?? []).map(normalizeSignalGroupEntry);
}

function normalizeZoneDatasourceGroupList(raw: ZoneDatasourceGroupListRspLike): ZoneDatasourceGroup[] {
  const list = raw.zoneDatasourceGroups ?? raw.zone_datasource_groups ?? [];
  return (list ?? []).map(normalizeZoneDatasourceGroup);
}

function normalizeZoneDatasourceGroupAddRsp(raw: ZoneDatasourceGroupAddRspLike): ZoneDatasourceGroupAddRsp {
  return {
    zoneId: raw.zoneId ?? raw.zone_id ?? 0,
    datasourceId: raw.datasourceId ?? raw.datasource_id ?? 0,
    groupMasterKey: raw.groupMasterKey ?? raw.group_master_key ?? '',
    groupName: raw.groupName ?? raw.group_name ?? null,
    zoneDatasourceGroup: normalizeZoneDatasourceGroup(raw.zoneDatasourceGroup ?? raw.zone_datasource_group ?? {}),
  };
}

export async function listDatasources(): Promise<DatasourcePair[]> {
  const data = await postJson<unknown[]>('/api/datasources/list');
  return (data || []).map(normalizeDatasourcePair).filter(Boolean) as DatasourcePair[];
}

export async function listSigintZones(): Promise<ZonePair[]> {
  const data = await postJson<unknown[]>('/api/sigint/zones/list', {});
  return (data || []).map(normalizeZonePair).filter(Boolean) as ZonePair[];
}

export async function listDatasourceGroupKeys(datasourceId: number): Promise<string[]> {
  return postJson<string[]>('/api/datasources/group-list', datasourceId);
}

export async function listZoneDatasources(zoneId: number): Promise<number[]> {
  return postJson<number[]>('/api/sigint/zones/zone-datasources', zoneId);
}

export async function listZoneDatasourceGroups(req: ZoneDatasourceGroupsReq): Promise<ZoneDatasourceGroup[]> {
  const data = await postJson<ZoneDatasourceGroupListRspLike>(
    '/api/sigint/zones/zone-datasource-groups',
    toZoneDatasourceGroupsReqBody(req),
  );
  return normalizeZoneDatasourceGroupList(data ?? {});
}

export async function updateZoneDatasourceGroup(req: ZoneDatasourceGroupUpdateReq): Promise<ZoneDatasourceGroup> {
  const data = await postJson<ZoneDatasourceGroupLike>(
    '/api/sigint/zones/zone-datasource-group-update',
    toZoneDatasourceGroupUpdateReqBody(req),
  );
  return normalizeZoneDatasourceGroup(data ?? {});
}

export async function addZoneDatasourceGroup(req: ZoneDatasourceGroupAddReq): Promise<ZoneDatasourceGroupAddRsp> {
  const data = await postJson<ZoneDatasourceGroupAddRspLike>(
    '/api/sigint/zones/zone-datasource-group-add',
    toZoneDatasourceGroupAddReqBody(req),
  );
  return normalizeZoneDatasourceGroupAddRsp(data ?? {});
}

export async function deleteZoneDatasourceGroup(zoneDatasourceId: number): Promise<void> {
  await postVoid('/api/sigint/zones/zone-datasource-group-delete', zoneDatasourceId);
}

export async function listOrphanSignalGroups(): Promise<OrphanSignalGroupEntry[]> {
  const data = await postJson<OrphanSignalGroupEntryLike[]>('/api/rer-importer/orphan-signal-groups');
  return (data || []).map(normalizeOrphanSignalGroupEntry);
}

export async function fetchSignalGroupInfoBatch(keys: string[]): Promise<SignalGroupEntry[]> {
  if (keys.length === 0) return [];
  const req: BatchSignalGroupReq = { groups: keys.map((masterKey) => ({ masterKey })) };
  const data = await postJson<SignalGroupsRspLike>('/api/rer-importer/signal-group-batch', toBatchSignalGroupReqBody(req));
  return normalizeSignalGroupsRsp(data ?? {});
}
