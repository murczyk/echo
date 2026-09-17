import { describe, expect, it } from 'vitest';
import dayjs from 'dayjs';
import timezone from 'dayjs/plugin/timezone';
import utc from 'dayjs/plugin/utc';

import {
  APP_TIME_ZONE,
  parseDateInputExclusiveEndInTimeZone,
  parseDateInputInTimeZone,
} from '../../../utils/misc';
import {
  canViewNetworkActivityTab,
  canViewNetworkRelationsTab,
  parseNetworkDetailsDateInput,
  parseNetworkDetailsDateInputExclusiveEnd,
} from '../use-rer-network-details-neo-page.shared';

dayjs.extend(utc);
dayjs.extend(timezone);

describe('network-details external input', () => {
  // @test-scope parser: parses inclusive UTC network date input
  it('parses inclusive start dates at UTC midnight', () => {
    expect(parseNetworkDetailsDateInput('2026-05-20')).toBe(Date.parse('2026-05-20T00:00:00Z'));
  });

  // @test-scope parser: parses exclusive UTC network date input
  it('parses exclusive end dates as next-day UTC midnight', () => {
    expect(parseNetworkDetailsDateInputExclusiveEnd('2026-05-20')).toBe(
      Date.parse('2026-05-21T00:00:00Z'),
    );
  });

  // @test-scope parser: parses network-relations date input in the application timezone
  it('parses relations dates in the app timezone', () => {
    const since = dayjs.tz('2026-05-20', 'YYYY-MM-DD', APP_TIME_ZONE).startOf('day').valueOf();
    expect(parseDateInputInTimeZone('2026-05-20')).toBe(since);
    expect(parseDateInputExclusiveEndInTimeZone('2026-05-20')).toBe(since + 24 * 60 * 60 * 1000);
  });
});

describe('network-details access', () => {
  // @test-scope safeguard: prevents roles without network activity access from receiving that tab
  it('allows the activity tab only for backend activity roles', () => {
    expect(canViewNetworkActivityTab({ roles: ['Rer'] } as any)).toBe(true);
    expect(canViewNetworkActivityTab({ roles: ['Api'] } as any)).toBe(false);
  });

  // @test-scope safeguard: prevents roles without network relations access from receiving that tab
  it('allows the relations tab for Api and legacy read roles', () => {
    expect(canViewNetworkRelationsTab({ roles: ['Rer'] } as any)).toBe(true);
    expect(canViewNetworkRelationsTab({ roles: ['Api'] } as any)).toBe(true);
  });
});
