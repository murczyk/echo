/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import type { KnownCallsignShortRes, NetworkCallsign, NetworkCallsignRes, Source } from '../../../../Bindings';
import {
  buildNetworkCallsignRowViews,
  buildNetworkCallsignTabData,
  countNetworkCallsignStatusRows,
  createDefaultNetworkCallsignDrawerForm,
  createNetworkCallsignDrawerForm,
  createNetworkCallsignActivityMap,
  flattenCatalogCallsignRows,
  normalizeCallsignDisplay,
  mergeNetworkCallsigns,
  removeKnownCallsignIdsFromNetworkCallsignGroups,
} from './network-callsigns';

function createNetworkCallsign(overrides: Partial<NetworkCallsign> = {}): NetworkCallsign {
  return {
    id: 1,
    networkId: 10,
    callsign: 'сокіл-1',
    knownCallsignId: null,
    position: 'Командир',
    comment: '',
    unitId: 101,
    unitName: '1 мб',
    sourceId: 1,
    radioFreq: null,
    createdAt: 1710000000000,
    active: true,
    developing: false,
    messageCount: 5,
    lastDatetime: 1710000000000,
    freqs: ['145.1000'],
    unitDeveloping: false,
    mainRadioStation: false,
    commandControl: false,
    ...overrides,
  };
}

function createKnownCallsign(overrides: Partial<KnownCallsignShortRes> = {}): KnownCallsignShortRes {
  return {
    id: 20,
    callsign: 'Барс-4',
    position: 'ЗКМ',
    comment: 'Збiг',
    unitId: 201,
    unitName: 'арт. дивізіон',
    sourceName: 'Каталог 2024',
    createdAt: 1710100000000,
    ...overrides,
  };
}

function createCatalogGroup(overrides: Partial<NetworkCallsignRes> & { knownCallsigns?: KnownCallsignShortRes[] } = {}): NetworkCallsignRes {
  return {
    callsign: 'барс-4',
    knownCallsigns: [],
    messageCount: 8,
    lastDatetime: 1710200000000,
    networkNames: null,
    isOld: false,
    isInDictionary: false,
    freqs: ['145.2000'],
    ...overrides,
  };
}

