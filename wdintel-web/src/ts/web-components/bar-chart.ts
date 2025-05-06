import * as d3 from "d3"
import { LitElement, html, PropertyValues, css } from 'lit';
import dayjs from "dayjs";
import { customElement, property, state } from 'lit/decorators.js';

type Data = { [key: string]: { [key: string]: number } }

type TransformedData = { date: string; group: string; count: number, groupName?: string }[]

const BARS_COLORSCHEME = ["#FFD454", "#FF9A3B", "#49A4FF", "#87D6F6", "#F087E9", "#AF54FF", "#FF5E63", "#E90008", "#82CE4B", "#499810"]

@customElement("bar-chart")
class BarChart extends LitElement {
	@property() data: Data;
	@property() lastDay: string;

	xAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
	yAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;

	chartWidth = 0;
	chartHeight = 0;

	colorMap = {}

	margins = {
		right: 10,
		top: 10,
		bottom: 25,
		left: 30,
	}

	static styles = [
		css`
		  :host { display: block;
		    height: 100%;
		    width: 100%;
		    max-height: 100%;
		    max-width: 100%;
		  }`
	];

	connectedCallback() {
		super.connectedCallback();
		const parentRect = this.parentElement?.getBoundingClientRect();
		if (parentRect) {
			this.chartWidth = parentRect.width;
			this.chartHeight = parentRect.height;
		}
	}

	updated(changedProperties: PropertyValues<this>) {
		if (changedProperties.has('data') || changedProperties.has('lastDay')) {
			const lastDay = dayjs(this.lastDay)
			const transformedData = this.transformData(this.data, lastDay.isValid() ? lastDay.toDate() : new Date());
			this.renderChart(transformedData)
		}
	}

	transformData(data: Data, lastDay: Date): TransformedData {
		const dayInMs = 24 * 60 * 60 * 1000;
		let days = Object.keys(data).map(dateInSecs => new Date(parseInt(dateInSecs)));

		const daysToDisplay = [lastDay];
		for (let i = 1; i < 10; i++) {
			const previousDay = new Date(lastDay.getTime() - i * dayInMs);
			daysToDisplay.push(previousDay);
		}
		daysToDisplay.reverse();
		const transformedData: TransformedData = [];

		daysToDisplay.forEach(day => {
			const dayData = days.find(d => d.getDate() === day.getDate() && d.getMonth() === day.getMonth());
			const groups = dayData ? data[dayData.getTime()] : null;

			if (!groups) {
				transformedData.push({
					date: day.toISOString().split('T')[0], // Format date as YYYY-MM-DD
					group: '', // No group for days without messages
					count: 0,
				});
			} else {
				Object.entries(groups).forEach(([groupName, count]) => {
					transformedData.push({
						date: day.toISOString().split('T')[0], // Format date as YYYY-MM-DD
						group: groupName,
						count,
					});
				});

			}
		})


		return transformedData;
	}

	render() {
		return html`
			<svg id="chart"  width="${this.chartWidth}" height="${this.chartHeight}" viewBox="0 0 ${this.chartWidth} ${this.chartHeight}"></svg>
		    `
	}

	renderChart(data: TransformedData) {
		const index = d3.index(data, d => d.date, d => d.group)
		const stack = d3.stack<typeof index>()
			.keys(d3.union(data.map(d => d.group)))
			.value((a, key) => {
				const groupData = a[1].get(key)
				return groupData ? groupData.count : 0
			})
			(index as any)


		const svgEl = this.renderRoot.querySelector("#chart");
		const svg = d3.select(svgEl)

		const xScale = d3.scaleBand<string>()
			.domain(data.map(d => d.date)).rangeRound([this.margins.left, this.chartWidth - this.margins.right]).padding(0.1);
		const yScale = d3.scaleLinear().domain([0, d3.max(stack, d => d3.max(d, d => d[1])) || 0]).rangeRound([this.chartHeight - this.margins.bottom, this.margins.top]);

		const groups = svg
			.selectAll(".data-group")
			.data(stack)
			.join("g")
			.attr("class", "data-group")
			.attr("fill", d => this.getColorForGroup(d.key))

		groups.selectAll("rect")
			.data(D => D.map(d => {
				type DataWithKey = typeof d & { key: string }
				const dataWithKey = d as DataWithKey;
				dataWithKey.key = D.key;
				return dataWithKey
			}))

			.join('rect')
			.attr("x", d => xScale(d.data[0]) ?? 0)
			.attr("y", d => yScale(d[1]))
			.attr("height", d => yScale(d[0]) - yScale(d[1]))
			.attr("width", xScale.bandwidth())
			.append("title")
			.text(d => {
				const groupName = d.data[1].get(d.key)?.groupName ?? d.key
				return `${groupName}: ${d.data[1].get(d.key)?.count} `
			});


		if (!this.xAxisGroup) {
			this.xAxisGroup = svg.append('g');
		}
		this.xAxisGroup
			.attr('transform', `translate(0, ${this.chartHeight - this.margins.bottom})`)
			.call(d3.axisBottom(xScale).tickFormat(d => dayjs(d).format("DD")));

		if (!this.yAxisGroup) {
			this.yAxisGroup = svg.append('g')
		}

		this.yAxisGroup.attr("transform", `translate(${this.margins.left}, 0)`).call(d3.axisLeft(yScale).ticks(4).tickFormat(d3.format("d")));

	}

	getColorForGroup(group: string) {
		if (!this.colorMap[group]) {
			const availableColors = BARS_COLORSCHEME.filter(color => !Object.values(this.colorMap).includes(color));
			if (availableColors.length > 0) {
				this.colorMap[group] = availableColors[0]
			} else {
				this.colorMap[group] = "#000000";
			}
		}
		return this.colorMap[group];
	}

}

