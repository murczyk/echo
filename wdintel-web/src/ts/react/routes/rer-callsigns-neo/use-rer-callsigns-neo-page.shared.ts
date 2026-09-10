import { isNullOrUndefined } from '../../utils/misc';
import type { Callsign } from '../../../../Bindings';
import type {
  CallsignsFilterState,
  CallsignsSortState,
  SelectedSidebarUnitFilter,
  UnitHierarchyFilter,
} from './types';
import {
  createDefaultFilters,
  DEFAULT_SORT,
  getDefaultPageSize,
  normalizeDuplicateLookupValue,
  toUpperCaseCallsign,
} from './helpers-core';

const EMPTY_HIERARCHY_PARAM = '__EMPTY__';

export const FILTERS_DEBOUNCE_MS = 500;
export function updateUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  mutator(params);
  const nextSearch = params.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

export function readInitialCallsignsFiltersFromUrl(): CallsignsFilterState {
  const defaults = createDefaultFilters();
  const params = new URLSearchParams(window.location.search);
  const developing = params.get('developing');
  const sortDateEnabled = params.get('date_filter') === '1';

  return {
    ...defaults,
    filterText: params.get('filter') ?? defaults.filterText,
    filterCallsign: params.get('callsign') ?? defaults.filterCallsign,
    filterPosition: params.get('position') ?? defaults.filterPosition,
    filterFullName: params.get('full_name') ?? defaults.filterFullName,
    filterComment: params.get('comment') ?? defaults.filterComment,
    filterUnit: params.get('unit') ?? defaults.filterUnit,
    filterDeveloping:
      developing === 'OnlyDeveloping' || developing === 'OnlyNonDeveloping' || developing === 'All'
        ? developing
        : defaults.filterDeveloping,
    isIgnoringDateFilter: !sortDateEnabled,
    fromDateTimeLocal: sortDateEnabled
      ? (params.get('from') ?? defaults.fromDateTimeLocal)
      : defaults.fromDateTimeLocal,
    toDateTimeLocal: sortDateEnabled
      ? (params.get('to') ?? defaults.toDateTimeLocal)
      : defaults.toDateTimeLocal,
  };
}

export function readInitialCallsignsSortFromUrl(): CallsignsSortState {
  const params = new URLSearchParams(window.location.search);
  const column = params.get('sort_col');
  const direction = params.get('sort_dir');

  const validColumn =
    column === 'callsign' ||
    column === 'position' ||
    column === 'fullName' ||
    column === 'comment' ||
    column === 'createdAt' ||
    column === 'unit' ||
    column === 'sourceName' ||
    column === 'radioFreq'
      ? column
      : DEFAULT_SORT.column;
  const validDirection =
    direction === 'asc' || direction === 'desc' ? direction : DEFAULT_SORT.direction;

  return {
    column: validColumn,
    direction: validDirection,
  };
}

export function readInitialSidebarOpenFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('units_sidebar');
  if (raw === '0') return false;
  if (raw === '1') return true;
  return true;
}

function decodeHierarchyParam(value: string | null): string | null {
  if (isNullOrUndefined(value)) return null;
  return value === EMPTY_HIERARCHY_PARAM ? '' : value;
}

function setHierarchyParam(params: URLSearchParams, key: string, value: string | null) {
  if (isNullOrUndefined(value)) {
    params.delete(key);
    return;
  }

  params.set(key, value === '' ? EMPTY_HIERARCHY_PARAM : value);
}

export function readInitialSidebarSelectedUnitFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const unit = params.get('unit')?.trim() ?? '';
  return unit || null;
}

export function readInitialSidebarHierarchyFilterFromUrl(): UnitHierarchyFilter | null {
  const params = new URLSearchParams(window.location.search);
  const hierarchy = {
    armyRegion: decodeHierarchyParam(params.get('unit_army_region')),
    militaryDistrict: decodeHierarchyParam(params.get('unit_military_district')),
    army: decodeHierarchyParam(params.get('unit_army')),
    division: decodeHierarchyParam(params.get('unit_division')),
    regiment: decodeHierarchyParam(params.get('unit_regiment')),
    battalion: decodeHierarchyParam(params.get('unit_battalion')),
  };

  if (Object.values(hierarchy).every((value) => isNullOrUndefined(value))) {
    return null;
  }

  return hierarchy;
}

export function getSidebarGroupLabel(hierarchy: UnitHierarchyFilter): string {
  const label = Object.values(hierarchy)
    .reverse()
    .find((value) => !isNullOrUndefined(value) && value.trim() !== '');
  return label?.trim() ?? 'Підрозділ';
}

export function readInitialSidebarFilterFromUrl(): SelectedSidebarUnitFilter | null {
  const hierarchy = readInitialSidebarHierarchyFilterFromUrl();
  if (hierarchy) {
    return {
      kind: 'group',
      label: getSidebarGroupLabel(hierarchy),
      hierarchy,
    };
  }

  const unitName = readInitialSidebarSelectedUnitFromUrl();
  if (!unitName) {
    return null;
  }

  return {
    kind: 'leaf',
    label: unitName,
    unitName,
  };
}

