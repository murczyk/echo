import {
  AddGroupToOrganismReq,
  CreateOrganismReq,
  ListOrganismsReq,
  Organism,
  OrganismGroup,
  RemoveGroupFromOrganismReq,
  SignalGroupFull,
  UpdateOrganismReq,
} from '../../../../Bindings';

import { postJson, postVoid } from './client';

type OrganismLike = {
  id?: number;
  parentId?: number | null;
  parent_id?: number | null;
  name?: string;
  createdAt?: number;
  created_at?: number;
  roles?: string[] | null;
  enabled?: boolean;
  aorIds?: number[] | null;
  aor_ids?: number[] | null;
  loginsCount?: number;
  logins_count?: number;
};

type SignalGroupFullLike = {
  name?: string;
  masterKey?: string;
  master_key?: string;
  originDatasourceId?: number;
  origin_datasource_id?: number;
};

type OrganismGroupLike = {
  masterKey?: string;
  master_key?: string;
  organismId?: number;
  organism_id?: number;
};

type ListOrganismsReqBody = {
  sort_by: ListOrganismsReq['sortBy'];
};

type CreateOrganismReqBody = {
  name: string;
  parent_id: number | null;
  roles: string[];
  aor_ids: number[] | null;
};

type UpdateOrganismReqBody = {
  id: number;
  parent_id: number | null;
  name: string | null;
  roles: string[] | null;
  enabled: boolean;
  aor_ids: number[] | null;
};

type AddGroupToOrganismReqBody = {
  organism_id: number;
  group_name: string;
};

type RemoveGroupFromOrganismReqBody = {
  organism_id: number;
  group_name: string;
};

function toListOrganismsReqBody(req: ListOrganismsReq): ListOrganismsReqBody {
  return { sort_by: req.sortBy };
}

function toCreateOrganismReqBody(req: CreateOrganismReq): CreateOrganismReqBody {
  return {
    name: req.name,
    parent_id: req.parentId,
    roles: req.roles,
    aor_ids: req.aorIds ?? null,
  };
}

function toUpdateOrganismReqBody(req: UpdateOrganismReq): UpdateOrganismReqBody {
  return {
    id: req.id,
    parent_id: req.parentId,
    name: req.name ?? null,
    roles: req.roles ?? null,
    enabled: req.enabled,
    aor_ids: req.aorIds ?? null,
  };
}

function toAddGroupReqBody(req: AddGroupToOrganismReq): AddGroupToOrganismReqBody {
  return {
    organism_id: req.organismId,
    group_name: req.groupName,
  };
}

function toRemoveGroupReqBody(req: RemoveGroupFromOrganismReq): RemoveGroupFromOrganismReqBody {
  return {
    organism_id: req.organismId,
    group_name: req.groupName,
  };
}

function normalizeOrganism(raw: OrganismLike): Organism {
  return {
    id: raw.id ?? 0,
    parentId: raw.parentId ?? raw.parent_id ?? null,
    name: raw.name ?? '',
    createdAt: raw.createdAt ?? raw.created_at ?? 0,
    roles: raw.roles ?? [],
    enabled: raw.enabled ?? false,
    aorIds: raw.aorIds ?? raw.aor_ids ?? [],
    loginsCount: raw.loginsCount ?? raw.logins_count ?? 0,
  };
}

function normalizeSignalGroup(raw: SignalGroupFullLike): SignalGroupFull {
  return {
    name: raw.name ?? '',
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    originDatasourceId: raw.originDatasourceId ?? raw.origin_datasource_id ?? 0,
  };
}

function normalizeOrganismGroup(raw: OrganismGroupLike): OrganismGroup {
  return {
    masterKey: raw.masterKey ?? raw.master_key ?? '',
    organismId: raw.organismId ?? raw.organism_id ?? 0,
  };
}

export async function listOrganisms(req: ListOrganismsReq): Promise<Organism[]> {
  const data = await postJson<OrganismLike[]>('/api/organisms', toListOrganismsReqBody(req));
  return (data || []).map(normalizeOrganism);
}

export async function createOrganism(req: CreateOrganismReq): Promise<Organism> {
  const data = await postJson<OrganismLike>('/api/organism/create', toCreateOrganismReqBody(req));
  return normalizeOrganism(data);
}

export async function updateOrganism(req: UpdateOrganismReq): Promise<Organism> {
  const data = await postJson<OrganismLike>('/api/organism/update', toUpdateOrganismReqBody(req));
  return normalizeOrganism(data);
}

export async function deleteOrganism(organismId: number): Promise<void> {
  await postVoid('/api/organism/delete', organismId);
}

export async function listSignalGroups(): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/all-groups');
  return (data || []).map(normalizeSignalGroup);
}

export async function listOrganismGroups(): Promise<OrganismGroup[]> {
  const data = await postJson<OrganismGroupLike[]>('/api/organism/group-list');
  return (data || []).map(normalizeOrganismGroup);
}

export async function listAvailableGroups(organismId: number): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/available-groups', organismId);
  return (data || []).map(normalizeSignalGroup);
}

export async function listAvailableGroupsBatch(
  organismIds: number[],
): Promise<Map<number, SignalGroupFull[]>> {
  const data = await postJson<Record<string, SignalGroupFullLike[]>>(
    '/api/organism/available-groups-batch',
    organismIds,
  );
  const result = new Map<number, SignalGroupFull[]>();
  Object.entries(data || {}).forEach(([key, groups]) => {
    const parsedId = Number(key);
    if (!Number.isFinite(parsedId)) return;
    result.set(parsedId, (groups || []).map(normalizeSignalGroup));
  });
  return result;
}

export async function computeAvailableGroups(req: UpdateOrganismReq): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/compute-available-groups', toUpdateOrganismReqBody(req));
  return (data || []).map(normalizeSignalGroup);
}

export async function computeAvailableGroupsForNew(req: CreateOrganismReq): Promise<SignalGroupFull[]> {
  const data = await postJson<SignalGroupFullLike[]>('/api/organism/compute-available-groups-for-new', toCreateOrganismReqBody(req));
  return (data || []).map(normalizeSignalGroup);
}

export async function listActiveLogins(organismId: number): Promise<string[]> {
  return postJson<string[]>('/api/organism/active-logins', organismId);
}

export async function addGroupToOrganism(req: AddGroupToOrganismReq): Promise<void> {
  await postVoid('/api/organism/add-group', toAddGroupReqBody(req));
}

export async function removeGroupFromOrganism(req: RemoveGroupFromOrganismReq): Promise<void> {
  await postVoid('/api/organism/remove-group', toRemoveGroupReqBody(req));
}
