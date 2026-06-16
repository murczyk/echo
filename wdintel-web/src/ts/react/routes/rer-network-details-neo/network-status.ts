import type { Network, NetworkStatus } from '../../../../Bindings';

export const NETWORK_STATUS_ACTIVE = 'NetworkActive' satisfies NetworkStatus;
export const NETWORK_STATUS_INACTIVE = 'NetworkInactive' satisfies NetworkStatus;

export function getRestoreNetworkOnEditValue(
  network: Pick<Network, 'deleted' | 'activeTo'> | null | undefined,
  status: NetworkStatus,
): boolean | null {
  return network?.deleted === true && network.activeTo !== null && status === NETWORK_STATUS_ACTIVE ? true : null;
}
