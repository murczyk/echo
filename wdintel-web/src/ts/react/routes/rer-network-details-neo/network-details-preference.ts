export type RerNetworkDetailsPreferredView = 'neo' | 'classic';

const PREFERRED_VIEW_STORAGE_KEY = 'rer-network-details.preferredView';

export function readRerNetworkDetailsPreferredView(): RerNetworkDetailsPreferredView {
  if (typeof window === 'undefined' || typeof window.localStorage?.getItem !== 'function') {
    return 'neo';
  }

  const storedValue = window.localStorage.getItem(PREFERRED_VIEW_STORAGE_KEY);
  return storedValue === 'classic' ? 'classic' : 'neo';
}

export function saveRerNetworkDetailsPreferredView(
  preferredView: RerNetworkDetailsPreferredView,
): void {
  if (typeof window === 'undefined' || typeof window.localStorage?.setItem !== 'function') {
    return;
  }

  window.localStorage.setItem(PREFERRED_VIEW_STORAGE_KEY, preferredView);
}

export function buildRerNetworkDetailsHref(
  networkId: number,
  preferredView: RerNetworkDetailsPreferredView = readRerNetworkDetailsPreferredView(),
): string {
  const baseHref = `/rer-networks/${networkId}`;
  return preferredView === 'classic' ? `${baseHref}?view=classic` : baseHref;
}
