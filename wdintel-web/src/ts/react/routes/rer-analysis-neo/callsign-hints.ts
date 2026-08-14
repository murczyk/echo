import type {
  CallsignInfo,
  CallsignInfoRes,
  CallsignNetworkHint,
  Network,
  Unit,
} from '../../../../Bindings';
import { normalizeCallsignLookupValue } from '../../utils/callsign-normalization';
import {
  formatLegacyCallsignTooltipLine,
  formatNetworkCallsignTooltipLine,
} from './callsign-hints-utils';
import { isPresent } from '../../utils/misc';

export type CallsignHintContext = 'message' | 'frequency';
export type CallsignHintStrategy = 'network' | 'system' | 'none';

export type CallsignHintResult = {
  strategy: CallsignHintStrategy;
  prioritizedCallsigns: Array<CallsignInfo | CallsignNetworkHint>;
  iconClass: string;
};

export type CallsignHintTooltipData = {
  header: string;
  items: string[];
};

export type MessageCallsignHintState = 'message-network' | 'known-elsewhere' | 'unresolved';

export type MessageCallsignHintResult = {
  state: MessageCallsignHintState;
  catalogRows: CallsignInfo[];
  exactNetworkHints: CallsignNetworkHint[];
  otherNetworkHints: CallsignNetworkHint[];
  networkNames: Record<number, string>;
};

export type CallsignHintTooltipSection = {
  header: string;
  items: string[];
};

export type MessageCallsignHintTooltipData = {
  sections: CallsignHintTooltipSection[];
};

function getReportedNetworkIds(callsignInfo: Pick<CallsignInfo, 'networkIdsReportedIn'>): number[] {
  return callsignInfo.networkIdsReportedIn ?? [];
}

function getMessageNetworkIds(networkIds?: number[] | null): number[] | null {
  if (!networkIds || networkIds.length === 0) return null;
  return networkIds;
}

export function resolveNetworkCallsignHints(
  networkIds: number[],
  callsignInfo: CallsignInfoRes,
): CallsignNetworkHint[] {
  return (callsignInfo.networkHints ?? []).filter((hint) => networkIds.includes(hint.networkId));
}

function filterNetworksByFreq(networks: Network[], freq: string | null): Network[] {
  if (!freq) return [];
  return networks.filter((network) =>
    network.freqs.some((networkFreq) => networkFreq.freq === freq),
  );
}

function getNetworksByIds(ids: number[], networks: Network[]): Network[] {
  return ids
    .map((id) => networks.find((network) => network.id === id))
    .filter((network): network is Network => isPresent(network));
}

function getAllUnitIdsForNetworks(networks: Network[]): number[] {
  return networks.flatMap((network) => network.unitIds ?? []);
}

function getUnitsInfoByIds(unitIds: number[], unitsMap: Record<number, Unit>): Unit[] {
  return unitIds.map((id) => unitsMap[id]).filter((unit): unit is Unit => isPresent(unit));
}

function isSameOrChildUnit(child: Unit, parent: Unit): boolean {
  const childParts = [
    child.armyRegion,
    child.militaryDistrict,
    child.army,
    child.division,
    child.regiment,
    child.battalion,
    child.company,
  ].map((value) => value?.trim() ?? '');
  const parentParts = [
    parent.armyRegion,
    parent.militaryDistrict,
    parent.army,
    parent.division,
    parent.regiment,
    parent.battalion,
    parent.company,
  ].map((value) => value?.trim() ?? '');
  return parentParts.every((part, index) => part === '' || part === childParts[index]);
}

function findCallsignUnits(callsigns: CallsignInfo[], unitsMap: Record<number, Unit>): Unit[] {
  const unitIds = callsigns
    .map((callsign) => callsign.unitId)
    .filter((unitId): unitId is number => isPresent(unitId));
  return getUnitsInfoByIds(unitIds, unitsMap);
}

function filterCallsignsByNetworkUnits(
  callsigns: CallsignInfo[],
  unitsMap: Record<number, Unit>,
  networkUnits: Unit[],
): CallsignInfo[] {
  const callsignUnits = findCallsignUnits(callsigns, unitsMap);
  const unitsWithSameRegiment = callsignUnits.filter((callsignUnit) =>
    networkUnits.some((networkUnit) => isSameOrChildUnit(callsignUnit, networkUnit)),
  );
  return callsigns.filter((callsign) =>
    unitsWithSameRegiment.some((unit) => unit.id === callsign.unitId),
  );
}

export function isCallsignRelatedToNetworks(
  callsignInfo: CallsignInfo[] | null,
  networks: Network[],
  unitsMap: Record<number, Unit>,
): boolean {
  if (!callsignInfo || callsignInfo.length === 0) return false;
  const networkUnits = getUnitsInfoByIds(getAllUnitIdsForNetworks(networks), unitsMap);
  const callsignUnits = findCallsignUnits(callsignInfo, unitsMap);
  return callsignUnits.some((callsignUnit) =>
    networkUnits.some((networkUnit) => isSameOrChildUnit(callsignUnit, networkUnit)),
  );
}

function hasCallsignInMessageNetworks(
  callsignInfo: CallsignInfo[] | null,
  messageNetworkIds: number[],
): boolean {
  if (!callsignInfo || callsignInfo.length === 0) return false;
  return callsignInfo.some((item) =>
    getReportedNetworkIds(item).some((networkId) => messageNetworkIds.includes(networkId)),
  );
}

function getStrictMessageNetworkHintStrategy(
  callsignInfo: CallsignInfo[] | null,
  messageNetworkIds: number[],
): Extract<CallsignHintStrategy, 'network' | 'none'> {
  return hasCallsignInMessageNetworks(callsignInfo, messageNetworkIds) ? 'network' : 'none';
}

