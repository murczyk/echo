import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes, Network } from '../../../../Bindings';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';
import { mergeNetworksById, shouldSkipNewCallsignsLoad } from './use-analysis-data';

function callsignInfoRow(
  overrides: Partial<CallsignInfoRes['res'][number]> = {},
): CallsignInfoRes['res'][number] {
  return {
    id: 1,
    comment: '',
    position: '',
    unit1: '',
    unit2: '',
    networkIdsReportedIn: [],
    ...overrides,
  };
}

function callsignInfo(callsign: string, rows: CallsignInfoRes['res']): CallsignInfoRes {
  return { callsign, res: rows, networkHints: [] };
}

describe('mergeAnalysisCallsignInfoMap', () => {
  it('merges accumulated network matches when adding later slices in the same query scope', () => {
    const prev = {
      ворчун: callsignInfo('ВОРЧУН', [
        callsignInfoRow({
          id: 21,
          position: 'командир',
          unit1: '2 мср мсб 26 тп 47 тд 1 та',
          networkIdsReportedIn: [501, 502],
        }),
      ]),
    };

    const next = mergeAnalysisCallsignInfoMap(prev, [
      callsignInfo('ВОРЧУН', [
        callsignInfoRow({
          id: 21,
          position: '',
          unit1: '',
          networkIdsReportedIn: [503],
        }),
      ]),
    ]);

    expect(next['ворчун'].res).toEqual([
      callsignInfoRow({
        id: 21,
        position: 'командир',
        unit1: '2 мср мсб 26 тп 47 тд 1 та',
        networkIdsReportedIn: [501, 502, 503],
      }),
    ]);
  });

  it('replaces stale cached entry when overwrite mode starts a new query scope', () => {
    const prev = {
      ворчун: callsignInfo('ВОРЧУН', [
        callsignInfoRow({
          id: 21,
          position: 'командир',
          unit1: '2 мср мсб 26 тп 47 тд 1 та',
          networkIdsReportedIn: [501, 502],
        }),
      ]),
    };

    const next = mergeAnalysisCallsignInfoMap(
      prev,
      [
        callsignInfo('ВОРЧУН', [
          callsignInfoRow({
            id: 21,
            position: 'командир',
            unit1: '1 мср мсб 26 тп 47 тд 1 та',
            networkIdsReportedIn: [503],
          }),
        ]),
      ],
      { overwrite: true },
    );

    expect(next['ворчун'].res).toEqual([
      callsignInfoRow({
        id: 21,
        position: 'командир',
        unit1: '1 мср мсб 26 тп 47 тд 1 та',
        networkIdsReportedIn: [503],
      }),
    ]);
  });

  it('normalizes callsign keys consistently when merging responses', () => {
    const next = mergeAnalysisCallsignInfoMap({}, [
      callsignInfo('  БеТоН  ', [
        callsignInfoRow({
          id: 31,
          callsign: '  БеТоН  ',
          position: 'catalog',
          unit1: 'unit',
          networkIdsReportedIn: [11],
        }),
      ]),
    ]);

    expect(next['бетон']).toBeDefined();
    expect(next['бетон'].callsign).toBe('  БеТоН  ');
  });

  it('merges partial network hints by stable id', () => {
    const prev = callsignInfo('ВЕТЕР', []);
    prev.networkHints = [{ id: 2, networkId: 20, position: 'old', formation: 'unit' }];
    const incoming = callsignInfo('ВЕТЕР', []);
    incoming.networkHints = [
      { id: 1, networkId: 10, position: 'first', formation: 'unit' },
      { id: 2, networkId: 20, position: 'updated', formation: 'unit' },
    ];

    const next = mergeAnalysisCallsignInfoMap({ ветер: prev }, [incoming]);

    expect(next['ветер'].networkHints).toEqual([
      { id: 1, networkId: 10, position: 'first', formation: 'unit' },
      { id: 2, networkId: 20, position: 'updated', formation: 'unit' },
    ]);
  });
});

describe('mergeNetworksById', () => {
  it('keeps concurrently updated networks when merging async-loaded items', () => {
    const merged = mergeNetworksById(
      [{ id: 1, name: 'one' } as Network, { id: 3, name: 'three' } as Network],
      [{ id: 2, name: 'two' } as Network],
    );

    expect(merged.map((network) => network.id)).toEqual([1, 3, 2]);
  });
});

describe('shouldSkipNewCallsignsLoad', () => {
  it('skips duplicate requests for the same in-flight or already loaded key', () => {
    expect(shouldSkipNewCallsignsLoad('loaded', null, 'loaded')).toBe(true);
    expect(shouldSkipNewCallsignsLoad(null, 'pending', 'pending')).toBe(true);
    expect(shouldSkipNewCallsignsLoad('loaded', 'pending', 'other')).toBe(false);
  });
});
