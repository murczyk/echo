import { Box, Paper, Stack, Typography } from '@mui/material';
import { useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { createPortal } from 'react-dom';

import { formatDeviceBytes, formatDeviceCount, type DeviceActivityDay } from '../device-activity';
import { FILE_TYPE_CATEGORIES, FILE_TYPE_CATEGORY_NAMES } from '../file-type-categories';

// Pixel geometry shared by the y labels, the SVG plot and the day labels so they line up exactly.
const GEOMETRY = {
  compact: {
    bandWidth: 17,
    barWidth: 13,
    plotHeight: 36,
    plotTop: 2,
    barRadius: 2,
  },
  detailed: {
    bandWidth: 22,
    barWidth: 16,
    plotHeight: 140,
    plotTop: 8,
    barRadius: 3,
  },
} as const;
const Y_LABEL_WIDTH = 40;
const Y_LABEL_FONT_SIZE = 11;
const DAY_LABEL_FONT_SIZE = 12;

type HoveredDay = {
  day: DeviceActivityDay;
  left: number;
  top: number;
};

type Props = {
  days: DeviceActivityDay[];
  /** `detailed` adds a y-axis with gridlines and a category legend and uses taller bars. */
  variant?: keyof typeof GEOMETRY;
};

/** Same layout as `NetworkDetailsActivityChart`, but in fixed pixels inside a horizontal
 * scroller so the full history fits; it opens scrolled to the latest day. */
export function DeviceActivityChart({ days, variant = 'compact' }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [hovered, setHovered] = useState<HoveredDay | null>(null);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (element) element.scrollLeft = element.scrollWidth;
  }, [days]);

  if (days.length === 0) {
    return (
      <Typography variant="body2" color="text.secondary">
        —
      </Typography>
    );
  }

  const geometry = GEOMETRY[variant];
  const detailed = variant === 'detailed';
  const svgHeight = geometry.plotTop + geometry.plotHeight;
  const maxCount = days.reduce((max, day) => (day.contentCount > max ? day.contentCount : max), 1n);
  // The top stop equals the tallest bar; the middle stop is a whole count placed at its own height.
  const midCount = maxCount / 2n;
  const yFor = (count: bigint) =>
    geometry.plotTop + geometry.plotHeight * (1 - Number(count) / Number(maxCount));
  const plotWidth = days.length * geometry.bandWidth;
  const plotBottom = svgHeight;
  const yTicks = detailed
    ? [
        { y: yFor(maxCount), label: formatDeviceCount(maxCount) },
        ...(midCount > 0n ? [{ y: yFor(midCount), label: formatDeviceCount(midCount) }] : []),
        { y: plotBottom, label: '0' },
      ]
    : [];

  const onMouseMove = (event: ReactMouseEvent<SVGSVGElement>) => {
    const group = (event.target as Element).closest('g[data-day-index]');
    const day = group ? days[Number(group.getAttribute('data-day-index'))] : undefined;
    if (!group || !day) {
      if (hovered !== null) setHovered(null);
      return;
    }
    if (hovered?.day === day) return;
    const rect = group.getBoundingClientRect();
    setHovered({ day, left: rect.left + rect.width / 2, top: rect.top - 6 });
  };

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'flex-start', maxWidth: '100%' }}>
        {detailed ? (
          <Box
            aria-hidden
            sx={{
              position: 'relative',
              flex: 'none',
              width: Y_LABEL_WIDTH,
              height: svgHeight,
              color: 'text.secondary',
              fontSize: Y_LABEL_FONT_SIZE,
              lineHeight: 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {yTicks.map((tick) => (
              <Box
                key={tick.y}
                component="span"
                sx={{
                  position: 'absolute',
                  right: 6,
                  top: tick.y,
                  transform: 'translateY(-50%)',
                  whiteSpace: 'nowrap',
                }}
              >
                {tick.label}
              </Box>
            ))}
          </Box>
        ) : null}
        <Box
          ref={scrollRef}
          onScroll={() => setHovered(null)}
          sx={{ flex: 1, minWidth: 0, overflowX: 'auto', overflowY: 'hidden', pb: '2px' }}
        >
          <Box
            component="svg"
            role="img"
            aria-label="Завантаження файлів за днями"
            width={plotWidth}
            height={svgHeight}
            onMouseMove={onMouseMove}
            onMouseLeave={() => setHovered(null)}
            sx={{ display: 'block', color: 'text.secondary' }}
          >
            {yTicks.slice(0, -1).map((tick) => (
              <line
                key={tick.y}
                x1={0}
                x2={plotWidth}
                y1={tick.y}
                y2={tick.y}
                stroke="currentColor"
                strokeOpacity={0.14}
                strokeDasharray="4 4"
              />
            ))}
            <line
              x1={0}
              x2={plotWidth}
              y1={plotBottom}
              y2={plotBottom}
              stroke="currentColor"
              strokeOpacity={0.3}
            />
            {days.map((day, index) => {
              const bandX = index * geometry.bandWidth;
              const x = bandX + (geometry.bandWidth - geometry.barWidth) / 2;
              let segmentTop = plotBottom;
              return (
                <g key={day.day} data-day-index={index}>
                  <rect
                    x={bandX}
                    y={0}
                    width={geometry.bandWidth}
                    height={svgHeight}
                    fill="currentColor"
                    fillOpacity={hovered?.day === day ? 0.08 : 0}
                  />
                  {day.categories.map((category, categoryIndex) => {
                    const height =
                      (Number(category.contentCount) / Number(maxCount)) * geometry.plotHeight;
                    segmentTop -= height;
                    const fill = FILE_TYPE_CATEGORIES[category.category]?.color;
                    return categoryIndex === day.categories.length - 1 ? (
                      <path
                        key={category.category}
                        d={roundedTopRectPath(
                          x,
                          segmentTop,
                          geometry.barWidth,
                          height,
                          geometry.barRadius,
                        )}
                        fill={fill}
                      />
                    ) : (
                      <rect
                        key={category.category}
                        x={x}
                        y={segmentTop}
                        width={geometry.barWidth}
                        height={height}
                        fill={fill}
                      />
                    );
                  })}
                </g>
              );
            })}
          </Box>
          {detailed ? (
            <Box
              aria-hidden
              sx={{
                display: 'flex',
                width: plotWidth,
                pt: '3px',
                color: 'text.secondary',
                fontSize: DAY_LABEL_FONT_SIZE,
                lineHeight: 1,
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {days.map((day) => (
                <Box
                  key={day.day}
                  sx={{
                    width: geometry.bandWidth,
                    flex: 'none',
                    display: 'flex',
                    justifyContent: 'center',
                  }}
                >
                  <Box
                    component="span"
                    sx={{
                      whiteSpace: 'nowrap',
                      writingMode: 'vertical-rl',
                      transform: 'rotate(180deg)',
                      opacity: day.contentCount > 0n ? 1 : 0.5,
                    }}
                  >
                    {day.label}
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
        </Box>
      </Box>
      {detailed ? <CategoryLegend days={days} /> : null}
      {hovered
        ? createPortal(
            <ActivityTooltip day={hovered.day} left={hovered.left} top={hovered.top} />,
            document.body,
          )
        : null}
    </>
  );
}

function ActivityTooltip({
  day,
  left,
  top,
}: {
  day: DeviceActivityDay;
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
        maxWidth: 320,
        borderRadius: 2,
        pointerEvents: 'none',
        transform: 'translate(-50%, -100%)',
      }}
    >
      <Stack spacing={1}>
        <Typography variant="subtitle2" sx={{ fontWeight: 700, lineHeight: 1.2 }}>
          {day.label}
        </Typography>
        {day.categories.length === 0 ? (
          <Typography variant="body2" color="text.secondary">
            Немає завантажень
          </Typography>
        ) : (
          <Stack spacing={0.5}>
            {day.categories.map((category) => (
              <Stack
                key={category.category}
                direction="row"
                spacing={1.25}
                alignItems="center"
                justifyContent="space-between"
              >
                <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0 }}>
                  <Box
                    sx={{
                      width: 12,
                      height: 12,
                      borderRadius: '3px',
                      bgcolor: FILE_TYPE_CATEGORIES[category.category]?.color,
                      flexShrink: 0,
                    }}
                  />
                  <Typography variant="body2" noWrap>
                    {category.category}
                  </Typography>
                </Stack>
                <Typography variant="body2" sx={{ flexShrink: 0, whiteSpace: 'nowrap' }}>
                  <b>{formatDeviceCount(category.contentCount)}</b> ·{' '}
                  {formatDeviceBytes(category.contentBytes)}
                </Typography>
              </Stack>
            ))}
          </Stack>
        )}
        {day.categories.length > 1 ? (
          <Stack direction="row" spacing={1} justifyContent="space-between">
            <Typography variant="body2" color="text.secondary">
              Разом
            </Typography>
            <Typography variant="body2" sx={{ whiteSpace: 'nowrap' }}>
              <b>{formatDeviceCount(day.contentCount)}</b> · {formatDeviceBytes(day.contentBytes)}
            </Typography>
          </Stack>
        ) : null}
      </Stack>
    </Paper>
  );
}

function CategoryLegend({ days }: { days: DeviceActivityDay[] }) {
  const totals = new Map<string, bigint>();
  for (const day of days) {
    for (const category of day.categories) {
      totals.set(category.category, (totals.get(category.category) ?? 0n) + category.contentCount);
    }
  }
  const categories = FILE_TYPE_CATEGORY_NAMES.filter((name) => totals.has(name));

  return (
    <Stack
      component="ul"
      direction="row"
      useFlexGap
      flexWrap="wrap"
      columnGap={2}
      rowGap={0.5}
      sx={{ listStyle: 'none', m: 0, mt: 1.5, p: 0 }}
    >
      {categories.map((name) => (
        <Stack key={name} component="li" direction="row" spacing={0.75} alignItems="center">
          <Box
            sx={{
              width: 12,
              height: 12,
              borderRadius: '3px',
              bgcolor: FILE_TYPE_CATEGORIES[name]?.color,
              flexShrink: 0,
            }}
          />
          <Typography variant="body2">{name}</Typography>
          <Typography variant="body2" color="text.secondary">
            {formatDeviceCount(totals.get(name) ?? 0n)}
          </Typography>
        </Stack>
      ))}
    </Stack>
  );
}

function roundedTopRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number,
): string {
  const r = Math.min(radius, width / 2, height);
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
