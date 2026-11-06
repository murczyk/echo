import { describe, expect, it } from 'vitest';

import type { NetworkCallsign } from '../../../../../Bindings';
import {
  applyNetworkCallsignStats,
  createNetworkCallsignStatsMap,
  findNetworkCallsignIdsOutsidePeriod,
  includeAddedNetworkCallsigns,
  resolveNetworkCallsignStatsPeriod,
} from '../network-callsigns.stats';

function networkCallsign(id: number, overrides: Partial<NetworkCallsign> = {}): NetworkCallsign {
  return {
    id,
    callsign: `позивний-${id}`,
    messageCount: 0,
    lastDatetime: null,
    freqs: null,
    ...overrides,
  } as NetworkCallsign;
}

describe('network-callsigns.stats', () => {
  it('uses the default stats window for an unlimited list', () => {
    expect(resolveNetworkCallsignStatsPeriod('Unlimited')).toBe('Last21Days');
    expect(resolveNetworkCallsignStatsPeriod('Last21Days')).toBe('Last21Days');
    expect(resolveNetworkCallsignStatsPeriod('Last7Days')).toBe('Last7Days');
  });

  it('merges stats by id and clears stale values for rows without stats', () => {
    const stats = createNetworkCallsignStatsMap([
      networkCallsign(1, { messageCount: 5, lastDatetime: 1000, freqs: ['145.1000'] }),
    ]);

    const merged = applyNetworkCallsignStats(
      [networkCallsign(1), networkCallsign(2, { messageCount: 9, lastDatetime: 2000 })],
      stats,
    );

    expect(merged[0]).toMatchObject({ id: 1, messageCount: 5, lastDatetime: 1000 });
    expect(merged[1]).toMatchObject({ id: 2, messageCount: 0, lastDatetime: null, freqs: null });
  });

  it('treats rows missing from a bounded response as outside the period', () => {
    const stats = createNetworkCallsignStatsMap([networkCallsign(1)]);

    expect([
      ...findNetworkCallsignIdsOutsidePeriod([networkCallsign(1), networkCallsign(2)], stats),
    ]).toEqual([2]);
  });

  it('keeps added rows out of the removal set without overwriting known stats', () => {
    const stats = includeAddedNetworkCallsigns(
      createNetworkCallsignStatsMap([networkCallsign(1, { messageCount: 5 })]),
      [networkCallsign(1), networkCallsign(2)],
    );

    expect(stats.get(1)?.messageCount).toBe(5);
    expect(findNetworkCallsignIdsOutsidePeriod([networkCallsign(2)], stats).size).toBe(0);
  });
});
