import { Data as ChartData, transformData as transformChartData } from './dashboard-chart.ts';

type CountByGroupName = {
  [key: string]: number;
};

type DataPerDate = {
  [key: string]: {
    count_by_group_name: CountByGroupName;
  };
};

export type Data = ChartData;

export function transformData(data: Data): DataPerDate {
  const { transformedData, uniqueDates } = transformChartData(data);
  const result: DataPerDate = {};

  for (const date of uniqueDates) {
    result[date] = { count_by_group_name: {} };
  }

  for (const entry of transformedData) {
    if (!result[entry.date]) {
      result[entry.date] = { count_by_group_name: {} };
    }
    result[entry.date].count_by_group_name[entry.group] = entry.count;
  }

  return result;
}
