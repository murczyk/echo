import { describe, expect, it } from 'vitest';

import {
  getDefaultNetworkRelationsDateRange,
  parseNetworkDetailsDateInput,
  parseNetworkDetailsDateInputExclusiveEnd,
  normalizeNetworkRelationsSinceChange,
  normalizeNetworkRelationsTillChange,
} from './use-rer-network-details-neo-page.shared';

describe('use-rer-network-details-neo-page.shared date parsing', () => {
  it('parses inclusive start dates at UTC midnight', () => {
    expect(parseNetworkDetailsDateInput('2026-05-20')).toBe(Date.parse('2026-05-20T00:00:00Z'));
  });

  it('parses exclusive end dates as next-day UTC midnight', () => {
    expect(parseNetworkDetailsDateInputExclusiveEnd('2026-05-20')).toBe(Date.parse('2026-05-21T00:00:00Z'));
  });

  it('defaults the relations range to the last month through today', () => {
    const range = getDefaultNetworkRelationsDateRange(new Date('2026-05-20T12:00:00Z'));
    expect(range).toEqual({
      relationsSince: '2026-04-20',
      relationsTill: '2026-05-20',
    });
  });

  it('clamps the since date to the till date when it moves forward past the end', () => {
    expect(normalizeNetworkRelationsSinceChange('2026-05-10', '2026-05-20', '2026-05-25')).toEqual({
      relationsSince: '2026-05-25',
      relationsTill: '2026-05-25',
    });
  });

  it('clamps the till date to the since date when it moves backward before the start', () => {
    expect(normalizeNetworkRelationsTillChange('2026-05-20', '2026-05-25', '2026-05-10')).toEqual({
      relationsSince: '2026-05-10',
      relationsTill: '2026-05-10',
    });
  });
});
