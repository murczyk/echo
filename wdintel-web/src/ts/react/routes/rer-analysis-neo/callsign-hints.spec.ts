import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes, Network, Unit } from '../../../../Bindings';
import { formatCallsignHintTooltip, getCallsignHintResult } from './callsign-hints';

const unitsMap: Record<number, Unit> = {
  1: {
    id: 1,
    company: '1',
    battalion: '10',
    regiment: '100',
    division: '1000',
    army: 'A',
    comment: '',
    name: 'Unit A',
    active: true,
    createdAt: 0,
    createdBy: 'test',
  },
  2: {
    id: 2,
    company: '2',
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
];

const callsignInfoMap: Record<string, CallsignInfoRes> = {
  wolf: {
    callsign: 'wolf',
    res: [
      {
        id: 1,
        callsign: 'wolf',
        position: 'cmd',
        comment: 'prio',
        unit1: 'u1',
        unit2: 'u2',
        unitId: 1,
        networkIdsReportedIn: [10],
      },
      {
        id: 2,
        callsign: 'wolf',
        position: 'other',
        comment: 'fallback',
        unit1: 'x1',
        unit2: 'x2',
        unitId: 2,
        networkIdsReportedIn: [20],
      },
    ],
  },
  fox: {
    callsign: 'fox',
    res: [
      {
        id: 3,
        callsign: 'fox',
        position: 'sys',
        comment: 'catalog',
        unit1: 's1',
        unit2: 's2',
        unitId: 2,
        networkIdsReportedIn: [20],
      },
    ],
  },
};

describe('rer-analysis-neo callsign hints', () => {
  it('prioritizes network-related callsigns for frequency context', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap,
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
    expect(result.nonPrioritizedCallsigns.map((item) => item.id)).toEqual([2]);
    expect(formatCallsignHintTooltip(result)).toContain('Позивні підрозділів мережі:');
  });

  it('falls back to system hints when no network relation exists', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap,
      callsign: 'fox',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([3]);
    expect(formatCallsignHintTooltip(result)).toContain('Позивні з каталогу:');
  });

  it('formats system tooltip for message context fallback', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: '100.000',
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: {
        lone: {
          callsign: 'lone',
          res: [
            {
              id: 4,
              callsign: 'lone',
              position: 'none',
              comment: '',
              unit1: 'u',
              unit2: 'v',
              unitId: 2,
              networkIdsReportedIn: [20],
            },
          ],
        },
      },
      callsign: 'lone',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns).toHaveLength(1);
    expect(formatCallsignHintTooltip(result)).toContain('Позивні з каталогу:');
  });

  it('returns no tooltip when there is no callsign info', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap: {},
      callsign: 'missing',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns).toHaveLength(0);
    expect(result.nonPrioritizedCallsigns).toHaveLength(0);
    expect(formatCallsignHintTooltip(result)).toBeNull();
  });
});
