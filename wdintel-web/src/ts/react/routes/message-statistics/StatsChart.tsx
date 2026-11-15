import { useEffect, useRef, useState } from 'react';
import { getContrastRatio, useTheme } from '@mui/material/styles';
import type { ECharts, EChartsOption } from 'echarts';
import type { DailyMessageStatsRsp } from '../../../../Bindings';
import { today } from './state';
import { PowerAlert } from '../../components/PowerAlert';
import { usePowerSnackbar } from '../../components/PowerSnackbar';

type Column = {
  day: string;
  label: string;
  key: string | null;
  messages: number;
  counterparts: number;
} | null;

function chartColumns(data: DailyMessageStatsRsp, width: number, mobile: boolean): Column[] {
  if (data.days.length > 1)
    return data.days.flatMap((day, index) => [
      null,
      ...data.series.map((series) => ({
        day,
        label: series.label,
        key: series.key,
        ...series.points[index],
      })),
      null,
    ]);
  const count = Math.max(data.series.length, Math.floor((width - 64) / (mobile ? 62 : 114)));
  const padding = count - data.series.length;
  return [
    ...Array<null>(Math.floor(padding / 2)).fill(null),
    ...data.series.map((series) => ({
      day: data.days[0],
      label: series.label,
      key: series.key,
      ...series.points[0],
    })),
    ...Array<null>(Math.ceil(padding / 2)).fill(null),
  ];
}

function chartOption(
  data: DailyMessageStatsRsp,
  columns: Column[],
  byGroups: boolean,
  mobile: boolean,
  colors: { text: string; divider: string; bar: string; inside: string; font?: string },
): EChartsOption {
  const multipleDays = data.days.length > 1;
  const peak = Math.max(
    0,
    ...data.series.flatMap((series) => series.points.map((point) => point.messages)),
  );
  const step = Math.max(1, (peak * 1.2) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const interval = Math.ceil(step / magnitude) * magnitude;
  return {
    animation: false,
    textStyle: { fontFamily: colors.font, fontSize: 12 },
    grid: { left: 48, right: 16, top: 24, bottom: 114 },
    tooltip: {
      trigger: 'item',
      confine: true,
      renderMode: 'richText',
      formatter: (entry: unknown) => {
        const point = columns[(entry as { dataIndex: number }).dataIndex];
        if (!point) return '';
        return `${point.label}${point.key ? ` (${point.key.slice(0, 12)})` : ''}\n${point.day}${point.day === today() ? ' · неповний день' : ''}\nПовідомлень: ${point.messages}\n${byGroups ? 'Відправників' : 'Груп'}: ${point.counterparts}`;
      },
    },
    xAxis: [
      {
        type: 'category',
        data: columns.map((column) => column?.label ?? ''),
        axisLabel: {
          rotate: multipleDays ? 90 : 0,
          interval: 0,
          width: multipleDays ? 80 : mobile ? 58 : 104,
          overflow: 'truncate',
          color: colors.text,
          fontSize: 12,
          margin: 8,
        },
        axisTick: { show: false },
        axisLine: { lineStyle: { color: colors.divider } },
      },
      ...(multipleDays
        ? [
            {
              type: 'category' as const,
              data: data.days,
              position: 'bottom' as const,
              offset: 90,
              axisLabel: {
                interval: 0,
                formatter: (value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}`,
                color: colors.text,
                fontSize: 12,
              },
              axisTick: { show: false },
              axisLine: { show: false },
            },
          ]
        : []),
    ],
    yAxis: {
      type: 'value',
      min: 0,
      minInterval: 1,
      splitNumber: 4,
      interval,
      max: interval * 4,
      axisLabel: { color: colors.text, fontSize: 12 },
      splitLine: { lineStyle: { color: colors.divider } },
    },
    series: [
      {
        id: 'messages',
        type: 'bar',
        barMaxWidth: multipleDays ? 20 : mobile ? 56 : 104,
        barCategoryGap: '8%',
        data: columns.map((point) => point?.messages ?? null),
        itemStyle: { color: colors.bar, borderRadius: [4, 4, 0, 0] },
        label: {
          show: true,
          position: 'top',
          distance: 8,
          color: colors.text,
          fontSize: 14,
          formatter: (entry) => (Number(entry.value) > 0 ? String(entry.value) : ''),
        },
      },
      {
        id: 'counterparts',
        type: 'bar',
        silent: true,
        barMaxWidth: multipleDays ? 20 : mobile ? 56 : 104,
        barGap: '-100%',
        data: columns.map((point) => point?.messages ?? null),
        itemStyle: { color: 'transparent' },
        tooltip: { show: false },
        label: {
          show: true,
          position: 'inside',
          color: colors.inside,
          fontSize: 14,
          formatter: (entry) =>
            Number(entry.value) > 0 ? String(columns[entry.dataIndex]?.counterparts ?? '') : '',
        },
      },
    ],
  };
}

export function StatsChart({ data, byGroups }: { data: DailyMessageStatsRsp; byGroups: boolean }) {
  const viewport = useRef<HTMLDivElement>(null);
  const host = useRef<HTMLDivElement>(null);
  const scrolled = useRef(false);
  const theme = useTheme();
  const { notify } = usePowerSnackbar();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    let instance: ECharts | null = null;
    let observer: ResizeObserver | null = null;
    setError(null);
    import('echarts')
      .then((echarts) => {
        if (!active || !host.current || !viewport.current) return;
        const element = host.current;
        const resize = () => {
          if (!viewport.current) return;
          const available = viewport.current.clientWidth;
          const mobile = window.innerWidth < 768;
          const minWidth =
            64 +
            (data.days.length > 1
              ? data.days.length * (data.series.length + 2) * 22
              : data.series.length * (mobile ? 62 : 114));
          const width = Math.max(available, minWidth);
          element.style.width = `${width}px`;
          if (!instance) instance = echarts.init(element, undefined, { renderer: 'svg' });
          else instance.resize({ width });
          const bar = getComputedStyle(element).getPropertyValue('--message-statistics-bar').trim();
          const { black, white } = theme.palette.common;
          const inside =
            getContrastRatio(bar, white) >= getContrastRatio(bar, black) ? white : black;
          instance.setOption(
            chartOption(data, chartColumns(data, width, mobile), byGroups, mobile, {
              text: theme.palette.text.secondary,
              divider: theme.palette.divider,
              bar,
              inside,
              font: theme.typography.fontFamily,
            }),
            true,
          );
        };
        resize();
        if (!scrolled.current) {
          viewport.current.scrollLeft = viewport.current.scrollWidth;
          scrolled.current = true;
        }
        observer = new ResizeObserver(resize);
        observer.observe(viewport.current);
      })
      .catch((reason) => {
        if (!active) return;
        const message = reason instanceof Error ? reason.message : 'Не вдалося відобразити графік.';
        setError(message);
        notify({ severity: 'error', message });
      });
    return () => {
      active = false;
      observer?.disconnect();
      instance?.dispose();
    };
  }, [data, byGroups, theme, notify]);
  return (
    <>
      {error ? (
        <div className="message-statistics-chart-notices">
          <PowerAlert severity="error" dismissible={false}>
            {error}
          </PowerAlert>
        </div>
      ) : null}
      <p className="message-statistics-axis-title">Повідомлень</p>
      <div
        ref={viewport}
        className="message-statistics-chart-viewport"
        role="region"
        aria-label="Прокручування графіка"
        tabIndex={0}
      >
        <div
          ref={host}
          className="message-statistics-chart"
          role="img"
          aria-label="Денна статистика повідомлень"
        />
      </div>
    </>
  );
}
