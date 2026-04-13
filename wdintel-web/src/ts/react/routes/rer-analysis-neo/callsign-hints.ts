import type { CallsignInfo, CallsignInfoRes, Network, Unit } from '../../../../Bindings';
import { formatLegacyCallsignTooltipLine } from './callsign-hints-utils';

export type CallsignHintContext = 'message' | 'frequency';
export type CallsignHintStrategy = 'network' | 'system' | 'none';

export type CallsignHintResult = {
  strategy: CallsignHintStrategy;
  prioritizedCallsigns: CallsignInfo[];
  iconClass: string;
};

export type CallsignHintTooltipData = {
  header: string;
  items: string[];
};

function getReportedNetworkIds(callsignInfo: Pick<CallsignInfo, 'networkIdsReportedIn'>): number[] {
  return callsignInfo.networkIdsReportedIn ?? [];
}

function getMessageNetworkIds(networkIds?: number[] | null): number[] | null {
  if (!networkIds || networkIds.length === 0) return null;
  return networkIds;
}

function filterNetworksByFreq(networks: Network[], freq: string | null): Network[] {
  if (!freq) return [];
  return networks.filter((network) => network.freqs.some((networkFreq) => networkFreq.freq === freq));
}

function getNetworksByIds(ids: number[], networks: Network[]): Network[] {
  return ids.map((id) => networks.find((network) => network.id === id)).filter((network): network is Network => network != null);
}

function getAllUnitIdsForNetworks(networks: Network[]): number[] {
  return networks.flatMap((network) => network.unitIds ?? []);
}

function getUnitsInfoByIds(unitIds: number[], unitsMap: Record<number, Unit>): Unit[] {
  return unitIds.map((id) => unitsMap[id]).filter((unit): unit is Unit => unit != null);
}

function isSameOrChildUnit(child: Unit, parent: Unit): boolean {
  const childParts = [child.army, child.division, child.regiment, child.battalion, child.company].map((value) => value?.trim() ?? '');
  const parentParts = [parent.army, parent.division, parent.regiment, parent.battalion, parent.company].map((value) => value?.trim() ?? '');
  return parentParts.every((part, index) => part === '' || part === childParts[index]);
}

function findCallsignUnits(callsigns: CallsignInfo[], unitsMap: Record<number, Unit>): Unit[] {
  const unitIds = callsigns.map((callsign) => callsign.unitId).filter((unitId): unitId is number => unitId != null);
  return getUnitsInfoByIds(unitIds, unitsMap);
}

function filterCallsignsByNetworkUnits(callsigns: CallsignInfo[], unitsMap: Record<number, Unit>, networkUnits: Unit[]): CallsignInfo[] {
  const callsignUnits = findCallsignUnits(callsigns, unitsMap);
  const unitsWithSameRegiment = callsignUnits.filter((callsignUnit) =>
    networkUnits.some((networkUnit) => isSameOrChildUnit(callsignUnit, networkUnit)),
  );
  return callsigns.filter((callsign) => unitsWithSameRegiment.some((unit) => unit.id === callsign.unitId));
}

function isCallsignRelatedToNetworks(callsignInfo: CallsignInfo[] | null, networks: Network[], unitsMap: Record<number, Unit>): boolean {
  if (!callsignInfo || callsignInfo.length === 0) return false;
  const networkUnits = getUnitsInfoByIds(getAllUnitIdsForNetworks(networks), unitsMap);
  const callsignUnits = findCallsignUnits(callsignInfo, unitsMap);
  return callsignUnits.some((callsignUnit) => networkUnits.some((networkUnit) => isSameOrChildUnit(callsignUnit, networkUnit)));
}

function hasCallsignInMessageNetworks(callsignInfo: CallsignInfo[] | null, messageNetworkIds: number[]): boolean {
  if (!callsignInfo || callsignInfo.length === 0) return false;
  return callsignInfo.some((item) => getReportedNetworkIds(item).some((networkId) => messageNetworkIds.includes(networkId)));
}

function getIconClass(strategy: CallsignHintStrategy): string {
  switch (strategy) {
    case 'network':
      return 'bi-info-circle-fill';
    case 'system':
      return 'bi-info-circle';
    case 'none':
      return '';
  }
}

