import * as d3 from 'd3';
import { LitElement, html, PropertyValues, css } from 'lit';
import dayjs from 'dayjs';
import { customElement, property, state } from 'lit/decorators.js';

type FreqActivityData = { [freq: string]: { [day: string]: number } };

@customElement('freq-activity-chart')
export class FreqActivityChart extends LitElement {
  @property({ type: Object })
  data?: FreqActivityData;

  @property({ type: Number })
  lastDay?: number;

  static styles = css`
    .micro-chart {
      width: 150px;
      height: 60px;
      cursor: pointer;
      position: relative;
      display: flex;
      align-items: center;
      justify-content: center;
    }

    .chart-container {
      width: 100%;
      height: 100%;
    }

    .chart-line {
      fill: none;
      stroke: #3b82f6;
      stroke-width: 2;
      transition: stroke-width 0.2s ease;
    }

    .chart-area {
      fill: url(#areaGradient);
      opacity: 0.2;
    }

    .micro-chart:hover .chart-line {
      stroke-width: 3;
    }

    .micro-chart:hover .chart-area {
      opacity: 0.3;
    }
  `;

  render() {
    return html`
      <div class="micro-chart">
        <div class="chart-container">
          <svg width="100%" height="100%"></svg>
        </div>
      </div>
    `;
  }

  updated(changedProperties: PropertyValues) {
    if (changedProperties.has('data') || changedProperties.has('lastDay')) {
      this.renderMicroChart();
    }
  }

  private renderMicroChart() {
    if (!this.data || !this.lastDay) return;

    const container = this.shadowRoot?.querySelector('.chart-container');
    if (!container) return;

    // Очищаємо попередній графік
    d3.select(container).selectAll('svg').remove();

    // Створюємо SVG
    const svg = d3
      .select(container)
      .append('svg')
      .attr('width', '100%')
      .attr('height', '100%')
      .style('display', 'block');

    // Отримуємо дані для першої частоти
    const freqKey = Object.keys(this.data)[0];
    if (!freqKey) return;

    const freqData = this.data[freqKey];
    if (!freqData) return;

    // Конвертуємо дані в масив і сортуємо по даті
    const data = Object.entries(freqData)
      .map(([day, count]) => ({
        day: day,
        count: count,
      }))
      .sort((a, b) => a.day.localeCompare(b.day));

    if (data.length === 0) return;

    // Розміри (без відступів для мікро чарта)
    const width = container.clientWidth;
    const height = container.clientHeight;

    // Створюємо групу для графіка
    const g = svg.append('g');

    // Шкали (без відступів)
    const xScale = d3
      .scaleLinear()
      .domain([0, data.length - 1])
      .range([0, width]);

    const yScale = d3
      .scaleLinear()
      .domain([0, d3.max(data, (d) => d.count) || 0])
      .range([height, 0])
      .nice();

    // Створюємо градієнт для заливки
    const defs = svg.append('defs');
    const gradient = defs
      .append('linearGradient')
      .attr('id', 'areaGradient')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');

    gradient
      .append('stop')
      .attr('offset', '0%')
      .attr('stop-color', '#3b82f6')
      .attr('stop-opacity', 0.6);

    gradient
      .append('stop')
      .attr('offset', '100%')
      .attr('stop-color', '#3b82f6')
      .attr('stop-opacity', 0.1);

    // Створюємо лінію
    const line = d3
      .line<{ day: string; count: number }>()
      .x((d, i) => xScale(i))
      .y((d) => yScale(d.count))
      .curve(d3.curveMonotoneX);

    // Створюємо область під лінією
    const area = d3
      .area<{ day: string; count: number }>()
      .x((d, i) => xScale(i))
      .y0(height)
      .y1((d) => yScale(d.count))
      .curve(d3.curveMonotoneX);

    // Малюємо область
    g.append('path').datum(data).attr('class', 'chart-area').attr('d', area);

    // Малюємо лінію
    g.append('path').datum(data).attr('class', 'chart-line').attr('d', line);
  }
}
