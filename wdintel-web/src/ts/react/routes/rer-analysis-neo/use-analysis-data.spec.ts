import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes } from '../../../../Bindings';
import { mergeAnalysisCallsignInfoMap } from './use-analysis-data.callsigns';

function callsignInfoRow(overrides: Partial<CallsignInfoRes['res'][number]> = {}): CallsignInfoRes['res'][number] {
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
  return { callsign, res: rows };
}

describe('mergeAnalysisCallsignInfoMap', () => {
  it('merges accumulated network matches when adding later slices in the same query scope', () => {
    const prev = {
      'ворчун': callsignInfo('ВОРЧУН', [
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
            position: '',
            unit1: '',
            networkIdsReportedIn: [503],
          }),
        ]),
      ],
    );

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
      'ворчун': callsignInfo('ВОРЧУН', [
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
});
