import { describe, expect, it } from 'vitest';

import type { CallsignInfoRes, Network, Unit } from '../../../../../Bindings';
import {
  formatCallsignHintTooltip,
  formatCallsignHintTooltipData,
  formatMessageCallsignHintTooltipData,
  getCallsignHintResult,
  getMessageCallsignHintResult,
  isCallsignRelatedToNetworks,
  resolveNetworkCallsignHints,
} from '../callsign-hints';
import {
  formatLegacyCallsignTooltipLine,
  formatNetworkCallsignTooltipLine,
} from '../callsign-hints-utils';

const unitsMap: Record<number, Unit> = {
  1: {
    id: 1,
    company: '',
    battalion: '10',
    regiment: '100',
    division: '1000',
    army: 'A',
    militaryDistrict: 'D1',
    armyRegion: 'R1',
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
    militaryDistrict: 'D1',
    armyRegion: 'R1',
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
    militaryDistrict: 'D2',
    armyRegion: 'R2',
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

function createCallsignInfoMap(
  items: Record<string, CallsignInfoRes['res']>,
  networkHints: CallsignInfoRes['networkHints'] = [],
): Record<string, CallsignInfoRes> {
  return Object.fromEntries(
    Object.entries(items).map(([callsign, res]) => [
      callsign,
      {
        callsign,
        res,
        networkHints,
      },
    ]),
  );
}

describe('rer-analysis-neo callsign hints', () => {
  it('classifies message callsigns from explicit network hints only', () => {
    const result = getMessageCallsignHintResult({
      callsign: '  WoLf ',
      networkIds: [10],
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 99,
              callsign: 'wolf',
              position: 'ТЮМЕНЬ',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [20],
            },
          ],
          networkHints: [{ id: 1, networkId: 10, position: 'cmd', formation: 'u1' }],
        },
      },
    });
    expect(result.state).toBe('message-network');
    expect(result.catalogRows).toHaveLength(0);
    expect(result.exactNetworkHints).toHaveLength(1);
  });
});
