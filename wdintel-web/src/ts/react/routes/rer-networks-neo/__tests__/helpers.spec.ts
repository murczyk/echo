// @test-scope parser: network filter, request, status, and activity-state normalization fixtures
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import { describe, expect, it, vi } from 'vitest';

import type { Network } from '../../../../../Bindings';
import { NETWORK_STATUS_ACTIVE } from '../../rer-network-details-neo/network-status';
import type { SelectedSidebarUnitFilter } from '../../rer-callsigns-neo/types';
import {
  buildActivityBars,
  buildNetworkRowView,
  buildNetworkFrequencyDisplayGroups,
  buildNetworkFrequencyPopupGroups,
  buildNetworkLabel,
  buildNetworksListReq,
  buildNetworksReportReq,
  buildNetworksStatusCountsReq,
  buildNetworksSortBy,
  getActivityBarHeight,
  getNetworkStatusDescriptor,
  getNetworkStatusLabel,
  matchesAorFilter,
  NO_AOR_FILTER_VALUE,
  NETWORK_STATUS_ACTIVE_COLOR,
  NETWORK_STATUS_ARCHIVED_COLOR,
  NETWORK_STATUS_INACTIVE_COLOR,
  sanitizeNetworkColumnFilters,
  resolveAorFilterSelectOptions,
  sortNetworkAorsForDisplay,
} from '../helpers';

dayjs.extend(utc);

const EMPTY_NETWORK_HIERARCHY_FILTER_FIELDS = {
  filterUnitArmyRegion: null,
  filterUnitMilitaryDistrict: null,
  filterUnitArmy: null,
  filterUnitCorps: null,
  filterUnitDivision: null,
  filterUnitBrigade: null,
  filterUnitRegiment: null,
  filterUnitBattalion: null,
  filterUnitCompany: null,
  filterUnitPlatoon: null,
  filterUnitSquad: null,
  filterUnitSection: null,
  filterUnitTeamOrCrew: null,
  filterUnitOther: null,
} as const;

