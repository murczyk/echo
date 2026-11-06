import type { NetworkCallsign, NetworkFreqCallsignsPeriod } from '../../../../Bindings';

// Live all-time stats take tens of seconds on busy networks, so they only run
// on explicit request.
export const NETWORK_CALLSIGN_DEFAULT_STATS_PERIOD: NetworkFreqCallsignsPeriod = 'Last21Days';

export type NetworkCallsignStats = Pick<NetworkCallsign, 'messageCount' | 'lastDatetime' | 'freqs'>;

export type NetworkCallsignStatsMap = ReadonlyMap<number, NetworkCallsignStats>;

const NO_NETWORK_CALLSIGN_STATS: NetworkCallsignStats = {
  messageCount: 0,
  lastDatetime: null,
  freqs: null,
};

export function resolveNetworkCallsignStatsPeriod(
  period: NetworkFreqCallsignsPeriod,
): NetworkFreqCallsignsPeriod {
  return period === 'Unlimited' ? NETWORK_CALLSIGN_DEFAULT_STATS_PERIOD : period;
}

export function createNetworkCallsignStatsMap(
  networkCallsigns: NetworkCallsign[],
): NetworkCallsignStatsMap {
  return new Map(
    networkCallsigns.map(
      ({ id, messageCount, lastDatetime, freqs }) =>
        [id, { messageCount, lastDatetime, freqs }] as const,
    ),
  );
}

export function applyNetworkCallsignStats(
  networkCallsigns: NetworkCallsign[],
  stats: NetworkCallsignStatsMap,
): NetworkCallsign[] {
  return networkCallsigns.map((networkCallsign) => ({
    ...networkCallsign,
    ...(stats.get(networkCallsign.id) ?? NO_NETWORK_CALLSIGN_STATS),
  }));
}

/**
 * A bounded stats response lists only callsigns active in that period, so a
 * missing row means no activity. Rows added since the stats request started are
 * unknown rather than inactive.
 */
export function findNetworkCallsignIdsOutsidePeriod(
  networkCallsigns: NetworkCallsign[],
  stats: NetworkCallsignStatsMap,
  addedSinceStats: ReadonlySet<number>,
): ReadonlySet<number> {
  return new Set(
    networkCallsigns.map(({ id }) => id).filter((id) => !stats.has(id) && !addedSinceStats.has(id)),
  );
}

export function formatNetworkCallsignStatsPeriodSuffix(
  period: NetworkFreqCallsignsPeriod | null,
): string {
  if (period === 'Last21Days') return ' (21 д)';
  if (period === 'Last7Days') return ' (7 д)';
  return '';
}
