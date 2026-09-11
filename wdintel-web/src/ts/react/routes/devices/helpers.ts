import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';

import type {
  AorSummary,
  AreaOfResponsibility,
  DeviceDetails,
  DeviceListItem,
  DeviceListSortBy,
  DeviceUnitStat,
  ListDevicesReq,
  Unit,
  UnitSummary,
} from '../../../../Bindings';
import { buildSelectableUnitOptions, getUnitDisplayLabel } from '../../utils/unit-search';
import { HttpRequestError } from '../../services/api/client';
import type { SelectedSidebarUnitFilter, UnitHierarchyFilter } from '../rer-callsigns-neo/types';

export type DeviceArchivedFilterValue = 'active' | 'archived' | 'all';

export type DevicesFilterState = {
  archivedFilter: DeviceArchivedFilterValue;
  unitIds: number[];
};

export type DeviceLookupOption = {
  id: number;
  label: string;
};

export type DeviceUnitStatView = {
  unitId: number;
  unitName: string;
  armyRegion: string;
  militaryDistrict: string;
  army: string;
  corps: string;
  division: string;
  brigade: string;
  regiment: string;
  battalion: string;
  company: string;
  platoon: string;
  squad: string;
  section: string;
  teamOrCrew: string;
  other: string;
  count: number;
};

export type DeviceRowView = DeviceListItem & {
  aorLabel: string;
  unitLabel: string;
  updatedAtLabel: string;
  createdAtLabel: string;
  archivedAtLabel: string;
};

export const DEVICES_LIST_PAGE_SIZE = 100;
export const DEFAULT_DEVICES_SORTING: MRT_SortingState = [{ id: 'updatedAt', desc: true }];
const DEVICE_UNIT_HIERARCHY_KEYS = [
  'armyRegion',
  'militaryDistrict',
  'army',
  'corps',
  'division',
  'brigade',
  'regiment',
  'battalion',
  'company',
  'platoon',
  'squad',
  'section',
  'teamOrCrew',
  'other',
] as const;

export function createDefaultDevicesFilterState(): DevicesFilterState {
  return {
    archivedFilter: 'active',
    unitIds: [],
  };
}
export function resolveDevicesColumnFilters(columnFilters: MRT_ColumnFiltersState): {
  archivedFilter: DeviceArchivedFilterValue;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
} {
  const lifecycleValue = columnFilters.find((filter) => filter.id === 'lifecycle')?.value;
  const archivedFilter: DeviceArchivedFilterValue =
    lifecycleValue === 'archived' || lifecycleValue === 'all' ? lifecycleValue : 'active';
  const unitValue = columnFilters.find((filter) => filter.id === 'unit')?.value;

  return {
    archivedFilter,
    selectedSidebarUnitFilter: isSelectedSidebarUnitFilter(unitValue) ? unitValue : null,
  };
}

export function buildDevicesColumnFilters({
  archivedFilter,
  selectedSidebarUnitFilter,
}: {
  archivedFilter: DeviceArchivedFilterValue;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
}): MRT_ColumnFiltersState {
  return [
    ...(archivedFilter === 'active' ? [] : [{ id: 'lifecycle', value: archivedFilter }]),
    ...(selectedSidebarUnitFilter === null
      ? []
      : [{ id: 'unit', value: selectedSidebarUnitFilter }]),
  ];
}

export function sanitizeDevicesColumnFilters(
  columnFilters: MRT_ColumnFiltersState,
): MRT_ColumnFiltersState {
  return buildDevicesColumnFilters(resolveDevicesColumnFilters(columnFilters));
}

