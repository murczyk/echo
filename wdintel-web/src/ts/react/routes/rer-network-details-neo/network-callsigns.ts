import type {
  CallsignActivityItem,
  KnownCallsignShortRes,
  NetworkCallsign,
  NetworkCallsignRes,
  Source,
} from '../../../../Bindings';
import { NO_DATA_LABEL, formatDateTime24 } from '../../utils/misc';

export type NetworkCallsignSectionMode = 'network' | 'catalog' | 'intercepted';

export type NetworkCallsignStatusFilter = 'All' | 'Verified' | 'Developing' | 'Catalog' | 'Unknown';

export type NetworkCallsignStatus = 'verified' | 'developing' | 'catalog' | 'unknown';

export enum NetworkCallsignSourceId {
  RO = 2,
}

export type NetworkCallsignDrawerMode = 'create' | 'edit';

export type NetworkCallsignDrawerForm = {
  id: number | null;
  networkId: number;
  callsign: string;
  status: NetworkCallsignStatus;
  position: string;
  comment: string;
  sourceId: number | null;
  radioFreq: string;
  unitId: number | null;
  unitDeveloping: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  commandControl: boolean;
};

export type NetworkCallsignRowView = {
  id: number;
  callsign: string;
  status: NetworkCallsignStatus;
  statusLabel: string;
  position: string;
  unitId: number | null;
  unitName: string;
  lastDatetime: number | null;
  messageCount: number;
  comment: string;
  sourceName: string;
  knownCallsignId: number | null;
  active: boolean;
  developing: boolean;
  mainRadioStation: boolean;
  unitDeveloping: boolean;
  sourceId: number | null;
  radioFreq: string | null;
  networkId: number;
  commandControl: boolean;
};

export type NetworkCallsignCatalogCallsign = {
  id: number;
  callsign: string;
  position: string;
  comment: string;
  unitId: number;
  unitName: string;
  sourceName: string;
  createdAt: number;
};

export type NetworkCallsignCatalogGroupView = {
  callsign: string;
  knownCallsigns: NetworkCallsignCatalogCallsign[];
  messageCount: number;
  lastDatetime: number | null;
  freqs: string[] | null;
  isOld: boolean;
  isInDictionary: boolean;
  activity: CallsignActivityItem | null;
};

export type NetworkCallsignInterceptedView = {
  callsign: string;
  messageCount: number;
  lastDatetime: number | null;
  freqs: string[] | null;
  isOld: boolean;
  isInDictionary: boolean;
  activity: CallsignActivityItem | null;
};

export type NetworkCallsignCatalogRowView = {
  id: number;
  knownCallsignId: number;
  callsign: string;
  position: string;
  unitName: string;
  lastDatetime: number | null;
  messageCount: number;
  comment: string;
  dateBoundAt: number;
  sourceName: string;
  networkCallsign: string;
  freqs: string[] | null;
};

export type NetworkCallsignStatusCounts = {
  all: number;
  verified: number;
  developing: number;
  catalog: number;
  unknown: number;
};

export type NetworkCallsignActivityMap = Map<string, CallsignActivityItem>;

export type NetworkCallsignsDerivedData = {
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
};

export type NetworkCallsignTabStore = {
  networkCallsignGroups: NetworkCallsignRes[];
  activityMap: NetworkCallsignActivityMap;
  networkCallsigns: NetworkCallsign[];
  catalogCallsignGroups: NetworkCallsignCatalogGroupView[];
  unknownInterceptedCallsigns: NetworkCallsignInterceptedView[];
};

export function createDefaultNetworkCallsignDrawerForm(networkId: number, unitId: number | null): NetworkCallsignDrawerForm {
  return {
    id: null,
    networkId,
    callsign: '',
    status: 'verified',
    position: '',
    comment: '',
    sourceId: null,
    radioFreq: '',
    unitId,
    unitDeveloping: false,
    developing: false,
    mainRadioStation: false,
    commandControl: false,
  };
}

export function createNetworkCallsignDrawerForm(
  networkId: number,
  networkCallsign: Pick<
    NetworkCallsignRowView,
    'id' | 'callsign' | 'status' | 'position' | 'comment' | 'sourceId' | 'radioFreq' | 'unitId' | 'unitDeveloping' | 'developing' | 'mainRadioStation' | 'commandControl'
  >,
): NetworkCallsignDrawerForm {
  return {
    id: networkCallsign.id,
    networkId,
    callsign: networkCallsign.callsign,
    status: networkCallsign.status,
    position: networkCallsign.position,
    comment: networkCallsign.comment,
    sourceId: networkCallsign.sourceId,
    radioFreq: networkCallsign.radioFreq ?? '',
    unitId: networkCallsign.unitId,
    unitDeveloping: networkCallsign.unitDeveloping,
    developing: networkCallsign.developing,
    mainRadioStation: networkCallsign.mainRadioStation,
    commandControl: networkCallsign.commandControl,
  };
}

