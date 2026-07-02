import { useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Callsign, CallsignUnitStatRow, Source, Unit, User } from '../../../../Bindings';
import {
  buildDuplicateHintGroups,
  createSourcesById,
  createUnitsById,
  getExportPermission,
  getExportPermissionFromRoles,
  normalizeDuplicateLookupValue,
  sortRowsClientSide,
  buildRowViews,
  mergeUnitStatsWithUnits,
} from './helpers';
import {
  FILTERS_DEBOUNCE_MS,
  areCallsignFiltersEqual,
  areCallsignSortStatesEqual,
  areSidebarFiltersEqual,
  readInitialCallsignsFiltersFromUrl,
  readInitialCallsignsSortFromUrl,
  readInitialSidebarFilterFromUrl,
  readInitialSidebarOpenFromUrl,
  syncCallsignsStateToUrl,
} from './use-rer-callsigns-neo-page.shared';
import { useRerCallsignsNeoPageActions } from './use-rer-callsigns-neo-page.actions';
import { useRerCallsignsNeoPageLoad } from './use-rer-callsigns-neo-page.load';
import { buildSelectableUnitOptions } from '../../utils/unit-search';
import type {
  CallsignDraftRow,
  CallsignEditForm,
  CallsignsFilterState,
  CallsignsSortState,
  DownloadKind,
  SelectedSidebarUnitFilter,
  UiStatus,
} from './types';

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
  const [filters, setFilters] = useState<CallsignsFilterState>(() =>
    readInitialCallsignsFiltersFromUrl(),
  );
  const [sort, setSort] = useState<CallsignsSortState>(() => readInitialCallsignsSortFromUrl());
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => readInitialSidebarOpenFromUrl());
  const [selectedSidebarUnitFilter, setSelectedSidebarUnitFilter] =
    useState<SelectedSidebarUnitFilter | null>(() => readInitialSidebarFilterFromUrl());
  const [addUnitId, setAddUnitId] = useState<number | null>(null);
  const [addSourceId, setAddSourceId] = useState<number | null>(null);
  const [addCallsignAdditionalSourceIds, setAddCallsignAdditionalSourceIds] = useState<number[]>(
    [],
  );
  const [addRows, setAddRows] = useState<CallsignDraftRow[]>([
    { callsign: '', position: '', fullName: '', comment: '', developing: false, radioFreq: '' },
  ]);
  const [addSubmitting, setAddSubmitting] = useState(false);
  const [addValidationError, setAddValidationError] = useState<string | null>(null);
  const [addDrawerOpen, setAddDrawerOpen] = useState(false);
  const [addDuplicateHintsEnabled, setAddDuplicateHintsEnabled] = useState(false);
  const [addDuplicateHintsImmediate, setAddDuplicateHintsImmediate] = useState(false);
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
  const selectableUnits = useMemo(() => buildSelectableUnitOptions(units), [units]);
  const permissions = useMemo(() => {
    const apiPermissions = getExportPermission(user);
    const shellPermissions = getExportPermissionFromRoles(authUserRoles);
    return {
      canEdit: apiPermissions.canEdit || shellPermissions.canEdit,
      canExport: apiPermissions.canExport || shellPermissions.canExport,
    };
  }, [authUserRoles, user]);

  const { runListFetch, refreshLookupsAndStats } = useRerCallsignsNeoPageLoad({
    filters,
    sort,
    selectedSidebarUnitFilter,
    callsignsLength: callsigns.length,
    setUser,
    setUnits,
    setSources,
    setUnitStats,
    setCallsigns,
    setShowLoadMore,
    setLoading,
    setLoadingMore,
    setRefreshing,
    setStatus,
    setAddSourceId,
    initializedRef,
    listRequestSeqRef,
    debounceTimerRef,
    activeListAbortRef,
  });

  const duplicateHintInputs = useMemo(
    () =>
      addRows
        .map((row, rowIndex) => ({
          rowIndex,
          callsignInput: normalizeDuplicateLookupValue(row.callsign),
          fullNameInput: normalizeDuplicateLookupValue(row.fullName),
          positionInput: normalizeDuplicateLookupValue(row.position),
        }))
        .filter((row) => row.callsignInput.length >= 2 || row.fullNameInput.length >= 2),
    [addRows],
  );
  const deferredDuplicateHintInputs = useDeferredValue(duplicateHintInputs);

  const sortedCallsigns = useMemo(
    () => sortRowsClientSide(callsigns, sort, unitsById, sourcesById),
    [callsigns, sort, sourcesById, unitsById],
  );
  const rows = useMemo(
    () => buildRowViews(sortedCallsigns, unitsById, sourcesById).rows,
    [sortedCallsigns, sourcesById, unitsById],
  );
  const unitStatsView = useMemo(
    () => mergeUnitStatsWithUnits(unitStats, unitsById),
    [unitStats, unitsById],
  );
  const addPotentialDuplicateGroups = useMemo(() => {
    if (!addDuplicateHintsEnabled || addSubmitting) return [];
    const activeDuplicateHintInputs = addDuplicateHintsImmediate
      ? duplicateHintInputs
      : deferredDuplicateHintInputs;
    if (activeDuplicateHintInputs.length === 0) return [];
    return buildDuplicateHintGroups(activeDuplicateHintInputs, callsigns, addUnitId, unitsById);
  }, [
    addDuplicateHintsEnabled,
    addDuplicateHintsImmediate,
    addSubmitting,
    addUnitId,
    callsigns,
    deferredDuplicateHintInputs,
    duplicateHintInputs,
    unitsById,
  ]);

  const actions = useRerCallsignsNeoPageActions({
    permissions,
    callsigns,
    filters,
    sort,
    selectedSidebarUnitFilter,
    selectedCallsignIds,
    addUnitId,
    addSourceId,
    addCallsignAdditionalSourceIds,
    addRows,
    addSubmitting,
    editForm,
    editSubmitting,
    deleteTarget,
    deleteInFlightId,
    deleteSubmitting,
    bulkDeleteDialogCallsigns,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    loadingMore,
    showLoadMore,
    sources,
    setFilters,
    setSort,
    setSelectedSidebarUnitFilter,
    setSelectedCallsignIds,
    setAddUnitId,
    setAddSourceId,
    setAddCallsignAdditionalSourceIds,
    setAddRows,
    setAddSubmitting,
    setAddValidationError,
    setAddDrawerOpen,
    setAddDuplicateHintsEnabled,
    setAddDuplicateHintsImmediate,
    setEditForm,
    setEditSubmitting,
    setEditValidationError,
    setDeleteTarget,
    setDeleteInFlightId,
    setDeleteSubmitting,
    setBulkDeleteDialogCallsigns,
    setBulkDeleteDialogOpen,
    setBulkDeleteInFlight,
    setStatus,
    setRefreshing,
    setCallsigns,
    setDownloadInProgress,
    refreshLookupsAndStats,
    runListFetch,
  });

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
  }, [filters, runListFetch, setRefreshing, setStatus, sort, selectedSidebarUnitFilter]);

  useEffect(() => {
    syncCallsignsStateToUrl(filters, sort, sidebarOpen, selectedSidebarUnitFilter);
  }, [filters, selectedSidebarUnitFilter, sidebarOpen, sort]);

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
        areSidebarFiltersEqual(prev, nextSelectedSidebarUnitFilter)
          ? prev
          : nextSelectedSidebarUnitFilter,
      );
    }

    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  useEffect(() => {
    setSelectedCallsignIds((prev) =>
      prev.filter((id) => callsigns.some((callsign) => callsign.id === id)),
    );
  }, [callsigns]);

  useEffect(() => {
    actions.clearSelectedCallsigns();
  }, [actions.clearSelectedCallsigns, filters, sort]);

  return {
    user,
    permissions,
    units,
    selectableUnits,
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
    onFiltersChange: actions.onFiltersChange,
    onSort: actions.onSort,
    onRefresh: actions.onRefresh,
    onClearFilters: actions.onClearFilters,
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
    onOpenAddDrawer: actions.onOpenAddDrawer,
    onCloseAddDrawer: actions.onCloseAddDrawer,
    addRows,
    addPotentialDuplicateGroups,
    addSubmitting,
    addValidationError,
    onRowChange: actions.onRowChange,
    onAppendRow: actions.onAppendRow,
    onRemoveRow: actions.onRemoveRow,
    onClearRows: actions.onClearRows,
    onApplyPastedRows: actions.onApplyPastedRows,
    onSubmitAdd: actions.onSubmitAdd,
    editForm,
    setEditForm,
    editSubmitting,
    editValidationError,
    onOpenEdit: actions.onOpenEdit,
    onCloseEdit: actions.onCloseEdit,
    onSaveEdit: actions.onSaveEdit,
    deleteTarget,
    deleteInFlightId,
    deleteSubmitting,
    onRequestDelete: actions.onRequestDelete,
    onCancelDelete: actions.onCancelDelete,
    onConfirmDelete: actions.onConfirmDelete,
    setCallsignSelected: actions.setCallsignSelected,
    setAllCallsignsSelected: actions.setAllCallsignsSelected,
    clearSelectedCallsigns: actions.clearSelectedCallsigns,
    requestBulkDelete: actions.requestBulkDelete,
    cancelBulkDelete: actions.cancelBulkDelete,
    confirmBulkDelete: actions.confirmBulkDelete,
    onBulkDeleteDialogExited: actions.onBulkDeleteDialogExited,
    downloadInProgress,
    onDownloadCsv: () => actions.onDownload('csv'),
    onDownloadXlsx: () => actions.onDownload('xlsx'),
    onLoadMore: actions.onLoadMore,
    onPickUnitFilter: actions.onPickUnitFilter,
    onClearUnitFilter: actions.onClearUnitFilter,
  };
}
