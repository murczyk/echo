import type { NetworkCallsign, Source } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';
import {
  type NetworkCallsignRowView,
  type NetworkCallsignStatus,
  type NetworkCallsignStatusCounts,
} from './network-callsigns.types';
import { normalizeCallsignDisplay } from './network-callsigns.utils';

export function getNetworkCallsignStatus(
  networkCallsign: Pick<NetworkCallsign, 'active' | 'developing' | 'knownCallsignId'>,
): NetworkCallsignStatus {
  if (networkCallsign.developing) return 'developing';
  if (networkCallsign.knownCallsignId !== null) return 'catalog';
  if (networkCallsign.active) return 'catalog';
  return 'unknown';
}

export function getNetworkCallsignStatusLabel(status: NetworkCallsignStatus): string {
  if (status === 'developing') return 'В дорозвідці';
  if (status === 'catalog') return 'Каталог';
  return 'Невідомо';
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
      fullName: networkCallsign.fullName?.trim() ?? '',
      status,
      statusLabel: getNetworkCallsignStatusLabel(status),
      position: networkCallsign.position?.trim() ?? '',
      unitId: networkCallsign.unitId ?? null,
      unitName: networkCallsign.unitName?.trim() ?? '',
      lastDatetime: networkCallsign.lastDatetime ?? null,
      messageCount: networkCallsign.messageCount,
      comment: networkCallsign.comment?.trim() ?? '',
      sourceName:
        networkCallsign.sourceId === null
          ? NO_DATA_LABEL
          : sourcesById.get(networkCallsign.sourceId)?.name?.trim() ||
            `#${networkCallsign.sourceId}`,
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

export function countNetworkCallsignStatusRows(
  rows: NetworkCallsignRowView[],
): NetworkCallsignStatusCounts {
  return rows.reduce<NetworkCallsignStatusCounts>(
    (accumulator, row) => {
      accumulator.all += 1;
      accumulator[row.status] += 1;
      return accumulator;
    },
    {
      all: 0,
      developing: 0,
      catalog: 0,
      unknown: 0,
    },
  );
}
