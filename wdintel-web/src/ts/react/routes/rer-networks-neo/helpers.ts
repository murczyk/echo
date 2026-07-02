import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type {
  AreaOfResponsibility,
  ListNetworksReq,
  ListNetworksSortBy,
  Network,
  NetworkFreq,
  Unit,
} from '../../../../Bindings';
import { isPresent } from '../../utils/misc';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';

dayjs.extend(utc);

export type NetworkRowView = {
  id: number;
  network: Network;
  networkLabel: string;
  statusLabel: string;
  statusColor: string;
  statusKey: 'active' | 'inactive' | 'archived';
  developing: boolean;
  unitLabels: string[];
  aorLabels: string[];
  activeFrequencies: NetworkFreq[];
  inactiveFrequencies: NetworkFreq[];
  activityBars: Array<{ value: number; title: string }>;
  lastActivityLabel: string;
  lastActivityDetail: string;
  lastActivityTooltip: string;
  createdAtLabel: string;
};

export type NetworkFrequencyDisplayGroup = {
  title: 'Активні' | 'Неактивні';
  frequencies: NetworkFreq[];
  hiddenCount: number;
  isInactive: boolean;
};

export type NetworksFilterState = {
  searchText: string;
  unitText: string;
  /** Classic parity: "all" means non-archived rows only. */
  status: 'all' | 'active' | 'inactive' | 'deleted';
  showOnlyInvestigating: boolean;
};

export type NetworkRowAction = 'report' | 'direction' | 'edit' | 'delete';
export type NetworkUnitStatView = {
  unitId: number;
  unitName: string;
  army: string;
  division: string;
  regiment: string;
  battalion: string;
  count: number;
};

export const NO_AOR_FILTER_VALUE = '__no_aor__';
export const ALL_BAND_AOR_LABEL = 'Вся смуга';
export const NETWORK_COLUMN_FILTER_IDS = ['network', 'aors', 'freqs', 'location'] as const;
type NetworkColumnFilterId = (typeof NETWORK_COLUMN_FILTER_IDS)[number];
export const ACTIVITY_BAR_MIN_HEIGHT = 6;
export const ACTIVITY_BAR_VISIBLE_MIN_HEIGHT = 8;
export const ACTIVITY_BAR_MAX_HEIGHT = 34;
export const NETWORK_STATUS_ACTIVE_COLOR = '#54c06c';
export const NETWORK_STATUS_INACTIVE_COLOR = '#bfbfbf';
export const NETWORK_STATUS_ARCHIVED_COLOR = '#6b6b6b';

type NetworkUnitFilterFields = {
  filterUnit: string | null;
  filterUnitArmy: string | null;
  filterUnitDivision: string | null;
  filterUnitRegiment: string | null;
  filterUnitBattalion: string | null;
};

export type NetworkStatusDescriptor = {
  label: 'Активна' | 'Неактивна' | 'Архівна';
  color: string;
  key: 'active' | 'inactive' | 'archived';
};

function formatDateTime(value: number | null | undefined): string {
  if (!isPresent(value)) return '—';
  return dayjs(value).format('DD.MM.YY HH:mm');
}

function formatDate(value: number | null | undefined): string {
  if (!isPresent(value)) return '—';
  return dayjs(value).format('DD.MM.YY');
}

export function createDefaultNetworksFilterState(): NetworksFilterState {
  return {
    searchText: '',
    unitText: '',
    status: 'all',
    showOnlyInvestigating: false,
  };
}

export const NETWORK_LIST_PAGE_SIZE = 100;

export function getNetworkStatusLabel(network: Network): string {
  return getNetworkStatusDescriptor(network).label;
}

export function getNetworkStatusDescriptor(network: Network): NetworkStatusDescriptor {
  if (network.deleted) {
    return { label: 'Архівна', color: NETWORK_STATUS_ARCHIVED_COLOR, key: 'archived' };
  }

  if (network.activeTo === null) {
    return { label: 'Активна', color: NETWORK_STATUS_ACTIVE_COLOR, key: 'active' };
  }

  return { label: 'Неактивна', color: NETWORK_STATUS_INACTIVE_COLOR, key: 'inactive' };
}

export function buildActivityBars(
  activityByDay: Record<string, Record<string, number>> | null | undefined,
): Array<{ value: number; title: string }> {
  const dayCounts = new Map<number, number>();
  let lastKnownDayMs: number | null = null;

  for (const [dayKey, groups] of Object.entries(activityByDay ?? {})) {
    const dayMs = Number(dayKey);
    if (!Number.isFinite(dayMs)) continue;
    const value = Object.values(groups ?? {}).reduce((sum, count) => sum + count, 0);
    const normalizedDayMs = dayjs.utc(dayMs).startOf('day').valueOf();
    dayCounts.set(normalizedDayMs, value);
    lastKnownDayMs =
      lastKnownDayMs === null ? normalizedDayMs : Math.max(lastKnownDayMs, normalizedDayMs);
  }

  const rangeEnd = dayjs.utc(lastKnownDayMs ?? dayjs.utc().valueOf()).startOf('day');
  return Array.from({ length: 10 }, (_, index) => {
    const day = rangeEnd.subtract(9 - index, 'day').startOf('day');
    return {
      value: dayCounts.get(day.valueOf()) ?? 0,
      title: day.format('DD.MM'),
    };
  });
}

