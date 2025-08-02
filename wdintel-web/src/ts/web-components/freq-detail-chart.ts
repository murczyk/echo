import * as d3 from "d3"
import { LitElement, html, PropertyValues, css } from 'lit';
import dayjs from "dayjs";
import { customElement, property } from 'lit/decorators.js';

type FreqActivityData = { [freq: string]: { [day: string]: number } }

@customElement("freq-detail-chart")
class FreqDetailChart extends LitElement {
  @property({ type: Object })
  data?: FreqActivityData;

  @property({ type: Number })
  lastDay?: number;

  static styles = css`
    .chart-container {
      width: 100%;
      height: 100%;
      position: relative;
    }
    
    .chart-line {
      fill: none;
      stroke: #3b82f6;
      stroke-width: 2;
    }
    
    .chart-area {
      fill: url(#areaGradient);
      opacity: 0.2;
    }
    
    .axis line {
      stroke: #e5e7eb;
    }
    
    .axis path {
      stroke: #e5e7eb;
    }
    
    .axis text {
      fill: #6b7280;
      font-size: 12px;
    }
    
    .grid line {
      stroke: #f3f4f6;
      stroke-opacity: 0.7;
    }
    
    .grid path {
      stroke-width: 0;
    }
  `;

  render() {
    return html`
      <div class="chart-container">
        <svg width="100%" height="100%"></svg>
      </div>
    `;
  }

  updated(changedProperties: PropertyValues) {
    if (changedProperties.has('data') || changedProperties.has('lastDay')) {
      this.renderChart();
    }
  }

  private parseDate(dateString: string): Date | null {
    // Перевіряємо чи це числовий рядок (timestamp)
    const trimmed = dateString.trim();
    if (/^\d+$/.test(trimmed)) {
      const timestamp = parseInt(trimmed);
      if (!isNaN(timestamp)) {
        // Перевіряємо чи це timestamp в мілісекундах або секундах
        let date: Date;
        if (timestamp > 1e12) {
          // Timestamp в мілісекундах
          date = new Date(timestamp);
        } else {
          // Timestamp в секундах
          date = new Date(timestamp * 1000);
        }
        if (!isNaN(date.getTime())) {
          return date;
        }
      }
    }
    
    // Спробувати стандартний парсинг дати
    let date = new Date(dateString);
    if (!isNaN(date.getTime())) {
      return date;
    }
    
    // Спробувати dayjs для більш надійного парсингу
    date = dayjs(dateString).toDate();
    if (!isNaN(date.getTime())) {
      return date;
    }
    
    return null;
  }

