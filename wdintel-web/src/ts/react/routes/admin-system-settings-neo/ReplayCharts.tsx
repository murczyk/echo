import { useTheme } from '@mui/material/styles';
import type { ECharts, EChartsOption } from 'echarts';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PowerAlert } from '../../components/PowerAlert';
import {
  formatCount,
  formatDate,
  formatDayMonth,
  formatKyiv,
  formatKyivTime,
  kyivDate,
  MONTH_NAMES,
  WEEKDAY_NAMES,
  type Bar,
} from './message-replay-helpers';

type IndexRange = [number, number];

function useChartColors() {
  const theme = useTheme();
  return theme.echo.color[theme.palette.mode];
}

/**
 * Renders `option` into a lazily loaded ECharts instance.
 * - `onClick` gets the clicked data index of the first series.
 * - `onBrush` enables dragging across a category x axis and gets the
 *   selected category index range; `brushRange` draws the current one.
 */
function EChart({
  option,
  ariaLabel,
  height,
  onClick,
  onBrush,
  brushRange,
  brushColor,
}: {
  option: EChartsOption;
  ariaLabel: string;
  height: number;
  onClick?: (dataIndex: number) => void;
  onBrush?: (range: IndexRange) => void;
  brushRange?: IndexRange | null;
  brushColor?: string;
}) {
  const host = useRef<HTMLDivElement>(null);
  const chartRef = useRef<ECharts | null>(null);
  const onClickRef = useRef(onClick);
  const onBrushRef = useRef(onBrush);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const brushable = onBrush !== undefined;
  onClickRef.current = onClick;
  onBrushRef.current = onBrush;

  useEffect(() => {
    const element = host.current;
    if (!element) return;
    let cancelled = false;
    const observer = new ResizeObserver(() => chartRef.current?.resize());
    observer.observe(element);
    import('echarts')
      .then((echarts) => {
        if (cancelled) return;
        const chart = echarts.init(element, undefined, { renderer: 'canvas' });
        chart.on('click', (params) => {
          if (params.seriesIndex === 0) onClickRef.current?.(params.dataIndex);
        });
        chart.on('brushEnd', (params) => {
          const range = (params as { areas?: Array<{ coordRange?: number[] }> }).areas?.[0]
            ?.coordRange;
          if (range && range.length === 2) {
            onBrushRef.current?.([Math.round(range[0]), Math.round(range[1])]);
          }
        });
        chartRef.current = chart;
        setReady(true);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
      observer.disconnect();
      chartRef.current?.dispose();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!ready || !chart) return;
    chart.setOption(
      brushable
        ? {
            ...option,
            brush: {
              toolbox: [],
              xAxisIndex: 0,
              brushType: 'lineX',
              brushMode: 'single',
              transformable: false,
              brushStyle: { color: 'rgba(211, 135, 29, 0.15)', borderColor: brushColor },
            },
          }
        : option,
      { notMerge: true },
    );
    if (!brushable) return;
    chart.dispatchAction({
      type: 'takeGlobalCursor',
      key: 'brush',
      brushOption: { brushType: 'lineX', brushMode: 'single' },
    });
    chart.dispatchAction({
      type: 'brush',
      areas: brushRange ? [{ brushType: 'lineX', xAxisIndex: 0, coordRange: brushRange }] : [],
    });
  }, [ready, option, brushable, brushRange, brushColor]);

  return (
    <>
      <div
        ref={host}
        role="img"
        aria-label={ariaLabel}
        style={{
          width: '100%',
          height,
          cursor: brushable ? 'crosshair' : onClick ? 'pointer' : undefined,
        }}
        hidden={failed}
      />
      {failed ? (
        <PowerAlert severity="error" autoHideDuration={null} dismissible={false}>
          Не вдалося побудувати графік. Скористайтеся полями дати.
        </PowerAlert>
      ) : null}
    </>
  );
}

/** A year of days as a calendar heatmap; clicking a day with messages selects it. */
export function YearHeatmap({
  fromDate,
  toDate,
  counts,
  selectedDate,
  onSelect,
}: {
  fromDate: string;
  toDate: string;
  counts: Map<string, number>;
  selectedDate: string | null;
  onSelect: (date: string) => void;
}) {
  const colors = useChartColors();
  const entries = useMemo(
    () => [...counts.entries()].filter(([date]) => date >= fromDate && date <= toDate),
    [counts, fromDate, toDate],
  );
  const option = useMemo<EChartsOption>(() => {
    const max = Math.max(1, ...entries.map(([, count]) => count));
    return {
      animation: false,
      tooltip: {
        formatter: (params: unknown) => {
          const [date, count] = (params as { value: [string, number] }).value;
          return `${formatDate(date)}<br/>Повідомлень: <b>${formatCount(count)}</b>`;
        },
      },
      visualMap: {
        show: false,
        min: 0,
        max,
        inRange: { color: [colors.hover, colors.primary] },
      },
      calendar: {
        range: [fromDate, toDate],
        top: 24,
        left: 32,
        right: 8,
        bottom: 4,
        cellSize: ['auto', 14],
        splitLine: { lineStyle: { color: colors.border } },
        itemStyle: { color: colors.surface, borderColor: colors.border },
        dayLabel: { firstDay: 1, nameMap: WEEKDAY_NAMES, color: colors.textMuted, fontSize: 10 },
        monthLabel: { nameMap: MONTH_NAMES, color: colors.textMuted },
        yearLabel: { show: false },
      },
      series: [
        {
          type: 'heatmap',
          coordinateSystem: 'calendar',
          data: entries.map(([date, count]) => ({
            value: [date, count],
            itemStyle:
              date === selectedDate ? { borderColor: colors.secondary, borderWidth: 3 } : undefined,
          })),
        },
      ],
    };
  }, [entries, fromDate, toDate, selectedDate, colors]);
  return (
    <EChart
      ariaLabel="Кількість повідомлень по днях за рік"
      option={option}
      height={150}
      onClick={(index) => {
        const entry = entries[index];
        if (entry) onSelect(entry[0]);
      }}
    />
  );
}

export type BarTone = 'normal' | 'selected' | 'played';

/**
 * Message counts as bars on a category axis (Kyiv time labels). With
 * `onSelect`, dragging across bars selects them.
 */
export function BarStrip({
  bars,
  bucketMs,
  tones,
  onSelect,
  selected,
  ariaLabel,
  height = 180,
}: {
  bars: Bar[];
  bucketMs: number;
  /** Per-bar tone, same order as `bars`. */
  tones: BarTone[];
  onSelect?: (fromBar: Bar, toBar: Bar) => void;
  /** Selected bar index range, drawn as the drag selection. */
  selected?: IndexRange | null;
  ariaLabel: string;
  height?: number;
}) {
  const colors = useChartColors();
  const option = useMemo<EChartsOption>(() => {
    const multiDay =
      bars.length > 0 && kyivDate(bars[0].startMs) !== kyivDate(bars[bars.length - 1].startMs);
    const toneColor: Record<BarTone, string> = {
      normal: colors.primary,
      selected: colors.secondary,
      played: colors.textDisabled,
    };
    return {
      animation: false,
      grid: { left: 8, right: 8, top: 8, bottom: 8, containLabel: true },
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: unknown) => {
          const index = (params as Array<{ dataIndex: number }>)[0]?.dataIndex ?? 0;
          const bar = bars[index];
          if (!bar) return '';
          return `${formatKyiv(bar.startMs)} – ${formatKyivTime(bar.startMs + bucketMs)}<br/>Повідомлень: <b>${formatCount(bar.count)}</b>`;
        },
      },
      xAxis: {
        type: 'category',
        data: bars.map((bar) =>
          multiDay
            ? `${formatDayMonth(kyivDate(bar.startMs))} ${formatKyivTime(bar.startMs)}`
            : formatKyivTime(bar.startMs),
        ),
        axisLabel: { color: colors.textMuted, hideOverlap: true },
        axisLine: { lineStyle: { color: colors.border } },
        axisTick: { show: false },
      },
      yAxis: {
        type: 'value',
        minInterval: 1,
        axisLabel: { color: colors.textMuted, formatter: (value: number) => formatCount(value) },
        splitLine: { lineStyle: { color: colors.border } },
      },
      series: [
        {
          type: 'bar',
          barCategoryGap: '15%',
          data: bars.map((bar, index) => ({
            value: bar.count,
            itemStyle: { color: toneColor[tones[index] ?? 'normal'] },
          })),
        },
      ],
    };
  }, [bars, bucketMs, tones, colors]);
  return (
    <EChart
      ariaLabel={ariaLabel}
      option={option}
      height={height}
      brushRange={selected}
      brushColor={colors.secondary}
      onBrush={
        onSelect
          ? ([from, to]) => {
              const last = bars.length - 1;
              const fromBar = bars[Math.max(0, Math.min(last, Math.min(from, to)))];
              const toBar = bars[Math.max(0, Math.min(last, Math.max(from, to)))];
              if (fromBar && toBar) onSelect(fromBar, toBar);
            }
          : undefined
      }
    />
  );
}
