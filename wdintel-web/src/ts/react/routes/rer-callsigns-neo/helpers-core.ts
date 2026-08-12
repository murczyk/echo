import { isNullOrUndefined } from '../../utils/misc';
import type {
  Callsign,
  DevelopingFilter,
  ListCallsignsReq,
  ListCallsignsSortBy,
  User,
} from '../../../../Bindings';
import type {
  BuildReqInput,
  CallsignsFilterState,
  CallsignsSortState,
  ExportPermission,
  SortColumn,
  SortDescriptor,
  UnitHierarchyFilter,
} from './types';
import { normalizeUnitSearchValue } from '../../utils/unit-search';
import { hasRole } from '../../utils/roles';

const DEFAULT_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_SORT: CallsignsSortState = {
  column: 'unit',
  direction: 'asc',
};

export const DEFAULT_FILTERS = createDefaultFilters();

export const CALLSIGN_FORM_HINT =
  'Заповніть "Позивний" або "ПІП". Якщо їх немає, залиште інші змістовні дані запису.';
export const UNIT_SELECTION_REQUIRED_ERROR = 'Оберіть підрозділ зі списку.';

function hasCallsignEditorAccess(roles: readonly string[] | null | undefined): boolean {
  return hasRole(roles, 'Admin') || (hasRole(roles, 'Rer') && hasRole(roles, 'CallsignsEditor'));
}

export function toUpperCaseCallsign(value: string): string {
  return value.toLocaleUpperCase('uk-UA');
}

export function normalizeDuplicateLookupValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

export function getUnitSelectionError(
  unitSearchInput: string,
  selectedUnit: { id: number; name: string } | null,
): string | null {
  if (selectedUnit) return null;
  if (normalizeUnitSearchValue(unitSearchInput) === '') return null;
  return UNIT_SELECTION_REQUIRED_ERROR;
}

export function createDefaultFilters(now = new Date()): CallsignsFilterState {
  const to = now;
  const from = new Date(now.getTime() - 7 * DAY_MS);

  return {
    filterText: '',
    filterCallsign: '',
    filterPosition: '',
    filterFullName: '',
    filterComment: '',
    filterUnit: '',
    filterDeveloping: 'OnlyNonDeveloping',
    isIgnoringDateFilter: true,
    fromDateTimeLocal: toDateTimeLocalValue(from),
    toDateTimeLocal: toDateTimeLocalValue(to),
  };
}

export function getExportPermission(user: User | null): ExportPermission {
  return {
    canEdit: hasCallsignEditorAccess(user?.roles),
    canExport: hasRole(user?.roles, 'Rer'),
  };
}

export function getExportPermissionFromRoles(rolesList: string[]): ExportPermission {
  return {
    canEdit: hasCallsignEditorAccess(rolesList),
    canExport: hasRole(rolesList, 'Rer'),
  };
}

export function buildListCallsignsReq(input: BuildReqInput): ListCallsignsReq {
  const { filters, sort, query, sidebarUnitHierarchyFilter = null } = input;

  return {
    afterId: query.afterId,
    beforeId: null,
    filterText: filters.filterText.trim() || null,
    filterCallsign: filters.filterCallsign.trim() || null,
    filterPosition: filters.filterPosition.trim() || null,
    filterFullName: filters.filterFullName.trim() || null,
    filterComment: filters.filterComment.trim() || null,
    filterUnit: filters.filterUnit.trim() || null,
    filterUnitArmyRegion: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.armyRegion),
    filterUnitMilitaryDistrict: normalizeHierarchyFilterValue(
      sidebarUnitHierarchyFilter?.militaryDistrict,
    ),
    filterUnitArmy: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.army),
    filterUnitDivision: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.division),
    filterUnitRegiment: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.regiment),
    filterUnitBattalion: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.battalion),
    filterDeveloping: filters.filterDeveloping,
    sinceDateInclusiveMs: filters.isIgnoringDateFilter
      ? null
      : parseDateTimeLocalToMs(filters.fromDateTimeLocal),
    tillDateInclusiveMs: filters.isIgnoringDateFilter
      ? null
      : parseDateTimeLocalToMs(filters.toDateTimeLocal),
    limit: query.limit,
    sortBy: toBackendSort(sort),
  };
}

export function buildInitialListReq(): ListCallsignsReq {
  return buildListCallsignsReq({
    filters: DEFAULT_FILTERS,
    sort: DEFAULT_SORT,
    query: { afterId: null, limit: DEFAULT_LIMIT },
  });
}