  private renderChart() {
    if (!this.data || !this.lastDay) return;

    const container = this.shadowRoot?.querySelector('.chart-container');
    if (!container) return;

    // Очищаємо попередній графік
    d3.select(container).selectAll('svg').remove();

    // Створюємо SVG
    const svg = d3.select(container)
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
    const rawData = Object.entries(freqData)
      .map(([day, count]) => ({
        day: day,
        count: count
      }));


    
    // Валідація та фільтрація дат
    const validData = rawData
      .map(d => ({
        ...d,
        parsedDate: this.parseDate(d.day)
      }))
      .filter(d => d.parsedDate !== null)
      .map(d => ({
        day: d.day,
        count: d.count,
        date: d.parsedDate!
      }))
      .sort((a, b) => a.date.getTime() - b.date.getTime());



    if (validData.length === 0) {
      // Показуємо повідомлення про відсутність валідних дат
      svg.append('text')
        .attr('x', '50%')
        .attr('y', '50%')
        .attr('text-anchor', 'middle')
        .attr('dominant-baseline', 'middle')
        .style('fill', '#6b7280')
        .style('font-size', '14px')
        .text('Немає валідних даних для відображення');
      return;
    }

    // Розміри з відступами для осей
    const margin = { top: 20, right: 30, bottom: 40, left: 50 };
    const width = container.clientWidth - margin.left - margin.right;
    const height = container.clientHeight - margin.top - margin.bottom;

    // Створюємо групу для графіка з відступами
    const g = svg.append('g')
      .attr('transform', `translate(${margin.left},${margin.top})`);

    // Створюємо градієнт для заливки
    const defs = svg.append('defs');
    const gradient = defs.append('linearGradient')
      .attr('id', 'areaGradient')
      .attr('gradientUnits', 'userSpaceOnUse')
      .attr('x1', '0%')
      .attr('y1', '0%')
      .attr('x2', '0%')
      .attr('y2', '100%');

    gradient.append('stop')
      .attr('offset', '0%')
      .attr('stop-color', '#3b82f6')
      .attr('stop-opacity', 0.6);

    gradient.append('stop')
      .attr('offset', '100%')
      .attr('stop-color', '#3b82f6')
      .attr('stop-opacity', 0.1);

    // Безпечне створення шкал з валідованими даними
    const dateExtent = d3.extent(validData, d => d.date) as [Date, Date];
    const xScale = d3.scaleTime()
      .domain(dateExtent)
      .range([0, width]);

    const yScale = d3.scaleLinear()
      .domain([0, d3.max(validData, d => d.count) || 0])
      .range([height, 0])
      .nice();

    // Створюємо сітку
    g.append('g')
      .attr('class', 'grid')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale)
        .tickSize(-height)
        .tickFormat(null)
      );

    g.append('g')
      .attr('class', 'grid')
      .call(d3.axisLeft(yScale)
        .tickSize(-width)
        .tickFormat(null)
      );

    // Створюємо лінію з валідованими даними
    const line = d3.line<{day: string, count: number, date: Date}>()
      .x(d => xScale(d.date))
      .y(d => yScale(d.count))
      .curve(d3.curveMonotoneX);

    // Створюємо область під лінією
    const area = d3.area<{day: string, count: number, date: Date}>()
      .x(d => xScale(d.date))
      .y0(height)
      .y1(d => yScale(d.count))
      .curve(d3.curveMonotoneX);

    // Малюємо область
    g.append('path')
      .datum(validData)
      .attr('class', 'chart-area')
      .attr('d', area);

    // Малюємо лінію
    g.append('path')
      .datum(validData)
      .attr('class', 'chart-line')
      .attr('d', line);

    // Малюємо точки з tooltip
    const points = g.selectAll('.point')
      .data(validData)
      .enter()
      .append('circle')
      .attr('class', 'point')
      .attr('cx', d => xScale(d.date))
      .attr('cy', d => yScale(d.count))
      .attr('r', 3)
      .attr('fill', '#3b82f6')
      .style('cursor', 'pointer');

    // Додаємо tooltip до кожної точки
    points.append('title')
      .text(d => {
        const dateStr = d.date.toLocaleDateString('uk-UA', { 
          day: '2-digit', 
          month: '2-digit', 
          year: 'numeric' 
        });
        return `Дата: ${dateStr}\nКількість: ${d.count}`;
      });

    // Розраховуємо оптимальний інтервал між мітками
    const totalDays = (dateExtent[1].getTime() - dateExtent[0].getTime()) / (1000 * 60 * 60 * 24);
    
    // Вручну створюємо мітки щоб уникнути дублікатів
    const maxTicks = 6;
    const tickStep = Math.max(1, Math.ceil(totalDays / maxTicks));
    const customTicks: Date[] = [];
    
    // Створюємо мітки кожні tickStep днів починаючи з першої дати
    const startDate = new Date(dateExtent[0]);
    startDate.setHours(0, 0, 0, 0); // Обнуляємо час
    
    // Додаємо першу дату
    customTicks.push(new Date(startDate));
    
    // Додаємо проміжні дати
    for (let i = 1; i < maxTicks; i++) {
      const tickDate = new Date(startDate);
      tickDate.setDate(startDate.getDate() + (i * tickStep));
      
      if (tickDate < dateExtent[1]) {
        customTicks.push(tickDate);
      } else {
        break; // Зупиняємось якщо перевищили кінцеву дату
      }
    }
    
    // Завжди додаємо останню дату якщо вона не дуже близько до попередньої
    const lastTick = customTicks[customTicks.length - 1];
    const daysDifference = (dateExtent[1].getTime() - lastTick.getTime()) / (1000 * 60 * 60 * 24);
    if (daysDifference >= 1) { // Тільки якщо різниця більше дня
      customTicks.push(new Date(dateExtent[1]));
    }



    // Додаємо осі з фіксованими мітками
    g.append('g')
      .attr('class', 'axis')
      .attr('transform', `translate(0,${height})`)
      .call(d3.axisBottom(xScale)
        .tickValues(customTicks)
        .tickFormat(d => {
          if (d instanceof Date && !isNaN(d.getTime())) {
            const day = d.getDate().toString().padStart(2, '0');
            const month = (d.getMonth() + 1).toString().padStart(2, '0');
            return `${day}/${month}`;
          }
          return '';
        })
      );

    g.append('g')
      .attr('class', 'axis')
      .call(d3.axisLeft(yScale));

    // Додаємо підписи осей
    g.append('text')
      .attr('class', 'axis-label')
      .attr('text-anchor', 'middle')
      .attr('x', width / 2)
      .attr('y', height + margin.bottom - 5)
      .style('fill', '#6b7280')
      .style('font-size', '12px')
      .text('Дата');

    g.append('text')
      .attr('class', 'axis-label')
      .attr('text-anchor', 'middle')
      .attr('transform', 'rotate(-90)')
      .attr('x', -height / 2)
      .attr('y', -margin.left + 15)
      .style('fill', '#6b7280')
      .style('font-size', '12px')
      .text('Кількість повідомлень');
  }
} 