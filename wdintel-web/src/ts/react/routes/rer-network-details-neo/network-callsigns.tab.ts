import type {
  CallsignActivityItem,
  KnownCallsignShortRes,
  NetworkCallsign,
  NetworkCallsignRes,
} from '../../../../Bindings';
import {
  type NetworkCallsignActivityMap,
  type NetworkCallsignCatalogCallsign,
  type NetworkCallsignCatalogGroupView,
  type NetworkCallsignCatalogRowView,
  type NetworkCallsignInterceptedView,
  type NetworkCallsignsDerivedData,
} from './network-callsigns.types';
import { normalizeCallsignDisplay } from './network-callsigns.utils';

export function createNetworkCallsignActivityMap(
  records: Array<{ callsign: string; activity: CallsignActivityItem }>,
): NetworkCallsignActivityMap {
  const map = new Map<string, CallsignActivityItem>();
  records.forEach((record) => {
    const callsign = normalizeCallsignDisplay(record.callsign);
    if (callsign === '') return;
    map.set(callsign, record.activity);
  });
  return map;
}

function toActivityFallback(
  row: Pick<NetworkCallsignRes, 'messageCount' | 'lastDatetime' | 'freqs'>,
): CallsignActivityItem {
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
  left: Pick<
    NetworkCallsignCatalogGroupView | NetworkCallsignInterceptedView,
    'messageCount' | 'lastDatetime' | 'callsign'
  >,
  right: Pick<
    NetworkCallsignCatalogGroupView | NetworkCallsignInterceptedView,
    'messageCount' | 'lastDatetime' | 'callsign'
  >,
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
  const knownNetworkCallsigns = new Set(
    networkCallsigns.map((networkCallsign) => normalizeCallsignDisplay(networkCallsign.callsign)),
  );
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

    const nextKnownCallsigns = knownCallsigns.filter(
      (knownCallsign) => !knownCallsignIdSet.has(knownCallsign.id),
    );
    if (nextKnownCallsigns.length === knownCallsigns.length) return group;

    return {
      ...group,
      knownCallsigns: nextKnownCallsigns,
    };
  });
}

export function mergeNetworkCallsigns(
  existingNetworkCallsigns: NetworkCallsign[],
  addedNetworkCallsigns: NetworkCallsign[],
): NetworkCallsign[] {
  if (addedNetworkCallsigns.length === 0) return existingNetworkCallsigns;

  const byId = new Map(
    existingNetworkCallsigns.map(
      (networkCallsign) => [networkCallsign.id, networkCallsign] as const,
    ),
  );
  addedNetworkCallsigns.forEach((networkCallsign) => {
    byId.set(networkCallsign.id, networkCallsign);
  });
  return [...byId.values()];
}

export function flattenCatalogCallsignRows(
  groups: NetworkCallsignCatalogGroupView[],
): NetworkCallsignCatalogRowView[] {
  return [...groups].sort(compareCatalogCallsignGroupsByActivityDesc).flatMap((group) =>
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
