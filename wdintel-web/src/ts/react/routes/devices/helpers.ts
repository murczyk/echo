import type { MRT_SortingState } from 'material-react-table';

import type {
  AreaOfResponsibility,
  DeviceDetails,
  DeviceListItem,
  DeviceListSortBy,
  ListDevicesReq,
  Unit,
} from '../../../../Bindings';
import { buildSelectableUnitOptions, getUnitDisplayLabel } from '../../utils/unit-search';

export type DeviceDeletedFilterValue = 'active' | 'deleted' | 'all';

export type DevicesFilterState = {
  deletedFilter: DeviceDeletedFilterValue;
  aorIds: number[];
  unitIds: number[];
  createdBy: string;
};

export type DeviceLookupOption = {
  id: number;
  label: string;
};

export type DeviceRowView = DeviceListItem & {
  aorLabel: string;
  unitLabel: string;
  updatedAtLabel: string;
  createdAtLabel: string;
  deletedAtLabel: string;
};

export const DEVICES_LIST_PAGE_SIZE = 100;
export const DEFAULT_DEVICES_SORTING: MRT_SortingState = [{ id: 'updatedAt', desc: true }];

export function createDefaultDevicesFilterState(): DevicesFilterState {
  return {
    deletedFilter: 'active',
    aorIds: [],
    unitIds: [],
    createdBy: '',
  };
}

export function formatDeviceDateTime(value: number | null | undefined): string {
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
      return [current.desc ? 'name_desc' : 'name_asc'];
    case 'updatedAt':
      return [current.desc ? 'updated_at_desc' : 'updated_at_asc'];
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
  const createdBy = params.filters.createdBy.trim();

  return {
    filterText: filterText === '' ? null : filterText,
    deletedFilter:
      params.filters.deletedFilter === 'deleted'
        ? 'deleted_only'
        : params.filters.deletedFilter === 'all'
          ? 'all'
          : 'active_only',
    aorIds: params.filters.aorIds.length > 0 ? params.filters.aorIds : null,
    unitIds: params.filters.unitIds.length > 0 ? params.filters.unitIds : null,
    createdBy: createdBy === '' ? null : createdBy,
    ids: null,
    limit: params.limit,
    offset: params.offset,
    sortBy: buildDevicesSortBy(params.sorting),
  };
}

export function hasActiveDevicesFilters(searchText: string, filters: DevicesFilterState): boolean {
  return (
    searchText.trim() !== '' ||
    filters.deletedFilter !== 'active' ||
    filters.aorIds.length > 0 ||
    filters.unitIds.length > 0 ||
    filters.createdBy.trim() !== ''
  );
}

export function buildDeviceRowView(device: DeviceListItem): DeviceRowView {
  return {
    ...device,
    aorLabel: formatAorsLabel(device.aorIds, device.aorNames),
    unitLabel: formatUnitLabel(device.unitId, device.unitName),
    updatedAtLabel: formatDeviceDateTime(device.updatedAtMs),
    createdAtLabel: formatDeviceDateTime(device.createdAtMs),
    deletedAtLabel: formatDeviceDateTime(device.deletedAtMs),
  };
}

export function deviceDetailsToListItem(device: DeviceDetails): DeviceListItem {
  return {
    id: device.id,
    name: device.name,
    createdBy: device.createdBy,
    aorIds: device.aorIds,
    aorNames: device.aorNames,
    unitId: device.unitId,
    unitName: device.unitName,
    externalUrl: device.externalUrl,
    deleted: device.deleted,
    createdAtMs: device.createdAtMs,
    updatedAtMs: device.updatedAtMs,
    deletedAtMs: device.deletedAtMs,
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

export function formatDeviceErrorMessage(error: unknown): string {
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

export function formatAorsLabel(ids: number[], names: string[]): string {
  if (ids.length > 0) {
    return ids
      .map((id, index) => {
        const name = names[index]?.trim();
        return name || `AOR #${id} — назва недоступна`;
      })
      .join(', ');
  }
  const visibleNames = names.map((name) => name.trim()).filter((name) => name !== '');
  if (visibleNames.length > 0) return visibleNames.join(', ');
  return '—';
}

function formatUnitLabel(id: number | null, name: string | null): string {
  if (name?.trim()) return name.trim();
  if (id !== null) return `Підрозділ #${id} — назва недоступна`;
  return '—';
}
