import { describe, it, expect } from 'vitest';
import { transformData as transformZoomableData, Data } from './bar-chart-zoomable.ts';
import { createYAxisConfig, transformData } from './dashboard-chart.ts';

describe('transformData', () => {
    it('should read camelCase nested counts from react payloads', () => {
        const stubData = {
            dataPerDate: {
                "2025-01-01": { countByGroupName: { groupA: 10, groupB: 3 } },
            }
        } as unknown as Data;

        const result = transformData(stubData);

        expect(result.transformedData).toEqual([
            { date: '2025-01-01', group: 'groupA', count: 10 },
            { date: '2025-01-01', group: 'groupB', count: 3 },
        ]);
        expect(result.uniqueDates).toEqual(['2025-01-01']);
    });

    it('should tolerate empty date entries without crashing', () => {
        const stubData = {
            dataPerDate: {
                "2025-01-01": { count_by_group_name: { groupA: 10 } },
                "2025-01-02": {},
                "2025-01-03": null,
            }
        } as unknown as Data;

        const result = transformData(stubData);

        expect(result.transformedData).toEqual([
            { date: '2025-01-01', group: 'groupA', count: 10 },
        ]);
        expect(result.uniqueDates).toEqual(['2025-01-01', '2025-01-02', '2025-01-03']);
    });

    it('should return daily data for less than 28 days', () => {
        const stubData: Data = {
            data_per_date: {
                "2025-01-01": { count_by_group_name: { groupA: 10, groupB: 20 } },
                "2025-01-02": { count_by_group_name: { groupA: 5, groupB: 15 } },
                "2025-01-03": { count_by_group_name: { groupA: 8, groupB: 12 } },
            }
        };

        const result = transformZoomableData(stubData);
        expect(result).toEqual({
            "2025-01-01": { count_by_group_name: { groupA: 10, groupB: 20 } },
            "2025-01-02": { count_by_group_name: { groupA: 5, groupB: 15 } },
            "2025-01-03": { count_by_group_name: { groupA: 8, groupB: 12 } },
        });
    });

    it('should bucket sparse data into 3-day period starts for 28 to 120 days', () => {
const stubData28To120Days: Data = {
    data_per_date: {
        "2025-01-01": { count_by_group_name: { groupA: 10, groupB: 20 } },
        "2025-01-05": { count_by_group_name: { groupA: 5, groupB: 15 } },
        "2025-01-10": { count_by_group_name: { groupA: 8, groupB: 12 } },
        "2025-01-15": { count_by_group_name: { groupA: 7, groupB: 14 } },
        "2025-01-20": { count_by_group_name: { groupA: 6, groupB: 13 } },
        "2025-01-25": { count_by_group_name: { groupA: 9, groupB: 11 } },
        "2025-02-01": { count_by_group_name: { groupA: 12, groupB: 18 } },
        "2025-02-07": { count_by_group_name: { groupA: 11, groupB: 19 } },
        "2025-02-15": { count_by_group_name: { groupA: 14, groupB: 22 } },
        "2025-02-20": { count_by_group_name: { groupA: 13, groupB: 21 } },
        "2025-02-28": { count_by_group_name: { groupA: 15, groupB: 23 } },
        "2025-03-01": { count_by_group_name: { groupA: 16, groupB: 24 } },
        "2025-03-07": { count_by_group_name: { groupA: 17, groupB: 25 } },
        "2025-03-15": { count_by_group_name: { groupA: 18, groupB: 26 } },
        "2025-03-20": { count_by_group_name: { groupA: 19, groupB: 27 } },
        "2025-03-28": { count_by_group_name: { groupA: 20, groupB: 28 } },
        "2025-04-01": { count_by_group_name: { groupA: 21, groupB: 29 } },
        "2025-04-05": { count_by_group_name: { groupA: 22, groupB: 30 } },
    }
};

        const result = transformZoomableData(stubData28To120Days);

        // Known dates are shifted to their period start (1st/4th/7th/etc day of month)
        expect(result["2025-01-01"]).toEqual({ count_by_group_name: { groupA: 10, groupB: 20 } });
        expect(result["2025-01-04"]).toEqual({ count_by_group_name: { groupA: 5, groupB: 15 } });
        expect(result["2025-01-10"]).toEqual({ count_by_group_name: { groupA: 8, groupB: 12 } });
        expect(result["2025-02-01"]).toEqual({ count_by_group_name: { groupA: 12, groupB: 18 } });
        expect(result["2025-03-01"]).toEqual({ count_by_group_name: { groupA: 16, groupB: 24 } });

        // Empty synthetic buckets are present for gap-filling
        expect(result["2025-01-07"]).toEqual({ count_by_group_name: {} });
        expect(result["2025-02-04"]).toEqual({ count_by_group_name: {} });
    });

    it('should aggregate into weekly buckets for 120+ day ranges', () => {
        const stubData: Data = {
            data_per_date: {
                "2025-01-01": { count_by_group_name: { groupA: 10, groupB: 20 } },
                "2025-01-05": { count_by_group_name: { groupA: 2, groupB: 3 } },
                "2025-03-08": { count_by_group_name: { groupA: 5, groupB: 15 } },
                "2025-05-20": { count_by_group_name: { groupA: 7, groupB: 11 } },
            }
        };

        const result = transformZoomableData(stubData);

        expect(result["2024-12-29"]).toEqual({ count_by_group_name: { groupA: 10, groupB: 20 } });
        expect(result["2025-01-05"]).toEqual({ count_by_group_name: { groupA: 2, groupB: 3 } });
        expect(result["2025-03-02"]).toEqual({ count_by_group_name: { groupA: 5, groupB: 15 } });
        expect(result["2025-05-18"]).toEqual({ count_by_group_name: { groupA: 7, groupB: 11 } });
    });
});

describe('createYAxisConfig', () => {
    it('should use a stable zero tick for empty data', () => {
        const config = createYAxisConfig(undefined);

        expect(config.domainMax).toBe(1);
        expect(config.tickValues).toEqual([0]);
        expect(config.tickFormat?.(0)).toBe('0');
    });

    it('should preserve the real domain for non-empty data', () => {
        const config = createYAxisConfig(7);

        expect(config.domainMax).toBe(7);
        expect(config.tickValues).toBeUndefined();
        expect(config.tickFormat).toBeUndefined();
    });
});
