/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';

import type { KnownCallsignShortRes, NetworkCallsign, NetworkCallsignRes, Source } from '../../../../Bindings';
import type { NetworkCallsignRowView } from './network-callsigns';
import {
  buildNetworkCallsignRowViews,
  filterCatalogCallsignGroups,
  filterInterceptedCallsigns,
  filterNetworkCallsignRows,
  buildNetworkCallsignTabData,
  countNetworkCallsignStatusRows,
  createDefaultNetworkCallsignDrawerForm,
  createNetworkCallsignDrawerForm,
  createNetworkCallsignActivityMap,
  getNetworkCallsignMarkerMode,
  getNetworkCallsignMarkerState,
  getNetworkCallsignStatusLabel,
  getNetworkCallsignDrawerSaveError,
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
      ['СОКІЛ-1', 'Каталог'],
      ['ТИГР-7', 'В дорозвідці'],
      ['ВОВК-1', 'Каталог'],
      ['ОРЕЛ-5', 'Невідомо'],
    ]);
    expect(countNetworkCallsignStatusRows(rows)).toEqual({
      all: 4,
      developing: 1,
      catalog: 2,
      unknown: 1,
    });
  });

  it('defaults new drawer forms to developing without a unit', () => {
    expect(createDefaultNetworkCallsignDrawerForm(10, null)).toEqual({
      id: null,
      networkId: 10,
      callsign: '',
      position: '',
      comment: '',
      sourceId: null,
      radioFreq: '',
      unitId: null,
      unitDeveloping: false,
      developing: true,
      mainRadioStation: false,
      commandControl: false,
    });
  });

    it('preserves primary marker and enforces exclusivity in drawer forms', () => {
    const row = {
      ...createNetworkCallsign({
        id: 8,
        mainRadioStation: true,
        commandControl: true,
      }),
      status: 'catalog',
      statusLabel: getNetworkCallsignStatusLabel('catalog'),
      sourceName: 'Каталог 2024',
    } as NetworkCallsignRowView;

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
      developing: true,
      mainRadioStation: false,
      commandControl: false,
    });
      expect(createNetworkCallsignDrawerForm(10, row)).toMatchObject({
        id: 8,
        networkId: 10,
        mainRadioStation: false,
        commandControl: true,
      });
      // when both flags are present on the source row, prefer `commandControl` in the drawer
      expect(getNetworkCallsignMarkerMode(row)).toBe('mainRadioStation');
    expect(getNetworkCallsignMarkerState('mainRadioStation')).toEqual({ mainRadioStation: true, commandControl: false });
    expect(getNetworkCallsignMarkerState('commandControl')).toEqual({ mainRadioStation: false, commandControl: true });
    expect(getNetworkCallsignMarkerState('none')).toEqual({ mainRadioStation: false, commandControl: false });
  });

    it('never allows both markers to be true in drawer forms', () => {
      const rowBoth = {
        ...createNetworkCallsign({ mainRadioStation: true, commandControl: true }),
        status: 'catalog',
        statusLabel: getNetworkCallsignStatusLabel('catalog'),
        sourceName: 'Каталог 2024',
      } as NetworkCallsignRowView;

      const form = createNetworkCallsignDrawerForm(10, rowBoth);
      expect(Boolean(form.mainRadioStation && form.commandControl)).toBe(false);
    });

  it('requires a callsign, source and RO radio frequency before saving a drawer form', () => {
    expect(getNetworkCallsignDrawerSaveError(null)).toBeNull();
    expect(getNetworkCallsignDrawerSaveError({ ...createDefaultNetworkCallsignDrawerForm(10, null), callsign: '  ' })).toBe('Позивний є обовʼязковим');
    expect(getNetworkCallsignDrawerSaveError({ ...createDefaultNetworkCallsignDrawerForm(10, null), callsign: 'СОКІЛ' })).toBe('Джерело є обовʼязковим');
    expect(
      getNetworkCallsignDrawerSaveError({
        ...createDefaultNetworkCallsignDrawerForm(10, null),
        callsign: 'СОКІЛ',
        sourceId: 2,
      }),
    ).toBe('Для джерела "РО" частота є обовʼязковою');
    expect(
      getNetworkCallsignDrawerSaveError({
        ...createDefaultNetworkCallsignDrawerForm(10, null),
        callsign: 'СОКІЛ',
        sourceId: 2,
        radioFreq: '145.5000',
      }),
    ).toBeNull();
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

  it('shows catalog-linked rows as developing when the developing flag is set', () => {
    const sourcesById = new Map<number, Source>();
    const rows = buildNetworkCallsignRowViews(
      [
        createNetworkCallsign({ id: 11, knownCallsignId: 44, developing: true, active: true }),
      ],
      sourcesById,
    );

    expect(rows[0].status).toBe('developing');
    expect(rows[0].statusLabel).toBe('В дорозвідці');
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

  it('filters network, catalog and intercepted callsigns by search query', () => {
    const networkRows = [
      {
        ...buildNetworkCallsignRowViews([createNetworkCallsign({ callsign: 'сокіл-1', comment: 'дозвіл' })], new Map())[0],
        sourceName: 'Пеленг',
      },
      {
        ...buildNetworkCallsignRowViews([createNetworkCallsign({ callsign: 'барс-4', comment: 'резерв' })], new Map())[0],
        sourceName: 'Каталог',
      },
    ];
    const catalogGroups = [
      createCatalogGroup({
        callsign: 'барс-4',
        knownCallsigns: [createKnownCallsign({ callsign: 'Барс-4', comment: 'Збiг' })],
      }),
    ];
    const intercepted = [
      {
        callsign: 'орел-5',
        messageCount: 12,
        lastDatetime: 1710200000000,
        freqs: ['145.1000'],
        isOld: false,
        isInDictionary: false,
        activity: { messageCount: 12, lastDatetime: 1710200000000, freqs: ['145.1000'] },
      },
    ];

    expect(filterNetworkCallsignRows(networkRows, 'дозвіл')).toHaveLength(1);
    expect(filterCatalogCallsignGroups(catalogGroups, 'збiг')).toHaveLength(1);
    expect(filterInterceptedCallsigns(intercepted, '145.1')).toHaveLength(1);
  });
});
