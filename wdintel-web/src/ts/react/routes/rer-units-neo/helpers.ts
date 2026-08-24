import type { CreateUnitReq, ListUnitsReq, ListUnitsSortBy, Unit } from '../../../../Bindings';
import type {
  MRT_ColumnFiltersState,
  MRT_PaginationState,
  MRT_SortingState,
} from 'material-react-table';
import { DEFAULT_LIST_UNITS_REQ } from '../../services/api/units';
import type { UnitSearchMode } from './search-mode';

export type UnitForm = CreateUnitReq;
export type UnitStatusFilter = 'all' | 'active' | 'inactive';
export type UnitBooleanColumnFilter = 'Усі' | 'yes' | 'no';
export type UnitNameColumnFilter = {
  text: string;
  duplicateCandidate: UnitBooleanColumnFilter;
};
export type UnitOrbitColumnFilter = {
  text: string;
  linked: UnitBooleanColumnFilter;
  comment: UnitBooleanColumnFilter;
};

const UNIT_SORTS: Record<string, [ListUnitsSortBy, ListUnitsSortBy]> = {
  name: ['UnitNameAsc', 'UnitNameDesc'],
  other: ['UnitOtherAsc', 'UnitOtherDesc'],
  teamOrCrew: ['UnitTeamOrCrewAsc', 'UnitTeamOrCrewDesc'],
  section: ['UnitSectionAsc', 'UnitSectionDesc'],
  squad: ['UnitSquadAsc', 'UnitSquadDesc'],
  platoon: ['UnitPlatoonAsc', 'UnitPlatoonDesc'],
  company: ['UnitCompanyAsc', 'UnitCompanyDesc'],
  battalion: ['UnitBattalionAsc', 'UnitBattalionDesc'],
  regiment: ['UnitRegimentAsc', 'UnitRegimentDesc'],
  brigade: ['UnitBrigadeAsc', 'UnitBrigadeDesc'],
  division: ['UnitDivisionAsc', 'UnitDivisionDesc'],
  corps: ['UnitCorpsAsc', 'UnitCorpsDesc'],
  army: ['UnitArmyAsc', 'UnitArmyDesc'],
  militaryDistrict: ['UnitMilitaryDistrictAsc', 'UnitMilitaryDistrictDesc'],
  armyRegion: ['UnitArmyRegionAsc', 'UnitArmyRegionDesc'],
  createdAt: ['CreatedAtAsc', 'CreatedAtDesc'],
  comment: ['UnitCommentAsc', 'UnitCommentDesc'],
  hasOrbit: ['UnitOrbitLinkedAsc', 'UnitOrbitLinkedDesc'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function unitBooleanColumnFilter(value: unknown): UnitBooleanColumnFilter {
  return value === 'yes' || value === 'no' ? value : 'Усі';
}

function unitBooleanRequestFilter(value: UnitBooleanColumnFilter): boolean | null {
  return value === 'Усі' ? null : value === 'yes';
}

export function readUnitNameColumnFilter(value: unknown): UnitNameColumnFilter {
  if (typeof value === 'string') return { text: value, duplicateCandidate: 'Усі' };
  return {
    text: isRecord(value) && typeof value.text === 'string' ? value.text : '',
    duplicateCandidate: unitBooleanColumnFilter(
      isRecord(value) ? value.duplicateCandidate : undefined,
    ),
  };
}

export function readUnitOrbitColumnFilter(value: unknown): UnitOrbitColumnFilter {
  if (typeof value === 'string') return { text: value, linked: 'Усі', comment: 'Усі' };
  return {
    text: isRecord(value) && typeof value.text === 'string' ? value.text : '',
    linked: unitBooleanColumnFilter(isRecord(value) ? value.linked : undefined),
    comment: unitBooleanColumnFilter(isRecord(value) ? value.comment : undefined),
  };
}

function textColumnFilter(filters: MRT_ColumnFiltersState, id: string): string | null {
  const value = filters.find((filter) => filter.id === id)?.value;
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

export function buildUnitsListReq({
  statusFilter,
  globalFilter,
  columnFilters,
  sorting,
  searchMode,
  pagination,
}: {
  statusFilter: UnitStatusFilter;
  globalFilter: string;
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
  searchMode: UnitSearchMode;
  pagination: MRT_PaginationState;
}): ListUnitsReq {
  const sort = sorting[0];
  const sortOptions = sort ? UNIT_SORTS[sort.id] : undefined;
  const nameFilter = readUnitNameColumnFilter(
    columnFilters.find((filter) => filter.id === 'name')?.value,
  );
  const orbitFilter = readUnitOrbitColumnFilter(
    columnFilters.find((filter) => filter.id === 'hasOrbit')?.value,
  );

  return {
    ...DEFAULT_LIST_UNITS_REQ,
    sortBy: sortOptions?.[Number(sort?.desc ?? false)] ?? 'UnitNameAsc',
    includeInactive: statusFilter !== 'active',
    filterActive: statusFilter === 'all' ? null : statusFilter === 'active',
    filterText: globalFilter.trim() || null,
    filterName: nameFilter.text.trim() || null,
    filterOther: textColumnFilter(columnFilters, 'other'),
    filterTeamOrCrew: textColumnFilter(columnFilters, 'teamOrCrew'),
    filterSection: textColumnFilter(columnFilters, 'section'),
    filterSquad: textColumnFilter(columnFilters, 'squad'),
    filterPlatoon: textColumnFilter(columnFilters, 'platoon'),
    filterCompany: textColumnFilter(columnFilters, 'company'),
    filterBattalion: textColumnFilter(columnFilters, 'battalion'),
    filterRegiment: textColumnFilter(columnFilters, 'regiment'),
    filterBrigade: textColumnFilter(columnFilters, 'brigade'),
    filterDivision: textColumnFilter(columnFilters, 'division'),
    filterCorps: textColumnFilter(columnFilters, 'corps'),
    filterArmy: textColumnFilter(columnFilters, 'army'),
    filterMilitaryDistrict: textColumnFilter(columnFilters, 'militaryDistrict'),
    filterArmyRegion: textColumnFilter(columnFilters, 'armyRegion'),
    filterComment: textColumnFilter(columnFilters, 'comment'),
    filterOrbitNote: orbitFilter.text.trim() || null,
    filterIsDeduplicateCandidate: unitBooleanRequestFilter(nameFilter.duplicateCandidate),
    filterHasOrbit: unitBooleanRequestFilter(orbitFilter.linked),
    filterHasOrbitNote: unitBooleanRequestFilter(orbitFilter.comment),
    searchMode: searchMode === 'strict' ? 'Strict' : 'Relaxed',
    limit: pagination.pageSize,
    offset: pagination.pageIndex * pagination.pageSize,
  };
}

export const EMPTY_UNIT_FORM: UnitForm = {
  name: null,
  other: '',
  teamOrCrew: '',
  section: '',
  squad: '',
  platoon: '',
  company: '',
  battalion: '',
  regiment: '',
  brigade: '',
  division: '',
  corps: '',
  army: '',
  militaryDistrict: '',
  armyRegion: '',
  active: true,
  isDeduplicateCandidate: null,
  comment: '',
  orbitNote: null,
  duplicateUnitIds: [],
};

export function unitToForm(unit: Unit): UnitForm {
  return {
    name: unit.name,
    other: unit.other ?? '',
    teamOrCrew: unit.teamOrCrew ?? '',
    section: unit.section ?? '',
    squad: unit.squad ?? '',
    platoon: unit.platoon ?? '',
    company: unit.company ?? '',
    battalion: unit.battalion ?? '',
    regiment: unit.regiment ?? '',
    brigade: unit.brigade ?? '',
    division: unit.division ?? '',
    corps: unit.corps ?? '',
    army: unit.army ?? '',
    militaryDistrict: unit.militaryDistrict ?? '',
    armyRegion: unit.armyRegion ?? '',
    active: unit.active,
    isDeduplicateCandidate: unit.isDeduplicateCandidate,
    comment: unit.comment ?? '',
    orbitNote: unit.orbitNote,
    duplicateUnitIds: [],
  };
}

export function trimUnitForm(form: UnitForm): UnitForm {
  return {
    name: form.name?.trim() ?? null,
    other: (form.other ?? '').trim(),
    teamOrCrew: (form.teamOrCrew ?? '').trim(),
    section: (form.section ?? '').trim(),
    squad: (form.squad ?? '').trim(),
    platoon: (form.platoon ?? '').trim(),
    company: (form.company ?? '').trim(),
    battalion: (form.battalion ?? '').trim(),
    regiment: (form.regiment ?? '').trim(),
    brigade: (form.brigade ?? '').trim(),
    division: (form.division ?? '').trim(),
    corps: (form.corps ?? '').trim(),
    army: (form.army ?? '').trim(),
    militaryDistrict: (form.militaryDistrict ?? '').trim(),
    armyRegion: (form.armyRegion ?? '').trim(),
    active: form.active,
    isDeduplicateCandidate: form.isDeduplicateCandidate,
    comment: (form.comment ?? '').trim(),
    orbitNote: form.orbitNote?.trim() || null,
    duplicateUnitIds: form.duplicateUnitIds,
  };
}

export function unitNameParts(form: UnitForm): string[] {
  return [
    form.other,
    form.teamOrCrew,
    form.section,
    form.squad,
    form.platoon,
    form.company,
    form.battalion,
    form.regiment,
    form.brigade,
    form.division,
    form.corps,
    form.army,
    form.militaryDistrict,
    form.armyRegion,
  ]
    .filter((value): value is string => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function unitName(form: UnitForm): string {
  return unitNameParts(form).join(' ');
}

export function isUnitFormValid(form: UnitForm): boolean {
  return Boolean(form.name?.trim()) || unitNameParts(form).length > 0;
}

export function uniqueTrimmed(values: string[]): string[] {
  const seen = new Set<string>();
  return values.flatMap((value) =>
    value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => {
        const key = item.toLocaleLowerCase();
        if (!item || seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
  );
}

export function defaultUnitMasks(form: UnitForm): string[] {
  const parts = unitNameParts(form);
  return uniqueTrimmed([parts.join(' '), [...parts].reverse().join(' ')]);
}

export function findPotentialDuplicates(units: Unit[], form: UnitForm): Unit[] {
  const fields = [
    'other',
    'teamOrCrew',
    'section',
    'squad',
    'platoon',
    'company',
    'battalion',
    'regiment',
    'brigade',
    'division',
    'corps',
    'army',
    'militaryDistrict',
    'armyRegion',
  ] as const;
  const inputs = fields.map((field) => form[field].trim().toLocaleLowerCase());
  if (inputs.every((value) => value === '')) return [];

  return units.filter((unit) =>
    fields.every((field, index) => {
      const input = inputs[index];
      const value = unit[field].trim().toLocaleLowerCase();
      return input === '' || (value !== '' && value.includes(input));
    }),
  );
}

export function unitStatusCounts(units: Unit[]): { active: number; inactive: number } {
  return units.reduce(
    (counts, unit) => ({
      active: counts.active + Number(unit.active),
      inactive: counts.inactive + Number(!unit.active),
    }),
    { active: 0, inactive: 0 },
  );
}

export function filterUnitsByStatus(units: Unit[], status: UnitStatusFilter): Unit[] {
  if (status === 'all') return units;
  const active = status === 'active';
  return units.filter((unit) => unit.active === active);
}

export function formatUnitError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error === 'string' && error.trim()) return error;
  return 'Сталася невідома помилка';
}
