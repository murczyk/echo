import React from 'react';

import type { Callsign, CallsignUnitStatRow, Source, Unit, User } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
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
  callsignToEditForm,
  createDefaultFilters,
  createEmptyDraftRow,
  createSourcesById,
  createUnitsById,
  DEFAULT_SORT,
  downloadBlob,
  formatErrorMessage,
  getDefaultPageSize,
  getExportPermission,
  getExportPermissionFromRoles,
  hasAnyDraftValue,
  isCursorPaginationSortCompatible,
  isAbortError,
  makeCreatePayload,
  makeUpdatePayload,
  mergeUnitStatsWithUnits,
  nextSortState,
  parseTabDelimitedInput,
  sortRowsClientSide,
  validateDraftRows,
  validateEditForm,
} from './helpers';
import { readDenseTableFromUrl, setDenseTableQueryParam } from '../../utils/denseTableQuery';
import type { CallsignDraftRow, CallsignEditForm, CallsignsFilterState, CallsignsSortState, DownloadKind, UiStatus } from './types';

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
    filterCallsign: params.get('callsign') ?? defaults.filterCallsign,
    filterPosition: params.get('position') ?? defaults.filterPosition,
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

  const validColumn = column === 'callsign' || column === 'createdAt' || column === 'unit' ? column : DEFAULT_SORT.column;
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

function syncCallsignsStateToUrl(filters: CallsignsFilterState, sort: CallsignsSortState, sidebarOpen: boolean, denseTable: boolean) {
  updateUrlSearchParams((params) => {
    const setOrDelete = (key: string, value: string | null | undefined) => {
      if (value == null || value === '') {
        params.delete(key);
        return;
      }
      params.set(key, value);
    };

    setOrDelete('callsign', filters.filterCallsign.trim() || null);
    setOrDelete('position', filters.filterPosition.trim() || null);
    setOrDelete('comment', filters.filterComment.trim() || null);
    setOrDelete('unit', filters.filterUnit.trim() || null);

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

    setDenseTableQueryParam(params, denseTable);
  });
}

function redirectToLogin() {
  window.location.assign('/login');
}

function unauthorizedOrThrow(error: unknown): never {
  if (isUnauthorizedError(error)) {
    redirectToLogin();
  }
  throw error;
}