export function normalizeCallsignDisplay(value: string | null | undefined): string {
  return (value?.trim() ?? '').toLocaleUpperCase('uk-UA');
}

export function createNetworkCallsignActivityMap(records: Array<{ callsign: string; activity: CallsignActivityItem }>): NetworkCallsignActivityMap {
  const map = new Map<string, CallsignActivityItem>();
  records.forEach((record) => {
    const callsign = normalizeCallsignDisplay(record.callsign);
    if (callsign === '') return;
    map.set(callsign, record.activity);
  });
  return map;
}

function toActivityFallback(row: Pick<NetworkCallsignRes, 'messageCount' | 'lastDatetime' | 'freqs'>): CallsignActivityItem {
  return {
    messageCount: row.messageCount,
    lastDatetime: row.lastDatetime,
    freqs: row.freqs,
  };
}

function resolveActivity(
  activityMap: NetworkCallsignActivityMap,
  callsign: string,
  fallback: Pick<NetworkCallsignRes, 'messageCount' | 'lastDatetime' | 'freqs'>,
): CallsignActivityItem {
  return activityMap.get(normalizeCallsignDisplay(callsign)) ?? toActivityFallback(fallback);
}

function compareCallsignViewsByActivityDesc(
  left: Pick<NetworkCallsignCatalogGroupView | NetworkCallsignInterceptedView, 'messageCount' | 'lastDatetime' | 'callsign'>,
  right: Pick<NetworkCallsignCatalogGroupView | NetworkCallsignInterceptedView, 'messageCount' | 'lastDatetime' | 'callsign'>,
): number {
  if (left.messageCount !== right.messageCount) {
    return right.messageCount - left.messageCount;
  }

  const leftLastDatetime = left.lastDatetime ?? 0;
  const rightLastDatetime = right.lastDatetime ?? 0;
  if (leftLastDatetime !== rightLastDatetime) {
    return rightLastDatetime - leftLastDatetime;
  }

  return left.callsign.localeCompare(right.callsign, 'uk');
}

function compareCatalogCallsignGroupsByActivityDesc(
  left: NetworkCallsignCatalogGroupView,
  right: NetworkCallsignCatalogGroupView,
): number {
  return compareCallsignViewsByActivityDesc(left, right);
}

function compareInterceptedCallsignsByActivityDesc(
  left: NetworkCallsignInterceptedView,
  right: NetworkCallsignInterceptedView,
): number {
  return compareCallsignViewsByActivityDesc(left, right);
}

export function getNetworkCallsignStatus(networkCallsign: Pick<NetworkCallsign, 'active' | 'developing' | 'knownCallsignId'>): NetworkCallsignStatus {
  if (networkCallsign.developing) return 'developing';
  if (networkCallsign.knownCallsignId !== null) return 'catalog';
  if (networkCallsign.active) return 'verified';
  return 'unknown';
}

export function getNetworkCallsignStatusLabel(status: NetworkCallsignStatus): string {
  if (status === 'developing') return 'В дорозвідці';
  if (status === 'catalog') return 'Каталог';
  if (status === 'unknown') return 'Невідомо';
  return 'Верифіковано';
}

export function buildNetworkCallsignRowViews(
  networkCallsigns: NetworkCallsign[],
  sourcesById: Map<number, Source>,
): NetworkCallsignRowView[] {
  return networkCallsigns.map((networkCallsign) => {
    const status = getNetworkCallsignStatus(networkCallsign);
    return {
      id: networkCallsign.id,
      callsign: normalizeCallsignDisplay(networkCallsign.callsign),
      status,
      statusLabel: getNetworkCallsignStatusLabel(status),
      position: networkCallsign.position?.trim() ?? '',
      unitId: networkCallsign.unitId ?? null,
      unitName: networkCallsign.unitName?.trim() ?? '',
      lastDatetime: networkCallsign.lastDatetime ?? null,
      messageCount: networkCallsign.messageCount,
      comment: networkCallsign.comment?.trim() ?? '',
      sourceName: networkCallsign.sourceId === null ? NO_DATA_LABEL : sourcesById.get(networkCallsign.sourceId)?.name?.trim() || `#${networkCallsign.sourceId}`,
      knownCallsignId: networkCallsign.knownCallsignId ?? null,
      active: networkCallsign.active,
      developing: networkCallsign.developing,
      mainRadioStation: networkCallsign.mainRadioStation,
      commandControl: networkCallsign.commandControl,
      unitDeveloping: networkCallsign.unitDeveloping,
      sourceId: networkCallsign.sourceId ?? null,
      radioFreq: networkCallsign.radioFreq ?? null,
      networkId: networkCallsign.networkId,
    };
  });
}

function buildCatalogCallsign(
  knownCallsign: KnownCallsignShortRes,
): NetworkCallsignCatalogCallsign {
  return {
    id: knownCallsign.id,
    callsign: normalizeCallsignDisplay(knownCallsign.callsign),
    position: knownCallsign.position.trim(),
    comment: knownCallsign.comment.trim(),
    unitId: knownCallsign.unitId,
    unitName: knownCallsign.unitName.trim(),
    sourceName: knownCallsign.sourceName.trim(),
    createdAt: knownCallsign.createdAt,
  };
}

