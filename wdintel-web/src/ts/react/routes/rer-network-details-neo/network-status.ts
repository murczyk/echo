import type { Network, NetworkStatus } from '../../../../Bindings';

export const NETWORK_STATUS_ACTIVE = 'NetworkActive' satisfies NetworkStatus;
export const NETWORK_STATUS_INACTIVE = 'NetworkInactive' satisfies NetworkStatus;

export function getRestoreNetworkOnEditValue(
  network: Pick<Network, 'deleted' | 'activeTo'> | null | undefined,
  _status: NetworkStatus,
): boolean | null {
  return network?.deleted === true ? true : null;
}
