import type {
  Callsign,
  CallsignUnitStatRow,
  CreateCallsignReq,
  DevelopingFilter,
  ListCallsignsReq,
  ListCallsignsSortBy,
  Source,
  Unit,
  User,
} from '../../../../Bindings';

import type {
  BuildReqInput,
  BuildRowsResult,
  CallsignDraftRow,
  CallsignDraftValidation,
  CallsignEditForm,
  CallsignsFilterState,
  CallsignsSortState,
  ExportPermission,
  SortColumn,
  SortDirection,
  SortDescriptor,
  UnitHierarchyFilter,
} from './types';

const DEFAULT_LIMIT = 100;
const DAY_MS = 24 * 60 * 60 * 1000;
export const DESKTOP_LAYOUT_MIN_WIDTH_PX = 1440;

export const DEFAULT_SORT: CallsignsSortState = {
  column: 'unit',
  direction: 'asc',
};

export const DEFAULT_FILTERS = createDefaultFilters();

export function toUpperCaseCallsign(value: string): string {
  return value.toLocaleUpperCase('uk-UA');
}

export function normalizeDuplicateLookupValue(value: string): string {
  return value.toLocaleLowerCase('uk-UA').replace(/\s+/g, ' ').trim();
}

export const QUICK_PASTE_TSV_FORMAT_ERROR =
  'Швидка вставка підтримує лише TSV-формат: позивний, посада, коментар або позивний, посада, ПІП, коментар';
export const CALLSIGN_FORM_HINT =
  'Заповніть "Позивний" або "ПІП". Якщо їх немає, залиште інші змістовні дані запису.';
export const EMPTY_CALLSIGN_ROW_ERROR =
  'Порожній запис зберегти не можна. Заповніть "Позивний" або "ПІП", або додайте інші дані.';
export const LEGACY_CALLSIGN_CLEAR_ERROR =
  'Не можна залишити запис повністю порожнім. Заповніть "Позивний" або "ПІП", або залиште інші дані.';
export const RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR =
  'Для джерела "РО" поле "Частота" є обов’язковим.';

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
  const roles = new Set(user?.roles ?? []);
  return {
    canEdit: roles.has('Admin') || roles.has('CallsignsEditor') || roles.has('UnitsEditor'),
    canExport:
      roles.has('Rer')
      && (roles.has('Admin') || roles.has('UnitsEditor') || roles.has('AdvancedReports')),
  };
}

export function getExportPermissionFromRoles(rolesList: string[]): ExportPermission {
  const roles = new Set(rolesList);
  return {
    canEdit: roles.has('Admin') || roles.has('CallsignsEditor') || roles.has('UnitsEditor'),
    canExport:
      roles.has('Rer')
      && (roles.has('Admin') || roles.has('UnitsEditor') || roles.has('AdvancedReports')),
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
    filterUnitArmy: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.army),
    filterUnitDivision: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.division),
    filterUnitRegiment: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.regiment),
    filterUnitBattalion: normalizeHierarchyFilterValue(sidebarUnitHierarchyFilter?.battalion),
    filterDeveloping: filters.filterDeveloping,
    sinceDateInclusiveMs: filters.isIgnoringDateFilter ? null : parseDateTimeLocalToMs(filters.fromDateTimeLocal),
    tillDateInclusiveMs: filters.isIgnoringDateFilter ? null : parseDateTimeLocalToMs(filters.toDateTimeLocal),
    limit: query.limit,
    sortBy: toBackendSort(sort),
  };
}

function normalizeHierarchyFilterValue(value: UnitHierarchyFilter[keyof UnitHierarchyFilter] | undefined): string | null {
  if (value == null) return null;
  return value.trim();
}

