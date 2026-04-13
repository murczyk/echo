import { describe, expect, it } from 'vitest';

import { toCamelCase, transformSnakeToCamel } from './snake-to-camel';

describe('snake-to-camel', () => {
  it('converts snake keys with numeric suffixes to camelCase keys used by the frontend', () => {
    expect(toCamelCase('unit_1')).toBe('unit1');
    expect(toCamelCase('unit_2')).toBe('unit2');
    expect(toCamelCase('network_ids_reported_in')).toBe('networkIdsReportedIn');
  });

  it('recursively transforms callsign info payloads with unit_1 and unit_2 fields', () => {
    const transformed = transformSnakeToCamel<{
      res: Array<{ unit1: string; unit2: string; networkIdsReportedIn: number[] }>;
    }>({
      res: [
        {
          unit_1: '2 мсб 1431 мсп 11 АК',
          unit_2: '',
          network_ids_reported_in: [10, 20],
        },
      ],
    });

    expect(transformed.res[0]).toEqual({
      unit1: '2 мсб 1431 мсп 11 АК',
      unit2: '',
      networkIdsReportedIn: [10, 20],
    });
  });
});
