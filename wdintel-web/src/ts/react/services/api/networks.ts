import type {
  AddNetworkFreqReq,
  CreateEncryptionKeyReq,
  AddNetworkDescriptionsReq,
  DeleteNetworkDescriptionReq,
  DeleteNetworkFreqReq,
  ListNetworksReq,
  ListKeysReq,
  Network,
  NetworkGroupsActivityOneReq,
  ListNetworkPointsReq,
  ListNetworkPointsRsp,
  NetworkFreqCallsignsReq,
  NetworkFreqsActivityReq,
  ReactivateNetworkFreqReq,
  SingleNetworkFreqsListRsp,
  SingleNetworkFreqsReq,
  ListKeysRsp,
  SingleNetworkCallsignsListRsp,
  UpdateNetworkDescriptionReq,
  UpdateNetworkFreqReq,
  UpdateNetworkPostsReq,
  UpdateNetworkReq,
  UpdateNetworkUnitsReq,
  EncryptionKeyData,
} from '../../../../Bindings';
import { postJson } from './client';
import { transformCamelToSnake, transformSnakeToCamel } from '../../../snake-to-camel';

/** Fetch all networks. Uses a filter so the backend returns full list without default limit. */
export async function getNetworksList(): Promise<Network[]> {
  const req: ListNetworksReq = {
    filterFreq: '',
    filterUnit: null,
    showOnlyFurtherInverstigation: null,
    showInactive: true,
    showOnlyDeleted: false,
    aorIds: null,
    ids: null,
    limit: null,
    offset: null,
    sortBy: ['NameAsc'],
  };
  const data = await postJson<Network[]>('/api/sigint/network-list', req);
  const normalizedData = transformSnakeToCamel(data);
  return Array.isArray(normalizedData) ? normalizedData : [];
}

/** Fetch networks by IDs */
export async function getNetworksByIds(ids: number[]): Promise<Network[]> {
  if (ids.length === 0) return [];
  const data = await postJson<Network[]>('/api/sigint/network-info-batch-id', ids);
  if (!Array.isArray(data)) return [];
  return data.map((row) => transformSnakeToCamel<Network>(row));
}

export async function getNetworkById(id: number): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network-info-one', id);
  return transformSnakeToCamel<Network>(data);
}

export async function getNetworkCallsignsList(
  networkId: number,
  includeActivityInfo = true,
): Promise<SingleNetworkCallsignsListRsp> {
  const data = await postJson<SingleNetworkCallsignsListRsp>('/api/sigint/network-callsigns-list', {
    network_id: networkId,
    include_activity_info: includeActivityInfo,
  });
  return transformSnakeToCamel<SingleNetworkCallsignsListRsp>(data);
}

export async function getSingleNetworkFreqs(
  networkId: number,
  includeCallsigns = true,
): Promise<SingleNetworkFreqsListRsp> {
  const data = await postJson<SingleNetworkFreqsListRsp>('/api/sigint/network-freqs-list', transformCamelToSnake({
    networkId,
    includeCallsigns,
  } satisfies SingleNetworkFreqsReq));
  return transformSnakeToCamel<SingleNetworkFreqsListRsp>(data);
}

export async function getNetworkFreqsActivity(networkId: number): Promise<Record<string, Record<string, number>>> {
  const data = await postJson<Record<string, Record<string, number>>>('/api/sigint/network-freqs-activity-one', transformCamelToSnake({
    networkId,
  } satisfies NetworkFreqsActivityReq));
  return transformSnakeToCamel<Record<string, Record<string, number>>>(data);
}

export async function getNetworkGroupsActivityOne(networkId: number): Promise<Record<string, Record<string, number>>> {
  const data = await postJson<Record<string, Record<string, number>>>('/api/sigint/network-group-activity-one', transformCamelToSnake({
    networkId,
    tillDateNoninclusiveMs: null,
  } satisfies NetworkGroupsActivityOneReq));
  return data;
}

export async function listNetworkPoints(req: ListNetworkPointsReq): Promise<ListNetworkPointsRsp> {
  const data = await postJson<ListNetworkPointsRsp>('/api/sigint/network-points', transformCamelToSnake(req));
  return transformSnakeToCamel<ListNetworkPointsRsp>(data);
}

export async function getNetworkFreqCallsigns(networkFreqId: number): Promise<string[]> {
  const data = await postJson<{ networkFreqId: number; callsigns: string[] }>('/api/sigint/network-freq-callsigns', transformCamelToSnake({
    networkFreqId,
  } satisfies NetworkFreqCallsignsReq));
  const normalized = transformSnakeToCamel<{ networkFreqId: number; callsigns: string[] }>(data);
  return normalized.callsigns ?? [];
}

export async function addFreqToNetwork(req: AddNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/add-freq', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkFreq(req: UpdateNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/update-freq', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function deleteNetworkFreq(req: DeleteNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/delete-freq', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function reactivateNetworkFreq(req: ReactivateNetworkFreqReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/reactivate-freq', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function listKeys(req: ListKeysReq): Promise<ListKeysRsp> {
  const data = await postJson<ListKeysRsp>('/api/sigint/keys', transformCamelToSnake(req));
  return transformSnakeToCamel<ListKeysRsp>(data);
}

export async function createKey(req: CreateEncryptionKeyReq): Promise<EncryptionKeyData> {
  const data = await postJson<EncryptionKeyData>('/api/sigint/keys/create', transformCamelToSnake(req));
  return transformSnakeToCamel<EncryptionKeyData>(data);
}

export async function deleteNetwork(networkId: number): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/delete-network', { network_id: networkId });
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkPosts(req: UpdateNetworkPostsReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/update-posts', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkUnits(req: UpdateNetworkUnitsReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/update-units', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetwork(req: UpdateNetworkReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/update-network', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function addNetworkDescriptions(req: AddNetworkDescriptionsReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/add-descriptions', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function updateNetworkDescription(req: UpdateNetworkDescriptionReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/update-description', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}

export async function deleteNetworkDescription(req: DeleteNetworkDescriptionReq): Promise<Network> {
  const data = await postJson<Network>('/api/sigint/network/delete-description', transformCamelToSnake(req));
  return transformSnakeToCamel<Network>(data);
}
