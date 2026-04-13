import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes, Network, Unit } from '../../../../Bindings';
import { formatCallsignHintTooltip, formatCallsignHintTooltipData, formatLegacyCallsignTooltipLine, getCallsignHintResult } from './callsign-hints';

const unitsMap: Record<number, Unit> = {
  1: {
    id: 1,
    company: '',
    battalion: '10',
    regiment: '100',
    division: '1000',
    army: 'A',
    comment: '',
    name: 'Unit A parent',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
  2: {
    id: 2,
    company: '2',
    battalion: '10',
    regiment: '100',
    division: '1000',
    army: 'A',
    comment: '',
    name: 'Unit A child',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
  3: {
    id: 3,
    company: '1',
    battalion: '20',
    regiment: '200',
    division: '2000',
    army: 'B',
    comment: '',
    name: 'Unit B',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
};

const networks: Network[] = [
  {
    id: 10,
    freqs: [
      {
        id: 1,
        networkId: 10,
        freq: '100.000',
        deleted: false,
        activeFrom: 0,
        activeTo: null,
        createdAt: 0,
        kind: 'voice',
        modulationId: null,
        encryptionKeys: [],
      },
    ],
    unitIds: [1],
    aorIds: [],
    name: 'Alpha',
    location: 'Kyiv',
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
  },
  {
    id: 20,
    freqs: [
      {
        id: 2,
        networkId: 20,
        freq: '200.000',
        deleted: false,
        activeFrom: 0,
        activeTo: null,
        createdAt: 0,
        kind: 'voice',
        modulationId: null,
        encryptionKeys: [],
      },
    ],
    unitIds: [3],
    aorIds: [],
    name: 'Bravo',
    location: 'Lviv',
    radioStation: null,
    createdAt: 0,
    purpose: null,
    operationMode: null,
    operationType: null,
    operationPeriod: null,
    lastUpdatedAt: 0,
    lastUpdatedBy: null,
    activeFrom: null,
    activeTo: null,
    postIds: [],
    descriptions: [],
    deleted: false,
  },
];

function createCallsignInfoMap(items: Record<string, CallsignInfoRes['res']>): Record<string, CallsignInfoRes> {
  return Object.fromEntries(
    Object.entries(items).map(([callsign, res]) => [
      callsign,
      {
        callsign,
        res,
      },
    ]),
  );
}

describe('rer-analysis-neo callsign hints', () => {
  it('formats tooltip line exactly like the legacy Elm component', () => {
    expect(
      formatLegacyCallsignTooltipLine({
        position: ' Командир отделения 5 мср ',
        unit1: ' 2 мсб 1431 мсп 11 АК ',
        unit2: '',
      } as never),
    ).toBe('🐷 Командир отделения 5 мср 2 мсб 1431 мсп 11 АК ');
  });

  it('returns system tooltip in message context when there are catalog entries and no message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: '1 рота',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
          {
            id: 2,
            callsign: 'wolf',
            position: 'заступник',
            comment: '',
            unit1: '2 рота',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'WOLF',
    });

    expect(result.strategy).toBe('system');
    expect(result.iconClass).toBe('bi-info-circle');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1, 2]);
    expect(formatCallsignHintTooltip(result)).toBe('Позивні з каталогу:\n🐷 командир 1 рота \n🐷 заступник 2 рота ');
  });

  it('returns no hints in message context when the callsign is absent from the message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: '3 рота',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('none');
    expect(result.iconClass).toBe('');
    expect(result.prioritizedCallsigns).toEqual([]);
    expect(formatCallsignHintTooltipData(result)).toBeNull();
  });

  it('returns network tooltip in message context and keeps only rows from message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: '1 рота',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
          {
            id: 2,
            callsign: 'wolf',
            position: 'заступник',
            comment: '',
            unit1: '2 рота',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.iconClass).toBe('bi-info-circle-fill');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
    expect(formatCallsignHintTooltip(result)).toBe('Позивні підрозділів мережі:\n🐷 командир 1 рота ');
  });

  it('treats empty message network ids the same as no message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: '1 рота',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
        ],
      }),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
  });

  it('returns network tooltip in frequency context when message networks exist, even without frequency matching', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '999.999',
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: '1 рота',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
          {
            id: 2,
            callsign: 'wolf',
            position: 'заступник',
            comment: '',
            unit1: '3 рота',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.iconClass).toBe('bi-info-circle-fill');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
  });

  it('returns network tooltip in frequency context when the callsign unit is same or child of the network unit', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        wolf: [
          {
            id: 1,
            callsign: 'wolf',
            position: 'командир взводу',
            comment: '',
            unit1: '3 тр',
            unit2: '',
            unitId: 2,
            networkIdsReportedIn: [999],
          },
          {
            id: 2,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: 'сторонній',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.iconClass).toBe('bi-info-circle-fill');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
    expect(formatCallsignHintTooltip(result)).toBe('Позивні підрозділів мережі:\n🐷 командир взводу 3 тр ');
  });

  it('returns system tooltip in frequency context when the callsign is not related to frequency networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        fox: [
          {
            id: 3,
            callsign: 'fox',
            position: 'начальник',
            comment: '',
            unit1: 'штаб',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'fox',
    });

    expect(result.strategy).toBe('system');
    expect(result.iconClass).toBe('bi-info-circle');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([3]);
    expect(formatCallsignHintTooltip(result)).toBe('Позивні з каталогу:\n🐷 начальник штаб ');
  });

  it('returns system tooltip in frequency context when there are no frequency networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        fox: [
          {
            id: 3,
            callsign: 'fox',
            position: 'начальник',
            comment: '',
            unit1: 'штаб',
            unit2: '',
            unitId: 3,
            networkIdsReportedIn: [20],
          },
        ],
      }),
      callsign: 'fox',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([3]);
  });

  it('returns no hints when there is no callsign info', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: {},
      callsign: 'missing',
    });

    expect(result.strategy).toBe('none');
    expect(result.prioritizedCallsigns).toEqual([]);
    expect(formatCallsignHintTooltip(result)).toBeNull();
  });

  it('preserves API order of prioritized tooltip rows', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        ordered: [
          {
            id: 21,
            callsign: 'ordered',
            position: 'перший',
            comment: '',
            unit1: 'u1',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
          {
            id: 22,
            callsign: 'ordered',
            position: 'другий',
            comment: '',
            unit1: 'u2',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
        ],
      }),
      callsign: 'ordered',
    });

    expect(formatCallsignHintTooltip(result)).toBe('Позивні з каталогу:\n🐷 перший u1 \n🐷 другий u2 ');
  });

  it('hides rows that have no visible tooltip text', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        emptyish: [
          {
            id: 9,
            callsign: 'emptyish',
            position: '',
            comment: '',
            unit1: '',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
        ],
      }),
      callsign: 'emptyish',
    });

    expect(formatCallsignHintTooltipData(result)).toBeNull();
  });

  it('does not use comment-only data in the tooltip text', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        commentonly: [
          {
            id: 10,
            callsign: 'commentonly',
            position: 'командир',
            comment: '2 мср мсб 26 тп 47 тд 1 та',
            unit1: '',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: [10],
          },
        ],
      }),
      callsign: 'commentonly',
    });

    expect(formatCallsignHintTooltip(result)).toBe('Позивні з каталогу:\n🐷 командир  ');
  });

  it('does not crash when networkIdsReportedIn is missing at runtime', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap({
        nonetworkids: [
          {
            id: 11,
            callsign: 'nonetworkids',
            position: 'командир',
            comment: '',
            unit1: '1 мср',
            unit2: '',
            unitId: 1,
            networkIdsReportedIn: undefined as never,
          },
        ],
      }),
      callsign: 'nonetworkids',
    });

    expect(result.strategy).toBe('none');
    expect(formatCallsignHintTooltip(result)).toBeNull();
  });
});