export function getActivityBarHeight(value: number, maxValue: number): number {
  if (value <= 0 || maxValue <= 0) {
    return ACTIVITY_BAR_MIN_HEIGHT;
  }

  const clampedValue = Math.min(value, maxValue);
  const ratio = clampedValue / maxValue;
  const height =
    ACTIVITY_BAR_VISIBLE_MIN_HEIGHT +
    ratio * (ACTIVITY_BAR_MAX_HEIGHT - ACTIVITY_BAR_VISIBLE_MIN_HEIGHT);
  return Math.min(
    ACTIVITY_BAR_MAX_HEIGHT,
    Math.max(ACTIVITY_BAR_VISIBLE_MIN_HEIGHT, Math.round(height)),
  );
}

export function buildNetworkRowView(
  network: Network,
  unitsById: Map<number, Unit>,
  aorsById: Map<number, AreaOfResponsibility>,
  activityByNetworkId: Map<number, Record<string, Record<string, number>>>,
): NetworkRowView {
  const status = getNetworkStatusDescriptor(network);
  const unitLabels = (network.unitIds ?? [])
    .map((unitId) => unitsById.get(unitId)?.name?.trim() || `#${unitId}`)
    .filter((label) => label.trim() !== '');
  const aorLabels = network.aorIds
    .map((aorId) => aorsById.get(aorId)?.name?.trim() || `#${aorId}`)
    .filter((label) => label.trim() !== '');
  const activeFrequencies = network.freqs
    .filter((freq) => !freq.deleted && freq.activeTo === null)
    .filter((freq) => freq.freq.trim() !== '');
  const inactiveFrequencies = network.freqs
    .filter((freq) => freq.deleted || freq.activeTo !== null)
    .filter((freq) => freq.freq.trim() !== '');

  return {
    id: network.id,
    network,
    networkLabel: buildNetworkLabel(network, unitLabels, false),
    statusLabel: status.label,
    statusColor: status.color,
    statusKey: status.key,
    developing: (network.unitIds ?? []).length === 0,
    unitLabels,
    aorLabels,
    activeFrequencies,
    inactiveFrequencies,
    activityBars: buildActivityBars(activityByNetworkId.get(network.id)),
    lastActivityLabel: formatDateTime(network.lastUpdatedAt),
    lastActivityDetail: network.lastUpdatedBy?.trim() || 'невідомий',
    lastActivityTooltip: [
      `Створено: ${formatDateTime(network.createdAt)}`,
      `Оновлено: ${formatDateTime(network.lastUpdatedAt)}`,
      `Автор: ${network.lastUpdatedBy?.trim() || 'невідомий'}`,
    ].join('\n'),
    createdAtLabel: formatDate(network.createdAt),
  };
}

export function buildNetworkLabel(
  network: Network,
  unitLabels: string[],
  developing: boolean,
): string {
  const pieces = [`р/м ${network.name}`];
  if (unitLabels.length > 0) {
    pieces.push(unitLabels.join(', '));
  }
  if (developing) {
    pieces.push('в дорозвідці');
  }
  return pieces.join(' ');
}

export function buildNetworkFrequencyDisplayGroups(
  row: NetworkRowView,
): NetworkFrequencyDisplayGroup[] {
  const activeVisible = row.activeFrequencies.slice(0, 2);
  const inactiveVisible = row.inactiveFrequencies.slice(0, 2);

  return [
    {
      title: 'Активні',
      frequencies: activeVisible,
      hiddenCount: Math.max(0, row.activeFrequencies.length - activeVisible.length),
      isInactive: false,
    },
    {
      title: 'Неактивні',
      frequencies: inactiveVisible,
      hiddenCount: Math.max(0, row.inactiveFrequencies.length - inactiveVisible.length),
      isInactive: true,
    },
  ];
}

export function buildNetworkFrequencyPopupGroups(
  row: NetworkRowView,
): NetworkFrequencyDisplayGroup[] {
  return [
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
  ];
}

