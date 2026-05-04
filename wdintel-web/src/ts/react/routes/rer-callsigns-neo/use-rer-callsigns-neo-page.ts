import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import { isNullOrUndefined, isPresent } from '../../utils/misc';


import type { Callsign, CallsignUnitStatRow, Source, Unit, User } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import {
  createCallsign,
  deleteCallsign,
  downloadCallsignsCsv,
  downloadCallsignsXlsx,
  fetchCallsignsBootstrapData,
  getCallsignUnitStats,
  listCallsigns,
  listSources,
  updateCallsign,
} from '../../services/api/callsigns';
import {
  buildListCallsignsReq,
  buildRowViews,
  callsignToEditForm,
  createDefaultFilters,
  createEmptyDraftRow,
  createSourcesById,
  createUnitsById,
  DEFAULT_SORT,
  formatErrorMessage,
  getDefaultPageSize,
  getExportPermission,
  getExportPermissionFromRoles,
  hasAnyDraftValue,
  isAbortError,
  makeCreatePayload,
  makeUpdatePayload,
  mergeUnitStatsWithUnits,
  nextSortState,
  normalizeDuplicateLookupValue,
  parseTabDelimitedInput,
  QUICK_PASTE_TSV_FORMAT_ERROR,
  sortRowsClientSide,
  toUpperCaseCallsign,
  validateDraftRows,
  validateEditForm,
} from './helpers';
import type {
  CallsignDraftRow,
  CallsignEditForm,
  CallsignsFilterState,
  CallsignsSortState,
  DownloadKind,
  SelectedSidebarUnitFilter,
  SortDirection,
  UiStatus,
  UnitHierarchyFilter,
} from './types';

const EMPTY_HIERARCHY_PARAM = '__EMPTY__';
const FILTERS_DEBOUNCE_MS = 500;
const HIERARCHY_LABELS = {
  army: 'Армія',
  division: 'Дивізія',
  regiment: 'Полк',
  battalion: 'Батальйон',
} as const;

function updateUrlSearchParams(mutator: (params: URLSearchParams) => void) {
  const url = new URL(window.location.href);
  const params = new URLSearchParams(url.search);
  mutator(params);
  const nextSearch = params.toString();
  const nextUrl = `${url.pathname}${nextSearch ? `?${nextSearch}` : ''}${url.hash}`;
  window.history.replaceState({}, '', nextUrl);
}

function readInitialCallsignsFiltersFromUrl(): CallsignsFilterState {
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
    fromDateTimeLocal: sortDateEnabled ? (params.get('from') ?? defaults.fromDateTimeLocal) : defaults.fromDateTimeLocal,
    toDateTimeLocal: sortDateEnabled ? (params.get('to') ?? defaults.toDateTimeLocal) : defaults.toDateTimeLocal,
  };
}

function readInitialCallsignsSortFromUrl(): CallsignsSortState {
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
  const validDirection = direction === 'asc' || direction === 'desc' ? direction : DEFAULT_SORT.direction;

  return {
    column: validColumn,
    direction: validDirection,
  };
}

function readInitialSidebarOpenFromUrl(): boolean {
  const params = new URLSearchParams(window.location.search);
  const raw = params.get('units_sidebar');
  if (raw === '0') return false;
  if (raw === '1') return true;
  return true;
}

function readInitialSidebarSelectedUnitFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const unit = params.get('unit')?.trim() ?? '';
  return unit || null;
}

