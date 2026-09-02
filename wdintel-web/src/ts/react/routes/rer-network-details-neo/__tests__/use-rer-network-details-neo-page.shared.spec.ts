import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

import { APP_TIME_ZONE } from '../../../utils/misc';
import {
  getDefaultNetworkRelationsDateRange,
  getDefaultNetworkPelengDateRange,
  parseNetworkDetailsDateInput,
  parseNetworkDetailsDateInputExclusiveEnd,
  normalizeNetworkRelationsSinceChange,
  normalizeNetworkRelationsTillChange,
  normalizeNetworkPelengSinceChange,
  normalizeNetworkPelengTillChange,
  canViewNetworkActivityTab,
  canViewNetworkRelationsTab,
} from '../use-rer-network-details-neo-page.shared';
import {
  parseDateInputExclusiveEndInTimeZone,
  parseDateInputInTimeZone,
} from '../../../utils/misc';

dayjs.extend(utc);
dayjs.extend(timezone);

// @test-scope parser: preserves supported network date parsing for the existing API and form boundary.
describe('use-rer-network-details-neo-page.shared date parsing', () => {
  // @test-scope parser: network-details inclusive UTC date input
  it('parses inclusive start dates at UTC midnight', () => {
    expect(parseNetworkDetailsDateInput('2026-05-20')).toBe(Date.parse('2026-05-20T00:00:00Z'));
  });

  // @test-scope parser: network-details exclusive UTC end-date input
  it('parses exclusive end dates as next-day UTC midnight', () => {
    expect(parseNetworkDetailsDateInputExclusiveEnd('2026-05-20')).toBe(
      Date.parse('2026-05-21T00:00:00Z'),
    );
  });

  // @test-scope parser: network-relations date input in the application timezone
  it('parses relations dates in the app timezone', () => {
    const since = dayjs.tz('2026-05-20', 'YYYY-MM-DD', APP_TIME_ZONE).startOf('day').valueOf();
    const till = since + 24 * 60 * 60 * 1000;

    expect(parseDateInputInTimeZone('2026-05-20')).toBe(since);
    expect(parseDateInputExclusiveEndInTimeZone('2026-05-20')).toBe(till);
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

  it('defaults the peleng range to the active window or the last month through now', () => {
    expect(getDefaultNetworkPelengDateRange(null, new Date('2026-05-20T12:00:00Z'))).toEqual({
      pelengSince: '2026-04-20',
      pelengTill: '2026-05-20',
    });
  });

  it('clamps peleng range endpoints the same way as the relations range', () => {
    expect(normalizeNetworkPelengSinceChange('2026-05-10', '2026-05-20', '2026-05-25')).toEqual({
      pelengSince: '2026-05-25',
      pelengTill: '2026-05-25',
    });
    expect(normalizeNetworkPelengTillChange('2026-05-20', '2026-05-25', '2026-05-10')).toEqual({
      pelengSince: '2026-05-10',
      pelengTill: '2026-05-10',
    });
  });

  it('allows the activity tab only for backend activity roles', () => {
    expect(canViewNetworkActivityTab({ roles: ['Rer'] } as any)).toBe(true);
    expect(canViewNetworkActivityTab({ roles: ['Full'] } as any)).toBe(true);
    expect(canViewNetworkActivityTab({ roles: ['Admin'] } as any)).toBe(true);
    expect(canViewNetworkActivityTab({ roles: ['Api'] } as any)).toBe(false);
    expect(canViewNetworkActivityTab({ roles: ['ApiAgent'] } as any)).toBe(false);
  });

  it('allows the relations tab for Api and the legacy read roles', () => {
    expect(canViewNetworkRelationsTab({ roles: ['Rer'] } as any)).toBe(true);
    expect(canViewNetworkRelationsTab({ roles: ['Api'] } as any)).toBe(true);
    expect(canViewNetworkRelationsTab({ roles: ['ApiAgent'] } as any)).toBe(true);
    expect(canViewNetworkRelationsTab({ roles: ['Full'] } as any)).toBe(true);
    expect(canViewNetworkRelationsTab({ roles: ['Admin'] } as any)).toBe(true);
  });
});