function isSelectedSidebarUnitFilter(value: unknown): value is SelectedSidebarUnitFilter {
  if (typeof value !== 'object' || value === null) return false;
  const filter = value as Record<string, unknown>;
  if (typeof filter.label !== 'string') return false;
  if (filter.kind === 'leaf') {
    return (
      typeof filter.unitName === 'string' &&
      (filter.unitId === undefined || Number.isInteger(filter.unitId))
    );
  }
  if (
    filter.kind !== 'group' ||
    typeof filter.hierarchy !== 'object' ||
    filter.hierarchy === null
  ) {
    return false;
  }
  const hierarchy = filter.hierarchy as Record<string, unknown>;
  return DEVICE_UNIT_HIERARCHY_KEYS.every(
    (key) =>
      hierarchy[key] === undefined || hierarchy[key] === null || typeof hierarchy[key] === 'string',
  );
}

export function formatDeviceDateTime(value: string | null | undefined): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('uk-UA');
}

export function buildDevicesSortBy(sorting: MRT_SortingState): DeviceListSortBy[] {
  const current = sorting[0];
  if (!current) return ['updated_at_desc'];

  switch (current.id) {
    case 'name':
      return [current.desc ? 'display_title_desc' : 'display_title_asc'];
    case 'updatedAt':
      return [current.desc ? 'updated_at_desc' : 'updated_at_asc'];
    case 'createdAt':
      return [current.desc ? 'created_at_desc' : 'created_at_asc'];
    default:
      return ['updated_at_desc'];
  }
}

export function buildDevicesListReq(params: {
  searchText: string;
  filters: DevicesFilterState;
  sorting: MRT_SortingState;
  limit: number | null;
  offset: number | null;
}): ListDevicesReq {
  const filterText = params.searchText.trim();

  return {
    filterText: filterText === '' ? null : filterText,
    archivedFilter:
      params.filters.archivedFilter === 'archived'
        ? 'archived_only'
        : params.filters.archivedFilter === 'all'
          ? 'all'
          : 'active_only',
    aorIds: null,
    unitIds: params.filters.unitIds.length > 0 ? params.filters.unitIds : null,
    limit: params.limit,
    offset: params.offset,
    sortBy: buildDevicesSortBy(params.sorting),
  };
}

export function hasActiveDevicesFilters(searchText: string, filters: DevicesFilterState): boolean {
  return (
    searchText.trim() !== '' || filters.archivedFilter !== 'active' || filters.unitIds.length > 0
  );
}

export function buildDeviceRowView(device: DeviceListItem): DeviceRowView {
  return {
    ...device,
    aorLabel: formatAorsLabel(device.aors),
    unitLabel: formatUnitLabel(device.unit),
    updatedAtLabel: formatDeviceDateTime(device.updatedAt),
    createdAtLabel: formatDeviceDateTime(device.createdAt),
    archivedAtLabel: formatDeviceDateTime(device.archivedAt),
  };
}

export function deviceDetailsToListItem(device: DeviceDetails): DeviceListItem {
  return {
    id: device.id,
    name: device.name,
    aors: device.aors,
    unit: device.unit,
    createdBy: device.createdBy,
    archived: device.archived,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
    archivedAt: device.archivedAt,
  };
}

export function resolveAorOptions(aors: AreaOfResponsibility[]): DeviceLookupOption[] {
  return aors
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name, 'uk'))
    .map((aor) => ({ id: aor.id, label: aor.name.trim() || `AOR #${aor.id}` }));
}

export function resolveUnitOptions(units: Unit[]): DeviceLookupOption[] {
  return buildSelectableUnitOptions(units).map((unit) => ({
    id: unit.id,
    label: getUnitDisplayLabel(unit),
  }));
}

export function mergeCurrentDeviceUnitOption(
  options: DeviceLookupOption[],
  unit: UnitSummary | null,
): DeviceLookupOption[] {
  if (unit === null || options.some((option) => option.id === unit.id)) return options;

  return [...options, { id: unit.id, label: unit.name.trim() || `Підрозділ #${unit.id}` }];
}

