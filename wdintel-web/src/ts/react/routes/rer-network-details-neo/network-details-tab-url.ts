import type { NetworkDetailsTab } from './use-rer-network-details-neo-page.shared';

const PUBLIC_TAB_TO_INTERNAL_TAB: Record<string, NetworkDetailsTab> = {
  justifications: 'descriptions',
  'reconnaissance-signs': 'signs',
  frequencies: 'frequencies',
  callsigns: 'callsigns',
  activity: 'activity',
  'direction-finding': 'direction-finding',
  pelengation: 'direction-finding',
  'connections-graph': 'relations',
};

export function resolveRequestedNetworkDetailsTab(
  requestedTab: string | null | undefined,
  canViewActivityTab: boolean,
  canViewRelationsTab: boolean,
): NetworkDetailsTab {
  const mappedTab = requestedTab ? PUBLIC_TAB_TO_INTERNAL_TAB[requestedTab] : undefined;
  if (!mappedTab) return 'descriptions';
  if (mappedTab === 'activity' && !canViewActivityTab) return 'descriptions';
  if (mappedTab === 'relations' && !canViewRelationsTab) return 'descriptions';
  return mappedTab;
}

export function readRequestedNetworkDetailsTab(search: string): string | null {
  const params = new URLSearchParams(search);
  const value = params.get('tab')?.trim() ?? '';
  return value === '' ? null : value;
}
