export type NetworkActivity = Record<string, Record<string, number>>;

export type ActivityDay = {
  dayMs: number;
  dayLabel: string;
  tooltipLabel: string;
  countsByGroup: Record<string, number>;
  total: number;
};

export type ActivitySegment = {
  groupName: string;
  count: number;
  color: string;
};

export type ActivityChartDay = ActivityDay & {
  segments: ActivitySegment[];
};

export type ActivityChartData = {
  days: ActivityChartDay[];
  groupNames: string[];
  groupColors: Map<string, string>;
  maxValue: number;
};

export type HoveredBar = {
  day: ActivityDay;
  left: number;
  top: number;
};

export const DAY_MS = 24 * 60 * 60 * 1000;
export const CHART_VIEWBOX_WIDTH = 920;
export const CHART_VIEWBOX_HEIGHT = 320;
export const CHART_MARGIN = {
  top: 24,
  right: 18,
  bottom: 52,
  left: 48,
};
export const BAR_GAP = 14;
export const GROUP_COLOR_PALETTE = [
  '#36c46b',
  '#3f6fd3',
  '#efc030',
  '#ab7df6',
  '#f97316',
  '#14b8a6',
  '#f43f5e',
  '#0ea5e9',
  '#84cc16',
  '#eab308',
  '#f59e0b',
  '#8b5cf6',
];
export const PLACEHOLDER_BAR_HEIGHTS = [30, 50, 20, 40, 18, 24, 12, 48, 34, 22] as const;
export const LOADING_CHART_HEIGHT = { xs: 340, sm: 370, md: 400 } as const;

const DAY_LABEL_FORMATTER = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: '2-digit',
  timeZone: 'UTC',
});
const TOOLTIP_DATE_FORMATTER = new Intl.DateTimeFormat('uk-UA', {
  day: '2-digit',
  month: 'long',
  year: 'numeric',
  timeZone: 'UTC',
});

export function startOfUtcDayMs(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function formatDayLabel(dayMs: number): string {
  return DAY_LABEL_FORMATTER.format(new Date(dayMs));
}

export function formatTooltipDate(dayMs: number): string {
  return TOOLTIP_DATE_FORMATTER.format(new Date(dayMs));
}

export function normalizeActivityDay(countsByGroup: Record<string, number>): Record<string, number> {
  const normalizedCounts: Record<string, number> = {};
  for (const [groupName, count] of Object.entries(countsByGroup)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    normalizedCounts[groupName] = (normalizedCounts[groupName] ?? 0) + count;
  }
  return normalizedCounts;
}

export function sumCounts(countsByGroup: Record<string, number>): number {
  return Object.values(countsByGroup).reduce((sum, count) => sum + count, 0);
}

export function buildRoundedTopRectPath(x: number, y: number, width: number, height: number, radius = 4): string {
  const r = Math.min(radius, width / 2, height);
  if (height <= 0 || width <= 0) return '';
  if (r <= 0) {
    return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  }
  return [
    `M ${x} ${y + height}`,
    `V ${y + r}`,
    `Q ${x} ${y} ${x + r} ${y}`,
    `H ${x + width - r}`,
    `Q ${x + width} ${y} ${x + width} ${y + r}`,
    `V ${y + height}`,
    'Z',
  ].join(' ');
}

function buildActivityDays(networkActivity: NetworkActivity, anchorDayMs: number): ActivityDay[] {
  const normalizedByDay = new Map<number, Record<string, number>>();

  for (const [dayMsText, countsByGroup] of Object.entries(networkActivity)) {
    const dayMsRaw = Number(dayMsText);
    if (!Number.isFinite(dayMsRaw)) continue;

    const dayMs = startOfUtcDayMs(dayMsRaw);
    const normalizedCounts = normalizeActivityDay(countsByGroup);
    const currentCounts = normalizedByDay.get(dayMs) ?? {};

    for (const [groupName, count] of Object.entries(normalizedCounts)) {
      currentCounts[groupName] = (currentCounts[groupName] ?? 0) + count;
    }

    normalizedByDay.set(dayMs, currentCounts);
  }

  const dayMsValues = [...normalizedByDay.keys()];
  const lastDayMs = Number.isFinite(anchorDayMs) ? startOfUtcDayMs(anchorDayMs) : Math.max(...dayMsValues);
  return Array.from({ length: 10 }, (_, index) => {
    const dayMs = lastDayMs - (9 - index) * DAY_MS;
    const countsByGroup = normalizedByDay.get(dayMs) ?? {};
    return {
      dayMs,
      dayLabel: formatDayLabel(dayMs),
      tooltipLabel: formatTooltipDate(dayMs),
      countsByGroup,
      total: sumCounts(countsByGroup),
    };
  });
}

function hashGroupName(groupName: string): number {
  let hash = 0;
  for (let index = 0; index < groupName.length; index += 1) {
    hash = (hash * 31 + groupName.charCodeAt(index)) >>> 0;
  }
  return hash;
}

export function getGroupColor(groupName: string): string {
  return GROUP_COLOR_PALETTE[hashGroupName(groupName) % GROUP_COLOR_PALETTE.length];
}

export function buildChartMax(totalValues: number[]): number {
  const maxTotal = Math.max(0, ...totalValues);
  if (maxTotal <= 0) return 0;
  return Math.max(4, Math.ceil(maxTotal / 4) * 4);
}

export function buildYTicks(maxValue: number): number[] {
  if (maxValue <= 0) return [0];
  const step = maxValue / 4;
  return [0, 1, 2, 3, 4].map((index) => Math.round(step * index));
}

export function buildActivityChartData(networkActivity: NetworkActivity, anchorDayMs: number): ActivityChartData {
  const days = buildActivityDays(networkActivity, anchorDayMs);
  const groupTotals = new Map<string, number>();

  for (const day of days) {
    for (const [groupName, count] of Object.entries(day.countsByGroup)) {
      groupTotals.set(groupName, (groupTotals.get(groupName) ?? 0) + count);
    }
  }

  const groupNames = [...groupTotals.entries()]
    .filter(([, total]) => total > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'uk'))
    .map(([groupName]) => groupName);

  const groupColors = new Map(groupNames.map((groupName) => [groupName, getGroupColor(groupName)] as const));
  const chartDays = days.map((day) => ({
    ...day,
    segments: groupNames
      .map((groupName) => ({
        groupName,
        count: day.countsByGroup[groupName] ?? 0,
        color: groupColors.get(groupName) ?? getGroupColor(groupName),
      }))
      .filter((segment) => segment.count > 0),
  }));

  return {
    days: chartDays,
    groupNames,
    groupColors,
    maxValue: buildChartMax(chartDays.map((day) => day.total)),
  };
}
