import type { ListNetworksReq, Network } from '../../../../Bindings';
import { postJson } from './client';
import { snakeToCamel } from '../../../snake-to-camel';

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
    sortBy: ['NameAsc'],
  };
  const data = await postJson<Network[]>('/api/sigint/network-list', req);
  // add model normalization here
  const normalizedData = snakeToCamel(data);
  return Array.isArray(normalizedData) ? normalizedData : []; 
}

/** Fetch networks by IDs */
export async function getNetworksByIds(ids: number[]): Promise<Network[]> {
  if (ids.length === 0) return [];
  const data = await postJson<Network[]>('/api/sigint/network-info-batch-id', ids);
  return Array.isArray(data) ? data : [];
}
