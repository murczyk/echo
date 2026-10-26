import { describe, expect, it } from 'vitest';

import type { DeviceDayStat, DeviceStats } from '../../../../../Bindings';
import {
  buildDeviceRecentActivity,
  DEVICE_LIST_ACTIVITY_DAYS,
  isDeviceStatsIncomplete,
} from '../device-activity';

function buildStats(days: DeviceDayStat[]): DeviceStats {
  return {
    directoryCount: 0,
    fileCount: 0,
    contentCount: days.reduce((sum, row) => sum + row.contentCount, 0),
    contentBytes: days.reduce((sum, row) => sum + row.contentBytes, 0),
    firstContentAt: null,
    lastContentAt: null,
    contentPending: false,
    backfilledAt: null,
    extensions: [],
    days,
  };
}

function upload(day: string, extension = 'pdf', contentCount = 1): DeviceDayStat {
  return { day, extension, contentCount, contentBytes: contentCount * 100 };
}

describe('buildDeviceRecentActivity', () => {
  it('shows the full week ending today when the device uploaded today', () => {
    const activity = buildDeviceRecentActivity(
      buildStats([upload('2026-10-20'), upload('2026-10-26', 'jpg', 3)]),
      '2026-10-26',
    );

    expect(activity.kind).toBe('recent');
    if (activity.kind !== 'recent') return;
    expect(activity.days).toHaveLength(DEVICE_LIST_ACTIVITY_DAYS);
    expect(activity.days.map(({ day }) => day)).toEqual([
      '2026-10-20',
      '2026-10-21',
      '2026-10-22',
      '2026-10-23',
      '2026-10-24',
      '2026-10-25',
      '2026-10-26',
    ]);
    expect(activity.days[0].contentCount).toBe(1n);
    expect(activity.days[6].contentCount).toBe(3n);
    expect(activity.days.slice(1, 6).every(({ contentCount }) => contentCount === 0n)).toBe(true);
  });

  it('keeps the window for an upload on its first day', () => {
    const activity = buildDeviceRecentActivity(buildStats([upload('2026-10-20')]), '2026-10-26');

    expect(activity.kind).toBe('recent');
    if (activity.kind !== 'recent') return;
    expect(activity.days[0]).toMatchObject({ day: '2026-10-20', contentCount: 1n });
  });

  it('falls back to the latest upload day before the window', () => {
    const activity = buildDeviceRecentActivity(
      buildStats([
        upload('2026-09-01'),
        upload('2026-10-19', 'pdf'),
        upload('2026-10-19', 'xlsx', 2),
      ]),
      '2026-10-26',
    );

    expect(activity.kind).toBe('lastActive');
    if (activity.kind !== 'lastActive') return;
    expect(activity.day).toMatchObject({ day: '2026-10-19', contentCount: 3n });
    expect(activity.day.categories).toHaveLength(2);
  });

  it('reports no activity for a device that never uploaded', () => {
    expect(buildDeviceRecentActivity(buildStats([]), '2026-10-26')).toEqual({ kind: 'none' });
  });

  it('spans a year boundary', () => {
    const activity = buildDeviceRecentActivity(buildStats([upload('2025-12-29')]), '2027-01-02');

    expect(activity.kind).toBe('lastActive');

    const recent = buildDeviceRecentActivity(buildStats([upload('2026-12-27')]), '2027-01-02');
    expect(recent.kind).toBe('recent');
    if (recent.kind !== 'recent') return;
    expect(recent.days[0].day).toBe('2026-12-27');
    expect(recent.days[6].day).toBe('2027-01-02');
  });
});

describe('isDeviceStatsIncomplete', () => {
  it('is complete when counted files match the live count', () => {
    expect(isDeviceStatsIncomplete({ ...buildStats([]), fileCount: 12 }, 12)).toBe(false);
  });

  it('flags tree stats missing files synced before stats existed', () => {
    expect(isDeviceStatsIncomplete({ ...buildStats([]), fileCount: 0 }, 12)).toBe(true);
  });

  it('flags uncounted uploads', () => {
    expect(isDeviceStatsIncomplete({ ...buildStats([]), contentPending: true }, 0)).toBe(true);
  });
});
