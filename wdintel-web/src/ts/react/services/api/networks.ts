import type {
  ListNetworksReq,
  Network,
  SingleNetworkCallsignsListRsp,
  UpdateNetworkPostsReq,
  UpdateNetworkReq,
  UpdateNetworkUnitsReq,
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