export function mergeNetworkUnitStatsWithUnits(
  unitStats: Array<{ unitId: number; count: number }>,
  unitsById: Map<number, Unit>,
): NetworkUnitStatView[] {
  return unitStats
    .map((stat) => {
      const unit = unitsById.get(stat.unitId);
      if (!unit) return null;

      return {
        unitId: stat.unitId,
        unitName: unit.name,
        army: unit.army,
        division: unit.division,
        regiment: unit.regiment,
        battalion: unit.battalion,
        count: stat.count,
      };
    })
    .filter((row): row is NetworkUnitStatView => row !== null)
    .sort(
      (left, right) =>
        right.count - left.count || left.unitName.localeCompare(right.unitName, 'uk'),
    );
}

export function resolveAorFilterValues(aorIds: number[]): string[] {
  if (aorIds.length === 0) {
    return [NO_AOR_FILTER_VALUE];
  }

  return aorIds.map((aorId) => String(aorId));
}

export function buildNetworksSortBy(sorting: MRT_SortingState): ListNetworksSortBy[] | null {
  const current = sorting[0];
  if (!current) return ['NameAsc'];

  switch (current.id) {
    case 'aors':
      return [current.desc ? 'AorDesc' : 'AorAsc'];
    case 'freqs':
      return [current.desc ? 'FreqDesc' : 'FreqAsc'];
    case 'location':
      return [current.desc ? 'LocationDesc' : 'LocationAsc'];
    case 'network':
      return [current.desc ? 'NameDesc' : 'NameAsc'];
    case 'lastActivity':
      return [current.desc ? 'LastActivityDesc' : 'LastActivityAsc'];
    default:
      return ['NameAsc'];
  }
}

function getNetworkTextColumnFilterValue(
  columnFilters: MRT_ColumnFiltersState,
  id: 'network' | 'freqs' | 'location',
): string | null {
  return normalizeTextColumnFilterValue(columnFilters.find((filter) => filter.id === id)?.value);
}

export function extractNetworkAorFilterValues(
  columnFilters: MRT_ColumnFiltersState,
): number[] | null {
  const filterValue = columnFilters.find((filter) => filter.id === 'aors')?.value;
  if (!Array.isArray(filterValue)) return null;

  const values = filterValue
    .map((value) => String(value))
    .filter((value) => value !== '')
    .map((value) => (value === NO_AOR_FILTER_VALUE ? -1 : Number.parseInt(value, 10)))
    .filter((value) => Number.isFinite(value));

  return values.length === 0 ? null : values;
}