export function useRerCallsignsNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] }) {
  const [user, setUser] = React.useState<User | null>(null);
  const [units, setUnits] = React.useState<Unit[]>([]);
  const [sources, setSources] = React.useState<Source[]>([]);
  const [unitStats, setUnitStats] = React.useState<CallsignUnitStatRow[]>([]);

  const [callsigns, setCallsigns] = React.useState<Callsign[]>([]);
  const [showLoadMore, setShowLoadMore] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [loadingMore, setLoadingMore] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [status, setStatus] = React.useState<UiStatus>(null);

  const [filters, setFilters] = React.useState<CallsignsFilterState>(() => readInitialCallsignsFiltersFromUrl());
  const [sort, setSort] = React.useState<CallsignsSortState>(() => readInitialCallsignsSortFromUrl());
  const [sidebarOpen, setSidebarOpen] = React.useState<boolean>(() => readInitialSidebarOpenFromUrl());
  const [denseTable, setDenseTable] = React.useState<boolean>(() => readDenseTableFromUrl());

  const [addUnitId, setAddUnitId] = React.useState<number | null>(null);
  const [addSourceId, setAddSourceId] = React.useState<number | null>(null);
  const [addRows, setAddRows] = React.useState<CallsignDraftRow[]>([createEmptyDraftRow()]);
  const [addSubmitting, setAddSubmitting] = React.useState(false);
  const [addValidationError, setAddValidationError] = React.useState<string | null>(null);
  const [addDrawerOpen, setAddDrawerOpen] = React.useState(false);

  const [editForm, setEditForm] = React.useState<CallsignEditForm | null>(null);
  const [editSubmitting, setEditSubmitting] = React.useState(false);
  const [editValidationError, setEditValidationError] = React.useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = React.useState<Callsign | null>(null);
  const [deleteInFlightId, setDeleteInFlightId] = React.useState<number | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = React.useState(false);
  const [selectedCallsignIds, setSelectedCallsignIds] = React.useState<number[]>([]);
  const [bulkDeleteDialogCallsigns, setBulkDeleteDialogCallsigns] = React.useState<Callsign[]>([]);
  const [bulkDeleteDialogOpen, setBulkDeleteDialogOpen] = React.useState(false);
  const [bulkDeleteInFlight, setBulkDeleteInFlight] = React.useState(false);

  const [downloadInProgress, setDownloadInProgress] = React.useState<DownloadKind | null>(null);

  const initializedRef = React.useRef(false);
  const listRequestSeqRef = React.useRef(0);
  const debounceTimerRef = React.useRef<number | null>(null);
  const activeListAbortRef = React.useRef<AbortController | null>(null);

  const unitsById = React.useMemo(() => createUnitsById(units), [units]);
  const sourcesById = React.useMemo(() => createSourcesById(sources), [sources]);
  const permissions = React.useMemo(() => {
    const apiPermissions = getExportPermission(user);
    const shellPermissions = getExportPermissionFromRoles(authUserRoles);
    return {
      canEdit: apiPermissions.canEdit || shellPermissions.canEdit,
      canExport: apiPermissions.canExport || shellPermissions.canExport,
    };
  }, [user, authUserRoles]);

  const sortedCallsigns = React.useMemo(() => sortRowsClientSide(callsigns, sort, unitsById), [callsigns, sort, unitsById]);
  const rows = React.useMemo(
    () =>
      sortedCallsigns.map((callsign) => ({
        ...callsign,
        unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
        sourceName: callsign.sourceId == null ? '—' : (sourcesById.get(callsign.sourceId)?.name ?? `#${callsign.sourceId}`),
      })),
    [sortedCallsigns, unitsById, sourcesById],
  );
  const unitStatsView = React.useMemo(() => mergeUnitStatsWithUnits(unitStats, unitsById), [unitStats, unitsById]);
  const canUseCursorPagination = React.useMemo(() => isCursorPaginationSortCompatible(sort), [sort]);
  const addPotentialDuplicates = React.useMemo(() => {
    const firstRow = addRows[0];
    if (!firstRow) return [];

    const callsignInput = firstRow.callsign.trim().toLocaleLowerCase();
    const positionInput = firstRow.position.trim().toLocaleLowerCase();
    const hasInput = callsignInput !== '' || positionInput !== '' || addUnitId !== null;
    if (!hasInput) return [];

    return callsigns
      .filter((callsign) => {
        const callsignMatches =
          callsignInput === '' || callsign.callsign.toLocaleLowerCase().includes(callsignInput);
        const positionMatches =
          positionInput === '' || callsign.position.toLocaleLowerCase().includes(positionInput);
        const unitMatches = addUnitId == null || callsign.unitId === addUnitId;

        return callsignMatches && positionMatches && unitMatches;
      })
      .slice(0, 10)
      .map((callsign) => ({
        id: callsign.id,
        callsign: callsign.callsign,
        position: callsign.position,
        comment: callsign.comment,
        unitName: unitsById.get(callsign.unitId)?.name ?? `#${callsign.unitId}`,
      }));
  }, [addRows, addUnitId, callsigns, unitsById]);

  function clearListRequest() {
    activeListAbortRef.current?.abort();
    activeListAbortRef.current = null;
  }

  async function runListFetch({ append, afterId, announceLoading }: { append: boolean; afterId: number | null; announceLoading: boolean }) {
    const seq = ++listRequestSeqRef.current;
    if (!append) {
      setLoadingMore(false);
      clearListRequest();
      const controller = new AbortController();
      activeListAbortRef.current = controller;
      if (announceLoading) setLoading(true);

      try {
        const rsp = await listCallsigns(
          buildListCallsignsReq({ filters, sort, query: { afterId, limit: getDefaultPageSize() } }),
          controller.signal,
        );
        if (listRequestSeqRef.current !== seq) return;
        setCallsigns(rsp.callsigns);
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

    if (!canUseCursorPagination) {
      setShowLoadMore(false);
      if (listRequestSeqRef.current === seq) {
        setLoadingMore(false);
      }
      return;
    }

    try {
      const rsp = await listCallsigns(buildListCallsignsReq({ filters, sort, query: { afterId, limit: getDefaultPageSize() } }));
      if (listRequestSeqRef.current !== seq) return;
      setCallsigns((prev) => {
        const byId = new Map<number, Callsign>();
        for (const item of prev) byId.set(item.id, item);
        for (const item of rsp.callsigns) byId.set(item.id, item);
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
      setAddSourceId((prev) => (prev == null ? freshSources[0]?.id ?? null : prev));
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setStatus({ kind: 'error', text: `Помилка оновлення довідників: ${formatErrorMessage(finalError)}` });
      }
    }
  }

  React.useEffect(() => {
    let cancelled = false;

    async function loadBootstrap() {
      setLoading(true);
      setStatus(null);
      try {
        const bootstrap = await fetchCallsignsBootstrapData(
          buildListCallsignsReq({ filters, sort, query: { afterId: null, limit: getDefaultPageSize() } }),
        );

        if (cancelled) return;

        setUser(bootstrap.user);
        setUnits(bootstrap.units);
        setSources(bootstrap.sources);
        setUnitStats(bootstrap.unitStats);
        setCallsigns(bootstrap.callsigns.callsigns);
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

  React.useEffect(() => {
    if (!initializedRef.current) return;

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev?.kind === 'success' ? null : prev));
      setRefreshing(true);
      void runListFetch({ append: false, afterId: null, announceLoading: false });
    }, 300);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [filters, sort]);

  React.useEffect(() => {
    syncCallsignsStateToUrl(filters, sort, sidebarOpen, denseTable);
  }, [filters, sort, sidebarOpen, denseTable]);

  React.useEffect(() => {
    setSelectedCallsignIds((prev) => prev.filter((id) => callsigns.some((callsign) => callsign.id === id)));
  }, [callsigns]);

  function onFiltersChange(updater: (prev: CallsignsFilterState) => CallsignsFilterState) {
    setFilters((prev) => updater(prev));
  }

  function onSort(column: 'callsign' | 'createdAt' | 'unit') {
    setSort((prev) => nextSortState(prev, column));
  }

  async function onRefresh() {
    setRefreshing(true);
    setStatus(null);
    await Promise.all([refreshLookupsAndStats(), runListFetch({ append: false, afterId: null, announceLoading: false })]);
  }

  function onClearFilters() {
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

  const clearSelectedCallsigns = React.useCallback(() => {
    setSelectedCallsignIds((prev) => (prev.length === 0 ? prev : []));
  }, []);

  React.useEffect(() => {
    clearSelectedCallsigns();
  }, [clearSelectedCallsigns, filters, sort]);

  function onAppendRow() {
    setAddRows((prev) => [...prev, createEmptyDraftRow()]);
  }

  function onRemoveRow(index: number) {
    setAddRows((prev) => {
      if (prev.length <= 1) return prev;
      return prev.filter((_, rowIndex) => rowIndex !== index);
    });
  }

  function onClearRows() {
    setAddRows([createEmptyDraftRow()]);
    setAddValidationError(null);
  }

  function onOpenAddDrawer() {
    if (!permissions.canEdit) return;
    setAddDrawerOpen(true);
    setAddValidationError(null);
  }

  function onCloseAddDrawer() {
    if (addSubmitting) return;
    setAddDrawerOpen(false);
  }

  function onRowChange(index: number, next: CallsignDraftRow) {
    setAddValidationError(null);
    setAddRows((prev) => prev.map((row, rowIndex) => (rowIndex === index ? next : row)));
  }

  function onApplyPastedRows(value: string) {
    if (!value.includes('\t') && !value.includes('\n')) return;
    const parsed = parseTabDelimitedInput(value);
    if (parsed.length === 0) return;
    setAddRows(parsed);
    setAddValidationError(null);
  }

  async function onSubmitAdd() {
    if (!permissions.canEdit) return;

    setStatus(null);
    setAddValidationError(null);

    if (addUnitId == null) {
      return;
    }
    if (addSourceId == null) {
      setAddValidationError('Оберіть джерело');
      return;
    }
    if (!addRows.some((row) => hasAnyDraftValue(row))) {
      return;
    }

    const validation = validateDraftRows(addRows, addSourceId);
    if (!validation.valid) {
      if (validation.error === 'Заповніть хоча б один позивний') {
        return;
      }
      setAddValidationError(validation.error);
      return;
    }

    setAddSubmitting(true);

    try {
      const nonEmptyRows = addRows.filter((row) => hasAnyDraftValue(row));
      const created: Callsign[] = [];
      const failed: Array<{ row: CallsignDraftRow; error: string }> = [];

      for (const row of nonEmptyRows) {
        try {
          const item = await createCallsign(makeCreatePayload(row, addUnitId, addSourceId));
          created.push(item);
        } catch (error) {
          if (isUnauthorizedError(error)) {
            redirectToLogin();
            return;
          }
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
        setStatus({ kind: 'success', text: `Додано позивних: ${created.length}` });
        return;
      }

      setAddRows(failed.map((item) => item.row));
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
      const updated = await updateCallsign(makeUpdatePayload(editForm));
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
      const req = buildListCallsignsReq({ filters, sort, query: { afterId: null, limit: null } });
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
    if (!canUseCursorPagination || loadingMore || !showLoadMore || callsigns.length === 0) return;
    const last = callsigns[callsigns.length - 1];
    if (!last) return;
    await runListFetch({ append: true, afterId: last.id, announceLoading: true });
  }

  function onPickUnitFilter(unitName: string) {
    setFilters((prev) => ({ ...prev, filterUnit: unitName }));
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
    showLoadMore: showLoadMore && canUseCursorPagination,
    status,
    filters,
    denseTable,
    sidebarOpen,
    setDenseTable,
    setSidebarOpen,
    onFiltersChange,
    onSort,
    onRefresh,
    onClearFilters,
    selectedCallsignIds,
    bulkDeleteDialogCallsigns,
    bulkDeleteDialogOpen,
    bulkDeleteInFlight,
    addUnitId,
    setAddUnitId,
    addSourceId,
    setAddSourceId,
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
  };
}
