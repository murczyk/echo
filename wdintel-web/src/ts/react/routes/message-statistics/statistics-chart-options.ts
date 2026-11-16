import type { EChartsOption } from 'echarts';
import type { DailyMessageStatsRsp } from '../../../../Bindings';
import { today } from './state';

type Column = {
  day: string;
  label: string;
  key: string | null;
  messages: number;
  counterparts: number;
} | null;

export const STATS_CHART_GRID = { left: 0, right: 16, top: 24, bottom: 114 };
const STATS_CHART_MIN_COUNTERPART_HEIGHT = 22;

export function chartScale(data: DailyMessageStatsRsp) {
  let peak = 0;
  for (const series of data.series)
    for (const point of series.points) peak = Math.max(peak, point.messages);
  const step = Math.max(1, (peak * 1.2) / 4);
  const magnitude = 10 ** Math.floor(Math.log10(step));
  const interval = Math.ceil(step / magnitude) * magnitude;
  return { peak, interval, max: interval * 4 };
}

export function chartColumnWidth(data: DailyMessageStatsRsp, mobile: boolean) {
  return Math.max(
    data.days.length > 1 ? 22 : mobile ? 62 : 114,
    String(chartScale(data).peak).length * 8 + 6,
  );
}

export function chartColumns(data: DailyMessageStatsRsp, width: number, mobile: boolean): Column[] {
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
  const count = Math.max(
    data.series.length,
    Math.floor((width - STATS_CHART_GRID.right) / chartColumnWidth(data, mobile)),
  );
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

export function chartOption(
  data: DailyMessageStatsRsp,
  columns: Column[],
  byGroups: boolean,
  mobile: boolean,
  plotHeight: number,
  colors: {
    text: string;
    divider: string;
    bar: string;
    inside: string;
    background: string;
    tooltip: string;
    font?: string;
  },
): EChartsOption {
  const multipleDays = data.days.length > 1;
  const scale = chartScale(data);
  const isShort = (index: number) =>
    ((columns[index]?.messages ?? 0) * plotHeight) / scale.max < STATS_CHART_MIN_COUNTERPART_HEIGHT;
  return {
    animation: false,
    textStyle: { fontFamily: colors.font, fontSize: 12 },
    grid: STATS_CHART_GRID,
    tooltip: {
      trigger: 'item',
      confine: true,
      renderMode: 'richText',
      backgroundColor: colors.background,
      borderColor: colors.divider,
      textStyle: { color: colors.tooltip },
      formatter: (entry: unknown) => {
        const point = columns[(entry as { dataIndex: number }).dataIndex];
        if (!point) return '';
        const date = `${point.day.slice(8, 10)}.${point.day.slice(5, 7)}.${point.day.slice(0, 4)}`;
        return `${point.label}\n${date}${point.day === today() ? ' · неповний день' : ''}\nПовідомлень: ${point.messages}\n${byGroups ? 'Відправників' : 'Груп'}: ${point.counterparts}`;
      },
    },
    xAxis: [
      {
        id: 'series-labels',
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
              id: 'days',
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
      id: 'message-count',
      type: 'value',
      min: 0,
      minInterval: 1,
      splitNumber: 4,
      interval: scale.interval,
      max: scale.max,
      axisLabel: { show: false },
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
          formatter: (entry) => {
            if (Number(entry.value) <= 0) return '';
            const counterparts = columns[entry.dataIndex]?.counterparts ?? 0;
            return isShort(entry.dataIndex)
              ? `${entry.value}\n{counterparts|${counterparts}}`
              : String(entry.value);
          },
          rich: {
            counterparts: {
              color: colors.inside,
              backgroundColor: colors.bar,
              borderRadius: 2,
              padding: [1, 2],
              fontSize: 14,
              lineHeight: 18,
            },
          },
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
            Number(entry.value) > 0 && !isShort(entry.dataIndex)
              ? String(columns[entry.dataIndex]?.counterparts ?? '')
              : '',
        },
      },
    ],
  };
}
