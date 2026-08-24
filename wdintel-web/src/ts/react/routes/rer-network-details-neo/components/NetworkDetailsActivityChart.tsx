import { Box, Paper, Stack, Typography } from '@mui/material';
import { createPortal } from 'react-dom';
import type { MouseEvent as ReactMouseEvent } from 'react';

import {
  BAR_GAP,
  CHART_MARGIN,
  CHART_VIEWBOX_HEIGHT,
  CHART_VIEWBOX_WIDTH,
  type ActivityChartData,
  type HoveredBar,
  buildYTicks,
  buildRoundedTopRectPath,
  getGroupColor,
} from './NetworkDetailsActivityPanel.utils';

type Props = {
  chartData: ActivityChartData;
  hoveredBar: HoveredBar | null;
  onHoveredBarChange: (hoveredBar: HoveredBar | null) => void;
  headingId: string;
};

function ActivityTooltip({
  day,
  groupNames,
  groupColors,
  left,
  top,
}: {
  day: HoveredBar['day'];
  groupNames: string[];
  groupColors: Map<string, string>;
  left: number;
  top: number;
}) {
  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        left,
        top,
        zIndex: 1500,
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
              <Stack
                key={groupName}
                direction="row"
                spacing={1.25}
                alignItems="center"
                justifyContent="space-between"
              >
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

export function NetworkDetailsActivityChart({
  chartData,
  hoveredBar,
  onHoveredBarChange,
  headingId,
}: Props) {
  const yTicks = buildYTicks(chartData.maxValue);
  const innerWidth = CHART_VIEWBOX_WIDTH - CHART_MARGIN.left - CHART_MARGIN.right;
  const innerHeight = CHART_VIEWBOX_HEIGHT - CHART_MARGIN.top - CHART_MARGIN.bottom;
  const maxValue = Math.max(chartData.maxValue, 1);
  const bandWidth = chartData.days.length > 0 ? innerWidth / chartData.days.length : innerWidth;
  const barWidth = Math.max(2, bandWidth - Math.min(BAR_GAP, bandWidth / 3));
  const chartBottomY = CHART_MARGIN.top + innerHeight;
  const yLabelWidthPx = 44;
  const xLabelHeightPx = 28;
  const xLabelStep = Math.max(1, Math.ceil(chartData.days.length / 10));

  function setHoveredBarFromElement(bar: Element | null) {
    if (!bar) return;

    const barRect = bar.getBoundingClientRect();
    const dayGroup = bar.closest('g[data-day]');
    const dayMs = dayGroup?.getAttribute('data-day');
    if (dayMs === null) {
      onHoveredBarChange(null);
      return;
    }

    const nextHoveredDayMs = Number(dayMs);
    if (!Number.isFinite(nextHoveredDayMs)) {
      onHoveredBarChange(null);
      return;
    }

    const day = chartData.days.find((day) => day.dayMs === nextHoveredDayMs) ?? null;
    if (!day) {
      onHoveredBarChange(null);
      return;
    }

    onHoveredBarChange({
      day,
      left: barRect.left + barRect.width / 2,
      top: barRect.top - 12,
    });
  }

  function handleBarMouseEnter(event: ReactMouseEvent<SVGElement>) {
    const bar = event.currentTarget;
    setHoveredBarFromElement(bar);
  }

  function handleChartMouseMove(event: ReactMouseEvent<SVGSVGElement>) {
    const target = event.target as Element | null;
    const bar = target?.closest('[data-group]');

    if (!bar) {
      if (hoveredBar !== null) {
        onHoveredBarChange(null);
      }
      return;
    }

    setHoveredBarFromElement(bar);
  }

  return (
    <>
      <Box
        sx={{
          position: 'relative',
          minHeight: 0,
          minWidth: 0,
          width: '100%',
          maxWidth: 1280,
          height: { xs: 340, sm: 370, md: 400 },
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
                    const segmentHeight =
                      chartData.maxValue > 0
                        ? (segment.count / chartData.maxValue) * innerHeight
                        : 0;
                    segmentTop -= segmentHeight;
                    const isTopSegment = segmentIndex === day.segments.length - 1;
                    const path = isTopSegment
                      ? buildRoundedTopRectPath(x, segmentTop, barWidth, segmentHeight)
                      : '';
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
            if (index % xLabelStep !== 0 && index !== chartData.days.length - 1) return null;
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

      {hoveredBar
        ? createPortal(
            <ActivityTooltip
              day={hoveredBar.day}
              groupNames={chartData.groupNames}
              groupColors={chartData.groupColors}
              left={hoveredBar.left}
              top={hoveredBar.top}
            />,
            document.body,
          )
        : null}
    </>
  );
}