export function buildDuplicateHintGroups(
  duplicateHintInputs: Array<{
    rowIndex: number;
    callsignInput: string;
    fullNameInput: string;
    positionInput: string;
  }>,
  callsigns: Callsign[],
  unitId: number | null,
  unitsById: Map<number, { name: string }>,
): Array<{
  rowIndex: number;
  matches: Array<{
    id: number;
    callsign: string;
    position: string;
    fullName: string;
    comment: string;
    unitName: string;
  }>;
}> {
  if (duplicateHintInputs.length === 0 || callsigns.length === 0) return [];

  const groupsByRowIndex = new Map<
    number,
    {
      rowIndex: number;
      matches: Array<{
        id: number;
        callsign: string;
        position: string;
        fullName: string;
        comment: string;
        unitName: string;
      }>;
    }
  >();

  for (const callsign of callsigns) {
    const callsignValue = normalizeDuplicateLookupValue(callsign.callsign);
    const fullNameValue = normalizeDuplicateLookupValue(callsign.fullName);
    const unitMatches = isNullOrUndefined(unitId) || callsign.unitId === unitId;

    if (!unitMatches) continue;

    for (const draftInput of duplicateHintInputs) {
      const callsignMatches =
        draftInput.callsignInput.length >= 2 && callsignValue.includes(draftInput.callsignInput);
      const fullNameMatches =
        draftInput.fullNameInput.length >= 2 && fullNameValue.includes(draftInput.fullNameInput);

      if (!(callsignMatches || fullNameMatches)) continue;

      const group = groupsByRowIndex.get(draftInput.rowIndex) ?? {
        rowIndex: draftInput.rowIndex,
        matches: [],
      };

      if (group.matches.some((match) => match.id === callsign.id)) {
        continue;
      }

      group.matches.push({
        id: callsign.id,
        callsign: callsign.callsign,
        position: callsign.position,
        fullName: callsign.fullName,
        comment: callsign.comment,
        unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
      });
      groupsByRowIndex.set(draftInput.rowIndex, group);
    }
  }

  return duplicateHintInputs
    .map((input) => groupsByRowIndex.get(input.rowIndex))
    .filter(
      (
        group,
      ): group is {
        rowIndex: number;
        matches: Array<{
          id: number;
          callsign: string;
          position: string;
          fullName: string;
          comment: string;
          unitName: string;
        }>;
      } => !isNullOrUndefined(group) && group.matches.length > 0,
    );
}

export function getDefaultPageSize() {
  return DEFAULT_LIMIT;
}

export function toBackendSort(sort: CallsignsSortState): ListCallsignsSortBy[] {
  if (sort.column === 'callsign') {
    return [sort.direction === 'asc' ? 'CallsignAsc' : 'CallsignDesc'];
  }
  if (sort.column === 'position') {
    return [sort.direction === 'asc' ? 'CallsignPositionAsc' : 'CallsignPositionDesc'];
  }
  if (sort.column === 'fullName') {
    return [sort.direction === 'asc' ? 'CallsignFullNameAsc' : 'CallsignFullNameDesc'];
  }
  if (sort.column === 'comment') {
    return [sort.direction === 'asc' ? 'CallsignCommentAsc' : 'CallsignCommentDesc'];
  }
  if (sort.column === 'sourceName') {
    return [sort.direction === 'asc' ? 'CallsignSourceAsc' : 'CallsignSourceDesc'];
  }
  if (sort.column === 'radioFreq') {
    return [sort.direction === 'asc' ? 'CallsignRadioFreqAsc' : 'CallsignRadioFreqDesc'];
  }
  if (sort.column === 'createdAt') {
    return [sort.direction === 'asc' ? 'CallsignCreatedAtAsc' : 'CallsignCreatedAtDesc'];
  }

  return [sort.direction === 'asc' ? 'CallsignUnitAsc' : 'CallsignUnitDesc'];
}

export function nextSortState(
  current: CallsignsSortState,
  column: SortColumn,
  direction?: CallsignsSortState['direction'],
): CallsignsSortState {
  if (direction) {
    return { column, direction };
  }
  if (current.column === column) {
    return {
      column,
      direction: current.direction === 'asc' ? 'desc' : 'asc',
    };
  }
  return {
    column,
    direction: column === 'createdAt' ? 'desc' : 'asc',
  };
}

export function getSortDescriptor(sort: CallsignsSortState, column: SortColumn): SortDescriptor {
  const active = sort.column === column;
  const direction = active ? sort.direction : null;
  return {
    backend: active ? toBackendSort(sort) : [],
    label: direction === 'asc' ? 'asc' : direction === 'desc' ? 'desc' : 'none',
  };
}

export function toDateTimeLocalValue(value: Date): string {
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}T${hour}:${minute}`;
}

export function parseDateTimeLocalToMs(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = new Date(value);
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

export function formatDateTime(ms: number): string {
  if (!Number.isFinite(ms)) return '—';
  try {
    return new Intl.DateTimeFormat('uk-UA', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(ms));
  } catch (_) {
    return new Date(ms).toLocaleString();
  }
}

export function formatErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Невідома помилка';
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export function emptyIfNull<T>(value: T | null | undefined, fallback: T): T {
  return value ?? fallback;
}

export function isDevelopingFilter(value: string): value is DevelopingFilter {
  return value === 'OnlyDeveloping' || value === 'OnlyNonDeveloping' || value === 'All';
}

function normalizeHierarchyFilterValue(
  value: UnitHierarchyFilter[keyof UnitHierarchyFilter] | undefined,
): string | null {
  if (isNullOrUndefined(value)) return null;
  return value.trim();
}