export function mergeDeviceUnitStatsWithUnits(
  unitStats: DeviceUnitStat[],
  unitsById: Map<number, Unit>,
): DeviceUnitStatView[] {
  return unitStats
    .map((stat) => {
      const unit = unitsById.get(stat.unit.id);
      return {
        unitId: stat.unit.id,
        unitName: stat.unit.name,
        armyRegion: unit?.armyRegion ?? '',
        militaryDistrict: unit?.militaryDistrict ?? '',
        army: unit?.army ?? '',
        corps: unit?.corps ?? '',
        division: unit?.division ?? '',
        brigade: unit?.brigade ?? '',
        regiment: unit?.regiment ?? '',
        battalion: unit?.battalion ?? '',
        company: unit?.company ?? '',
        platoon: unit?.platoon ?? '',
        squad: unit?.squad ?? '',
        section: unit?.section ?? '',
        teamOrCrew: unit?.teamOrCrew ?? '',
        other: unit?.other ?? '',
        count: stat.count,
      };
    })
    .sort(
      (left, right) =>
        right.count - left.count || left.unitName.localeCompare(right.unitName, 'uk'),
    );
}

function matchesDeviceUnitHierarchy(unit: Unit, hierarchy: UnitHierarchyFilter): boolean {
  return DEVICE_UNIT_HIERARCHY_KEYS.every((key) => {
    const expected = hierarchy[key] ?? null;
    return expected === null || unit[key] === expected;
  });
}

export function resolveDeviceSidebarUnitIds(
  filter: SelectedSidebarUnitFilter | null,
  units: Unit[],
): number[] {
  if (filter === null) return [];

  if (filter.kind === 'leaf') {
    if (typeof filter.unitId === 'number') return [filter.unitId];
    return units
      .filter((unit) => unit.name === filter.unitName)
      .map((unit) => unit.id)
      .sort((left, right) => left - right);
  }

  return units
    .filter((unit) => matchesDeviceUnitHierarchy(unit, filter.hierarchy))
    .map((unit) => unit.id)
    .sort((left, right) => left - right);
}

export function isSameDeviceSidebarUnitFilter(
  left: SelectedSidebarUnitFilter | null,
  right: SelectedSidebarUnitFilter,
): boolean {
  if (left === null || left.kind !== right.kind) return false;
  if (left.kind === 'leaf' && right.kind === 'leaf') {
    if (left.unitId !== undefined || right.unitId !== undefined)
      return left.unitId === right.unitId;
    return left.unitName === right.unitName;
  }
  if (left.kind === 'group' && right.kind === 'group') {
    return DEVICE_UNIT_HIERARCHY_KEYS.every(
      (key) => (left.hierarchy[key] ?? null) === (right.hierarchy[key] ?? null),
    );
  }
  return false;
}

const FILE_REGISTRY_NOT_CONFIGURED_ERROR_MESSAGE =
  'Device file operations are unavailable because the [file_registry] configuration section is missing.';
const FILE_REGISTRY_NOT_CONFIGURED_USER_MESSAGE =
  'Сховище файлів пристроїв не налаштоване. Аналіз файлів недоступний. Зверніться до адміністратора сервера.';

export function isFileRegistryNotConfiguredError(error: unknown): boolean {
  return (
    error instanceof HttpRequestError &&
    error.status === 503 &&
    error.message === FILE_REGISTRY_NOT_CONFIGURED_ERROR_MESSAGE
  );
}

export function formatDeviceErrorMessage(error: unknown): string {
  if (isFileRegistryNotConfiguredError(error)) return FILE_REGISTRY_NOT_CONFIGURED_USER_MESSAGE;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return 'Невідома помилка';
  }
}

export function isSafeExternalUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

export function formatAorsLabel(aors: AorSummary[]): string {
  if (aors.length === 0) return '—';
  return aors.map((aor) => aor.name.trim() || `AOR #${aor.id} — назва недоступна`).join(', ');
}

export function formatUnitLabel(unit: UnitSummary | null): string {
  if (unit === null) return '—';
  return unit.name.trim() || `Підрозділ #${unit.id} — назва недоступна`;
}