export function areSidebarFiltersEqual(
  left: SelectedSidebarUnitFilter | null,
  right: SelectedSidebarUnitFilter | null,
): boolean {
  if (isNullOrUndefined(left) || isNullOrUndefined(right)) return left === right;
  if (left.kind !== right.kind) return false;

  if (left.kind === 'leaf' && right.kind === 'leaf') {
    return left.unitName === right.unitName;
  }

  if (left.kind === 'group' && right.kind === 'group') {
    return (
      left.hierarchy.armyRegion === right.hierarchy.armyRegion &&
      left.hierarchy.militaryDistrict === right.hierarchy.militaryDistrict &&
      left.hierarchy.army === right.hierarchy.army &&
      left.hierarchy.division === right.hierarchy.division &&
      left.hierarchy.regiment === right.hierarchy.regiment &&
      left.hierarchy.battalion === right.hierarchy.battalion
    );
  }

  return false;
}

export function areCallsignFiltersEqual(
  left: CallsignsFilterState,
  right: CallsignsFilterState,
): boolean {
  return (
    left.filterText === right.filterText &&
    left.filterCallsign === right.filterCallsign &&
    left.filterPosition === right.filterPosition &&
    left.filterFullName === right.filterFullName &&
    left.filterComment === right.filterComment &&
    left.filterUnit === right.filterUnit &&
    left.filterDeveloping === right.filterDeveloping &&
    left.isIgnoringDateFilter === right.isIgnoringDateFilter &&
    left.fromDateTimeLocal === right.fromDateTimeLocal &&
    left.toDateTimeLocal === right.toDateTimeLocal
  );
}

export function areCallsignSortStatesEqual(
  left: CallsignsSortState,
  right: CallsignsSortState,
): boolean {
  return left.column === right.column && left.direction === right.direction;
}

export function syncCallsignsStateToUrl(
  filters: CallsignsFilterState,
  sort: CallsignsSortState,
  sidebarOpen: boolean,
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null,
) {
  updateUrlSearchParams((params) => {
    const setOrDelete = (key: string, value: string | null | undefined) => {
      if (isNullOrUndefined(value) || value === '') {
        params.delete(key);
        return;
      }
      params.set(key, value);
    };

    setOrDelete('filter', filters.filterText.trim() || null);
    setOrDelete('callsign', filters.filterCallsign.trim() || null);
    setOrDelete('position', filters.filterPosition.trim() || null);
    setOrDelete('full_name', filters.filterFullName.trim() || null);
    setOrDelete('comment', filters.filterComment.trim() || null);
    setOrDelete('unit', filters.filterUnit.trim() || null);
    setHierarchyParam(
      params,
      'unit_army_region',
      selectedSidebarUnitFilter?.kind === 'group'
        ? selectedSidebarUnitFilter.hierarchy.armyRegion
        : null,
    );
    setHierarchyParam(
      params,
      'unit_military_district',
      selectedSidebarUnitFilter?.kind === 'group'
        ? selectedSidebarUnitFilter.hierarchy.militaryDistrict
        : null,
    );
    setHierarchyParam(
      params,
      'unit_army',
      selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy.army : null,
    );
    setHierarchyParam(
      params,
      'unit_division',
      selectedSidebarUnitFilter?.kind === 'group'
        ? selectedSidebarUnitFilter.hierarchy.division
        : null,
    );
    setHierarchyParam(
      params,
      'unit_regiment',
      selectedSidebarUnitFilter?.kind === 'group'
        ? selectedSidebarUnitFilter.hierarchy.regiment
        : null,
    );
    setHierarchyParam(
      params,
      'unit_battalion',
      selectedSidebarUnitFilter?.kind === 'group'
        ? selectedSidebarUnitFilter.hierarchy.battalion
        : null,
    );

    if (filters.filterDeveloping !== 'OnlyNonDeveloping') {
      params.set('developing', filters.filterDeveloping);
    } else {
      params.delete('developing');
    }

    if (!filters.isIgnoringDateFilter) {
      params.set('date_filter', '1');
      setOrDelete('from', filters.fromDateTimeLocal);
      setOrDelete('to', filters.toDateTimeLocal);
    } else {
      params.delete('date_filter');
      params.delete('from');
      params.delete('to');
    }

    if (sort.column !== DEFAULT_SORT.column) {
      params.set('sort_col', sort.column);
    } else {
      params.delete('sort_col');
    }
    if (sort.direction !== DEFAULT_SORT.direction) {
      params.set('sort_dir', sort.direction);
    } else {
      params.delete('sort_dir');
    }

    if (sidebarOpen) {
      params.delete('units_sidebar');
    } else {
      params.set('units_sidebar', '0');
    }
  });
}

export function normalizeCallsign(callsign: Callsign): Callsign {
  return {
    ...callsign,
    callsign: toUpperCaseCallsign(callsign.callsign),
  };
}

export function normalizeCallsigns(callsigns: Callsign[]): Callsign[] {
  return callsigns.map(normalizeCallsign);
}

export function hasAnyDuplicateHintInput(
  rows: Array<{ callsign: string; fullName: string }>,
): boolean {
  return rows.some((row) => {
    const callsignInput = normalizeDuplicateLookupValue(row.callsign);
    const fullNameInput = normalizeDuplicateLookupValue(row.fullName);
    return callsignInput.length >= 2 || fullNameInput.length >= 2;
  });
}

export function getReloadPageSize(callsignsCount: number): number {
  return Math.max(getDefaultPageSize(), callsignsCount);
}
