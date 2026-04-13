import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes } from '../../../../Bindings';
import {
  combineDutyCallsignInfoMaps,
  mergeDutyCallsignInfoMap,
  replaceDutyCallsignInfoMap,
  updateDutyResolvedCallsignInfoMap,
  updateDutyInboxCallsignInfoMapByFeedId,
} from './useRerDutyCallsignInfo';

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

describe('mergeDutyCallsignInfoMap', () => {
  it('unions network ids and preserves richer existing row data for the same callsign', () => {
    const prev = {
      'борода': callsignInfo('БОРОДА', [
        callsignInfoRow({
          id: 11,
          position: 'Командир відділення 5 мср',
          unit1: '2 мсб 1431 мсп 11 АК',
          networkIdsReportedIn: [1001],
        }),
      ]),
    };

    const next = mergeDutyCallsignInfoMap(prev, [
      callsignInfo('БОРОДА', [
        callsignInfoRow({
          id: 11,
          position: '',
          unit1: '',
          networkIdsReportedIn: [1002],
        }),
        callsignInfoRow({
          id: 12,
          position: 'старший групи',
          unit1: 'загін "Шторм" 11 тп 18 мсд 11 АК',
          networkIdsReportedIn: [1003],
        }),
      ]),
    ]);

    expect(next['борода'].res).toEqual([
      callsignInfoRow({
        id: 11,
        position: 'Командир відділення 5 мср',
        unit1: '2 мсб 1431 мсп 11 АК',
        networkIdsReportedIn: [1001, 1002],
      }),
      callsignInfoRow({
        id: 12,
        position: 'старший групи',
        unit1: 'загін "Шторм" 11 тп 18 мсд 11 АК',
        networkIdsReportedIn: [1003],
      }),
    ]);
  });
});

describe('replaceDutyCallsignInfoMap', () => {
  it('replaces prior feed-scoped inbox rows instead of keeping stale network matches', () => {
    const prev = {
      'борода': callsignInfo('БОРОДА', [
        callsignInfoRow({
          id: 11,
          networkIdsReportedIn: [1001],
        }),
      ]),
    };

    const next = replaceDutyCallsignInfoMap(prev, [
      callsignInfo('БОРОДА', [
        callsignInfoRow({
          id: 11,
          networkIdsReportedIn: [2002],
        }),
      ]),
    ]);

    expect(next['борода'].res).toEqual([
      callsignInfoRow({
        id: 11,
        networkIdsReportedIn: [2002],
      }),
    ]);
  });
});

describe('combineDutyCallsignInfoMaps', () => {
  it('combines only active feed maps with resolved enrichment rows', () => {
    const next = combineDutyCallsignInfoMaps(
      {
        'mf-1': {
          'борода': callsignInfo('БОРОДА', [
            callsignInfoRow({
              id: 11,
              networkIdsReportedIn: [1001],
            }),
          ]),
        },
      },
      {
        'борода': callsignInfo('БОРОДА', [
          callsignInfoRow({
            id: 12,
            position: 'командир',
            networkIdsReportedIn: [3003],
          }),
        ]),
      },
    );

    expect(next['борода'].res).toEqual([
      callsignInfoRow({
        id: 12,
        position: 'командир',
        networkIdsReportedIn: [3003],
      }),
      callsignInfoRow({
        id: 11,
        networkIdsReportedIn: [1001],
      }),
    ]);
  });

  it('preserves richer resolved row text when inbox carries a weaker version of the same row id', () => {
    const next = combineDutyCallsignInfoMaps(
      {
        'mf-1': {
          'борода': callsignInfo('БОРОДА', [
            callsignInfoRow({
              id: 11,
              position: 'командир',
              unit1: '2 мсб',
              networkIdsReportedIn: [1001],
            }),
          ]),
        },
      },
      {
        'борода': callsignInfo('БОРОДА', [
          callsignInfoRow({
            id: 11,
            position: 'Командир відділення 5 мср',
            unit1: '2 мсб 1431 мсп 11 АК',
            networkIdsReportedIn: [3003],
          }),
        ]),
      },
    );

    expect(next['борода'].res).toEqual([
      callsignInfoRow({
        id: 11,
        position: 'Командир відділення 5 мср',
        unit1: '2 мсб 1431 мсп 11 АК',
        networkIdsReportedIn: [3003, 1001],
      }),
    ]);
  });
});

describe('updateDutyInboxCallsignInfoMapByFeedId', () => {
  it('clears prior feed cache when replace payload is empty', () => {
    const prev = {
      'mf-1': {
        'борода': callsignInfo('БОРОДА', [
          callsignInfoRow({
            id: 11,
            networkIdsReportedIn: [1001],
          }),
        ]),
      },
    };

    const next = updateDutyInboxCallsignInfoMapByFeedId(prev, 'mf-1', [], { replace: true });

    expect(next).toEqual({
      'mf-1': {},
    });
  });
});

describe('updateDutyResolvedCallsignInfoMap', () => {
  it('clears stale resolved rows when backend returns an empty result for that callsign', () => {
    const prev = {
      'борода': callsignInfo('БОРОДА', [
        callsignInfoRow({
          id: 11,
          position: 'командир',
          networkIdsReportedIn: [1001],
        }),
      ]),
    };

    const next = updateDutyResolvedCallsignInfoMap(prev, [
      callsignInfo('БОРОДА', []),
    ]);

    expect(next).toEqual({});
  });
});
