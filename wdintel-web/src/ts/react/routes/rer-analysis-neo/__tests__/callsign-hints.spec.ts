// @test-scope parser: analysis callsign-hint network, hierarchy, and tooltip normalization fixtures
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
    const tooltip = formatMessageCallsignHintTooltipData(result);
    expect(result.state).toBe('message-network');
    expect(result.catalogRows).toHaveLength(0);
    expect(result.exactNetworkHints).toHaveLength(1);
    expect(tooltip?.sections).toEqual([
      { header: 'Позивні підрозділів мережі:', items: ['🐷 cmd u1'] },
    ]);
    expect(JSON.stringify(tooltip)).not.toContain('ТЮМЕНЬ');
  });

  it('keeps blank exact hints visible with a network fallback', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [],
          networkHints: [{ id: 1, networkId: 10, position: '', formation: '' }],
        },
      },
    });
    expect(result.state).toBe('message-network');
    expect(formatMessageCallsignHintTooltipData(result)?.sections[0].items[0]).toContain('Alpha');
  });

  it('uses the union of all assigned networks for exact hints', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10, 20],
      networks,
      unitsMap,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'catalog',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 2,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [
            { id: 1, networkId: 10, position: 'alpha', formation: '' },
            { id: 2, networkId: 20, position: 'bravo', formation: '' },
            { id: 3, networkId: 30, position: 'other', formation: '' },
          ],
        },
      },
    });

    expect(result.state).toBe('message-network');
    expect(result.exactNetworkHints.map((hint) => hint.networkId)).toEqual([10, 20]);
    expect(formatMessageCallsignHintTooltipData(result)?.sections[0].items).toEqual([
      '🐷 alpha',
      '🐷 bravo',
    ]);
  });

  it('separates catalog and other-network message information', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: '',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [{ id: 2, networkId: 20, position: '', formation: '' }],
        },
      },
    });
    expect(result.state).toBe('unresolved');
    expect(formatMessageCallsignHintTooltipData(result)).toBeNull();
  });

  it('classifies missing and empty responses as unresolved', () => {
    for (const callsignInfoMap of [{}, { wolf: { callsign: 'wolf', res: [], networkHints: [] } }]) {
      const result = getMessageCallsignHintResult({
        callsign: 'wolf',
        networkIds: [],
        networks,
        callsignInfoMap,
      });
      expect(result.state).toBe('unresolved');
      expect(formatMessageCallsignHintTooltipData(result)).toBeNull();
    }
  });

  it('classifies catalog-only callsigns and keeps the catalog section', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'cmd',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });
    expect(result.state).toBe('unresolved');
    expect(formatMessageCallsignHintTooltipData(result)).toBeNull();
  });

  it('uses the catalog fallback for blank catalog rows', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: '',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });
    expect(result.state).toBe('catalog');
    expect(formatMessageCallsignHintTooltipData(result)?.sections[0].items).toEqual([
      'Позивний присутній у каталозі. Додатковий опис відсутній.',
    ]);
  });

  it('uses only callsign rows from the assigned networks regiment formation', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'same',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 2,
              networkIdsReportedIn: [],
            },
            {
              id: 2,
              callsign: 'wolf',
              position: 'other',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 3,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });

    expect(result.state).toBe('formation-catalog');
    expect(result.catalogRows.map((row) => row.id)).toEqual([1]);
  });

  it('requires populated ancestors to match the assigned formation', () => {
    const strictUnitsMap = {
      ...unitsMap,
      1: { ...unitsMap[1], corps: 'C1' },
      2: { ...unitsMap[2], corps: 'C1' },
      6: { ...unitsMap[2], id: 6, army: '' },
      7: { ...unitsMap[2], id: 7, corps: 'different-corps' },
    };
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      unitsMap: strictUnitsMap,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'subordinate',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 2,
              networkIdsReportedIn: [],
            },
            {
              id: 2,
              callsign: 'wolf',
              position: 'missing ancestor',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 6,
              networkIdsReportedIn: [],
            },
            {
              id: 3,
              callsign: 'wolf',
              position: 'conflicting ancestor',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 7,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });

    expect(result.catalogRows.map((row) => row.id)).toEqual([1]);
  });

  it('uses brigade scope when the assigned unit has no regiment', () => {
    const brigadeUnitsMap = {
      ...unitsMap,
      4: { ...unitsMap[1], id: 4, regiment: '', brigade: 'B-1' },
      5: { ...unitsMap[1], id: 5, regiment: 'R-2', brigade: 'B-1' },
    };
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [40],
      networks: [{ ...networks[0], id: 40, unitIds: [4] }],
      unitsMap: brigadeUnitsMap,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'brigade',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 5,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });

    expect(result.state).toBe('formation-catalog');
    expect(result.catalogRows.map((row) => row.id)).toEqual([1]);
  });

  it('does not create a fallback scope without a regiment or brigade', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [41],
      networks: [{ ...networks[0], id: 41, unitIds: [4] }],
      unitsMap: { ...unitsMap, 4: { ...unitsMap[1], id: 4, regiment: '', brigade: '' } },
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'catalog',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 2,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });

    expect(result.state).toBe('unresolved');
  });

  it('does not use unrestricted catalog rows when an assigned network has no unit', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [30],
      networks: [{ ...networks[0], id: 30, unitIds: [] }],
      unitsMap,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'catalog',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: 2,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [],
        },
      },
    });

    expect(result.state).toBe('unresolved');
    expect(formatMessageCallsignHintTooltipData(result)).toBeNull();
  });

  it('classifies other-network-only callsigns separately', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: [10],
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [],
          networkHints: [{ id: 2, networkId: 20, position: 'p', formation: 'f' }],
        },
      },
    });
    expect(result.state).toBe('unresolved');
    expect(result.exactNetworkHints).toEqual([]);
    expect(formatMessageCallsignHintTooltipData(result)).toBeNull();
  });

  it('treats network hints as other-network when message networks are missing', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networkIds: undefined,
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [],
          networkHints: [{ id: 1, networkId: 10, position: 'p', formation: 'f' }],
        },
      },
    });
    expect(result.state).toBe('catalog');
    expect(result.exactNetworkHints).toEqual([]);
    expect(result.otherNetworkHints).toHaveLength(1);
    expect(
      formatMessageCallsignHintTooltipData(result)?.sections.map((section) => section.header),
    ).toEqual(['Позивний присутній в інших мережах:']);
  });

  it('keeps catalog and other-network sections for unassigned messages', () => {
    const result = getMessageCallsignHintResult({
      callsign: 'wolf',
      networks,
      callsignInfoMap: {
        wolf: {
          callsign: 'wolf',
          res: [
            {
              id: 1,
              callsign: 'wolf',
              position: 'catalog',
              comment: '',
              unit1: '',
              unit2: '',
              unitId: null,
              networkIdsReportedIn: [],
            },
          ],
          networkHints: [{ id: 2, networkId: 20, position: 'network', formation: 'Bravo' }],
        },
      },
    });

    expect(
      formatMessageCallsignHintTooltipData(result)?.sections.map((section) => section.header),
    ).toEqual(['Позивні з каталогу:', 'Позивний присутній в інших мережах:']);
  });

  it('keeps only hints in the requested network scope', () => {
    const callsignInfo = {
      callsign: 'ВЕТЕР',
      res: [],
      networkHints: [
        { id: 1, networkId: 10, position: 'командир', formation: '4 мср' },
        { id: 2, networkId: 20, position: 'інша', formation: 'інша' },
      ],
    };

    expect(resolveNetworkCallsignHints([10], callsignInfo)).toEqual([callsignInfo.networkHints[0]]);
  });

  it('formats a network-only callsign hint', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: {
        ветер: {
          callsign: 'ВЕТЕР',
          res: [],
          networkHints: [
            {
              id: 1,
              networkId: 10,
              position: 'командир',
              formation: '4 мср',
            },
          ],
        },
      },
      callsign: 'ВЕТЕР',
    });

    expect(formatCallsignHintTooltip(result)).toBe(
      'Позивні підрозділів мережі:\n🐷 командир 4 мср',
    );
    expect(formatNetworkCallsignTooltipLine(result.prioritizedCallsigns[0] as never)).toBe(
      '🐷 командир 4 мср',
    );
  });

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
    expect(result.iconClass).toBe('info-circle');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1, 2]);
    expect(formatCallsignHintTooltip(result)).toBe(
      'Позивні з каталогу:\n🐷 командир 1 рота \n🐷 заступник 2 рота ',
    );
  });

  it('returns no tooltip in message context when exact message-network ids are absent', () => {
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
    expect(formatCallsignHintTooltip(result)).toBeNull();
  });

  it('returns no tooltip for catalog-only callsigns when message networks exist', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap: {
        ...unitsMap,
        99: {
          id: 99,
          company: '',
          battalion: '',
          regiment: '',
          division: '',
          army: 'Z',
          comment: '',
          name: 'Unmapped unit',
          active: true,
          createdAt: 0,
          createdBy: 'test',
        },
      },
      callsignInfoMap: createCallsignInfoMap({
        fox: [
          {
            id: 3,
            callsign: 'fox',
            position: 'начальник',
            comment: '',
            unit1: 'штаб',
            unit2: '',
            unitId: 99,
            networkIdsReportedIn: [30],
          },
        ],
      }),
      callsign: 'fox',
    });

    expect(result.strategy).toBe('none');
    expect(result.iconClass).toBe('');
    expect(result.prioritizedCallsigns).toEqual([]);
    expect(formatCallsignHintTooltip(result)).toBeNull();
  });

  it('returns network tooltip in message context and keeps only rows from message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap(
        {
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
        },
        [
          { id: 1, networkId: 10, position: 'командир', formation: '1 рота' },
          { id: 2, networkId: 20, position: 'заступник', formation: '2 рота' },
        ],
      ),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.iconClass).toBe('info-circle-fill');
    expect(
      result.prioritizedCallsigns.map((item) => 'networkId' in item && item.networkId),
    ).toEqual([10]);
    expect(formatCallsignHintTooltip(result)).toBe(
      'Позивні підрозділів мережі:\n🐷 командир 1 рота',
    );
  });

  it('treats empty message network ids the same as no message networks', () => {
    const result = getCallsignHintResult({
      hintContext: 'message',
      freq: null,
      networkIds: [],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap(
        {
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
        },
        [{ id: 1, networkId: 10, position: 'командир', formation: '1 рота' }],
      ),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('system');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1]);
  });

  it('returns a system tooltip when no network matches the frequency context', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '999.999',
      networkIds: [10],
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap(
        {
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
        },
        [{ id: 1, networkId: 10, position: 'командир взводу', formation: '3 тр' }],
      ),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('system');
    expect(result.iconClass).toBe('info-circle');
    expect(result.prioritizedCallsigns.map((item) => item.id)).toEqual([1, 2]);
  });

  it('returns network tooltip in frequency context when the callsign unit is same or child of the network unit', () => {
    const result = getCallsignHintResult({
      hintContext: 'frequency',
      freq: '100.000',
      networks,
      unitsMap,
      callsignInfoMap: createCallsignInfoMap(
        {
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
        },
        [{ id: 1, networkId: 10, position: 'командир взводу', formation: '3 тр' }],
      ),
      callsign: 'wolf',
    });

    expect(result.strategy).toBe('network');
    expect(result.iconClass).toBe('info-circle-fill');
    expect(
      result.prioritizedCallsigns.map((item) => 'networkId' in item && item.networkId),
    ).toEqual([10]);
    expect(formatCallsignHintTooltip(result)).toBe(
      'Позивні підрозділів мережі:\n🐷 командир взводу 3 тр',
    );
  });

  it('does not relate matching lower hierarchies from another region', () => {
    const unitsInDifferentRegions = {
      ...unitsMap,
      4: {
        ...unitsMap[2],
        id: 4,
        armyRegion: 'R2',
        name: 'Unit in another region',
      },
    };

    expect(
      isCallsignRelatedToNetworks(
        [
          {
            id: 4,
            callsign: 'wolf',
            position: 'командир',
            comment: '',
            unit1: 'інший регіон',
            unit2: '',
            unitId: 4,
            networkIdsReportedIn: [999],
          },
        ],
        [networks[0]],
        unitsInDifferentRegions,
      ),
    ).toBe(false);
  });

  it('returns no tooltip when a catalog-only callsign is absent from the frequency network', () => {
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

    expect(result.strategy).toBe('none');
    expect(result.iconClass).toBe('');
    expect(result.prioritizedCallsigns).toEqual([]);
    expect(formatCallsignHintTooltip(result)).toBeNull();
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

    expect(formatCallsignHintTooltip(result)).toBe(
      'Позивні з каталогу:\n🐷 перший u1 \n🐷 другий u2 ',
    );
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
