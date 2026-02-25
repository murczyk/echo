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
import type { CallsignDraftRow, CallsignEditForm, CallsignsFilterState, CallsignsSortState, DownloadKind, UiStatus } from './types';

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

  const [filters, setFilters] = React.useState<CallsignsFilterState>(() => createDefaultFilters());
  const [sort, setSort] = React.useState<CallsignsSortState>(DEFAULT_SORT);
  const [sidebarOpen, setSidebarOpen] = React.useState(true);

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
  const [deleteSubmitting, setDeleteSubmitting] = React.useState(false);

  const [downloadInProgress, setDownloadInProgress] = React.useState<DownloadKind | null>(null);

  const initializedRef = React.useRef(false);
  const skipAutoReloadRef = React.useRef(false);
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

  function clearListRequest() {
    activeListAbortRef.current?.abort();
    activeListAbortRef.current = null;
  }

  async function runListFetch({ append, afterId, announceLoading }: { append: boolean; afterId: number | null; announceLoading: boolean }) {
    const seq = ++listRequestSeqRef.current;
    if (!append) {
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
          buildListCallsignsReq({ filters: createDefaultFilters(), sort: DEFAULT_SORT, query: { afterId: null, limit: getDefaultPageSize() } }),
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
        skipAutoReloadRef.current = true;
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
    if (skipAutoReloadRef.current) {
      skipAutoReloadRef.current = false;
      return;
    }

    if (debounceTimerRef.current !== null) {
      window.clearTimeout(debounceTimerRef.current);
    }

    debounceTimerRef.current = window.setTimeout(() => {
      setStatus((prev) => (prev?.kind === 'success' ? null : prev));
      void runListFetch({ append: false, afterId: null, announceLoading: true });
    }, 300);

    return () => {
      if (debounceTimerRef.current !== null) {
        window.clearTimeout(debounceTimerRef.current);
        debounceTimerRef.current = null;
      }
    };
  }, [filters, sort]);

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
    setStatus(null);
    setAddValidationError(null);

    if (addUnitId == null) {
      setAddValidationError('Оберіть підрозділ');
      return;
    }
    if (addSourceId == null) {
      setAddValidationError('Оберіть джерело');
      return;
    }

    const validation = validateDraftRows(addRows, addSourceId);
    if (!validation.valid) {
      setAddValidationError(validation.error);
      return;
    }

    setAddSubmitting(true);

    try {
      const nonEmptyRows = addRows.filter((row) => row.callsign.trim() !== '' || row.position.trim() !== '' || row.comment.trim() !== '' || row.radioFreq.trim() !== '' || row.developing);
      const created: Callsign[] = [];
      for (const row of nonEmptyRows) {
        const item = await createCallsign(makeCreatePayload(row, addUnitId, addSourceId));
        created.push(item);
      }

      setCallsigns((prev) => [...created, ...prev]);
      setAddRows([createEmptyDraftRow()]);
      setAddDrawerOpen(false);
      setStatus({ kind: 'success', text: `Додано позивних: ${created.length}` });
      await refreshLookupsAndStats();
    } catch (error) {
      try {
        unauthorizedOrThrow(error);
      } catch (finalError) {
        setAddValidationError(`Помилка створення позивного: ${formatErrorMessage(finalError)}`);
      }
    } finally {
      setAddSubmitting(false);
    }
  }

  function onOpenEdit(callsign: Callsign) {
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
    setDeleteTarget(callsign);
  }

  function onCancelDelete() {
    if (deleteSubmitting) return;
    setDeleteTarget(null);
  }

  async function onConfirmDelete() {
    if (!deleteTarget) return;
    setDeleteSubmitting(true);
    setStatus(null);

    try {
      const deleted = await deleteCallsign(deleteTarget.id);
      setCallsigns((prev) => prev.filter((item) => item.id !== deleted.id));
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
    }
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
    if (loadingMore || !showLoadMore || callsigns.length === 0) return;
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
    showLoadMore,
    status,
    filters,
    sidebarOpen,
    setSidebarOpen,
    onFiltersChange,
    onSort,
    onRefresh,
    onClearFilters,
    addUnitId,
    setAddUnitId,
    addSourceId,
    setAddSourceId,
    addDrawerOpen,
    onOpenAddDrawer,
    onCloseAddDrawer,
    addRows,
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
    deleteSubmitting,
    onRequestDelete,
    onCancelDelete,
    onConfirmDelete,
    downloadInProgress,
    onDownloadCsv: () => onDownload('csv'),
    onDownloadXlsx: () => onDownload('xlsx'),
    onLoadMore,
    onPickUnitFilter,
  };
}