function determineHintStrategyForCallsign(params: {
  hintContext: CallsignHintContext;
  freq: string | null;
  networkIds?: number[] | null;
  networks: Network[];
  unitsMap: Record<number, Unit>;
  callsignInfo: CallsignInfo[] | null;
}): CallsignHintStrategy {
  const { hintContext, freq, networkIds, networks, unitsMap, callsignInfo } = params;
  const networksByFreq = filterNetworksByFreq(networks, freq);
  const messageNetworkIds = getMessageNetworkIds(networkIds);
  const hasCatalogMatch = (callsignInfo ?? []).length > 0;

  if (hintContext === 'message') {
    if (messageNetworkIds) {
      return hasCallsignInMessageNetworks(callsignInfo, messageNetworkIds) ? 'network' : 'none';
    }
    return hasCatalogMatch ? 'system' : 'none';
  }

  if (messageNetworkIds) return 'network';
  if (networksByFreq.length > 0) {
    return isCallsignRelatedToNetworks(callsignInfo, networksByFreq, unitsMap) ? 'network' : 'system';
  }
  return 'system';
}

function getPrioritizedCallsigns(params: {
  strategy: CallsignHintStrategy;
  freq: string | null;
  networkIds?: number[] | null;
  networks: Network[];
  unitsMap: Record<number, Unit>;
  callsignInfo: CallsignInfo[];
}): CallsignInfo[] {
  const { strategy, freq, networkIds, networks, unitsMap, callsignInfo } = params;
  if (strategy === 'none') return [];
  if (strategy === 'system') return callsignInfo;

  const messageNetworkIds = getMessageNetworkIds(networkIds);
  if (messageNetworkIds) {
    return callsignInfo.filter((item) => getReportedNetworkIds(item).some((networkId) => messageNetworkIds.includes(networkId)));
  }

  const networksByFreq = filterNetworksByFreq(networks, freq);
  const networkUnits = getUnitsInfoByIds(getAllUnitIdsForNetworks(networksByFreq), unitsMap);
  return filterCallsignsByNetworkUnits(callsignInfo, unitsMap, networkUnits);
}

function isTooltipLineVisible(line: string): boolean {
  return line.replace(/^🐷/, '').trim() !== '';
}

export function getCallsignHintResult(params: {
  hintContext: CallsignHintContext;
  freq: string | null;
  networkIds?: number[] | null;
  networks: Network[];
  unitsMap: Record<number, Unit>;
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  callsign: string;
}): CallsignHintResult {
  const callsignInfo = params.callsignInfoMap?.[params.callsign.toLowerCase()]?.res ?? null;
  const strategy = determineHintStrategyForCallsign({
    hintContext: params.hintContext,
    freq: params.freq,
    networkIds: params.networkIds,
    networks: params.networks,
    unitsMap: params.unitsMap,
    callsignInfo,
  });

  return {
    strategy,
    prioritizedCallsigns: callsignInfo
      ? getPrioritizedCallsigns({
          strategy,
          freq: params.freq,
          networkIds: params.networkIds,
          networks: params.networks,
          unitsMap: params.unitsMap,
          callsignInfo,
        })
      : [],
    iconClass: getIconClass(strategy),
  };
}

export function formatCallsignHintTooltipData(result: CallsignHintResult): CallsignHintTooltipData | null {
  if (result.prioritizedCallsigns.length === 0) return null;

  const header = result.strategy === 'network' ? 'Позивні підрозділів мережі:' : 'Позивні з каталогу:';
  const items = result.prioritizedCallsigns.map(formatLegacyCallsignTooltipLine).filter(isTooltipLineVisible);
  if (items.length === 0) return null;

  return {
    header,
    items,
  };
}

export function formatCallsignHintTooltip(result: CallsignHintResult): string | null {
  const tooltipData = formatCallsignHintTooltipData(result);
  if (!tooltipData) return null;
  return [tooltipData.header, ...tooltipData.items].join('\n');
}

export const __private__ = {
  filterNetworksByFreq,
  getNetworksByIds,
  getAllUnitIdsForNetworks,
  getUnitsInfoByIds,
  isSameOrChildUnit,
  filterCallsignsByNetworkUnits,
  isCallsignRelatedToNetworks,
  hasCallsignInMessageNetworks,
  determineHintStrategyForCallsign,
  getPrioritizedCallsigns,
};
