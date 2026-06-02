import type { InboxMessage, Network } from '../../../../../Bindings';
import { NO_DATA_LABEL, isPresent } from '../../../utils/misc';
import { buildRerNetworkDetailsHref } from '../../rer-network-details-neo/network-details-preference';

export type EtalonBindingDisplayValue = {
  displayValue: string;
  copyValue: string | null;
};

export type MessageCardRenderedNetwork = {
  networkId: number;
  label: string;
  badge: boolean;
};

export type MessageCardNavigationMenuItem = {
  kind: 'network' | 'map' | 'analysis';
  href: string;
  label?: string;
  networkLabel?: string;
  badge?: boolean;
};

export type MessageCardEtalonDisplayModel = {
  primaryKind: 'network' | 'location' | 'unit' | 'empty';
  displayValue: string;
  copyEtalonValue: string | null;
  copyLocationValue: string | null;
  renderedNetworks: MessageCardRenderedNetwork[];
  showInlineLocationTooltip: boolean;
  locationDisplayValue: string | null;
};

type ResolveEtalonBindingDisplayValueOptions = {
  featureStrictNetworks?: boolean;
  networkDisplayMap?: Record<number, string>;
  networkMap?: Record<number, Network>;
  networks?: Network[];
};

function normalizeLabel(value: string | null | undefined): string {
  return String(value ?? '').trim();
}

function buildNetworkMap(
  options: ResolveEtalonBindingDisplayValueOptions,
): Record<number, Network> {
  if (options.networkMap) return options.networkMap;
  if (!options.networks) return {};
  return Object.fromEntries(options.networks.map((network) => [network.id, network]));
}

function uniqueNetworkIds(values: number[] | null | undefined): number[] {
  return Array.from(new Set(values ?? []));
}

function networkNeedsInvestigationBadge(network: Network | undefined): boolean {
  if (network == null) return false;
  const ids = network.unitIds;
  if (ids == null) return true;
  return ids.length === 0;
}

function hasLowercaseLetters(value: string): boolean {
  return value !== value.toUpperCase();
}

function titleCaseWord(value: string): string {
  const [first = '', ...rest] = value;
  return first.toLocaleUpperCase('uk-UA') + rest.join('').toLocaleLowerCase('uk-UA');
}

export function normalizeLocationDisplayValue(value: string | null | undefined): string | null {
  const normalizedLocation = String(value ?? '').trim();
  if (normalizedLocation === '' || normalizedLocation === 'Не встановлена') return null;
  if (hasLowercaseLetters(normalizedLocation)) return normalizedLocation;
  return normalizedLocation
    .toLocaleLowerCase('uk-UA')
    .split(/(\s+|-)/)
    .map((part) => (part.trim() === '' || part === '-' ? part : titleCaseWord(part)))
    .join('');
}

export function resolveMessageCardRenderedNetworks(
  networkIds: number[] | null | undefined,
  options: Pick<ResolveEtalonBindingDisplayValueOptions, 'networkDisplayMap' | 'networkMap' | 'networks'> = {},
): MessageCardRenderedNetwork[] {
  const networkMap = buildNetworkMap(options);
  const renderedNetworks = uniqueNetworkIds(networkIds)
    .map((networkId) => {
      const network = networkMap[networkId];
      const label = normalizeLabel(options.networkDisplayMap?.[networkId] ?? network?.name ?? null);
      if (label === '') return null;
      return {
        networkId,
        label: options.networkDisplayMap?.[networkId] ?? (network ? `р/м ${network.name}` : ''),
        badge: networkNeedsInvestigationBadge(network),
      };
    })
    .filter((network): network is MessageCardRenderedNetwork => network != null && normalizeLabel(network.label) !== '');

  return renderedNetworks.filter((item, index, all) => index === all.findIndex((other) => other.networkId === item.networkId));
}

export function buildMessageCardNavigationMenuItems(
  renderedNetworks: MessageCardRenderedNetwork[],
  mapHref: string | null | undefined,
  analysisHref: string | null | undefined,
): MessageCardNavigationMenuItem[] {
  const items: MessageCardNavigationMenuItem[] = renderedNetworks.map((network) => ({
    kind: 'network',
    href: buildRerNetworkDetailsHref(network.networkId),
    networkLabel: network.label,
    badge: network.badge,
  }));
  if (isPresent(mapHref) && mapHref.trim() !== '') {
    items.push({ kind: 'map', href: mapHref, label: 'На мапу' });
  }
  if (isPresent(analysisHref) && analysisHref.trim() !== '') {
    items.push({ kind: 'analysis', href: analysisHref, label: 'В аналіз' });
  }
  return items;
}

export function resolveEtalonBindingDisplayValue(
  msg: InboxMessage,
  options: ResolveEtalonBindingDisplayValueOptions = {},
): EtalonBindingDisplayValue {
  const networkIds = uniqueNetworkIds(msg.networkIds);
  const networkMap = buildNetworkMap(options);
  const labels = networkIds
    .map((networkId) => {
      const label = normalizeLabel(options.networkDisplayMap?.[networkId] ?? networkMap[networkId]?.name ?? null);
      if (label === '') return null;
      return options.networkDisplayMap?.[networkId] ?? (networkMap[networkId] ? `р/м ${networkMap[networkId].name}` : null);
    })
    .filter((label): label is string => normalizeLabel(label) !== '');

  if (labels.length > 0) {
    const displayValue = labels.join('\n');
    return {
      displayValue,
      copyValue: displayValue,
    };
  }

  if (networkIds.length > 0) {
    return {
      displayValue: NO_DATA_LABEL,
      copyValue: null,
    };
  }

  const unit = options.featureStrictNetworks ? '' : normalizeLabel(msg.unit);
  if (unit !== '') {
    return {
      displayValue: unit,
      copyValue: unit,
    };
  }

  return {
    displayValue: NO_DATA_LABEL,
    copyValue: null,
  };
}

export function resolveMessageCardEtalonDisplayModel(
  msg: InboxMessage,
  options: ResolveEtalonBindingDisplayValueOptions = {},
): MessageCardEtalonDisplayModel {
  const renderedNetworks = resolveMessageCardRenderedNetworks(msg.networkIds, options);
  const locationDisplayValue = normalizeLocationDisplayValue(msg.location);
  const etalonBindingValue = resolveEtalonBindingDisplayValue(msg, options);

  if (renderedNetworks.length > 0) {
    const displayValue = renderedNetworks.map((network) => network.label).join('\n');
    return {
      primaryKind: 'network',
      displayValue,
      copyEtalonValue: displayValue,
      copyLocationValue: null,
      renderedNetworks,
      showInlineLocationTooltip: locationDisplayValue != null,
      locationDisplayValue,
    };
  }

  if (locationDisplayValue != null) {
    return {
      primaryKind: 'location',
      displayValue: locationDisplayValue,
      copyEtalonValue: null,
      copyLocationValue: locationDisplayValue,
      renderedNetworks,
      showInlineLocationTooltip: false,
      locationDisplayValue,
    };
  }

  if (etalonBindingValue.copyValue != null) {
    return {
      primaryKind: 'unit',
      displayValue: etalonBindingValue.displayValue,
      copyEtalonValue: etalonBindingValue.copyValue,
      copyLocationValue: null,
      renderedNetworks,
      showInlineLocationTooltip: false,
      locationDisplayValue: null,
    };
  }

  return {
    primaryKind: 'empty',
    displayValue: NO_DATA_LABEL,
    copyEtalonValue: null,
    copyLocationValue: null,
    renderedNetworks,
    showInlineLocationTooltip: false,
    locationDisplayValue: null,
  };
}
