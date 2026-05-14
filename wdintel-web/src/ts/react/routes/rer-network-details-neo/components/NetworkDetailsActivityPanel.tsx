import { Box, Button, CircularProgress, Paper, Skeleton, Stack, Typography } from '@mui/material';
import { useId, useMemo, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';

import { PowerAlert } from '../../../components/PowerAlert';

type NetworkActivity = Record<string, Record<string, number>>;

type ActivityDay = {
  dayMs: number;
  dayLabel: string;
  tooltipLabel: string;
  countsByGroup: Record<string, number>;
  total: number;
};

type HoveredBar = {
  day: ActivityDay;
  left: number;
  top: number;
};

type Props = {
  networkActivity: NetworkActivity;
  networkActivityLoading: boolean;
  networkActivityLoaded: boolean;
  networkActivityError: string | null;
  onReloadNetworkActivity: () => void;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const CHART_VIEWBOX_WIDTH = 920;
const CHART_VIEWBOX_HEIGHT = 320;
const CHART_MARGIN = {
  top: 24,
  right: 18,
  bottom: 52,
  left: 48,
};
const BAR_GAP = 14;
const GROUP_COLOR_PALETTE = [
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
const PLACEHOLDER_BAR_HEIGHTS = [30, 50, 20, 40, 18, 24, 12, 48, 34, 22] as const;
const LOADING_CHART_HEIGHT = { xs: 340, sm: 370, md: 400 } as const;

function startOfUtcDayMs(value: number): number {
  const date = new Date(value);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function formatDayLabel(dayMs: number): string {
  return DAY_LABEL_FORMATTER.format(new Date(dayMs));
}

function formatTooltipDate(dayMs: number): string {
  return TOOLTIP_DATE_FORMATTER.format(new Date(dayMs));
}

function normalizeActivityDay(countsByGroup: Record<string, number>): Record<string, number> {
  const normalizedCounts: Record<string, number> = {};
  for (const [groupName, count] of Object.entries(countsByGroup)) {
    if (!Number.isFinite(count) || count <= 0) continue;
    normalizedCounts[groupName] = (normalizedCounts[groupName] ?? 0) + count;
  }
  return normalizedCounts;
}

function sumCounts(countsByGroup: Record<string, number>): number {
  return Object.values(countsByGroup).reduce((sum, count) => sum + count, 0);
}

function buildRoundedTopRectPath(x: number, y: number, width: number, height: number, radius = 4): string {
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

function getGroupColor(groupName: string): string {
  return GROUP_COLOR_PALETTE[hashGroupName(groupName) % GROUP_COLOR_PALETTE.length];
}

function buildChartMax(totalValues: number[]): number {
  const maxTotal = Math.max(0, ...totalValues);
  if (maxTotal <= 0) return 0;
  return Math.max(4, Math.ceil(maxTotal / 4) * 4);
}

function buildYTicks(maxValue: number): number[] {
  if (maxValue <= 0) return [0];
  const step = maxValue / 4;
  return [0, 1, 2, 3, 4].map((index) => Math.round(step * index));
}

function ActivityLoadingState() {
  const chartInnerWidth = CHART_VIEWBOX_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const chartInnerHeight = CHART_VIEWBOX_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;

  return (
    <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <CircularProgress size={18} />
        <Typography variant="body2" color="text.secondary">
          Завантаження активності мережі
        </Typography>
      </Stack>
      <Box
        sx={{
          position: 'relative',
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          maxWidth: 1280,
          height: LOADING_CHART_HEIGHT,
          alignSelf: 'stretch',
        }}
      >
        <Box
          component="svg"
          aria-hidden="true"
          viewBox="0 0 920 320"
          preserveAspectRatio="none"
          sx={{
            display: 'block',
            width: '100%',
            height: '100%',
            overflow: 'visible',
          }}
        >
          {[0, 1, 2, 3, 4].map((tickIndex) => {
            const y = CHART_MARGIN.top + (chartInnerHeight / 4) * tickIndex;
            return (
              <g key={tickIndex}>
                <line
                  x1={48}
                  x2={902}
                  y1={y}
                  y2={y}
                  stroke="currentColor"
                  strokeOpacity={tickIndex === 4 ? 0.2 : 0.12}
                  strokeDasharray={tickIndex === 4 ? undefined : '6 6'}
                />
              </g>
            );
          })}

          {PLACEHOLDER_BAR_HEIGHTS.map((heightValue, index) => {
            const bandWidth = chartInnerWidth / PLACEHOLDER_BAR_HEIGHTS.length;
            const barWidth = Math.max(18, bandWidth - BAR_GAP);
            const x = CHART_MARGIN.left + index * bandWidth + (bandWidth - barWidth) / 2;
            const barHeight = (heightValue / 100) * chartInnerHeight;
            const y = CHART_MARGIN.top + chartInnerHeight - barHeight;
            const path = buildRoundedTopRectPath(x, y, barWidth, barHeight);
            return (
              <path key={index} d={path} fill="rgba(255,255,255,0.12)" />
            );
          })}
        </Box>
      </Box>
    </Stack>
  );
}

function ActivityEmptyState() {
  return (
    <Box
      sx={{
        minHeight: 180,
        width: '100%',
        display: 'grid',
        placeItems: 'center',
        borderRadius: 2,
        border: '1px dashed',
        borderColor: 'divider',
        bgcolor: 'background.default',
      }}
    >
      <Typography variant="body2" color="text.secondary">
        Відсутня активність за останні 10 днів
      </Typography>
    </Box>
  );
}

function ActivityErrorState({ error, onReload }: { error: string; onReload: () => void }) {
  return (
    <Stack spacing={2} sx={{ alignItems: 'flex-start' }}>
      <PowerAlert severity="error" autoHideDuration={null} sx={{ width: '100%' }}>
        {error}
      </PowerAlert>
      <Button variant="outlined" onClick={onReload}>
        Спробувати ще раз
      </Button>
    </Stack>
  );
}

function ActivityTooltip({
  day,
  groupNames,
  groupColors,
  left,
  top,
}: {
  day: ActivityDay;
  groupNames: string[];
  groupColors: Map<string, string>;
  left: number;
  top: number;
}) {
  return (
    <Paper
      elevation={6}
      sx={{
        position: 'absolute',
        left,
        top,
        zIndex: 1,
        p: 1.5,
        minWidth: 220,
        maxWidth: 280,
        borderRadius: 2,
        pointerEvents: 'none',
        transform: 'translate(-50%, -100%)',
      }}
    >
      <Stack spacing={1}>
        <Typography variant="subtitle1" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
          {day.tooltipLabel}
        </Typography>
        <Stack spacing={0.75}>
          {groupNames.map((groupName) => {
            const count = day.countsByGroup[groupName] ?? 0;
            if (count <= 0) return null;

            return (
              <Stack key={groupName} direction="row" spacing={1.25} alignItems="center" justifyContent="space-between">
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                  <Box
                    sx={{
                      width: 14,
                      height: 14,
                      borderRadius: '3px',
                      bgcolor: groupColors.get(groupName) ?? getGroupColor(groupName),
                      flexShrink: 0,
                    }}
                  />
                  <Typography variant="body2" sx={{ minWidth: 0 }} noWrap title={groupName}>
                    {groupName}
                  </Typography>
                </Stack>
                <Typography variant="body2" sx={{ fontWeight: 700, flexShrink: 0 }}>
                  {count}
                </Typography>
              </Stack>
            );
          })}
        </Stack>
        <Stack direction="row" spacing={1} justifyContent="space-between">
          <Typography variant="body2" color="text.secondary">
            Разом
          </Typography>
          <Typography variant="body2" sx={{ fontWeight: 700 }}>
            {day.total}
          </Typography>
        </Stack>
      </Stack>
    </Paper>
  );
}

export function NetworkDetailsActivityPanel({
  networkActivity,
  networkActivityLoading,
  networkActivityLoaded,
  networkActivityError,
  onReloadNetworkActivity,
}: Props) {
  const headingId = useId().replace(/:/g, '-');
  const [hoveredBar, setHoveredBar] = useState<HoveredBar | null>(null);

  const chartData = useMemo(() => {
    const days = buildActivityDays(networkActivity, Date.now());
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
  }, [networkActivity]);

  const isLoading = networkActivityLoading || (!networkActivityLoaded && networkActivityError === null);
  const yTicks = useMemo(() => buildYTicks(chartData.maxValue), [chartData.maxValue]);
  const innerWidth = CHART_VIEWBOX_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const innerHeight = CHART_VIEWBOX_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const maxValue = Math.max(chartData.maxValue, 1);
  const bandWidth = chartData.days.length > 0 ? innerWidth / chartData.days.length : innerWidth;
  const barWidth = Math.max(18, bandWidth - BAR_GAP);
  const chartHeightPx = 400;
  const yLabelWidthPx = 44;
  const xLabelHeightPx = 28;
  const chartBottomY = CHART_MARGIN.top + innerHeight;

  function setHoveredBarFromElement(bar: Element | null, container: HTMLElement | null) {
    if (!bar || !container) return;

    const containerRect = container.getBoundingClientRect();
    const barRect = bar.getBoundingClientRect();
    const dayGroup = bar.closest('g[data-day]');
    const dayMs = dayGroup?.getAttribute('data-day');
    if (dayMs === null) {
      setHoveredBar(null);
      return;
    }

    const nextHoveredDayMs = Number(dayMs);
    if (!Number.isFinite(nextHoveredDayMs)) {
      setHoveredBar(null);
      return;
    }

    const day = chartData.days.find((day) => day.dayMs === nextHoveredDayMs) ?? null;
    if (!day) {
      setHoveredBar(null);
      return;
    }

    setHoveredBar({
      day,
      left: barRect.left - containerRect.left + barRect.width / 2,
      top: barRect.top - containerRect.top - 12,
    });
  }

  function handleBarMouseEnter(event: ReactMouseEvent<SVGElement>) {
    const bar = event.currentTarget;
    const container = event.currentTarget.ownerSVGElement?.parentElement?.parentElement as HTMLElement | null;
    if (!container) return;
    setHoveredBarFromElement(bar, container);
  }

  function handleChartMouseMove(event: ReactMouseEvent<SVGSVGElement>) {
    const target = event.target as Element | null;
    const bar = target?.closest('[data-group]');
    const container = event.currentTarget.parentElement?.parentElement as HTMLElement | null;

    if (!bar || !container) {
      if (hoveredBar !== null) {
        setHoveredBar(null);
      }
      return;
    }

    setHoveredBarFromElement(bar, container);
  }

  if (networkActivityError) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <ActivityErrorState error={networkActivityError} onReload={onReloadNetworkActivity} />
        </Stack>
      </Box>
    );
  }

  if (isLoading) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <ActivityLoadingState />
        </Stack>
      </Box>
    );
  }

  if (chartData.groupNames.length === 0) {
    return (
      <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
        <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }}>
          <Typography id={headingId} component="h2" variant="h6">
            Активність мережі
          </Typography>
          <ActivityEmptyState />
        </Stack>
      </Box>
    );
  }

  return (
    <Box sx={{ minHeight: 0, minWidth: 0, width: '100%', display: 'flex', flexDirection: 'column' }}>
      <Stack spacing={2} sx={{ minHeight: 0, minWidth: 0, width: '100%' }} onMouseLeave={() => setHoveredBar(null)}>
        <Typography id={headingId} component="h2" variant="h6">
          Активність мережі
        </Typography>

        <Box
          sx={{
            position: 'relative',
            minHeight: 0,
            minWidth: 0,
            width: '100%',
            maxWidth: 1280,
            height: { xs: 340, sm: 370, md: chartHeightPx },
            alignSelf: 'stretch',
            display: 'grid',
            gridTemplateColumns: `${yLabelWidthPx}px minmax(0, 1fr)`,
            gridTemplateRows: 'minmax(0, 1fr) auto',
            columnGap: 1,
          }}
        >
          <Box
            sx={{
              gridColumn: 1,
              gridRow: 1,
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              color: 'text.secondary',
              fontSize: '0.85rem',
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            {yTicks.map((tickValue) => {
              const y = chartBottomY - (tickValue / maxValue) * innerHeight;
              const topPercent = (y / CHART_VIEWBOX_HEIGHT) * 100;
              return (
                <Box
                  key={tickValue}
                  component="span"
                  sx={{
                    position: 'absolute',
                    right: 8,
                    top: `${topPercent}%`,
                    transform: 'translateY(-50%)',
                  }}
                >
                  {tickValue}
                </Box>
              );
            })}
          </Box>

          <Box
            sx={{
              gridColumn: 2,
              gridRow: 1,
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              overflow: 'visible',
            }}
          >
            <Box
              component="svg"
              role="img"
              aria-labelledby={headingId}
              data-chart="network-activity"
              viewBox={`0 0 ${CHART_VIEWBOX_WIDTH} ${CHART_VIEWBOX_HEIGHT}`}
              preserveAspectRatio="none"
              onMouseMove={handleChartMouseMove}
              sx={{
                display: 'block',
                width: '100%',
                height: '100%',
                overflow: 'visible',
                color: 'text.secondary',
              }}
            >
              {yTicks.map((tickValue) => {
                const y = chartBottomY - (tickValue / maxValue) * innerHeight;
                return (
                  <g key={tickValue}>
                    <line
                      x1={CHART_MARGIN.left}
                      x2={CHART_VIEWBOX_WIDTH - CHART_MARGIN.right}
                      y1={y}
                      y2={y}
                      stroke="currentColor"
                      strokeOpacity={tickValue === 0 ? 0.2 : 0.14}
                      strokeDasharray={tickValue === 0 ? undefined : '6 6'}
                    />
                  </g>
                );
              })}

              {chartData.days.map((day, index) => {
                const x = CHART_MARGIN.left + index * bandWidth + (bandWidth - barWidth) / 2;
                let segmentTop = chartBottomY;

                return (
                  <g key={day.dayMs} data-day={String(day.dayMs)} style={{ cursor: 'default' }}>
                    {day.segments.map((segment, segmentIndex) => {
                      const segmentHeight = chartData.maxValue > 0 ? (segment.count / chartData.maxValue) * innerHeight : 0;
                      segmentTop -= segmentHeight;
                      const isTopSegment = segmentIndex === day.segments.length - 1;
                      const path = isTopSegment ? buildRoundedTopRectPath(x, segmentTop, barWidth, segmentHeight) : '';
                      return path ? (
                        <path
                          key={segment.groupName}
                          data-group={segment.groupName}
                          d={path}
                          fill={segment.color}
                          onMouseEnter={handleBarMouseEnter}
                        />
                      ) : (
                        <rect
                          key={segment.groupName}
                          data-group={segment.groupName}
                          x={x}
                          y={segmentTop}
                          width={barWidth}
                          height={segmentHeight}
                          fill={segment.color}
                          onMouseEnter={handleBarMouseEnter}
                        />
                      );
                    })}
                    <line
                      x1={x + barWidth / 2}
                      x2={x + barWidth / 2}
                      y1={chartBottomY}
                      y2={chartBottomY + 6}
                      stroke="currentColor"
                      strokeOpacity={0.3}
                    />
                  </g>
                );
              })}
            </Box>

            {hoveredBar ? (
              <ActivityTooltip
                day={hoveredBar.day}
                groupNames={chartData.groupNames}
                groupColors={chartData.groupColors}
                left={hoveredBar.left}
                top={hoveredBar.top}
              />
            ) : null}
          </Box>

          <Box
            sx={{
              gridColumn: 2,
              gridRow: 2,
              position: 'relative',
              minWidth: 0,
              minHeight: 0,
              height: `${xLabelHeightPx}px`,
              color: 'text.secondary',
              fontSize: '0.85rem',
              lineHeight: 1.1,
              fontVariantNumeric: 'tabular-nums',
              pointerEvents: 'none',
              overflow: 'visible',
            }}
          >
            {chartData.days.map((day, index) => {
              const x = CHART_MARGIN.left + index * bandWidth + bandWidth / 2;
              const leftPercent = (x / CHART_VIEWBOX_WIDTH) * 100;
              return (
                <Box
                  key={day.dayMs}
                  component="span"
                  sx={{
                    position: 'absolute',
                    left: `${leftPercent}%`,
                    top: 0,
                    transform: 'translateX(-50%)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {day.dayLabel}
                </Box>
              );
            })}
          </Box>
        </Box>

        <Stack direction="row" spacing={1.5} useFlexGap sx={{ flexWrap: 'wrap', pt: 0.5 }}>
          {chartData.groupNames.map((groupName) => (
            <Stack key={groupName} direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
              <Box
                sx={{
                  width: 12,
                  height: 12,
                  borderRadius: '50%',
                  bgcolor: chartData.groupColors.get(groupName) ?? getGroupColor(groupName),
                  flexShrink: 0,
                }}
              />
              <Typography variant="body2" sx={{ minWidth: 0 }} noWrap title={groupName}>
                {groupName}
              </Typography>
            </Stack>
          ))}
        </Stack>
      </Stack>
    </Box>
  );
}