describe('rer-networks-neo AOR filters', () => {
  it('keeps the no-AOR option first and the all-band option second in the filter menu', () => {
    const options = resolveAorFilterSelectOptions([
      { id: 3, name: 'Вся смуга' } as any,
      { id: 2, name: 'Бета' } as any,
      { id: 1, name: 'Альфа' } as any,
    ]);

    expect(options).toEqual([
      { label: '—', value: NO_AOR_FILTER_VALUE },
      { label: 'Вся смуга', value: '3' },
      { label: 'Альфа', value: '1' },
      { label: 'Бета', value: '2' },
    ]);
    expect(new Set(options.map((option) => option.value)).size).toBe(options.length);
  });

  it('orders drawer and filter AORs with all-band first and regular bands by Ukrainian locale', () => {
    expect(
      sortNetworkAorsForDisplay([
        { id: 2, name: 'Бета' } as any,
        { id: 1, name: 'Альфа' } as any,
        { id: 3, name: 'Вся смуга' } as any,
      ]).map((aor) => aor.name),
    ).toEqual(['Вся смуга', 'Альфа', 'Бета']);
  });

  it('matches no-AOR rows and regular AOR rows the same way as the classic filter', () => {
    const emptyNetwork = { aorIds: [] } as Network;
    const mixedNetwork = { aorIds: [1, 9] } as Network;
    const otherNetwork = { aorIds: [7] } as Network;

    expect(matchesAorFilter(emptyNetwork, [NO_AOR_FILTER_VALUE])).toBe(true);
    expect(matchesAorFilter(mixedNetwork, [NO_AOR_FILTER_VALUE])).toBe(false);
    expect(matchesAorFilter(mixedNetwork, ['1', NO_AOR_FILTER_VALUE])).toBe(true);
    expect(matchesAorFilter(otherNetwork, ['1', NO_AOR_FILTER_VALUE])).toBe(false);
    expect(matchesAorFilter(otherNetwork, [])).toBe(true);
  });

  it('builds the classic-style network label with units and investigation state', () => {
    expect(
      buildNetworkLabel({ name: 'Alpha', unitIds: [] } as Network, ['1 АК', '2 ОМБр'], true),
    ).toBe('р/м Alpha 1 АК, 2 ОМБр в дорозвідці');
  });

  it('keeps the row label separate from the developing marker', () => {
    const row = buildNetworkRowView(
      {
        id: 1,
        name: 'Alpha',
        unitIds: [1],
        freqs: [],
        aorIds: [],
        location: '',
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
        status: NETWORK_STATUS_ACTIVE,
      } as Network,
      new Map([
        [1, { id: 1, name: '1 АК', army: '', division: '', regiment: '', battalion: '' } as any],
      ]),
      new Map(),
      new Map(),
    );

    expect(row.networkLabel).toBe('р/м Alpha 1 АК');
    expect(row.developing).toBe(false);
  });

  // Regression for ECHO-3207: the activity column must not display catalog edit time.
  it('projects last activity from the latest interception timestamp', () => {
    const lastActivityAt = Date.UTC(2026, 8, 7, 10, 15);
    const row = buildNetworkRowView(
      {
        id: 1,
        name: 'Alpha',
        unitIds: [],
        freqs: [],
        aorIds: [],
        location: '',
        radioStation: null,
        createdAt: 0,
        purpose: null,
        operationMode: null,
        operationType: null,
        operationPeriod: null,
        doNotArchive: false,
        lastActivityAt,
        lastUpdatedAt: Date.UTC(2026, 7, 24, 8, 0),
        lastUpdatedBy: 'Оператор',
        activeFrom: null,
        activeTo: null,
        postIds: [],
        descriptions: [],
        deleted: false,
        status: NETWORK_STATUS_ACTIVE,
      },
      new Map(),
      new Map(),
      new Map(),
    );

    expect(row.lastActivityLabel).toBe(dayjs(lastActivityAt).format('DD.MM.YY HH:mm'));
    expect(row.lastActivityDetail).toBe('Останнє перехоплення');
    expect(row.lastActivityTooltip).toContain(row.lastActivityLabel);

    const recentRow = buildNetworkRowView(
      { ...row.network, lastActivityAt: Date.now() - 10 * 60 * 1000 },
      new Map(),
      new Map(),
      new Map(),
    );
    expect(recentRow.lastActivityLabel).toBe('Активна останні 15хв');
    expect(recentRow.lastActivityTooltip).toContain(
      dayjs(recentRow.network.lastActivityAt).format('DD.MM.YY HH:mm'),
    );

    const now = Date.UTC(2026, 8, 13, 12, 0);
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(now);
    try {
      const atBoundary = buildNetworkRowView(
        { ...row.network, lastActivityAt: now - 15 * 60 * 1000 },
        new Map(),
        new Map(),
        new Map(),
      );
      const outsideBoundary = buildNetworkRowView(
        { ...row.network, lastActivityAt: now - 15 * 60 * 1000 - 1 },
        new Map(),
        new Map(),
        new Map(),
      );
      expect(atBoundary.lastActivityLabel).toBe('Активна останні 15хв');
      expect(outsideBoundary.lastActivityLabel).not.toBe('Активна останні 15хв');
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('maps the active network list request to classic active-only flags', () => {
    expect(
      buildNetworksListReq({
        searchText: '  alpha  ',
        selectedSidebarUnitFilter: null,
        selectedUnitLabel: '  3 АК  ',
        showOnlyInvestigating: true,
        status: 'active',
        columnFilters: [
          { id: 'network', value: '  Alpha  ' },
          { id: 'freqs', value: '  128.5  ' },
          { id: 'location', value: '  Kyiv  ' },
          { id: 'aors', value: ['1', NO_AOR_FILTER_VALUE] },
        ],
        sorting: [{ id: 'network', desc: true }],
        limit: 50,
        offset: 100,
      }),
    ).toEqual({
      filterFreq: '128.5',
      filterUnit: '3 АК',
      ...EMPTY_NETWORK_HIERARCHY_FILTER_FIELDS,
      filterText: 'alpha',
      filterName: 'Alpha',
      filterLocation: 'Kyiv',
      showOnlyFurtherInverstigation: true,
      showInactive: false,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: [1, -1],
      ids: null,
      limit: 50,
      offset: 100,
      sortBy: ['NameDesc'],
    });
  });

  it('maps the sidebar leaf filter to a unit-name-only request', () => {
    const selectedSidebarUnitFilter: SelectedSidebarUnitFilter = {
      kind: 'leaf',
      label: '1 АК',
      unitName: '1 АК',
    };

    expect(
      buildNetworksListReq({
        searchText: '',
        selectedSidebarUnitFilter,
        selectedUnitLabel: 'ignored',
        showOnlyInvestigating: false,
        status: 'all',
        columnFilters: [],
        sorting: [],
        limit: null,
        offset: null,
      }),
    ).toEqual(
      expect.objectContaining({
        filterUnit: '1 АК',
        filterUnitArmyRegion: null,
        filterUnitMilitaryDistrict: null,
        filterUnitArmy: null,
        filterUnitCorps: null,
        filterUnitDivision: null,
        filterUnitBrigade: null,
        filterUnitRegiment: null,
        filterUnitBattalion: null,
        filterUnitCompany: null,
        filterUnitPlatoon: null,
        filterUnitSquad: null,
        filterUnitSection: null,
        filterUnitTeamOrCrew: null,
        filterUnitOther: null,
      }),
    );
  });

  it('maps the sidebar group filter to hierarchy-only request fields', () => {
    const selectedSidebarUnitFilter: SelectedSidebarUnitFilter = {
      kind: 'group',
      label: '1 АК',
      hierarchy: {
        armyRegion: 'R',
        militaryDistrict: 'D',
        army: '1',
        corps: 'C',
        division: '2',
        brigade: 'BR',
        regiment: '3',
        battalion: '4',
        company: 'CO',
        platoon: 'P',
        squad: 'SQ',
        section: 'S',
        teamOrCrew: 'T',
        other: 'O',
      },
    };

    expect(
      buildNetworksListReq({
        searchText: '',
        selectedSidebarUnitFilter,
        selectedUnitLabel: 'ignored',
        showOnlyInvestigating: false,
        status: 'all',
        columnFilters: [],
        sorting: [],
        limit: null,
        offset: null,
      }),
    ).toEqual(
      expect.objectContaining({
        filterUnit: null,
        filterUnitArmyRegion: 'R',
        filterUnitMilitaryDistrict: 'D',
        filterUnitArmy: '1',
        filterUnitCorps: 'C',
        filterUnitDivision: '2',
        filterUnitBrigade: 'BR',
        filterUnitRegiment: '3',
        filterUnitBattalion: '4',
        filterUnitCompany: 'CO',
        filterUnitPlatoon: 'P',
        filterUnitSquad: 'SQ',
        filterUnitSection: 'S',
        filterUnitTeamOrCrew: 'T',
        filterUnitOther: 'O',
      }),
    );
  });

  it('preserves empty group hierarchy values', () => {
    const selectedSidebarUnitFilter: SelectedSidebarUnitFilter = {
      kind: 'group',
      label: '1 АК',
      hierarchy: {
        armyRegion: null,
        militaryDistrict: null,
        army: '',
        corps: undefined,
        division: null,
        brigade: undefined,
        regiment: undefined,
        battalion: '4',
        company: undefined,
        platoon: undefined,
        squad: undefined,
        section: undefined,
        teamOrCrew: undefined,
        other: undefined,
      },
    };

    expect(
      buildNetworksListReq({
        searchText: '',
        selectedSidebarUnitFilter,
        selectedUnitLabel: 'ignored',
        showOnlyInvestigating: false,
        status: 'all',
        columnFilters: [],
        sorting: [],
        limit: null,
        offset: null,
      }),
    ).toEqual(
      expect.objectContaining({
        filterUnit: null,
        filterUnitArmyRegion: null,
        filterUnitMilitaryDistrict: null,
        filterUnitArmy: '',
        filterUnitDivision: null,
        filterUnitRegiment: null,
        filterUnitBattalion: '4',
      }),
    );
  });

  it('maps the AOR, frequency, and location sorts to backend variants', () => {
    expect(buildNetworksSortBy([{ id: 'aors', desc: false }])).toEqual(['AorAsc']);
    expect(buildNetworksSortBy([{ id: 'aors', desc: true }])).toEqual(['AorDesc']);
    expect(buildNetworksSortBy([{ id: 'freqs', desc: false }])).toEqual(['FreqAsc']);
    expect(buildNetworksSortBy([{ id: 'freqs', desc: true }])).toEqual(['FreqDesc']);
    expect(buildNetworksSortBy([{ id: 'location', desc: false }])).toEqual(['LocationAsc']);
    expect(buildNetworksSortBy([{ id: 'location', desc: true }])).toEqual(['LocationDesc']);
  });

  it('maps the default status request to classic non-archived flags', () => {
    expect(
      buildNetworksListReq({
        searchText: '',
        selectedSidebarUnitFilter: null,
        selectedUnitLabel: null,
        showOnlyInvestigating: false,
        status: 'all',
        columnFilters: [
          { id: 'network', value: '  Alpha  ' },
          { id: 'freqs', value: '  128.5  ' },
          { id: 'location', value: '  Kyiv  ' },
        ],
        sorting: [],
        limit: null,
        offset: null,
      }),
    ).toEqual({
      filterFreq: '128.5',
      filterUnit: null,
      ...EMPTY_NETWORK_HIERARCHY_FILTER_FIELDS,
      filterText: null,
      filterName: 'Alpha',
      filterLocation: 'Kyiv',
      showOnlyFurtherInverstigation: null,
      showInactive: true,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: null,
      ids: null,
      limit: null,
      offset: null,
      sortBy: ['NameAsc'],
    });
  });

  it('builds the filtered top report request without paging', () => {
    expect(
      buildNetworksReportReq({
        searchText: 'alpha',
        selectedSidebarUnitFilter: null,
        selectedUnitLabel: '3 АК',
        showOnlyInvestigating: false,
        status: 'active',
        columnFilters: [
          { id: 'network', value: 'Alpha' },
          { id: 'freqs', value: '128.5' },
          { id: 'location', value: 'Kyiv' },
        ],
        sorting: [{ id: 'network', desc: false }],
      }),
    ).toEqual({
      filterFreq: '128.5',
      filterUnit: '3 АК',
      ...EMPTY_NETWORK_HIERARCHY_FILTER_FIELDS,
      filterText: 'alpha',
      filterName: 'Alpha',
      filterLocation: 'Kyiv',
      showOnlyFurtherInverstigation: null,
      showInactive: false,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: null,
      ids: null,
      limit: null,
      offset: null,
      sortBy: ['NameAsc'],
    });
  });

  it('builds the backend status count request without a status chip filter', () => {
    expect(
      buildNetworksStatusCountsReq({
        searchText: 'alpha',
        selectedSidebarUnitFilter: null,
        selectedUnitLabel: '3 АК',
        showOnlyInvestigating: true,
        columnFilters: [
          { id: 'network', value: 'Alpha' },
          { id: 'freqs', value: '128.5' },
          { id: 'location', value: 'Kyiv' },
          { id: 'aors', value: ['1'] },
          { id: 'activity', value: 'ignored' },
          { id: 'lastActivity', value: 'ignored' },
        ],
      }),
    ).toEqual({
      filterFreq: '128.5',
      filterUnit: '3 АК',
      ...EMPTY_NETWORK_HIERARCHY_FILTER_FIELDS,
      filterText: 'alpha',
      filterName: 'Alpha',
      filterLocation: 'Kyiv',
      showOnlyFurtherInverstigation: true,
      showInactive: true,
      showOnlyDeleted: false,
      statusFilter: null,
      aorIds: [1],
      ids: null,
      limit: null,
      offset: null,
      sortBy: null,
    });
  });

  it('maps network table sorting to backend variants', () => {
    expect(buildNetworksSortBy([{ id: 'network', desc: false }])).toEqual(['NameAsc']);
    expect(buildNetworksSortBy([{ id: 'network', desc: true }])).toEqual(['NameDesc']);
    expect(buildNetworksSortBy([{ id: 'lastActivity', desc: false }])).toEqual(['NameAsc']);
    expect(buildNetworksSortBy([{ id: 'lastActivity', desc: true }])).toEqual(['NameAsc']);
    expect(buildNetworksSortBy([{ id: 'activity', desc: false }])).toEqual(['NameAsc']);
    expect(buildNetworksSortBy([{ id: 'unknown', desc: false } as never])).toEqual(['NameAsc']);
    expect(buildNetworksSortBy([])).toEqual(['NameAsc']);
  });

  it('sanitizes restored column filters to known ids and safe value shapes', () => {
    expect(
      sanitizeNetworkColumnFilters([
        { id: 'network', value: '  Alpha  ' },
        { id: 'aors', value: ['1', null, NO_AOR_FILTER_VALUE, { bad: true }] as never },
        { id: 'freqs', value: '  128.5  ' },
        { id: 'location', value: '  Kyiv  ' },
        { id: 'activity', value: 42 as never },
        { id: 'lastActivity', value: '2026-06-01' },
        { id: 'unknown', value: 'keep? no' },
      ] as never),
    ).toEqual([
      { id: 'network', value: 'Alpha' },
      { id: 'aors', value: ['1', NO_AOR_FILTER_VALUE] },
      { id: 'freqs', value: '128.5' },
      { id: 'location', value: 'Kyiv' },
    ]);
  });

  it('splits frequency rows into active and inactive groups with separate overflow counts', () => {
    expect(
      buildNetworkFrequencyDisplayGroups({
        activeFrequencies: [
          { id: 1, freq: '128.5000', deleted: false, activeTo: null } as never,
          { id: 2, freq: '124.0000', deleted: false, activeTo: null } as never,
          { id: 3, freq: '123.0000', deleted: false, activeTo: null } as never,
        ],
        inactiveFrequencies: [{ id: 4, freq: '130.0000', deleted: true, activeTo: 1 } as never],
      } as never),
    ).toEqual([
      {
        title: 'Активні',
        frequencies: [
          { id: 1, freq: '128.5000', deleted: false, activeTo: null },
          { id: 2, freq: '124.0000', deleted: false, activeTo: null },
        ],
        hiddenCount: 1,
        isInactive: false,
      },
      {
        title: 'Неактивні',
        frequencies: [{ id: 4, freq: '130.0000', deleted: true, activeTo: 1 }],
        hiddenCount: 0,
        isInactive: true,
      },
    ]);
  });

  it('keeps popup frequency groups untruncated', () => {
    const row = {
      activeFrequencies: [
        { id: 1, freq: '128.5000', deleted: false, activeTo: null } as never,
        { id: 2, freq: '124.0000', deleted: false, activeTo: null } as never,
        { id: 3, freq: '123.0000', deleted: false, activeTo: null } as never,
      ],
      inactiveFrequencies: [{ id: 4, freq: '130.0000', deleted: true, activeTo: 1 } as never],
    } as never;

    expect(buildNetworkFrequencyPopupGroups(row)).toEqual([
      {
        title: 'Активні',
        frequencies: row.activeFrequencies,
        hiddenCount: 0,
        isInactive: false,
      },
      {
        title: 'Неактивні',
        frequencies: row.inactiveFrequencies,
        hiddenCount: 0,
        isInactive: true,
      },
    ]);
  });

  // Regression for ECHO-3207: a stale latest bucket must not shift the chart away from today.
  it('builds activity bars from backend day keys and anchors the range at today', () => {
    const rangeEndMs = 1781136000000;
    const bars = buildActivityBars(
      {
        1780444800000: { foo: 2, bar: 1 },
        1780531200000: { foo: 4, bar: 1 },
        1780963200000: { foo: 7, bar: 4 },
      },
      rangeEndMs,
    );

    expect(bars).toHaveLength(10);
    expect(bars.at(-1)?.title).toBe(dayjs.utc(rangeEndMs).format('DD.MM'));
    expect(bars.at(-1)?.value).toBe(0);
    expect(bars.at(-3)?.value).toBe(11);
    expect(bars.some((bar) => bar.value === 3)).toBe(true);
    expect(bars.some((bar) => bar.value === 5)).toBe(true);
  });

  it('uses the Kyiv calendar day for the activity range', () => {
    const kyivNextDayMs = Date.UTC(2026, 8, 8);
    const bars = buildActivityBars({ [kyivNextDayMs]: { foo: 1 } }, Date.UTC(2026, 8, 7, 22, 30));

    expect(bars.at(-1)).toEqual({ value: 1, title: '08.09' });
  });

  it('scales activity bar heights within row-local bounds', () => {
    expect(getActivityBarHeight(0, 11)).toBe(6);
    expect(getActivityBarHeight(11, 11)).toBe(34);
    expect(getActivityBarHeight(5, 11)).toBeGreaterThanOrEqual(8);
    expect(getActivityBarHeight(5, 11)).toBeLessThan(34);
    expect(getActivityBarHeight(155, 11)).toBe(34);
  });

  it('derives network status descriptors from deleted and active-to state', () => {
    expect(
      getNetworkStatusDescriptor({
        deleted: false,
        activeTo: null,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toEqual({
      label: 'Активна',
      color: NETWORK_STATUS_ACTIVE_COLOR,
      key: 'active',
    });

    expect(
      getNetworkStatusDescriptor({
        deleted: false,
        activeTo: 1,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toEqual({
      label: 'Неактивна',
      color: NETWORK_STATUS_INACTIVE_COLOR,
      key: 'inactive',
    });

    expect(
      getNetworkStatusDescriptor({
        deleted: true,
        activeTo: null,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toEqual({
      label: 'Архівна',
      color: NETWORK_STATUS_ARCHIVED_COLOR,
      key: 'archived',
    });
  });

  it('keeps the status label helper aligned with the descriptor labels', () => {
    expect(
      getNetworkStatusLabel({
        deleted: false,
        activeTo: null,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toBe('Активна');
    expect(
      getNetworkStatusLabel({
        deleted: false,
        activeTo: 1,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toBe('Неактивна');
    expect(
      getNetworkStatusLabel({
        deleted: true,
        activeTo: null,
        status: NETWORK_STATUS_ACTIVE,
      } as Network),
    ).toBe('Архівна');
  });

  it('projects the row status color and key from the same descriptor', () => {
    expect(
      buildNetworkRowView(
        {
          id: 1,
          deleted: false,
          activeTo: null,
          unitIds: [],
          freqs: [],
          aorIds: [],
          name: '',
          location: '',
          radioStation: null,
          createdAt: 0,
          purpose: null,
          operationMode: null,
          operationType: null,
          operationPeriod: null,
          lastUpdatedAt: 0,
          lastUpdatedBy: null,
          activeFrom: null,
          postIds: [],
          descriptions: [],
          status: NETWORK_STATUS_ACTIVE,
        } as Network,
        new Map(),
        new Map(),
        new Map(),
      ).statusColor,
    ).toBe(NETWORK_STATUS_ACTIVE_COLOR);

    expect(
      buildNetworkRowView(
        {
          id: 1,
          deleted: false,
          activeTo: 1,
          unitIds: [],
          freqs: [],
          aorIds: [],
          name: '',
          location: '',
          radioStation: null,
          createdAt: 0,
          purpose: null,
          operationMode: null,
          operationType: null,
          operationPeriod: null,
          lastUpdatedAt: 0,
          lastUpdatedBy: null,
          activeFrom: null,
          postIds: [],
          descriptions: [],
          status: NETWORK_STATUS_ACTIVE,
        } as Network,
        new Map(),
        new Map(),
        new Map(),
      ).statusKey,
    ).toBe('inactive');
  });
});