export function buildInitialListReq(): ListCallsignsReq {
  return buildListCallsignsReq({
    filters: DEFAULT_FILTERS,
    sort: DEFAULT_SORT,
    query: { afterId: null, limit: DEFAULT_LIMIT },
  });
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
  direction?: SortDirection,
): CallsignsSortState {
  if (direction) {
    return {
      column,
      direction,
    };
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

export function downloadBlob(blob: Blob, fileName: string) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function createEmptyDraftRow(): CallsignDraftRow {
  return {
    callsign: '',
    position: '',
    fullName: '',
    comment: '',
    developing: false,
    radioFreq: '',
  };
}

function sanitizeCallsignAdditionalSourceIds(callsignAdditionalSourceIds: number[], primarySourceId: number | null | undefined): number[] {
  const uniqueIds = Array.from(new Set(callsignAdditionalSourceIds.filter((item) => Number.isInteger(item) && item > 0))).sort(
    (left, right) => left - right,
  );
  if (primarySourceId == null) return uniqueIds;
  return uniqueIds.filter((sourceId) => sourceId !== primarySourceId);
}

export function callsignToEditForm(callsign: Callsign): CallsignEditForm {
  return {
    id: callsign.id,
    callsign: toUpperCaseCallsign(callsign.callsign),
    position: callsign.position,
    fullName: callsign.fullName,
    comment: callsign.comment,
    callsignAdditionalSourceIds: sanitizeCallsignAdditionalSourceIds(callsign.callsignAdditionalSources, callsign.sourceId),
    unitId: callsign.unitId,
    sourceId: callsign.sourceId,
    developing: callsign.developing,
    radioFreq: callsign.radioFreq ?? '',
    createdAt: callsign.createdAt,
    active: callsign.active,
  };
}

export function validateDraftRows(rows: CallsignDraftRow[], _sourceId: number | null): CallsignDraftValidation {
  if (rows.length === 0) return { valid: false, error: 'Немає рядків для додавання' };

  const nonEmptyRows = rows.filter((row) => hasAnyDraftValue(row));
  if (nonEmptyRows.length === 0) return { valid: false, error: 'Заповніть хоча б один рядок' };

  const emptyIdentityAndLegacyContent = nonEmptyRows.find((row) => {
    const hasIdentity = row.callsign.trim() !== '' || row.fullName.trim() !== '';
    if (hasIdentity) return false;

    return [row.position, row.comment, row.radioFreq].every((value) => value.trim() === '') && !row.developing;
  });
  if (emptyIdentityAndLegacyContent) return { valid: false, error: EMPTY_CALLSIGN_ROW_ERROR };

  if (_sourceId === 2) {
    const missingRadioFreq = nonEmptyRows.find((row) => row.radioFreq.trim() === '');
    if (missingRadioFreq) {
      return { valid: false, error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR };
    }
  }

  return { valid: true, error: null };
}

export function validateEditForm(form: CallsignEditForm | null): CallsignDraftValidation {
  if (!form) return { valid: false, error: 'Не вибрано позивний для редагування' };
  const hasIdentity = form.callsign.trim() !== '' || form.fullName.trim() !== '';
  const hasLegacyContent =
    [form.position, form.comment, form.radioFreq].some((value) => value.trim() !== '')
    || form.developing
    || form.unitId > 0
    || form.sourceId != null
    || form.callsignAdditionalSourceIds.length > 0;
  if (!hasIdentity && !hasLegacyContent) {
    return { valid: false, error: LEGACY_CALLSIGN_CLEAR_ERROR };
  }
  if (form.sourceId === 2 && form.radioFreq.trim() === '') {
    return { valid: false, error: RO_SOURCE_RADIO_FREQ_REQUIRED_ERROR };
  }
  return { valid: true, error: null };
}

export function hasAnyDraftValue(row: CallsignDraftRow): boolean {
  return [row.callsign, row.position, row.fullName, row.comment, row.radioFreq].some((value) => value.trim() !== '') || row.developing;
}

export function parseTabDelimitedInput(input: string): {
  rows: CallsignDraftRow[];
  error: string | null;
} {
  const trimmed = input.replace(/(?:\r\n|\r|\n)+$/, '');
  if (!trimmed) {
    return { rows: [], error: null };
  }

  const rows: CallsignDraftRow[] = [];
  for (const line of trimmed.split(/\r?\n/)) {
    const nextRows = (() => {
      const cells = line.split('\t');
      if (cells.length === 3) {
        return [createDraftRow(cells[0], cells[1], '', cells[2])];
      }
      if (cells.length === 4) {
        return [createDraftRow(cells[0], cells[1], cells[2], cells[3])];
      }
      return null;
    })();

    if (nextRows == null) {
      return { rows: [], error: QUICK_PASTE_TSV_FORMAT_ERROR };
    }

    rows.push(...nextRows);
  }

  return { rows, error: null };
}
function createDraftRow(callsign: string, position: string, fullName: string, comment: string): CallsignDraftRow {
  return {
    callsign: toUpperCaseCallsign(callsign.trim()),
    position: position.trim(),
    fullName: fullName.trim(),
    comment: comment.trim(),
    developing: false,
    radioFreq: '',
  };
}

export function mergeUnitStatsWithUnits(unitStats: CallsignUnitStatRow[], unitsById: Map<number, Unit>) {
  return unitStats
    .map((stat) => {
      const unit = unitsById.get(stat.unitId);
      return {
        ...stat,
        unitName: unit?.name ?? `#${stat.unitId}`,
        army: unit?.army ?? '',
        division: unit?.division ?? '',
        regiment: unit?.regiment ?? '',
        battalion: unit?.battalion ?? '',
      };
    })
    .sort((a, b) => b.count - a.count || a.unitName.localeCompare(b.unitName, 'uk'));
}

export function buildRowViews(callsigns: Callsign[], unitsById: Map<number, Unit>, sourcesById: Map<number, Source>): BuildRowsResult {
  const rows = callsigns.map((callsign) => {
    const callsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(callsign.callsignAdditionalSources, callsign.sourceId);
    const callsignAdditionalSourceNames = callsignAdditionalSourceIds
      .map((sourceId) => sourcesById.get(sourceId)?.name ?? `#${sourceId}`);

    return {
      ...callsign,
      callsignAdditionalSourceIds,
      callsignAdditionalSourceNames,
      unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
      sourceName: callsign.sourceId == null ? '—' : (sourcesById.get(callsign.sourceId)?.name ?? `#${callsign.sourceId}`),
    };
  });

  return {
    rows,
    unitStats: [],
  };
}

export function createUnitsById(units: Unit[]): Map<number, Unit> {
  return new Map(units.map((unit) => [unit.id, unit]));
}

export function createSourcesById(sources: Source[]): Map<number, Source> {
  return new Map(sources.map((source) => [source.id, source]));
}

export function makeUpdatePayload(form: CallsignEditForm): Callsign {
  const callsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(form.callsignAdditionalSourceIds, form.sourceId);
  return {
    id: form.id,
    callsign: toUpperCaseCallsign(form.callsign).trim(),
    position: form.position.trim(),
    fullName: form.fullName.trim(),
    comment: form.comment.trim(),
    unitId: form.unitId,
    active: form.active,
    sourceId: form.sourceId,
    callsignAdditionalSources: callsignAdditionalSourceIds,
    createdAt: form.createdAt,
    developing: form.developing,
    radioFreq: form.radioFreq.trim() === '' ? '' : form.radioFreq.trim(),
  };
}

export function makeCreatePayload(
  row: CallsignDraftRow,
  unitId: number,
  sourceId: number,
  callsignAdditionalSourceIds: number[],
): CreateCallsignReq {
  const safeCallsignAdditionalSourceIds = sanitizeCallsignAdditionalSourceIds(callsignAdditionalSourceIds, sourceId);
  return {
    callsign: toUpperCaseCallsign(row.callsign).trim(),
    position: row.position.trim(),
    fullName: row.fullName.trim(),
    comment: row.comment.trim(),
    unitId,
    sourceId,
    callsignAdditionalSources: safeCallsignAdditionalSourceIds,
    developing: row.developing,
    radioFreq: row.radioFreq.trim() === '' ? '' : row.radioFreq.trim(),
  };
}

function compareStrings(left: string, right: string) {
  return left.localeCompare(right, 'uk', { sensitivity: 'base' });
}

function normalizeRadioFreq(value: string | null | undefined) {
  const normalized = value?.trim() ?? '';
  return normalized === '' ? '—' : normalized;
}

function compareUnitNames(left: Callsign, right: Callsign, unitsById: Map<number, Unit>) {
  const leftUnit = unitsById.get(left.unitId);
  const rightUnit = unitsById.get(right.unitId);
  const unitParts = ['army', 'division', 'regiment', 'battalion', 'company'] as const;

  for (const part of unitParts) {
    const leftValue = String(leftUnit?.[part] ?? '');
    const rightValue = String(rightUnit?.[part] ?? '');
    const result = compareStrings(leftValue, rightValue);
    if (result !== 0) return result;
  }

  return compareStrings(left.callsign, right.callsign);
}

export function sortRowsClientSide(
  callsigns: Callsign[],
  sort: CallsignsSortState,
  unitsById: Map<number, Unit>,
  sourcesById: Map<number, Source>,
): Callsign[] {
  const sorted = [...callsigns];
  sorted.sort((left, right) => {
    let result = 0;

    if (sort.column === 'callsign') {
      result = compareStrings(left.callsign, right.callsign);
    } else if (sort.column === 'position') {
      result = compareStrings(left.position, right.position);
    } else if (sort.column === 'fullName') {
      result = compareStrings(left.fullName, right.fullName);
    } else if (sort.column === 'comment') {
      result = compareStrings(left.comment, right.comment);
    } else if (sort.column === 'sourceName') {
      result = compareStrings(
        left.sourceId == null ? '—' : (sourcesById.get(left.sourceId)?.name ?? `#${left.sourceId}`),
        right.sourceId == null ? '—' : (sourcesById.get(right.sourceId)?.name ?? `#${right.sourceId}`),
      );
    } else if (sort.column === 'radioFreq') {
      result = compareStrings(normalizeRadioFreq(left.radioFreq), normalizeRadioFreq(right.radioFreq));
    } else if (sort.column === 'createdAt') {
      result = left.createdAt - right.createdAt;
    } else {
      result = compareUnitNames(left, right, unitsById);
    }

    if (result === 0) {
      result = left.id - right.id;
    }

    return sort.direction === 'asc' ? result : -result;
  });
  return sorted;
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