function normalizeTextColumnFilterValue(value: unknown): string | null {
  if (typeof value !== 'string') return null;

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function normalizeUnitFilterValue(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

function normalizeUnitHierarchyFilterValue(value: string | null | undefined): string | null {
  return value ?? null;
}

export function buildNetworkUnitFilterFields(params: {
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  selectedUnitLabel: string | null;
}): NetworkUnitFilterFields {
  if (params.selectedSidebarUnitFilter?.kind === 'group') {
    return {
      filterUnit: null,
      filterUnitArmy: normalizeUnitHierarchyFilterValue(
        params.selectedSidebarUnitFilter.hierarchy.army,
      ),
      filterUnitDivision: normalizeUnitHierarchyFilterValue(
        params.selectedSidebarUnitFilter.hierarchy.division,
      ),
      filterUnitRegiment: normalizeUnitHierarchyFilterValue(
        params.selectedSidebarUnitFilter.hierarchy.regiment,
      ),
      filterUnitBattalion: normalizeUnitHierarchyFilterValue(
        params.selectedSidebarUnitFilter.hierarchy.battalion,
      ),
    };
  }

  const selectedUnitLabel =
    params.selectedSidebarUnitFilter?.kind === 'leaf'
      ? params.selectedSidebarUnitFilter.unitName
      : params.selectedUnitLabel;

  return {
    filterUnit: normalizeUnitFilterValue(selectedUnitLabel),
    filterUnitArmy: null,
    filterUnitDivision: null,
    filterUnitRegiment: null,
    filterUnitBattalion: null,
  };
}

function normalizeAorColumnFilterValue(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;

  const values = value
    .map((item) => {
      if (typeof item === 'string' || typeof item === 'number') {
        return String(item).trim();
      }

      return '';
    })
    .filter((item) => item !== '');

  return values.length === 0 ? null : values;
}

export function sanitizeNetworkColumnFilters(
  columnFilters: MRT_ColumnFiltersState,
): MRT_ColumnFiltersState {
  const sanitized: MRT_ColumnFiltersState = [];

  for (const filter of columnFilters) {
    if (!NETWORK_COLUMN_FILTER_IDS.includes(filter.id as NetworkColumnFilterId)) {
      continue;
    }

    if (filter.id === 'aors') {
      const value = normalizeAorColumnFilterValue(filter.value);
      if (value !== null) {
        sanitized.push({ id: filter.id, value });
      }
      continue;
    }

    const value = normalizeTextColumnFilterValue(filter.value);
    if (value !== null) {
      sanitized.push({ id: filter.id, value });
    }
  }

  return sanitized;
}

export function buildNetworksListReq(params: {
  searchText: string;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  selectedUnitLabel: string | null;
  showOnlyInvestigating: boolean;
  status: NetworksFilterState['status'];
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
  limit: number | null;
  offset: number | null;
}): ListNetworksReq {
  const statusFilter =
    params.status === 'inactive'
      ? 'ListNetworksInactive'
      : params.status === 'deleted'
        ? 'ListNetworksArchived'
        : null;
  const filterName = getNetworkTextColumnFilterValue(params.columnFilters, 'network');
  const filterFreq = getNetworkTextColumnFilterValue(params.columnFilters, 'freqs');
  const filterLocation = getNetworkTextColumnFilterValue(params.columnFilters, 'location');
  const unitFilterFields = buildNetworkUnitFilterFields({
    selectedSidebarUnitFilter: params.selectedSidebarUnitFilter,
    selectedUnitLabel: params.selectedUnitLabel,
  });

  return {
    filterFreq,
    ...unitFilterFields,
    filterText: params.searchText.trim() === '' ? null : params.searchText.trim(),
    filterName,
    filterLocation,
    showOnlyFurtherInverstigation: params.showOnlyInvestigating ? true : null,
    showInactive: params.status === 'all' ? true : params.status === 'active' ? false : null,
    showOnlyDeleted: params.status === 'all' || params.status === 'active' ? false : null,
    statusFilter,
    aorIds: extractNetworkAorFilterValues(params.columnFilters),
    ids: null,
    limit: params.limit,
    offset: params.offset,
    sortBy: buildNetworksSortBy(params.sorting),
  };
}

export function buildNetworksReportReq(params: {
  searchText: string;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  selectedUnitLabel: string | null;
  showOnlyInvestigating: boolean;
  status: NetworksFilterState['status'];
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
}): ListNetworksReq {
  return buildNetworksListReq({
    ...params,
    limit: null,
    offset: null,
  });
}

export function buildNetworksStatusCountsReq(params: {
  searchText: string;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  selectedUnitLabel: string | null;
  showOnlyInvestigating: boolean;
  columnFilters: MRT_ColumnFiltersState;
}): ListNetworksReq {
  const filterName = getNetworkTextColumnFilterValue(params.columnFilters, 'network');
  const filterFreq = getNetworkTextColumnFilterValue(params.columnFilters, 'freqs');
  const filterLocation = getNetworkTextColumnFilterValue(params.columnFilters, 'location');
  const unitFilterFields = buildNetworkUnitFilterFields({
    selectedSidebarUnitFilter: params.selectedSidebarUnitFilter,
    selectedUnitLabel: params.selectedUnitLabel,
  });
  return {
    filterFreq,
    ...unitFilterFields,
    filterText: params.searchText.trim() === '' ? null : params.searchText.trim(),
    filterName,
    filterLocation,
    showOnlyFurtherInverstigation: params.showOnlyInvestigating ? true : null,
    showInactive: true,
    showOnlyDeleted: false,
    statusFilter: null,
    aorIds: extractNetworkAorFilterValues(params.columnFilters),
    ids: null,
    limit: null,
    offset: null,
    sortBy: null,
  };
}

export function resolveAorFilterSelectOptions(aors: AreaOfResponsibility[]) {
  const seenValues = new Set<string>();
  const addOption = (
    options: Array<{ label: string; value: string }>,
    option: { label: string; value: string },
  ) => {
    if (seenValues.has(option.value)) {
      return;
    }
    seenValues.add(option.value);
    options.push(option);
  };

  const options: Array<{ label: string; value: string }> = [];
  addOption(options, { label: '—', value: NO_AOR_FILTER_VALUE });

  for (const aor of sortNetworkAorsForDisplay(aors)) {
    addOption(options, { label: aor.name, value: String(aor.id) });
  }

  return options;
}

export function sortNetworkAorsForDisplay(aors: AreaOfResponsibility[]): AreaOfResponsibility[] {
  const allBandAors = aors.filter((aor) => aor.name === ALL_BAND_AOR_LABEL);
  const regularAors = aors
    .filter((aor) => aor.name !== ALL_BAND_AOR_LABEL)
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'uk'));

  return [...allBandAors, ...regularAors];
}

export function matchesAorFilter(network: Network, selectedValues: string[]) {
  if (selectedValues.length === 0) return true;
  const selected = new Set(selectedValues);
  const hasNoAor = selected.has(NO_AOR_FILTER_VALUE);
  const regularSelected = selectedValues.filter((value) => value !== NO_AOR_FILTER_VALUE);
  const networkAorValues = new Set(network.aorIds.map(String));

  if (hasNoAor && network.aorIds.length === 0) return true;
  if (regularSelected.some((value) => networkAorValues.has(value))) return true;
  return false;
}
