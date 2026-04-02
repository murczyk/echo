import type { CallsignInfo, CallsignInfoRes, Network, Unit } from '../../../../Bindings';

export type CallsignHintContext = 'message' | 'frequency';
export type CallsignHintStrategy = 'network' | 'system' | 'none';

export type CallsignHintResult = {
  strategy: CallsignHintStrategy;
  prioritizedCallsigns: CallsignInfo[];
  nonPrioritizedCallsigns: CallsignInfo[];
  iconClass: string;
};

function filterNetworksByFreq(networks: Network[], freq: string | null): Network[] {
  if (!freq) return [];
  return networks.filter((network) => network.freqs.some((networkFreq) => networkFreq.freq === freq));
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
  const networksFromMessage = (networkIds ?? []).length > 0 ? networks.filter((network) => (networkIds ?? []).includes(network.id)) : [];
  const hasCatalogMatch = (callsignInfo ?? []).length > 0;

  if (hintContext === 'message') {
    if (networksFromMessage.length > 0) {
      const hasCallsignInMessageNetworks = (callsignInfo ?? []).some((item) =>
        item.networkIdsReportedIn.some((networkId) => (networkIds ?? []).includes(networkId)),
      );
      if (hasCallsignInMessageNetworks) return 'network';
      return hasCatalogMatch ? 'system' : 'none';
    }
    return hasCatalogMatch ? 'system' : 'none';
  }

  if (networksFromMessage.length > 0) return 'network';
  if (networksByFreq.length > 0) {
    return isCallsignRelatedToNetworks(callsignInfo, networksByFreq, unitsMap) ? 'network' : 'system';
  }
  return 'system';
}

export function getCallsignHintResult(params: {
  hintContext: CallsignHintContext;
  freq: string | null;
  networkIds?: number[] | null;
  networks: Network[];
  unitsMap: Record<number, Unit>;
  callsignInfoMap: Record<string, CallsignInfoRes>;
  callsign: string;
}): CallsignHintResult {
  const callsignInfo = params.callsignInfoMap[params.callsign.toLowerCase()]?.res ?? null;
  const strategy = determineHintStrategyForCallsign({
    hintContext: params.hintContext,
    freq: params.freq,
    networkIds: params.networkIds,
    networks: params.networks,
    unitsMap: params.unitsMap,
    callsignInfo,
  });

  if (!callsignInfo || callsignInfo.length === 0 || strategy === 'none') {
    return {
      strategy,
      prioritizedCallsigns: [],
      nonPrioritizedCallsigns: [],
      iconClass: getIconClass(strategy),
    };
  }

  const prioritizedCallsigns =
    strategy === 'network'
      ? filterCallsignsByNetworkUnits(
          callsignInfo,
          params.unitsMap,
          getUnitsInfoByIds(
            getAllUnitIdsForNetworks(
              (params.networkIds ?? []).length > 0
                ? params.networks.filter((network) => (params.networkIds ?? []).includes(network.id))
                : filterNetworksByFreq(params.networks, params.freq),
            ),
            params.unitsMap,
          ),
        )
      : callsignInfo;
  const prioritizedIds = new Set(prioritizedCallsigns.map((item) => item.id));
  return {
    strategy,
    prioritizedCallsigns,
    nonPrioritizedCallsigns: callsignInfo.filter((item) => !prioritizedIds.has(item.id)),
    iconClass: getIconClass(strategy),
  };
}

export function formatCallsignHintTooltip(result: CallsignHintResult): string | null {
  if (result.prioritizedCallsigns.length === 0 && result.nonPrioritizedCallsigns.length === 0) {
    return null;
  }

  const toText = (value: string | null | undefined): string => value?.trim() ?? '';

  const viewCallsign = (callsignInfo: CallsignInfo) =>
    ['🐷', toText(callsignInfo.position), toText(callsignInfo.unit1), toText(callsignInfo.unit2)]
      .filter((part) => part !== '')
      .join(' ');

  if (result.prioritizedCallsigns.length > 0) {
    const header = result.strategy === 'network' ? 'Позивні підрозділів мережі:' : 'Позивні з каталогу:';
    return [header, ...result.prioritizedCallsigns.map(viewCallsign)].join('\n');
  }

  return null;
}
