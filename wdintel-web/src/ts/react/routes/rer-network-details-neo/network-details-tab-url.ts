import type { NetworkDetailsTab } from './use-rer-network-details-neo-page.shared';

const INTERNAL_TO_PUBLIC_TAB: Record<NetworkDetailsTab, string> = {
  descriptions: 'justifications',
  signs: 'reconnaissance-signs',
  frequencies: 'frequencies',
  callsigns: 'callsigns',
  relations: 'connections-graph',
  activity: 'activity',
  'direction-finding': 'direction-finding',
};

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

export function getPublicNetworkDetailsTab(tab: NetworkDetailsTab): string {
  return INTERNAL_TO_PUBLIC_TAB[tab];
}

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

export function buildNetworkDetailsTabUrl(
  location: Pick<Location, 'pathname' | 'search' | 'hash'>,
  tab: NetworkDetailsTab,
): string {
  const params = new URLSearchParams(location.search);
  params.set('tab', getPublicNetworkDetailsTab(tab));
  const query = params.toString();
  return `${location.pathname}${query === '' ? '' : `?${query}`}${location.hash}`;
}

export function updateCurrentNetworkDetailsTabUrl(
  tab: NetworkDetailsTab,
  mode: 'push' | 'replace',
): void {
  if (typeof window === 'undefined') return;

  const nextUrl = buildNetworkDetailsTabUrl(window.location, tab);
  if (mode === 'push') {
    window.history.pushState(window.history.state, '', nextUrl);
    return;
  }

  window.history.replaceState(window.history.state, '', nextUrl);
}
