import * as d3 from 'd3';
import dayjs from 'dayjs';
import { LitElement, html, PropertyValues, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';

export type Data = {
  data_per_date: DataPerDate;
};

export type Data2 = {
  stats_per_minute: StatsPerPeriod;
};

type DataCamel = {
  dataPerDate?: DataPerDate | null;
};

type Data2Camel = {
  statsPerMinute?: StatsPerPeriod | null;
};

type StatsPerPeriod = { timestamp: string; stats: Stats }[];
type Stats = { [key: string]: { count: number; group_name: string } };

type CountByGroupName = {
  [key: string]: number; // Group names with their respective counts
};

type DataPerDateEntry =
  | {
      count_by_group_name?: CountByGroupName | null;
      countByGroupName?: CountByGroupName | null;
    }
  | null
  | undefined;

type DataPerDate = {
  [key: string]: DataPerDateEntry;
};

type TransformedData = { date: string; group: string; count: number; groupName?: string }[];

type YAxisConfig = {
  domainMax: number;
  tickValues?: number[];
  tickFormat?: (value: d3.NumberValue) => string;
};

function getDataPerDate(data: Data | DataCamel | null | undefined): DataPerDate {
  if (!data) return {};
  return (data as Data).data_per_date ?? (data as DataCamel).dataPerDate ?? {};
}

function getStatsPerMinute(data: Data2 | Data2Camel | null | undefined): StatsPerPeriod {
  if (!data) return [];
  return (data as Data2).stats_per_minute ?? (data as Data2Camel).statsPerMinute ?? [];
}

function normalizeDataPerDateEntry(entry: DataPerDateEntry): {
  count_by_group_name: CountByGroupName;
} {
  return {
    count_by_group_name: entry?.count_by_group_name ?? entry?.countByGroupName ?? {},
  };
}

function a(data: Data | DataCamel | null | undefined): DataPerDate {
  const dataPerDate = getDataPerDate(data);
  const sortedDates = Object.keys(dataPerDate)
    .map((dateString) => dayjs(dateString))
    .filter((date) => date.isValid())
    .sort((a, b) => a.valueOf() - b.valueOf());
  const [minDate, maxDate] = d3.extent(sortedDates);
  if (minDate && maxDate) {
    const differenceInDays = maxDate.diff(minDate, 'day');
    if (differenceInDays < 28) {
      const allDays = fillMissingDates(sortedDates);
      const obj = {};
      allDays.map((date) => {
        const d = dataPerDate[date.format('YYYY-MM-DD')];
        obj[date.format('YYYY-MM-DD')] = normalizeDataPerDateEntry(d);
      });

      return obj;
    } else if (differenceInDays < 120) {
      const allDays = fillMissingDates(sortedDates);

      const obj = {};
      const groupedData: { [key: string]: { count_by_group_name: { [key: string]: number } } } = {};

      allDays.map((date) => {
        const d = dataPerDate[date.format('YYYY-MM-DD')];
        const periodKey = Math.floor((date.date() - 1) / 3);
        const monthYearKey = date.format('YYYY-MM');
        const startDateKey = dayjs(
          `${monthYearKey}-${(periodKey * 3 + 1).toString().padStart(2, '0')}`,
        ); // Start date of the period

        if (!groupedData[startDateKey.format('YYYY-MM-DD')]) {
          groupedData[startDateKey.format('YYYY-MM-DD')] = { count_by_group_name: {} };
        }

        if (d) {
          Object.entries(normalizeDataPerDateEntry(d).count_by_group_name).forEach(
            ([groupName, count]) => {
              if (!groupedData[startDateKey.format('YYYY-MM-DD')].count_by_group_name[groupName]) {
                groupedData[startDateKey.format('YYYY-MM-DD')].count_by_group_name[groupName] = 0;
              }
              groupedData[startDateKey.format('YYYY-MM-DD')].count_by_group_name[groupName] +=
                count;
            },
          );
        }
      });
      Object.keys(groupedData).forEach((key) => {
        const startDate = dayjs(key);
        obj[startDate.format('YYYY-MM-DD')] = groupedData[key];
      });

      return obj;
    } else {
      const allDays = fillMissingDates(sortedDates);
      const obj: { [key: string]: any } = {};
      const weeklyGroupedData: {
        [key: string]: { count_by_group_name: { [key: string]: number } };
      } = {};

      allDays.forEach((date) => {
        const d = dataPerDate[date.format('YYYY-MM-DD')];
        const weekStartDate = date.startOf('week'); // Get the start of the week (Monday)

        if (!weeklyGroupedData[weekStartDate.format('YYYY-MM-DD')]) {
          weeklyGroupedData[weekStartDate.format('YYYY-MM-DD')] = { count_by_group_name: {} };
        }

        if (d) {
          Object.entries(normalizeDataPerDateEntry(d).count_by_group_name).forEach(
            ([groupName, count]) => {
              if (
                !weeklyGroupedData[weekStartDate.format('YYYY-MM-DD')].count_by_group_name[
                  groupName
                ]
              ) {
                weeklyGroupedData[weekStartDate.format('YYYY-MM-DD')].count_by_group_name[
                  groupName
                ] = 0;
              }
              weeklyGroupedData[weekStartDate.format('YYYY-MM-DD')].count_by_group_name[
                groupName
              ] += count;
            },
          );
        }
      });

      Object.keys(weeklyGroupedData).forEach((key) => {
        obj[key] = weeklyGroupedData[key];
      });

      return obj;
    }
  }
  return {};
}
export function transformData(data: Data | DataCamel | null | undefined): {
  transformedData: TransformedData;
  uniqueDates: string[];
} {
  const dataPerDate = a(data);
  const uniqueDates = Object.keys(dataPerDate);
  const transformedData: TransformedData = [];
  for (const date in dataPerDate) {
    const counts = normalizeDataPerDateEntry(dataPerDate[date]).count_by_group_name;
    for (const group in counts) {
      transformedData.push({
        date: date,
        group: group,
        count: counts[group],
      });
    }
  }
  return { transformedData, uniqueDates };
}

function mergeStats(stats1: Stats, stats2: Stats): Stats {
  const mergedStats: Stats = {};

  for (const key in stats1) {
    if (stats1.hasOwnProperty(key)) {
      mergedStats[key] = { ...stats1[key] };
    }
  }

  for (const key in stats2) {
    if (stats2.hasOwnProperty(key)) {
      if (mergedStats[key]) {
        mergedStats[key].count += stats2[key].count;
      } else {
        mergedStats[key] = { ...stats2[key] };
      }
    }
  }

  return mergedStats;
}

function transformData2(data: Data2 | Data2Camel | null | undefined): {
  transformedData: TransformedData;
  uniqueDates: string[];
} {
  const transformedData: TransformedData = [];
  const uniqueDates: string[] = [];

  const statsPerMinute = getStatsPerMinute(data);
  const a = statsPerMinute.reduce<StatsPerPeriod>((acc, current, index) => {
    if (index % 5 === 0) {
      acc.push(current);
    } else {
      const { stats } = current;
      const prevStats = acc[acc.length - 1];
      if (prevStats) {
        const newStats = mergeStats(prevStats.stats, stats);
        acc.splice(acc.length - 1, 1, { timestamp: prevStats.timestamp, stats: newStats });
      }
    }
    return acc;
  }, []);

  for (const entry of a) {
    const { timestamp, stats } = entry;
    uniqueDates.push(timestamp);

    for (const [key, value] of Object.entries(stats)) {
      transformedData.push({
        date: timestamp,
        group: key,
        count: value.count,
        groupName: value.group_name,
      });
    }
  }

  return { transformedData, uniqueDates };
}

function fillMissingDates(dates: dayjs.Dayjs[]) {
  return dates.reduce<dayjs.Dayjs[]>((acc, currentItem) => {
    const lastValue = acc.at(-1);
    if (!lastValue) {
      acc.push(currentItem);
      return acc;
    }
    const dayDifference = Math.abs(lastValue.diff(currentItem, 'day'));
    if (dayDifference === 1) {
      acc.push(currentItem);
    } else if (dayDifference > 1) {
      let tempDate = lastValue.clone();

      while (tempDate.add(1, 'day').isBefore(currentItem)) {
        tempDate = tempDate.add(1, 'day');
        acc.push(tempDate);
      }
      acc.push(currentItem);
    }
    return acc;
  }, []);
}

export function createYAxisConfig(maxStackedValue: number | undefined): YAxisConfig {
  if (!maxStackedValue || maxStackedValue <= 0) {
    return {
      domainMax: 1,
      tickValues: [0],
      tickFormat: () => '0',
    };
  }

  return {
    domainMax: maxStackedValue,
  };
}

const BARS_COLORSCHEME = [
  '#FFD454',
  '#FF9A3B',
  '#49A4FF',
  '#87D6F6',
  '#F087E9',
  '#AF54FF',
  '#FF5E63',
  '#E90008',
  '#82CE4B',
  '#499810',
];
const BARS_ADDITIONAL_COLORS = [
  '#FFC107', // Amber (new)
  '#FF5722', // Deep Orange (new)
  '#2196F3', // Blue (new)
  '#673AB7', // Deep Purple (new)
  '#4CAF50', // Green (new)
  '#FF9800', // Orange (new)
  '#3F51B5', // Indigo (new)
  '#009688', // Teal (new)
  '#795548', // Brown (new)
  '#607D8B', // Blue Grey (new)
];
const BARS_EXTRA_COLORS = [
  '#8BC34A', // Light Green
  '#CDDC39', // Lime
  '#00BCD4', // Cyan
  '#9C27B0', // Purple
  '#E91E63', // Pink
  '#A0522D', // Sienna
  '#7B1FA2', // Dark Purple
  '#00695C', // Dark Teal
  '#C0CA33', // Yellow Green
  '#F06292', // Light Pink
  '#5D4037', // Dark Brown
  '#26A69A', // Jade
  '#EF6C00', // Deep Orange Dark
  '#64B5F6', // Light Blue
  '#1976D2', // Strong Blue
  '#C2185B', // Raspberry
  '#FFA726', // Light Orange
  '#43A047', // Deep Green
  '#546E7A', // Slate
  '#1E88E5', // Vivid Blue
];
const BARS_COLOR_PALETTE = [...BARS_COLORSCHEME, ...BARS_ADDITIONAL_COLORS, ...BARS_EXTRA_COLORS];

@customElement('dashboard-chart')
export class DashboardChart extends LitElement {
  @property()
  data: Data | Data2;
  transformedData: TransformedData = [];
  colorMap = {};
  nextColorIndex = 0;
  lastAssignedColor: string | null = null;
  pendingRenderFrame: number | null = null;
  resizeObserver: ResizeObserver | null = null;
  hasRenderedChart = false;

  @property()
  isAnalysis = false;

  @state()
  chartWidth = 0;

  @state()
  chartHeight = 0;

  @property({ type: Number, attribute: 'margin-right' })
  marginRight = 10;

  @property({ type: Number, attribute: 'margin-top' })
  marginTop = 10;

  @property({ type: Number, attribute: 'margin-bottom' })
  marginBottom = 25;

  @property({ type: Number, attribute: 'margin-left' })
  marginLeft = 30;
  xAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  yAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  tooltip: d3.Selection<HTMLDivElement, unknown, HTMLElement, any>;

  static styles = [
    css`
      :host {
        display: block;
        height: 100%;
        width: 100%;
        max-height: 100%;
        max-width: 100%;
      }
    `,
  ];

  connectedCallback(): void {
    super.connectedCallback();
    if (this.resizeObserver == null) {
      this.resizeObserver = new ResizeObserver(() => {
        if (this.data) {
          this.scheduleRenderChart();
        }
      });
    }
    this.resizeObserver.observe(this);
    this.chartWidth = Math.max(0, this.getBoundingClientRect().width);
    this.chartHeight = Math.max(0, this.getBoundingClientRect().height);
    const topLine =
      this.renderRoot.querySelector('#top-line')?.getBoundingClientRect().height ?? 30;
    const rect = this.getBoundingClientRect();
    this.chartWidth = Math.max(0, rect.width);
    this.chartHeight = Math.max(0, rect.height - topLine);
  }

  disconnectedCallback(): void {
    super.disconnectedCallback();
    if (this.pendingRenderFrame != null) {
      cancelAnimationFrame(this.pendingRenderFrame);
      this.pendingRenderFrame = null;
    }
    if (this.resizeObserver != null) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.tooltip) {
      this.tooltip.remove();
      this.tooltip = null as any;
    }
  }

  updated(changedProperties: PropertyValues<this>) {
    if (changedProperties.has('data')) {
      this.scheduleRenderChart();
    }
  }

  scheduleRenderChart() {
    if (this.pendingRenderFrame != null) {
      cancelAnimationFrame(this.pendingRenderFrame);
    }
    this.pendingRenderFrame = requestAnimationFrame(() => {
      this.pendingRenderFrame = null;
      this.renderChart();
    });
  }

  getColorForGroup(group: string) {
    if (!this.colorMap[group]) {
      this.colorMap[group] = this.pickNextColor();
    }
    return this.colorMap[group];
  }

  pickNextColor() {
    if (BARS_COLOR_PALETTE.length === 0) {
      return '#000000';
    }

    let candidate = BARS_COLOR_PALETTE[this.nextColorIndex % BARS_COLOR_PALETTE.length];
    // Avoid assigning the same color twice in a row when we loop through the palette
    if (candidate === this.lastAssignedColor) {
      for (let offset = 1; offset < BARS_COLOR_PALETTE.length; offset++) {
        const nextCandidate =
          BARS_COLOR_PALETTE[(this.nextColorIndex + offset) % BARS_COLOR_PALETTE.length];
        if (nextCandidate !== this.lastAssignedColor) {
          candidate = nextCandidate;
          this.nextColorIndex = (this.nextColorIndex + offset) % BARS_COLOR_PALETTE.length;
          break;
        }
      }
    }

    this.lastAssignedColor = candidate;
    this.nextColorIndex = (this.nextColorIndex + 1) % BARS_COLOR_PALETTE.length;
    return candidate;
  }

  render() {
    const safeChartWidth = Math.max(0, this.chartWidth);
    const safeChartHeight = Math.max(0, this.chartHeight);
    return html`
      <div>
        <section id="top-line" style="display:flex; justify-content: space-between">
          <div style="flex-grow: 1;"></div>
          <slot name="period"></slot>
        </section>
        <svg
          id="chart"
          width="${safeChartWidth}"
          height="${safeChartHeight}"
          viewBox="0 0 ${safeChartWidth} ${safeChartHeight}"
        ></svg>
      </div>
    `;
  }

  renderChart() {
    const topLine =
      this.renderRoot.querySelector('#top-line')?.getBoundingClientRect().height ?? 30;
    const rect = this.getBoundingClientRect();
    this.chartWidth = Math.max(0, rect.width);
    this.chartHeight = Math.max(0, rect.height - topLine);
    if (this.chartWidth <= 0 || this.chartHeight <= 0 || !this.data) {
      return;
    }

    let uniqueDates: string[] = [];
    let tickFormatFn: (x: string) => string = (x) => x;
    if ('stats_per_minute' in this.data || 'statsPerMinute' in this.data) {
      const result = transformData2(this.data as Data2 | Data2Camel);
      this.transformedData = result.transformedData;
      uniqueDates = result.uniqueDates;
    } else {
      const result = transformData(this.data as Data | DataCamel);
      this.transformedData = result.transformedData;
      uniqueDates = result.uniqueDates;
      tickFormatFn = (x: string) => dayjs(x).format('DD/MM');
    }

    const e = d3.index(
      this.transformedData,
      (d) => d.date,
      (d) => d.group,
    );
    const s = d3
      .stack<typeof e>()
      .keys(d3.union(this.transformedData.map((d) => d.group)))
      .value((a, key) => {
        const groupData = a[1].get(key);
        return groupData ? groupData.count : 0;
      })(e as any);

    const svgEl = this.renderRoot.querySelector('#chart');
    const svg = d3.select(svgEl);
    const shouldAnimate = !this.isAnalysis || !this.hasRenderedChart;
    // tooltip from https://observablehq.com/@anreut/bar-chart-with-a-tooltip
    if (!this.tooltip) {
      this.tooltip = d3
        .select('body')
        .append('div')
        .style('position', 'fixed')
        .style('z-index', '100')
        .style('visibility', 'hidden')
        .style('padding', '5px')
        .style('background', 'var(--card-color)')
        .style('border', '2px solid var(--border-color)')
        .style('color', 'var(--text-color)')
        .style('pointer-events', 'none');
    }
    const tooltip = this.tooltip;
    const { xScale, xAxis } = createBandScale(
      uniqueDates,
      [this.marginLeft, this.chartWidth - this.marginRight],
      tickFormatFn,
    );
    const maxStackedValue = d3.max(s, (d) => d3.max(d, (d) => d[1]));
    const yAxisConfig = createYAxisConfig(maxStackedValue);

    const y = d3
      .scaleLinear()
      .domain([0, yAxisConfig.domainMax])
      .rangeRound([this.chartHeight - this.marginBottom, this.marginTop]);
    const groups = svg
      .selectAll('.data-group')
      .data(s)
      .join('g')
      .attr('class', 'data-group')
      .attr('fill', (d) => this.getColorForGroup(d.key));

    const bandwidth = xScale.bandwidth();
    const barWidth = this.isAnalysis ? Math.min(100, bandwidth) : bandwidth;
    const rects = groups
      .selectAll('rect')
      .data((D) =>
        D.map((d) => {
          type DataWithKey = typeof d & { key: string };
          const dataWithKey = d as DataWithKey;
          dataWithKey.key = D.key;
          return dataWithKey;
        }),
      )
      .join(
        (enter) =>
          enter
            .append('rect')
            .attr('x', (d) => {
              return xScale(d.data[0]) ?? 0;
            })
            .attr('y', this.chartHeight - this.marginBottom)
            .attr('height', 0)
            .attr('width', (d) => barWidth),
        (update) => update,
        (exit) =>
          exit
            .transition()
            .attr('y', this.chartHeight - this.marginBottom)
            .attr('height', 0)
            .remove(),
      )
      .on('mouseover', function (e, d) {
        d3.select(this).attr('stroke', 'var(--text-color)');
        const groupName = d.data[1].get(d.key)?.groupName ?? d.key;
        tooltip
          .html(
            `<div>
						  <p>${d.data[0]}</p>
						  <p>${groupName}</p>
						  <p>${d.data[1].get(d.key)?.count}</p>
						</div>`,
          )
          .style('visibility', 'visible');
      })
      .on('mousemove', function (e) {
        tooltip.style('top', e.pageY - 40 + 'px').style('left', e.pageX + 10 + 'px');
      })
      .on('mouseout', function (e, a) {
        tooltip.html(``).style('visibility', 'hidden');
        d3.select(this).attr('stroke', 'none');
      });
    const positionedRects = rects
      .attr('x', (d) => {
        return (xScale(d.data[0]) ?? 0) + (bandwidth - barWidth) / 2;
      })
      .attr('width', barWidth);
    if (shouldAnimate) {
      positionedRects
        .transition()
        .attr('y', (d) => y(d[1]))
        .attr('height', (d) => y(d[0]) - y(d[1]));
    } else {
      positionedRects
        .interrupt()
        .attr('y', (d) => y(d[1]))
        .attr('height', (d) => y(d[0]) - y(d[1]));
    }

    if (!this.xAxisGroup) {
      this.xAxisGroup = svg.append('g');
    }
    const xAxisGroup = this.xAxisGroup.attr(
      'transform',
      `translate(0,${this.chartHeight - this.marginBottom})`,
    );
    if (shouldAnimate) {
      xAxisGroup.transition().call(xAxis);
    } else {
      xAxisGroup.interrupt().call(xAxis);
    }

    if (!this.yAxisGroup) {
      this.yAxisGroup = svg.append('g');
    }
    const yAxis = d3.axisLeft(y).ticks(null, 's');
    if (yAxisConfig.tickValues) {
      yAxis.tickValues(yAxisConfig.tickValues);
    }
    if (yAxisConfig.tickFormat) {
      yAxis.tickFormat(yAxisConfig.tickFormat);
    }
    const yAxisGroup = this.yAxisGroup.attr('transform', `translate(${this.marginLeft},0)`);
    if (shouldAnimate) {
      yAxisGroup.transition().call(yAxis);
    } else {
      yAxisGroup.interrupt().call(yAxis);
    }
    this.hasRenderedChart = true;
  }
}

function createBandScale(
  domain: string[],
  rangeValue: [number, number],
  tickFormatFn: (x: string) => string,
) {
  const xScale = d3.scaleBand().domain(domain).range(rangeValue).padding(0.1);

  const xAxis = d3
    .axisBottom(xScale)
    .tickSizeOuter(0)
    .tickFormat((d, i) => {
      if (domain.length > 12) {
        return i % _gapBetweenTicks(domain.length) !== 0 ? '' : tickFormatFn(d);
      }
      return tickFormatFn(d);
    });

  return { xScale, xAxis };
}

function _gapBetweenTicks(totalTicks: number) {
  return Math.max(1, Math.ceil(totalTicks / 8));
}
