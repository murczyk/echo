import * as d3 from 'd3';
import dayjs from 'dayjs'
import { LitElement, html, PropertyValues, css } from 'lit';
import { customElement, property, state } from 'lit/decorators.js';


export type Data = {
	data_per_date: DataPerDate
}

export type Data2 = {
	stats_per_minute: StatsPerPeriod
}

type StatsPerPeriod = { timestamp: string, stats: Stats }[]
type Stats = { [key: string]: { count: number, group_name: string } }

type CountByGroupName = {
	[key: string]: number; // Group names with their respective counts
};

type DataPerDate = {
	[key: string]: {
		count_by_group_name: CountByGroupName; // The structure of the returned data
	};
};

type TransformedData = { date: string; group: string; count: number, groupName?: string }[]

function a(data: Data): DataPerDate {

	const dataPerDate = data.data_per_date;
	const sortedDates = Object.keys(dataPerDate)
		.map(dateString => dayjs(dateString))
		.filter(date => date.isValid())
		.sort((a, b) => a.valueOf() - b.valueOf())
	const [minDate, maxDate] = d3.extent(sortedDates)
	if (minDate && maxDate) {

		const differenceInDays = maxDate.diff(minDate, 'day')
		if (differenceInDays < 28) {
			const allDays = fillMissingDates(sortedDates)
			const obj = {}
			allDays.map(date => {
				const d = dataPerDate[date.format("YYYY-MM-DD")]
				obj[date.format("YYYY-MM-DD")] = d ? d : {}
			})

			return obj
		} else if (differenceInDays < 120) {
			const allDays = fillMissingDates(sortedDates)

			const obj = {}
			const groupedData: { [key: string]: { count_by_group_name: { [key: string]: number } } } = {};

			allDays.map(date => {
				const d = dataPerDate[date.format("YYYY-MM-DD")]
				const periodKey = Math.floor((date.date() - 1) / 3)
				const monthYearKey = date.format("YYYY-MM");
				const startDateKey = dayjs(`${monthYearKey}-${(periodKey * 3 + 1).toString().padStart(2, '0')}`); // Start date of the period

				if (!groupedData[startDateKey.format("YYYY-MM-DD")]) {
					groupedData[startDateKey.format("YYYY-MM-DD")] = { count_by_group_name: {} };
				}

				if (d) {
					Object.entries(d.count_by_group_name).forEach(([groupName, count]) => {
						if (!groupedData[startDateKey.format("YYYY-MM-DD")].count_by_group_name[groupName]) {
							groupedData[startDateKey.format("YYYY-MM-DD")].count_by_group_name[groupName] = 0;
						}
						groupedData[startDateKey.format("YYYY-MM-DD")].count_by_group_name[groupName] += count;
					});
				}
			})
			Object.keys(groupedData).forEach(key => {
				const startDate = dayjs(key);
				obj[startDate.format("YYYY-MM-DD")] = groupedData[key];
			});

			return obj;

		} else {
			const allDays = fillMissingDates(sortedDates);
			const obj: { [key: string]: any } = {};
			const weeklyGroupedData: { [key: string]: { count_by_group_name: { [key: string]: number } } } = {};

			allDays.forEach(date => {
				const d = dataPerDate[date.format("YYYY-MM-DD")];
				const weekStartDate = date.startOf('week'); // Get the start of the week (Monday)

				if (!weeklyGroupedData[weekStartDate.format("YYYY-MM-DD")]) {
					weeklyGroupedData[weekStartDate.format("YYYY-MM-DD")] = { count_by_group_name: {} };
				}

				if (d) {
					Object.entries(d.count_by_group_name).forEach(([groupName, count]) => {
						if (!weeklyGroupedData[weekStartDate.format("YYYY-MM-DD")].count_by_group_name[groupName]) {
							weeklyGroupedData[weekStartDate.format("YYYY-MM-DD")].count_by_group_name[groupName] = 0;
						}
						weeklyGroupedData[weekStartDate.format("YYYY-MM-DD")].count_by_group_name[groupName] += count;
					});
				}
			});

			Object.keys(weeklyGroupedData).forEach(key => {
				obj[key] = weeklyGroupedData[key];
			});

			return obj;
		}
	}
	return {}
}
export function transformData(data: Data): { transformedData: TransformedData, uniqueDates: string[] } {
	const dataPerDate = a(data)
	const uniqueDates = Object.keys(dataPerDate);
	const transformedData: TransformedData = [];
	for (const date in dataPerDate) {
		const counts = dataPerDate[date].count_by_group_name;
		for (const group in counts) {
			transformedData.push({
				date: date,
				group: group,
				count: counts[group]
			});
		}
	}
	return { transformedData, uniqueDates }
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

function transformData2(data: Data2): { transformedData: TransformedData, uniqueDates: string[] } {
	const transformedData: TransformedData = [];
	const uniqueDates: string[] = []

	const a = data.stats_per_minute.reduce<StatsPerPeriod>((acc, current, index) => {
		if (index % 5 === 0) {
			acc.push(current)
		} else {
			const { stats } = current;
			const prevStats = acc[acc.length - 1]
			if (prevStats) {
				const newStats = mergeStats(prevStats.stats, stats)
				acc.splice(acc.length - 1, 1, { timestamp: prevStats.timestamp, stats: newStats })
			}
		}
		return acc;
	}, [])

	for (const entry of a) {
		const { timestamp, stats } = entry;
		uniqueDates.push(timestamp);

		for (const [key, value] of Object.entries(stats)) {
			transformedData.push({
				date: timestamp,
				group: key,
				count: value.count,
				groupName: value.group_name
			})
		}
	}

	return { transformedData, uniqueDates };
}

function fillMissingDates(dates: dayjs.Dayjs[]) {
	return dates.reduce<dayjs.Dayjs[]>((acc, currentItem) => {
		const lastValue = acc.at(-1)
		if (!lastValue) {
			acc.push(currentItem)
			return acc;
		}
		const dayDifference = Math.abs(lastValue.diff(currentItem, 'day'))
		if (dayDifference === 1) {
			acc.push(currentItem)
		} else if (dayDifference > 1) {
			let tempDate = lastValue.clone()

			while (tempDate.add(1, 'day').isBefore(currentItem)) {
				tempDate = tempDate.add(1, 'day')
				acc.push(tempDate);
			}
			acc.push(currentItem)
		}
		return acc;
	}, [])

}


const BARS_COLORSCHEME = ["#FFD454", "#FF9A3B", "#49A4FF", "#87D6F6", "#F087E9", "#AF54FF", "#FF5E63", "#E90008", "#82CE4B", "#499810"
]
const BARS_ADDITIONAL_COLORS = [
	"#FFC107", // Amber (new)
	"#FF5722", // Deep Orange (new)
	"#2196F3", // Blue (new)
	"#673AB7", // Deep Purple (new)
	"#4CAF50", // Green (new)
	"#FF9800", // Orange (new)
	"#3F51B5", // Indigo (new)
	"#009688", // Teal (new)
	"#795548", // Brown (new)
	"#607D8B", // Blue Grey (new)
]


@customElement('bar-chart-2')
export class BarChart2 extends LitElement {
	@property()
	data: Data | Data2;
	transformedData: TransformedData = [];
	colorMap = {}

	@property()
	isAnalysis = false;

	chartWidth = 0;
	chartHeight = 0;
	margins = {
		right: 10,
		top: 10,
		bottom: 25,
		left: 30,
	}
	xAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
	yAxisGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
	tooltip: d3.Selection<HTMLDivElement, unknown, HTMLElement, any>;

	static styles = [
		css`
		  :host { display: block;
		    height: 100%;
		    width: 100%;
		    max-height: 100%;
		    max-width: 100%;
		  }`
	];

	connectedCallback(): void {
		super.connectedCallback();
		this.chartWidth = this.getBoundingClientRect().width;
		this.chartHeight = this.getBoundingClientRect().height;
		const topLine = this.renderRoot.querySelector("#top-line")?.getBoundingClientRect().height ?? 30
		const rect = this.getBoundingClientRect();
		this.chartWidth = rect.width
		this.chartHeight = rect.height - topLine
	}

	updated(changedProperties: PropertyValues<this>) {
		if (changedProperties.has('data')) {
			this.renderChart()
		}
	}

	getColorForGroup(group: string) {
		if (!this.colorMap[group]) {
			const availableColors = BARS_COLORSCHEME.filter(color => !Object.values(this.colorMap).includes(color));
			const additionalColorsAvailable = BARS_ADDITIONAL_COLORS.filter(color => !Object.values(this.colorMap).includes(color));
			if (availableColors.length > 0) {
				this.colorMap[group] = availableColors[0]
			} else if (additionalColorsAvailable.length > 0) {
				this.colorMap[group] = additionalColorsAvailable[0]
			} else {
				this.colorMap[group] = "#000000";
			}
		}
		return this.colorMap[group];
	}

	render() {
		return html`
		    <div>
			<section id="top-line" style="display:flex; justify-content: space-between"> 
			    <div style="flex-grow: 1;"></div>
			    <slot name="period"></slot>
			</section>
			<svg id="chart"  width="${this.chartWidth}" height="${this.chartHeight}" viewBox="0 0 ${this.chartWidth} ${this.chartHeight}"></svg>
		    </div>

		    `
	}

	renderChart() {
		let uniqueDates: string[] = []
		let tickFormatFn: (x: string) => string = (x) => x;
		if ("stats_per_minute" in this.data) {
			const result = transformData2(this.data)
			this.transformedData = result.transformedData
			uniqueDates = result.uniqueDates;
		} else {
			const result = transformData(this.data)
			this.transformedData = result.transformedData
			uniqueDates = result.uniqueDates
			tickFormatFn = (x: string) => dayjs(x).format("DD/MM")
		}

		const e = d3.index(this.transformedData, d => d.date, d => d.group)
		const s = d3.stack<typeof e>()
			.keys(d3.union(this.transformedData.map(d => d.group)))
			.value((a, key) => {
				const groupData = a[1].get(key)
				return groupData ? groupData.count : 0
			})
			(e as any)


		const svgEl = this.renderRoot.querySelector("#chart");
		const svg = d3.select(svgEl)
		// tooltip from https://observablehq.com/@anreut/bar-chart-with-a-tooltip
		if (!this.tooltip) {
			this.tooltip = d3
				.select('body')
				.append('div')
				.style('position', 'absolute')
				.style('z-index', '100')
				.style('visibility', 'hidden')
				.style('padding', '5px')
				.style('background', 'var(--card-color)')
				.style('border', '2px solid var(--border-color)')
				.style('color', 'var(--text-color)')
		}
		const tooltip = this.tooltip;
		const { xScale, xAxis } = createBandScale(uniqueDates, [this.margins.left, this.chartWidth - this.margins.right], tickFormatFn)

		const y = d3.scaleLinear()
			.domain([0, d3.max(s, d => d3.max(d, d => d[1])) || 0])
			.rangeRound([this.chartHeight - this.margins.bottom, this.margins.top]);
		const groups = svg
			.selectAll(".data-group")
			.data(s)
			.join("g")
			.attr("class", "data-group")
			.attr("fill", d => this.getColorForGroup(d.key))

		const bandwidth = xScale.bandwidth()
		const barWidth = this.isAnalysis ? Math.min(100, bandwidth) : bandwidth
		groups.selectAll("rect")
			.data(D => D.map(d => {
				type DataWithKey = typeof d & { key: string }
				const dataWithKey = d as DataWithKey;
				dataWithKey.key = D.key;
				return dataWithKey
			}))
			.join(
				(enter) => enter.append('rect')
					.attr("x", d => { return xScale(d.data[0]) ?? 0 })
					.attr("y", this.chartHeight - this.margins.bottom)
					.attr("height", 0)
					.attr("width", d => barWidth),
				(update) => update,
				(exit) => exit.transition()
					.attr('y', this.chartHeight - this.margins.bottom)
					.attr('height', 0)
					.remove()
			)
			.on("mouseover", function(e, d) {
				d3.select(this).attr('stroke', 'var(--text-color)');
				const groupName = d.data[1].get(d.key)?.groupName ?? d.key
				tooltip
					.html(
						`<div>
						  <p>${d.data[0]}</p>
						  <p>${groupName}</p>
						  <p>${d.data[1].get(d.key)?.count}</p>
						</div>`)
					.style('visibility', 'visible');
			})
			.on('mousemove', function(e) {
				tooltip
					.style('top', e.pageY - 40 + 'px')
					.style('left', e.pageX + 10 + 'px')
			})
			.on('mouseout', function(e, a) {
				tooltip.html(``).style('visibility', 'hidden');
				d3.select(this).attr('stroke', 'none');
			})
			.transition()
			.attr("x", d => { return (xScale(d.data[0]) ?? 0) + (bandwidth - barWidth) / 2 })
			.attr("y", d => y(d[1]))
			.attr("height", d => y(d[0]) - y(d[1]))
			.attr("width", barWidth)

		if (!this.xAxisGroup) {
			this.xAxisGroup = svg.append("g")
		}
		this.xAxisGroup.attr("transform", `translate(0,${this.chartHeight - this.margins.bottom})`)
			.transition().call(xAxis)

		if (!this.yAxisGroup) {
			this.yAxisGroup = svg.append("g")
		}
		this.yAxisGroup.attr("transform", `translate(${this.margins.left},0)`)
			.transition().call(d3.axisLeft(y).ticks(null, "s"))

	}
}


function createBandScale(domain: string[], rangeValue: [number, number], tickFormatFn: (x: string) => string) {
	const xScale = d3.scaleBand()
		.domain(domain)
		.range(rangeValue).padding(0.1);

	const xAxis = d3.axisBottom(xScale).tickSizeOuter(0).tickFormat((d, i) => {
		if (domain.length > 12) {
			return i % _gapBetweenTicks(domain.length) !== 0 ? "" : tickFormatFn(d)
		}
		return tickFormatFn(d)
	}
	)

	return { xScale, xAxis };
}

function _gapBetweenTicks(totalTicks: number) {
	return Math.max(1, Math.ceil(totalTicks / 8));
}