function readInitialSidebarHierarchyFilterFromUrl(): UnitHierarchyFilter | null {
  const params = new URLSearchParams(window.location.search);
  const hierarchy = {
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

function getSidebarGroupLabel(hierarchy: UnitHierarchyFilter): string {
  const lastDefinedEntry = (Object.entries(hierarchy) as Array<[keyof UnitHierarchyFilter, string | null]>)
    .reverse()
    .find(([, value]) => isPresent(value));

  if (!lastDefinedEntry) return 'Підрозділ';

  const [key, value] = lastDefinedEntry;
  return value === '' ? `Без ${HIERARCHY_LABELS[key].toLowerCase()}` : (value ?? 'Підрозділ');
}

function areSidebarFiltersEqual(
  left: SelectedSidebarUnitFilter | null,
  right: SelectedSidebarUnitFilter | null,
): boolean {
  if (isNullOrUndefined(left) || isNullOrUndefined(right)) return left === right;
  if (left.kind !== right.kind) return false;

  if (left.kind === 'leaf' && right.kind === 'leaf') {
    return left.unitName === right.unitName;
  }

  if (left.kind === 'group' && right.kind === 'group') {
    return left.hierarchy.army === right.hierarchy.army
      && left.hierarchy.division === right.hierarchy.division
      && left.hierarchy.regiment === right.hierarchy.regiment
      && left.hierarchy.battalion === right.hierarchy.battalion;
  }

  return false;
}

function readInitialSidebarFilterFromUrl(): SelectedSidebarUnitFilter | null {
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

function syncCallsignsStateToUrl(
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
    setHierarchyParam(params, 'unit_army', selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy.army : null);
    setHierarchyParam(params, 'unit_division', selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy.division : null);
    setHierarchyParam(params, 'unit_regiment', selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy.regiment : null);
    setHierarchyParam(params, 'unit_battalion', selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy.battalion : null);

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

function areCallsignFiltersEqual(left: CallsignsFilterState, right: CallsignsFilterState): boolean {
  return left.filterText === right.filterText
    && left.filterCallsign === right.filterCallsign
    && left.filterPosition === right.filterPosition
    && left.filterFullName === right.filterFullName
    && left.filterComment === right.filterComment
    && left.filterUnit === right.filterUnit
    && left.filterDeveloping === right.filterDeveloping
    && left.isIgnoringDateFilter === right.isIgnoringDateFilter
    && left.fromDateTimeLocal === right.fromDateTimeLocal
    && left.toDateTimeLocal === right.toDateTimeLocal;
}

function areCallsignSortStatesEqual(left: CallsignsSortState, right: CallsignsSortState): boolean {
  return left.column === right.column && left.direction === right.direction;
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

function unauthorizedOrThrow(error: unknown): never {
  throw error;
}

function normalizeCallsign(callsign: Callsign): Callsign {
  return {
    ...callsign,
    callsign: toUpperCaseCallsign(callsign.callsign),
  };
}

function normalizeCallsigns(callsigns: Callsign[]): Callsign[] {
  return callsigns.map(normalizeCallsign);
}

function hasAnyDuplicateHintInput(rows: CallsignDraftRow[]): boolean {
  return rows.some((row) => {
    const callsignInput = normalizeDuplicateLookupValue(row.callsign);
    const fullNameInput = normalizeDuplicateLookupValue(row.fullName);
    return callsignInput.length >= 2 || fullNameInput.length >= 2;
  });
}

type DuplicateHintInput = {
  callsignInput: string;
  fullNameInput: string;
  positionInput: string;
};

function getReloadPageSize(callsignsCount: number) {
  return Math.max(getDefaultPageSize(), callsignsCount);
}

export function useRerCallsignsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const [user, setUser] = useState<User | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [sources, setSources] = useState<Source[]>([]);
  const [unitStats, setUnitStats] = useState<CallsignUnitStatRow[]>([]);

  const [callsigns, setCallsigns] = useState<Callsign[]>([]);
  const [showLoadMore, setShowLoadMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [status, setStatus] = useState<UiStatus>(null);

  const [filters, setFilters] = useState<CallsignsFilterState>(() => readInitialCallsignsFiltersFromUrl());
  const [sort, setSort] = useState<CallsignsSortState>(() => readInitialCallsignsSortFromUrl());
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readInitialSidebarOpenFromUrl());
  const [selectedSidebarUnitFilter, setSelectedSidebarUnitFilter] = useState<SelectedSidebarUnitFilter | null>(() =>
    readInitialSidebarFilterFromUrl(),
  );

  const [addUnitId, setAddUnitId] = useState<number | null>(null);
  const [addSourceId, setAddSourceId] = useState<number | null>(null);
  const [addCallsignAdditionalSourceIds, setAddCallsignAdditionalSourceIds] = useState<number[]>([]);
  const [addRows, setAddRows] = useState<CallsignDraftRow[]>([createEmptyDraftRow()]);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addValidationError, setAddValidationError] = useState<string | null>(null);
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [addDuplicateHintsEnabled, setAddDuplicateHintsEnabled] = useState(false);
  const duplicateHintInputs = useMemo<DuplicateHintInput[]>(
    () =>
      addRows
        .map((row) => ({
          callsignInput: normalizeDuplicateLookupValue(row.callsign),
          fullNameInput: normalizeDuplicateLookupValue(row.fullName),
          positionInput: normalizeDuplicateLookupValue(row.position),
        }))
        .filter((row) => row.callsignInput.length >= 2 || row.fullNameInput.length >= 2),
    [addRows],
  );
  const deferredDuplicateHintInputs = useDeferredValue(duplicateHintInputs);

  const [editForm, setEditForm] = useState<CallsignEditForm | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editValidationError, setEditValidationError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<Callsign | null>(null);
  const [deleteInFlightId, setDeleteInFlightId] = useState<number | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [selectedCallsignIds, setSelectedCallsignIds] = useState<number[]>([]);
  const [bulkDeleteDialogCallsigns, setBulkDeleteDialogCallsigns] = useState<Callsign[]>([]);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = useState(false);
  const [bulkDeleteInFlight, setBulkDeleteInFlight] = useState(false);

  const [downloadInProgress, setDownloadInProgress] = useState<DownloadKind | null>(null);

  const initializedRef = useRef(false);
  const listRequestSeqRef = useRef(0);
  const debounceTimerRef = useRef<number | null>(null);
  const activeListAbortRef = useRef<AbortController | null>(null);

  const unitsById = useMemo(() => createUnitsById(units), [units]);
  const sourcesById = useMemo(() => createSourcesById(sources), [sources]);
  const permissions = useMemo(() => {
    const apiPermissions = getExportPermission(user);
    const shellPermissions = getExportPermissionFromRoles(authUserRoles);
    return {
      canEdit: apiPermissions.canEdit || shellPermissions.canEdit,
      canExport: apiPermissions.canExport || shellPermissions.canExport,
    };
  }, [user, authUserRoles]);

  const sortedCallsigns = useMemo(
    () => sortRowsClientSide(callsigns, sort, unitsById, sourcesById),
    [callsigns, sort, unitsById, sourcesById],
  );
  const rows = useMemo(
    () => buildRowViews(sortedCallsigns, unitsById, sourcesById).rows,
    [sortedCallsigns, unitsById, sourcesById],
  );
  const unitStatsView = useMemo(() => mergeUnitStatsWithUnits(unitStats, unitsById), [unitStats, unitsById]);
  const addPotentialDuplicates = useMemo(() => {
    if (!addDuplicateHintsEnabled || addSubmitting) return [];
    if (deferredDuplicateHintInputs.length === 0) return [];

    return callsigns
      .filter((callsign) => {
        const callsignValue = normalizeDuplicateLookupValue(callsign.callsign);
        const fullNameValue = normalizeDuplicateLookupValue(callsign.fullName);
        const positionValue = normalizeDuplicateLookupValue(callsign.position);
        const rowMatches = deferredDuplicateHintInputs.some((draftInput) => {
          const callsignMatches =
            draftInput.callsignInput.length >= 2 && callsignValue.includes(draftInput.callsignInput);
          const fullNameMatches =
            draftInput.fullNameInput.length >= 2 && fullNameValue.includes(draftInput.fullNameInput);
          const positionMatches =
            draftInput.positionInput === '' || positionValue.includes(draftInput.positionInput);
          return (callsignMatches || fullNameMatches) && positionMatches;
        });
        const unitMatches = isNullOrUndefined(addUnitId) || callsign.unitId === addUnitId;

        return rowMatches && unitMatches;
      })
      .slice(0, 10)
      .map((callsign) => ({
        id: callsign.id,
        callsign: callsign.callsign,
        position: callsign.position,
        fullName: callsign.fullName,
        comment: callsign.comment,
        unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
      }));
  }, [addDuplicateHintsEnabled, addSubmitting, addUnitId, callsigns, deferredDuplicateHintInputs, unitsById]);

  function clearListRequest() {
    activeListAbortRef.current?.abort();
    activeListAbortRef.current = null;
  }

  async function runListFetch({
    append,
    afterId,
    announceLoading,
    preserveLoadedCount = false,
  }: {
    append: boolean;
    afterId: number | null;
    announceLoading: boolean;
    preserveLoadedCount?: boolean;
  }) {
    const seq = ++listRequestSeqRef.current;
    if (!append) {
      const limit = preserveLoadedCount ? getReloadPageSize(callsigns.length) : getDefaultPageSize();
      setLoadingMore(false);
      clearListRequest();
      const controller = new AbortController();
      activeListAbortRef.current = controller;
      if (announceLoading) setLoading(true);

      try {
        const rsp = await listCallsigns(
          buildListCallsignsReq({
            filters,
            sort,
            query: { afterId, limit },
            sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
          }),
          controller.signal,
        );
        if (listRequestSeqRef.current !== seq) return;
        setCallsigns(normalizeCallsigns(rsp.callsigns));
        setShowLoadMore(rsp.showLoadMore);
      } catch (error) {
        if (isAbortError(error)) return;
        try {
          unauthorizedOrThrow(error);
        } catch (finalError) {
          setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(finalError)}` });
        }
      } finally {
        if (listRequestSeqRef.current === seq) {
          setLoading(false);
          setRefreshing(false);
        }
      }
      return;
    }

    if (announceLoading) setLoadingMore(true);

    try {
      const rsp = await listCallsigns(
        buildListCallsignsReq({
          filters,
          sort,
          query: { afterId, limit: getDefaultPageSize() },
          sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
        }),
      );
      if (listRequestSeqRef.current !== seq) return;
      setCallsigns((prev) => {
        const byId = new Map<number, Callsign>();
        for (const item of prev) byId.set(item.id, item);
        for (const item of normalizeCallsigns(rsp.callsigns)) byId.set(item.id, item);
        return Array.from(byId.values());
      });
      setShowLoadMore(rsp.showLoadMore);
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(finalError)}` });
      }
    } finally {
      if (listRequestSeqRef.current === seq) {
        setLoadingMore(false);
      }
    }
  }

  async function refreshLookupsAndStats() {
    try {
      const [freshSources, freshStats] = await Promise.all([listSources(), getCallsignUnitStats()]);
      setSources(freshSources);
      setUnitStats(freshStats);
      setAddSourceId((prev) => (isNullOrUndefined(prev) ? freshSources[0]?.id ?? null : prev));
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setStatus({ kind: 'error', text: `Помилка оновлення довідників: ${formatErrorMessage(finalError)}` });
      }
    }
  }

  useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      setLoading(true);
      setStatus(null);
      try {
        const bootstrap = await fetchCallsignsBootstrapData(
          buildListCallsignsReq({
            filters,
            sort,
            query: { afterId: null, limit: getDefaultPageSize() },
            sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
          }),
        );

        if (cancelled) return;

        setUser(bootstrap.user);
        setUnits(bootstrap.units);
        setSources(bootstrap.sources);
        setUnitStats(bootstrap.unitStats);
        setCallsigns(normalizeCallsigns(bootstrap.callsigns.callsigns));
        setShowLoadMore(bootstrap.callsigns.showLoadMore);
        setAddSourceId(bootstrap.sources[0]?.id ?? null);
        initializedRef.current = true;
      } catch (error) {
        if (cancelled) return;
        try {
          unauthorizedOrThrow(error);
        } catch (finalError) {
          setStatus({ kind: 'error', text: `Помилка завантаження позивних: ${formatErrorMessage(finalError)}` });
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    loadBootstrap();

    return () => {
      cancelled = true;
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
      clearListRequest();
    };
  }, []);

  useEffect(() => {
    if (!initializedRef.current) return;

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev?.kind === 'success' ? null : prev));
      setRefreshing(true);
      void runListFetch({ append: false, afterId: null, announceLoading: false });
    }, FILTERS_DEBOUNCE_MS);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [filters, sort, selectedSidebarUnitFilter]);

  useEffect(() => {
    syncCallsignsStateToUrl(filters, sort, sidebarOpen, selectedSidebarUnitFilter);
  }, [filters, sort, sidebarOpen, selectedSidebarUnitFilter]);

  useEffect(() => {
    function onPopState() {
      const nextFilters = readInitialCallsignsFiltersFromUrl();
      const nextSort = readInitialCallsignsSortFromUrl();
      const nextSidebarOpen = readInitialSidebarOpenFromUrl();
      const nextSelectedSidebarUnitFilter = readInitialSidebarFilterFromUrl();

      setFilters((prev) => (areCallsignFiltersEqual(prev, nextFilters) ? prev : nextFilters));
      setSort((prev) => (areCallsignSortStatesEqual(prev, nextSort) ? prev : nextSort));
      setSidebarOpen((prev) => (prev === nextSidebarOpen ? prev : nextSidebarOpen));
      setSelectedSidebarUnitFilter((prev) =>
        areSidebarFiltersEqual(prev, nextSelectedSidebarUnitFilter) ? prev : nextSelectedSidebarUnitFilter,
      );
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setSelectedCallsignIds((prev) => prev.filter((id) => callsigns.some((callsign) => callsign.id === id)));
  }, [callsigns]);

  function onFiltersChange(updater: (prev: CallsignsFilterState) => CallsignsFilterState) {
    setFilters((prev) => {
      const next = updater(prev);
      if (next.filterUnit.trim() !== prev.filterUnit.trim() && selectedSidebarUnitFilter) {
        if (selectedSidebarUnitFilter.kind === 'leaf') {
          if (next.filterUnit.trim() !== selectedSidebarUnitFilter.unitName) {
            setSelectedSidebarUnitFilter(null);
          }
        } else if (next.filterUnit.trim() !== '') {
          setSelectedSidebarUnitFilter(null);
        }
      }
      return next;
    });
  }

  function onSort(
    column: 'callsign' | 'position' | 'fullName' | 'comment' | 'createdAt' | 'unit' | 'sourceName' | 'radioFreq',
    direction?: SortDirection,
  ) {
    setSort((prev) => nextSortState(prev, column, direction));
  }

  async function onRefresh() {
    setRefreshing(true);
    setStatus(null);
    await Promise.all([
      refreshLookupsAndStats(),
      runListFetch({ append: false, afterId: null, announceLoading: false, preserveLoadedCount: true }),
    ]);
  }

  function onClearFilters() {
    setSelectedSidebarUnitFilter(null);
    setFilters(createDefaultFilters());
  }

  function setCallsignSelected(callsignId: number, checked: boolean) {
    setSelectedCallsignIds((prev) => {
      if (checked) {
        if (prev.includes(callsignId)) return prev;
        return [...prev, callsignId];
      }

      return prev.filter((id) => id !== callsignId);
    });
  }

  function setAllCallsignsSelected(callsignIds: number[], checked: boolean) {
    if (callsignIds.length === 0) return;

    setSelectedCallsignIds((prev) => {
      if (checked) {
        const selected = new Set(prev);
        for (const callsignId of callsignIds) {
          selected.add(callsignId);
        }
        return Array.from(selected);
      }

      const toRemove = new Set(callsignIds);
      return prev.filter((id) => !toRemove.has(id));
    });
  }

  const clearSelectedCallsigns = useCallback(() => {
    setSelectedCallsignIds((prev) => (prev.length === 0 ? prev : []));
  }, []);

  useEffect(() => {
    clearSelectedCallsigns();
  }, [clearSelectedCallsigns, filters, sort]);

  function onAppendRow() {
    setAddRows((prev) => [...prev, createEmptyDraftRow()]);
  }

  function onRemoveRow(index: number) {
    setAddValidationError(null);
    setAddRows((prev) => {
      if (prev.length <= 1) {
        setAddDuplicateHintsEnabled(false);
        return prev;
      }
      const nextRows = prev.filter((_, rowIndex) => rowIndex !== index);
      setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(nextRows));
      return nextRows;
    });
  }

  function onClearRows() {
    setAddRows([createEmptyDraftRow()]);
    setAddValidationError(null);
    setAddDuplicateHintsEnabled(false);
  }

  function onOpenAddDrawer() {
    if (!permissions.canEdit) return;
    setAddDrawerOpen(true);
    setAddValidationError(null);
    setAddCallsignAdditionalSourceIds([]);
  }

  function resetAddDrawerState() {
    setAddRows([createEmptyDraftRow()]);
    setAddUnitId(null);
    setAddSourceId(sources[0]?.id ?? null);
    setAddCallsignAdditionalSourceIds([]);
    setAddValidationError(null);
    setAddDuplicateHintsEnabled(false);
  }

  function onCloseAddDrawer() {
    if (addSubmitting) return;
    resetAddDrawerState();
    setAddDrawerOpen(false);
  }

  function onRowChange(index: number, next: CallsignDraftRow) {
    setAddValidationError(null);
    setAddRows((prev) => {
      const nextRows = prev.map((row, rowIndex) => (rowIndex === index ? next : row));
      setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(nextRows));
      return nextRows;
    });
  }

  function onApplyPastedRows(value: string) {
    if (!value.includes('\t') && !value.includes('\n')) {
      setAddValidationError(null);
      return;
    }
    const parsed = parseTabDelimitedInput(value);
    if (parsed.error) {
      setAddRows([createEmptyDraftRow()]);
      setAddDuplicateHintsEnabled(false);
      setAddValidationError(parsed.error);
      return;
    }
    if (parsed.rows.length === 0) {
      setAddRows([createEmptyDraftRow()]);
      setAddDuplicateHintsEnabled(false);
      setAddValidationError(QUICK_PASTE_TSV_FORMAT_ERROR);
      return;
    }
    setAddRows(parsed.rows);
    setAddValidationError(null);
    setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(parsed.rows));
  }

  async function onSubmitAdd() {
    if (!permissions.canEdit) return;

    setStatus(null);
    setAddValidationError(null);

    if (isNullOrUndefined(addUnitId)) {
      return;
    }
    if (isNullOrUndefined(addSourceId)) {
      setAddValidationError('Оберіть джерело');
      return;
    }
    if (!addRows.some((row) => hasAnyDraftValue(row))) {
      return;
    }

    const validation = validateDraftRows(addRows, addSourceId);
    if (!validation.valid) {
      if (validation.error === 'Заповніть хоча б один рядок') {
        return;
      }
      setAddValidationError(validation.error);
      return;
    }

    setAddSubmitting(true);
    setAddDuplicateHintsEnabled(false);

    try {
      const nonEmptyRows = addRows.filter((row) => hasAnyDraftValue(row));
      const created: Callsign[] = [];
      const failed: Array<{ row: CallsignDraftRow; error: string }> = [];

      for (const row of nonEmptyRows) {
        try {
          const item = await createCallsign(
            makeCreatePayload(row, addUnitId, addSourceId, addCallsignAdditionalSourceIds),
          );
          created.push(normalizeCallsign(item));
        } catch (error) {
          failed.push({ row, error: formatErrorMessage(error) });
        }
      }

      if (created.length > 0) {
        setCallsigns((prev) => [...created, ...prev]);
        await refreshLookupsAndStats();
      }

      if (failed.length === 0) {
        setAddRows([createEmptyDraftRow()]);
        setAddDrawerOpen(false);
        resetAddDrawerState();
        setStatus({ kind: 'success', text: `Додано позивних: ${created.length}` });
        return;
      }

      const failedRows = failed.map((item) => item.row);
      setAddRows(failedRows);
      setAddDuplicateHintsEnabled(hasAnyDuplicateHintInput(failedRows));
      setAddValidationError(
        failed.length === 1
          ? `Не вдалося додати 1 позивний: ${failed[0]?.error ?? 'Невідома помилка'}`
          : `Не вдалося додати ${failed.length} позивних. Перша помилка: ${failed[0]?.error ?? 'Невідома помилка'}`,
      );
      if (created.length > 0) {
        setStatus({
          kind: 'error',
          text: `Додано: ${created.length}, не вдалося: ${failed.length}`,
        });
      }
    } finally {
      setAddSubmitting(false);
    }
  }

  function onOpenEdit(callsign: Callsign) {
    if (!permissions.canEdit) return;
    setEditValidationError(null);
    setEditForm(callsignToEditForm(callsign));
  }

  function onCloseEdit() {
    if (editSubmitting) return;
    setEditValidationError(null);
    setEditForm(null);
  }

  async function onSaveEdit() {
    setEditValidationError(null);
    setStatus(null);

    const validation = validateEditForm(editForm);
    if (!validation.valid) {
      setEditValidationError(validation.error);
      return;
    }
    if (!editForm) return;

    setEditSubmitting(true);
    try {
      const updated = normalizeCallsign(await updateCallsign(makeUpdatePayload(editForm)));
      setCallsigns((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setEditForm(null);
      setStatus({ kind: 'success', text: 'Позивний оновлено' });
      await refreshLookupsAndStats();
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setEditValidationError(`Помилка оновлення позивного: ${formatErrorMessage(finalError)}`);
      }
    } finally {
      setEditSubmitting(false);
    }
  }

  function onRequestDelete(callsign: Callsign) {
    if (!permissions.canEdit) return;
    if (bulkDeleteInFlight || deleteInFlightId !== null) return;
    setDeleteTarget(callsign);
  }

  function onCancelDelete() {
    if (deleteSubmitting || bulkDeleteInFlight || deleteInFlightId !== null) return;
    setDeleteTarget(null);
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleteSubmitting(true);
    setDeleteInFlightId(deleteTarget.id);
    setStatus(null);

    try {
      const deleted = await deleteCallsign(deleteTarget.id);
      setCallsigns((prev) => prev.filter((item) => item.id !== deleted.id));
      setSelectedCallsignIds((prev) => prev.filter((id) => id !== deleted.id));
      setDeleteTarget(null);
      setStatus({ kind: 'success', text: 'Позивний видалено' });
      await refreshLookupsAndStats();
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setStatus({ kind: 'error', text: `Помилка видалення позивного: ${formatErrorMessage(finalError)}` });
      }
    } finally {
      setDeleteSubmitting(false);
      setDeleteInFlightId(null);
    }
  }

  function requestBulkDelete() {
    if (!permissions.canEdit) return;
    if (bulkDeleteInFlight || deleteInFlightId !== null || deleteTarget !== null) return;

    const selectedSet = new Set(selectedCallsignIds);
    const selected = callsigns.filter((callsign) => selectedSet.has(callsign.id) && deleteInFlightId !== callsign.id);
    if (selected.length === 0) return;

    setBulkDeleteDialogCallsigns(selected);
    setBulkDeleteDialogOpen(true);
  }

  function cancelBulkDelete() {
    if (bulkDeleteInFlight || deleteInFlightId !== null) return;
    setBulkDeleteDialogOpen(false);
  }

  async function confirmBulkDelete() {
    if (bulkDeleteInFlight || deleteInFlightId !== null) return;

    const callsignsToDelete = [...bulkDeleteDialogCallsigns];
    if (callsignsToDelete.length === 0) return;

    setBulkDeleteDialogOpen(false);
    setBulkDeleteInFlight(true);
    setStatus(null);

    const failed: string[] = [];

    try {
      for (const callsign of callsignsToDelete) {
        setDeleteInFlightId(callsign.id);

        try {
          await deleteCallsign(callsign.id);
          setCallsigns((prev) => prev.filter((item) => item.id !== callsign.id));
          setSelectedCallsignIds((prev) => prev.filter((id) => id !== callsign.id));
        } catch (deleteError) {
          try {
            unauthorizedOrThrow(deleteError);
          } catch (finalError) {
            failed.push(`${callsign.callsign}: ${formatErrorMessage(finalError)}`);
          }
        } finally {
          setDeleteInFlightId(null);
        }
      }

      if (failed.length > 0) {
        setStatus({ kind: 'error', text: `Не вдалося видалити деякі позивні: ${failed[0]}` });
      } else {
        setStatus({ kind: 'success', text: `Видалено позивних: ${callsignsToDelete.length}` });
      }

      await refreshLookupsAndStats();
    } finally {
      setBulkDeleteInFlight(false);
      setBulkDeleteDialogCallsigns([]);
    }
  }

  function onBulkDeleteDialogExited() {
    if (bulkDeleteDialogOpen || bulkDeleteInFlight) return;
    setBulkDeleteDialogCallsigns([]);
  }

  async function onDownload(kind: DownloadKind) {
    setStatus(null);
    setDownloadInProgress(kind);
    try {
      const req = buildListCallsignsReq({
        filters,
        sort,
        query: { afterId: null, limit: null },
        sidebarUnitHierarchyFilter: selectedSidebarUnitFilter?.kind === 'group' ? selectedSidebarUnitFilter.hierarchy : null,
      });
      const blob = kind === 'csv' ? await downloadCallsignsCsv(req) : await downloadCallsignsXlsx(req);
      downloadBlob(blob, kind === 'csv' ? 'callsigns.csv' : 'callsigns.xlsx');
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setStatus({ kind: 'error', text: `Помилка завантаження ${kind.toUpperCase()}: ${formatErrorMessage(finalError)}` });
      }
    } finally {
      setDownloadInProgress(null);
    }
  }

  async function onLoadMore() {
    if (loadingMore || !showLoadMore || callsigns.length === 0) return;
    const last = callsigns[callsigns.length - 1];
    if (!last) return;
    await runListFetch({ append: true, afterId: last.id, announceLoading: true });
  }

  function onPickUnitFilter(filter: SelectedSidebarUnitFilter) {
    setSelectedSidebarUnitFilter((prevSelected) => {
      const nextSelected = areSidebarFiltersEqual(prevSelected, filter) ? null : filter;
      setFilters((prev) => ({
        ...prev,
        filterUnit: nextSelected?.kind === 'leaf' ? nextSelected.unitName : '',
      }));
      return nextSelected;
    });
  }

  function onClearUnitFilter() {
    setSelectedSidebarUnitFilter(null);
    setFilters((prev) => ({
      ...prev,
      filterUnit: '',
    }));
  }

  return {
    user,
    permissions,
    units,
    sources,
    rows,
    sort,
    unitStatsView,
    loading,
    loadingMore,
    refreshing,
    showLoadMore,
    status,
    filters,
    sidebarOpen,
    setSidebarOpen,
    selectedSidebarUnitFilter,
    onFiltersChange,
    onSort,
    onRefresh,
    onClearFilters,
    selectedCallsignIds,
    setSelectedCallsignIds,
    bulkDeleteDialogCallsigns,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    addUnitId,
    setAddUnitId,
    addSourceId,
    setAddSourceId,
    addCallsignAdditionalSourceIds,
    setAddCallsignAdditionalSourceIds,
    addDrawerOpen,
    onOpenAddDrawer,
    onCloseAddDrawer,
    addRows,
    addPotentialDuplicates,
    addSubmitting,
    addValidationError,
    onRowChange,
    onAppendRow,
    onRemoveRow,
    onClearRows,
    onApplyPastedRows,
    onSubmitAdd,
    editForm,
    setEditForm,
    editSubmitting,
    editValidationError,
    onOpenEdit,
    onCloseEdit,
    onSaveEdit,
    deleteTarget,
    deleteInFlightId,
    deleteSubmitting,
    onRequestDelete,
    onCancelDelete,
    onConfirmDelete,
    setCallsignSelected,
    setAllCallsignsSelected,
    clearSelectedCallsigns,
    requestBulkDelete,
    cancelBulkDelete,
    confirmBulkDelete,
    onBulkDeleteDialogExited,
    downloadInProgress,
    onDownloadCsv: () => onDownload('csv'),
    onDownloadXlsx: () => onDownload('xlsx'),
    onLoadMore,
    onPickUnitFilter,
    onClearUnitFilter,
  };
}