export function buildNetworkCallsignTabData(
  groups: NetworkCallsignRes[],
  activityMap: NetworkCallsignActivityMap,
  networkCallsigns: NetworkCallsign[],
): NetworkCallsignsDerivedData {
  const knownNetworkCallsigns = new Set(networkCallsigns.map((networkCallsign) => normalizeCallsignDisplay(networkCallsign.callsign)));
  const catalogCallsignGroups: NetworkCallsignCatalogGroupView[] = [];
  const unknownInterceptedCallsigns: NetworkCallsignInterceptedView[] = [];

  groups.forEach((group) => {
    const callsign = normalizeCallsignDisplay(group.callsign);
    if (callsign === 'НВ') return;
    const activity = resolveActivity(activityMap, callsign, group);
    const knownCallsigns = (group.knownCallsigns ?? []).map(buildCatalogCallsign);

    if (knownCallsigns.length > 0) {
      catalogCallsignGroups.push({
        callsign,
        knownCallsigns,
        messageCount: activity.messageCount,
        lastDatetime: activity.lastDatetime,
        freqs: activity.freqs,
        isOld: group.isOld,
        isInDictionary: group.isInDictionary,
        activity,
      });
      return;
    }

    if (knownNetworkCallsigns.has(callsign)) return;

    unknownInterceptedCallsigns.push({
      callsign,
      messageCount: activity.messageCount,
      lastDatetime: activity.lastDatetime,
      freqs: activity.freqs,
      isOld: group.isOld,
      isInDictionary: group.isInDictionary,
      activity,
    });
  });

  catalogCallsignGroups.sort(compareCatalogCallsignGroupsByActivityDesc);
  unknownInterceptedCallsigns.sort(compareInterceptedCallsignsByActivityDesc);

  return {
    catalogCallsignGroups,
    unknownInterceptedCallsigns,
  };
}

export function removeKnownCallsignIdsFromNetworkCallsignGroups(
  groups: NetworkCallsignRes[],
  knownCallsignIds: number[],
): NetworkCallsignRes[] {
  if (knownCallsignIds.length === 0) return groups;

  const knownCallsignIdSet = new Set(knownCallsignIds);
  return groups.map((group) => {
    const knownCallsigns = group.knownCallsigns ?? [];
    if (knownCallsigns.length === 0) return group;

    const nextKnownCallsigns = knownCallsigns.filter((knownCallsign) => !knownCallsignIdSet.has(knownCallsign.id));
    if (nextKnownCallsigns.length === knownCallsigns.length) return group;

    return {
      ...group,
      knownCallsigns: nextKnownCallsigns,
    };
  });
}

export function mergeNetworkCallsigns(existingNetworkCallsigns: NetworkCallsign[], addedNetworkCallsigns: NetworkCallsign[]): NetworkCallsign[] {
  if (addedNetworkCallsigns.length === 0) return existingNetworkCallsigns;

  const byId = new Map(existingNetworkCallsigns.map((networkCallsign) => [networkCallsign.id, networkCallsign] as const));
  addedNetworkCallsigns.forEach((networkCallsign) => {
    byId.set(networkCallsign.id, networkCallsign);
  });
  return [...byId.values()];
}

export function flattenCatalogCallsignRows(groups: NetworkCallsignCatalogGroupView[]): NetworkCallsignCatalogRowView[] {
  return [...groups]
    .sort(compareCatalogCallsignGroupsByActivityDesc)
    .flatMap((group) =>
      [...group.knownCallsigns]
        .sort((left, right) => right.createdAt - left.createdAt)
        .map((knownCallsign) => ({
          id: knownCallsign.id,
          knownCallsignId: knownCallsign.id,
          callsign: knownCallsign.callsign,
          position: knownCallsign.position,
          unitName: knownCallsign.unitName,
          lastDatetime: group.lastDatetime,
          messageCount: group.messageCount,
          comment: knownCallsign.comment,
          dateBoundAt: knownCallsign.createdAt,
          sourceName: knownCallsign.sourceName,
          networkCallsign: group.callsign,
          freqs: group.freqs,
        })),
    );
}

export function countNetworkCallsignStatusRows(rows: NetworkCallsignRowView[]): NetworkCallsignStatusCounts {
  return rows.reduce<NetworkCallsignStatusCounts>(
    (accumulator, row) => {
      accumulator.all += 1;
      accumulator[row.status] += 1;
      return accumulator;
    },
    {
      all: 0,
      verified: 0,
      developing: 0,
      catalog: 0,
      unknown: 0,
    },
  );
}

export function formatNetworkCallsignDatetime(value: number | null): string {
  return value === null ? NO_DATA_LABEL : formatDateTime24(value);
}