describe('network-callsigns helpers', () => {
  it('uppercases callsign display values', () => {
    expect(normalizeCallsignDisplay('  сокіл-1  ')).toBe('СОКІЛ-1');
  });

  it('builds network rows and counts statuses', () => {
    const sourcesById = new Map<number, Source>([[1, { id: 1, name: 'Пеленг', createdAt: 0 }]]);
    const rows = buildNetworkCallsignRowViews(
      [
        createNetworkCallsign({ id: 1, active: true, knownCallsignId: null, developing: false }),
        createNetworkCallsign({ id: 2, callsign: 'тигр-7', active: true, knownCallsignId: null, developing: true }),
        createNetworkCallsign({ id: 3, callsign: 'вовк-1', active: true, knownCallsignId: 44, developing: false }),
        createNetworkCallsign({ id: 4, callsign: 'орел-5', active: false, knownCallsignId: null, developing: false }),
      ],
      sourcesById,
    );

    expect(rows.map((row) => [row.callsign, row.statusLabel])).toEqual([
      ['СОКІЛ-1', 'Верифіковано'],
      ['ТИГР-7', 'В дорозвідці'],
      ['ВОВК-1', 'Каталог'],
      ['ОРЕЛ-5', 'Невідомо'],
    ]);
    expect(countNetworkCallsignStatusRows(rows)).toEqual({
      all: 4,
      verified: 1,
      developing: 1,
      catalog: 1,
      unknown: 1,
    });
  });

  it('preserves both network markers in drawer forms', () => {
    const row = createNetworkCallsign({
      id: 8,
      mainRadioStation: true,
      commandControl: true,
    });

    expect(createDefaultNetworkCallsignDrawerForm(10, 4)).toEqual({
      id: null,
      networkId: 10,
      callsign: '',
      position: '',
      comment: '',
      sourceId: null,
      radioFreq: '',
      unitId: 4,
      unitDeveloping: false,
      developing: false,
      mainRadioStation: false,
      commandControl: false,
    });
    expect(createNetworkCallsignDrawerForm(10, row)).toMatchObject({
      id: 8,
      networkId: 10,
      mainRadioStation: true,
      commandControl: true,
    });
  });

  it('flattens catalog rows and excludes callsigns already present in the network', () => {
    const groups: NetworkCallsignRes[] = [
      createCatalogGroup({
        callsign: 'барс-4',
        knownCallsigns: [createKnownCallsign()],
        messageCount: 11,
      }),
      createCatalogGroup({
        callsign: 'сокіл-1',
        knownCallsigns: [],
        messageCount: 19,
      }),
      createCatalogGroup({
        callsign: 'гієна-4',
        knownCallsigns: [],
        messageCount: 9,
        isInDictionary: true,
      }),
    ];
    const activityMap = createNetworkCallsignActivityMap([
      { callsign: 'барс-4', activity: { messageCount: 12, lastDatetime: 1710201000000, freqs: ['145.4000'] } },
      { callsign: 'гієна-4', activity: { messageCount: 9, lastDatetime: 1710300000000, freqs: ['145.5000'] } },
    ]);
    const derived = buildNetworkCallsignTabData(groups, activityMap, [createNetworkCallsign({ callsign: 'сокіл-1' })]);

    expect(derived.catalogCallsignGroups).toHaveLength(1);
    expect(derived.catalogCallsignGroups[0].callsign).toBe('БАРС-4');
    expect(flattenCatalogCallsignRows(derived.catalogCallsignGroups)).toEqual([
      {
        id: 20,
        knownCallsignId: 20,
        callsign: 'БАРС-4',
        position: 'ЗКМ',
        unitName: 'арт. дивізіон',
        lastDatetime: 1710201000000,
        messageCount: 12,
        comment: 'Збiг',
        dateBoundAt: 1710100000000,
        sourceName: 'Каталог 2024',
        networkCallsign: 'БАРС-4',
        freqs: ['145.4000'],
      },
    ]);
    expect(derived.unknownInterceptedCallsigns).toHaveLength(1);
    expect(derived.unknownInterceptedCallsigns[0].callsign).toBe('ГІЄНА-4');
    expect(derived.unknownInterceptedCallsigns[0].messageCount).toBe(9);
  });

  it('removes known callsign ids from groups without dropping other rows', () => {
    const groups: NetworkCallsignRes[] = [
      createCatalogGroup({
        callsign: 'барс-4',
        knownCallsigns: [createKnownCallsign({ id: 20 }), createKnownCallsign({ id: 21, callsign: 'Барс-4-2' })],
      }),
      createCatalogGroup({
        callsign: 'гієна-4',
        knownCallsigns: [createKnownCallsign({ id: 30, callsign: 'Гієна-4' })],
      }),
    ];

    expect(removeKnownCallsignIdsFromNetworkCallsignGroups(groups, [20])).toEqual([
      {
        ...groups[0],
        knownCallsigns: [createKnownCallsign({ id: 21, callsign: 'Барс-4-2' })],
      },
      groups[1],
    ]);
  });

  it('merges added network callsigns by id', () => {
    const merged = mergeNetworkCallsigns(
      [createNetworkCallsign({ id: 1, callsign: 'сокіл-1' })],
      [createNetworkCallsign({ id: 2, callsign: 'барс-4' }), createNetworkCallsign({ id: 1, callsign: 'сокіл-1-оновлений' })],
    );

    expect(merged).toEqual([
      createNetworkCallsign({ id: 1, callsign: 'сокіл-1-оновлений' }),
      createNetworkCallsign({ id: 2, callsign: 'барс-4' }),
    ]);
  });
});
