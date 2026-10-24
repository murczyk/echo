import type { DeviceStats } from '../../../../Bindings';
import { FILE_TYPE_CATEGORY_NAMES, fileTypeCategoryForExtension } from './file-type-categories';

const DAY_MS = 24 * 60 * 60 * 1000;
const CURRENT_YEAR_DAY_FORMAT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: 'short',
  timeZone: 'UTC',
});
const OTHER_YEAR_DAY_FORMAT = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
  timeZone: 'UTC',
});

export type DeviceActivityCategory = {
  category: string;
  contentCount: bigint;
  contentBytes: bigint;
};

export type DeviceActivityDay = {
  /** Kyiv calendar date, `YYYY-MM-DD`. */
  day: string;
  label: string;
  contentCount: bigint;
  contentBytes: bigint;
  /** Non-empty categories in `FILE_TYPE_CATEGORIES` order. */
  categories: DeviceActivityCategory[];
};

/** Every day from the first to the last upload day; days without uploads stay empty. */
export function buildDeviceActivity(
  stats: DeviceStats | null,
  currentYear: number = currentKyivYear(),
): DeviceActivityDay[] {
  if (!stats || stats.days.length === 0) return [];
  let firstDay = stats.days[0].day;
  let lastDay = firstDay;
  for (const { day } of stats.days) {
    if (day < firstDay) firstDay = day;
    if (day > lastDay) lastDay = day;
  }

  const firstTime = Date.parse(`${firstDay}T00:00:00Z`);
  const dayCount = Math.round((Date.parse(`${lastDay}T00:00:00Z`) - firstTime) / DAY_MS) + 1;
  const window = Array.from({ length: dayCount }, (_, index) =>
    new Date(firstTime + index * DAY_MS).toISOString().slice(0, 10),
  );
  const totals = new Map(
    window.map((day) => [day, new Map<string, DeviceActivityCategory>()] as const),
  );
  for (const row of stats.days) {
    const categories = totals.get(row.day);
    if (!categories) continue;
    const category = fileTypeCategoryForExtension(row.extension);
    const current = categories.get(category) ?? { category, contentCount: 0n, contentBytes: 0n };
    current.contentCount += BigInt(row.contentCount);
    current.contentBytes += BigInt(row.contentBytes);
    categories.set(category, current);
  }

  return window.map((day) => {
    const categories = totals.get(day) ?? new Map<string, DeviceActivityCategory>();
    const ordered = FILE_TYPE_CATEGORY_NAMES.flatMap((name) => {
      const category = categories.get(name);
      return category ? [category] : [];
    });
    return {
      day,
      label: formatActivityDayLabel(day, currentYear),
      contentCount: ordered.reduce((sum, category) => sum + category.contentCount, 0n),
      contentBytes: ordered.reduce((sum, category) => sum + category.contentBytes, 0n),
      categories: ordered,
    };
  });
}

/** `DD MON` within the current year, `DD.MM.YYYY` otherwise (Ukrainian locale). */
export function formatActivityDayLabel(day: string, currentYear: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  const format =
    date.getUTCFullYear() === currentYear ? CURRENT_YEAR_DAY_FORMAT : OTHER_YEAR_DAY_FORMAT;
  return format.format(date);
}

/** Rounds to one decimal below 10 units, to whole units otherwise. */
export function formatDeviceBytes(bytes: bigint): string {
  const units = ['KB', 'MB', 'GB'];
  let divisor = 1024n;
  let unitIndex = 0;
  while (bytes >= divisor * 1024n && unitIndex < units.length - 1) {
    divisor *= 1024n;
    unitIndex += 1;
  }
  const tenths = roundDiv(bytes * 10n, divisor);
  const value =
    tenths >= 100n || tenths % 10n === 0n
      ? roundDiv(bytes, divisor).toLocaleString('uk-UA')
      : `${(tenths / 10n).toLocaleString('uk-UA')},${tenths % 10n}`;
  return `${value} ${units[unitIndex]}`;
}

export function formatDeviceCount(count: bigint): string {
  return count.toLocaleString('uk-UA');
}

function roundDiv(value: bigint, divisor: bigint): bigint {
  return (value + divisor / 2n) / divisor;
}

function currentKyivYear(): number {
  return Number(
    new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Kyiv', year: 'numeric' }).format(
      new Date(),
    ),
  );
}

export type DeviceTypeTotals = {
  contentCount: bigint;
  contentBytes: bigint;
};

export type DeviceExtensionBreakdown = DeviceTypeTotals & {
  /** Backend extension: lowercase, no leading dot, `''` when the file has none. */
  extension: string;
};

export type DeviceCategoryBreakdown = DeviceTypeTotals & {
  category: string;
  extensions: DeviceExtensionBreakdown[];
};

export type DeviceTypeBreakdown = DeviceTypeTotals & {
  categories: DeviceCategoryBreakdown[];
};

/** Grand total, then categories and their extensions, each sorted by file count descending. */
export function buildDeviceTypeBreakdown(stats: DeviceStats | null): DeviceTypeBreakdown {
  const categories = new Map<string, DeviceCategoryBreakdown>();
  for (const row of stats?.extensions ?? []) {
    const name = fileTypeCategoryForExtension(row.extension);
    const category = categories.get(name) ?? {
      category: name,
      contentCount: 0n,
      contentBytes: 0n,
      extensions: [],
    };
    const contentCount = BigInt(row.contentCount);
    const contentBytes = BigInt(row.contentBytes);
    category.contentCount += contentCount;
    category.contentBytes += contentBytes;
    category.extensions.push({ extension: row.extension, contentCount, contentBytes });
    categories.set(name, category);
  }

  const sorted = [...categories.values()].sort(compareTotals);
  for (const category of sorted) category.extensions.sort(compareTotals);
  return {
    contentCount: sorted.reduce((sum, category) => sum + category.contentCount, 0n),
    contentBytes: sorted.reduce((sum, category) => sum + category.contentBytes, 0n),
    categories: sorted,
  };
}

/** Number of file type categories with at least one upload. */
export function countDeviceFileTypes(stats: DeviceStats): number {
  return new Set(stats.extensions.map((row) => fileTypeCategoryForExtension(row.extension))).size;
}

function compareTotals(left: DeviceTypeTotals, right: DeviceTypeTotals): number {
  if (left.contentCount !== right.contentCount) {
    return left.contentCount > right.contentCount ? -1 : 1;
  }
  if (left.contentBytes !== right.contentBytes) {
    return left.contentBytes > right.contentBytes ? -1 : 1;
  }
  return 0;
}
