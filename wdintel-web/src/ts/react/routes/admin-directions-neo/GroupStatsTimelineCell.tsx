import { Box, CircularProgress, Typography } from '@mui/material';
import { useEffect, useMemo, useRef } from 'react';
import type { ECharts, EChartsOption } from 'echarts';

import type { SignalGroupStatsTimelinePoint } from '../../../../Bindings';
import { NO_DATA_LABEL } from '../../utils/misc';

type TimelineStatus = 'idle' | 'loading' | 'success' | 'error';

type Props = {
  points: SignalGroupStatsTimelinePoint[];
  status: TimelineStatus;
  error: string | null;
  periodHours: number;
  defaultWindowHours: number;
};

let echartsImport: Promise<typeof import('echarts')> | null = null;

function loadEcharts() {
  if (!echartsImport) {
    echartsImport = import('echarts');
  }
  return echartsImport;
}

function buildOption(
  points: SignalGroupStatsTimelinePoint[],
  periodHours: number,
  defaultWindowHours: number,
): EChartsOption {
  const periodEndTimestamp = Date.now();
  const periodStartTimestamp = periodEndTimestamp - periodHours * 60 * 60 * 1000;
  const defaultStartTimestamp = Math.max(
    periodStartTimestamp,
    periodEndTimestamp - defaultWindowHours * 60 * 60 * 1000,
  );

  return {
    animation: false,
    grid: {
      left: 0,
      right: 0,
      top: 4,
      bottom: 30,
    },
    tooltip: {
      trigger: 'axis',
      appendToBody: true,
      confine: true,
      valueFormatter: (value) => String(value),
    },
    xAxis: {
      type: 'time',
      min: periodStartTimestamp,
      max: periodEndTimestamp,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: {
        color: '#6b7280',
        fontSize: 10,
        hideOverlap: true,
      },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'value',
      min: 0,
      axisLine: { show: false },
      axisTick: { show: false },
      axisLabel: { show: false },
      splitLine: { show: false },
    },
    dataZoom: [
      {
        type: 'inside',
        xAxisIndex: 0,
        startValue: defaultStartTimestamp,
        endValue: periodEndTimestamp,
      },
      {
        type: 'slider',
        xAxisIndex: 0,
        startValue: defaultStartTimestamp,
        endValue: periodEndTimestamp,
        bottom: 0,
        height: 20,
        brushSelect: false,
        showDataShadow: false,
        showDetail: false,
      },
    ],
    series: [
      {
        type: 'line',
        data: points.map((point) => [point.timestamp, point.count]),
        showSymbol: false,
        smooth: false,
        lineStyle: {
          color: '#1976d2',
          width: 1.5,
        },
        areaStyle: {
          color: 'rgba(25, 118, 210, 0.12)',
        },
      },
    ],
  };
}

export function GroupStatsTimelineCell({
  points,
  status,
  error,
  periodHours,
  defaultWindowHours,
}: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<ECharts | null>(null);
  const total = useMemo(() => points.reduce((sum, point) => sum + point.count, 0), [points]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || status !== 'success') {
      chartRef.current?.dispose();
      chartRef.current = null;
      return;
    }

    let cancelled = false;
    const resizeObserver = new ResizeObserver(() => chartRef.current?.resize());
    resizeObserver.observe(host);

    loadEcharts().then((echarts) => {
      if (cancelled || !hostRef.current) return;
      const chart =
        chartRef.current ?? echarts.init(hostRef.current, undefined, { renderer: 'svg' });
      chartRef.current = chart;
      chart.setOption(buildOption(points, periodHours, defaultWindowHours), true);
      chart.resize();
    });

    return () => {
      cancelled = true;
      resizeObserver.disconnect();
    };
  }, [defaultWindowHours, periodHours, points, status]);

  useEffect(
    () => () => {
      chartRef.current?.dispose();
      chartRef.current = null;
    },
    [],
  );

  if (status === 'loading' || status === 'idle') {
    return (
      <Box sx={{ width: 280, height: 86, display: 'grid', placeItems: 'center' }}>
        <CircularProgress size={18} />
      </Box>
    );
  }

  if (status === 'error') {
    return (
      <Typography variant="caption" color="error" title={error ?? undefined}>
        {NO_DATA_LABEL}
      </Typography>
    );
  }

  return (
    <Box sx={{ width: 280, height: 86, position: 'relative' }}>
      <Box ref={hostRef} sx={{ width: '100%', height: '100%' }} />
      <Typography
        variant="caption"
        sx={{
          position: 'absolute',
          top: 2,
          right: 2,
          px: 0.5,
          bgcolor: 'background.paper',
          fontVariantNumeric: 'tabular-nums',
          lineHeight: 1.2,
        }}
      >
        {total}
      </Typography>
    </Box>
  );
}