function getIconClass(strategy: CallsignHintStrategy): string {
  switch (strategy) {
    case 'network':
      return 'info-circle-fill';
    case 'system':
      return 'info-circle';
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
  const isRelatedToAnyLoadedNetwork =
    hasCatalogMatch && isCallsignRelatedToNetworks(callsignInfo, networks, unitsMap);

  if (hintContext === 'message') {
    if (messageNetworkIds) {
      if (hasCallsignInMessageNetworks(callsignInfo, messageNetworkIds)) return 'network';
      if (!isRelatedToAnyLoadedNetwork) return hasCatalogMatch ? 'system' : 'none';
      return 'none';
    }
    return hasCatalogMatch ? 'system' : 'none';
  }

  if (messageNetworkIds) return 'network';
  if (networksByFreq.length > 0) {
    return isCallsignRelatedToNetworks(callsignInfo, networksByFreq, unitsMap)
      ? 'network'
      : 'system';
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
    return callsignInfo.filter((item) =>
      getReportedNetworkIds(item).some((networkId) => messageNetworkIds.includes(networkId)),
    );
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
  const callsignResponse = params.callsignInfoMap?.[normalizeCallsignLookupValue(params.callsign)];
  const callsignInfo = callsignResponse?.res ?? null;
  const scopedNetworkIds =
    params.hintContext === 'message'
      ? getMessageNetworkIds(params.networkIds)
      : filterNetworksByFreq(params.networks, params.freq).map((network) => network.id);
  if (scopedNetworkIds && scopedNetworkIds.length > 0) {
    const networkHints = callsignResponse
      ? resolveNetworkCallsignHints(scopedNetworkIds, callsignResponse)
      : [];
    return {
      strategy: networkHints.length > 0 ? 'network' : 'none',
      prioritizedCallsigns: networkHints,
      iconClass: getIconClass(networkHints.length > 0 ? 'network' : 'none'),
    };
  }
  const strategy = determineHintStrategyForCallsign({
    hintContext: params.hintContext,
    freq: params.freq,
    networkIds: params.hintContext === 'message' ? params.networkIds : undefined,
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

export function formatCallsignHintTooltipData(
  result: CallsignHintResult,
): CallsignHintTooltipData | null {
  if (result.prioritizedCallsigns.length === 0) return null;

  const header =
    result.strategy === 'network' ? 'Позивні підрозділів мережі:' : 'Позивні з каталогу:';
  const items = result.prioritizedCallsigns
    .map((item) =>
      'networkId' in item
        ? formatNetworkCallsignTooltipLine(item)
        : formatLegacyCallsignTooltipLine(item),
    )
    .filter(isTooltipLineVisible);
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

export function getMessageCallsignHintResult(params: {
  networkIds?: number[] | null;
  networks: Network[];
  callsignInfoMap?: Record<string, CallsignInfoRes>;
  callsign: string;
}): MessageCallsignHintResult {
  const response = params.callsignInfoMap?.[normalizeCallsignLookupValue(params.callsign)];
  const messageNetworkIds = new Set(params.networkIds ?? []);
  const catalogRows = response?.res ?? [];
  const exactNetworkHints = (response?.networkHints ?? []).filter((hint) =>
    messageNetworkIds.has(hint.networkId),
  );
  const otherNetworkHints = (response?.networkHints ?? []).filter(
    (hint) => !messageNetworkIds.has(hint.networkId),
  );
  const state: MessageCallsignHintState =
    exactNetworkHints.length > 0
      ? 'message-network'
      : catalogRows.length > 0 || otherNetworkHints.length > 0
        ? 'known-elsewhere'
        : 'unresolved';
  return {
    state,
    catalogRows,
    exactNetworkHints,
    otherNetworkHints,
    networkNames: Object.fromEntries(params.networks.map((network) => [network.id, network.name])),
  };
}

function formatMessageNetworkHint(
  hint: CallsignNetworkHint,
  networkNames: Record<number, string>,
): string {
  const line = formatNetworkCallsignTooltipLine(hint);
  return isTooltipLineVisible(line)
    ? line
    : `Позивний присутній у мережі «${networkNames[hint.networkId] ?? `#${hint.networkId}`}». Додатковий опис відсутній.`;
}

export function formatMessageCallsignHintTooltipData(
  result: MessageCallsignHintResult,
): MessageCallsignHintTooltipData | null {
  if (result.state === 'unresolved') return null;
  const sections: CallsignHintTooltipSection[] = [];
  if (result.state === 'message-network') {
    sections.push({
      header: 'Позивні підрозділів мережі:',
      items: result.exactNetworkHints.map((hint) =>
        formatMessageNetworkHint(hint, result.networkNames),
      ),
    });
  } else {
    if (result.catalogRows.length > 0) {
      sections.push({
        header: 'Позивні з каталогу:',
        items: result.catalogRows.map((row) => {
          const line = formatLegacyCallsignTooltipLine(row);
          return isTooltipLineVisible(line)
            ? line
            : 'Позивний присутній у каталозі. Додатковий опис відсутній.';
        }),
      });
    }
    if (result.otherNetworkHints.length > 0) {
      sections.push({
        header: 'Позивний присутній в інших мережах:',
        items: result.otherNetworkHints.map((hint) =>
          formatMessageNetworkHint(hint, result.networkNames),
        ),
      });
    }
  }
  return { sections };
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
  getStrictMessageNetworkHintStrategy,
  determineHintStrategyForCallsign,
  getPrioritizedCallsigns,
};
