import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { Callsign, Source } from '../../../../Bindings';
import { downloadBlob } from '../../utils/download-blob';
import {
  deleteCallsign,
  downloadCallsignsCsv,
  downloadCallsignsXlsx,
  updateCallsign,
} from '../../services/api/callsigns';
import { buildListCallsignsReq, formatErrorMessage, nextSortState } from './helpers-core';
import { callsignToEditForm, makeUpdatePayload, validateEditForm } from './helpers-form';
import { useRerCallsignsNeoPageAddActions } from './use-rer-callsigns-neo-page.add-actions';
import { areSidebarFiltersEqual, normalizeCallsign } from './use-rer-callsigns-neo-page.shared';
import type {
  CallsignDraftRow,
  CallsignEditForm,
  CallsignsFilterState,
  CallsignsSortState,
  DownloadKind,
  ExportPermission,
  SelectedSidebarUnitFilter,
  UiStatus,
} from './types';

type SetState<T> = Dispatch<SetStateAction<T>>;

type Args = {
  permissions: ExportPermission;
  callsigns: Callsign[];
  filters: CallsignsFilterState;
  sort: CallsignsSortState;
  selectedSidebarUnitFilter: SelectedSidebarUnitFilter | null;
  selectedCallsignIds: number[];
  addUnitId: number | null;
  addSourceId: number | null;
  addCallsignAdditionalSourceIds: number[];
  addRows: CallsignDraftRow[];
  addSubmitting: boolean;
  setAddDuplicateHintsImmediate: SetState<boolean>;
  editForm: CallsignEditForm | null;
  editSubmitting: boolean;
  deleteTarget: Callsign | null;
  deleteInFlightId: number | null;
  deleteSubmitting: boolean;
  bulkDeleteDialogCallsigns: Callsign[];
  bulkDeleteDialogOpen: boolean;
  bulkDeleteInFlight: boolean;
  loadingMore: boolean;
  showLoadMore: boolean;
  sources: Source[];
  setFilters: SetState<CallsignsFilterState>;
  setSort: SetState<CallsignsSortState>;
  setSelectedSidebarUnitFilter: SetState<SelectedSidebarUnitFilter | null>;
  setSelectedCallsignIds: SetState<number[]>;
  setAddUnitId: SetState<number | null>;
  setAddSourceId: SetState<number | null>;
  setAddCallsignAdditionalSourceIds: SetState<number[]>;
  setAddRows: SetState<CallsignDraftRow[]>;
  setAddSubmitting: SetState<boolean>;
  setAddValidationError: SetState<string | null>;
  setAddDrawerOpen: SetState<boolean>;
  setAddDuplicateHintsEnabled: SetState<boolean>;
  setEditForm: SetState<CallsignEditForm | null>;
  setEditSubmitting: SetState<boolean>;
  setEditValidationError: SetState<string | null>;
  setDeleteTarget: SetState<Callsign | null>;
  setDeleteInFlightId: SetState<number | null>;
  setDeleteSubmitting: SetState<boolean>;
  setBulkDeleteDialogCallsigns: SetState<Callsign[]>;
  setBulkDeleteDialogOpen: SetState<boolean>;
  setBulkDeleteInFlight: SetState<boolean>;
  setStatus: SetState<UiStatus>;
  setRefreshing: SetState<boolean>;
  setCallsigns: SetState<Callsign[]>;
  setDownloadInProgress: SetState<DownloadKind | null>;
  refreshLookupsAndStats: () => Promise<void>;
  runListFetch: (args: {
    append: boolean;
    afterId: number | null;
    announceLoading: boolean;
    preserveLoadedCount?: boolean;
  }) => Promise<void>;
};

export function useRerCallsignsNeoPageActions({
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
}: Args) {
  const addActions = useRerCallsignsNeoPageAddActions({
    permissions,
    addUnitId,
    addSourceId,
    addCallsignAdditionalSourceIds,
    addRows,
    addSubmitting,
    sources,
    setAddUnitId,
    setAddSourceId,
    setAddCallsignAdditionalSourceIds,
    setAddRows,
    setAddSubmitting,
    setAddValidationError,
    setAddDrawerOpen,
    setAddDuplicateHintsEnabled,
    setAddDuplicateHintsImmediate,
    setStatus,
    setCallsigns,
    refreshLookupsAndStats,
  });

  const onFiltersChange = useCallback(
    (updater: (prev: CallsignsFilterState) => CallsignsFilterState) => {
      setFilters((prev) => {
        const next = updater(prev);
        if (next.filterUnit.trim() !== prev.filterUnit.trim() && selectedSidebarUnitFilter) {
          if (selectedSidebarUnitFilter.kind === 'leaf') {
            if (next.filterUnit.trim() !== selectedSidebarUnitFilter.unitName) {
              setSelectedSidebarUnitFilter(null);
            }
          }
        }
        return next;
      });
    },
    [selectedSidebarUnitFilter, setFilters, setSelectedSidebarUnitFilter],
  );

  const onSort = useCallback(
    (column: CallsignsSortState['column'], direction?: CallsignsSortState['direction']) => {
      setSort((prev) => nextSortState(prev, column, direction));
    },
    [setSort],
  );

  const onRefresh = useCallback(async () => {
    setStatus(null);
    setRefreshing(true);
    await Promise.all([
      refreshLookupsAndStats(),
      runListFetch({
        append: false,
        afterId: null,
        announceLoading: false,
        preserveLoadedCount: true,
      }),
    ]);
  }, [refreshLookupsAndStats, runListFetch, setRefreshing, setStatus]);

  const onClearFilters = useCallback(() => {
    setSelectedSidebarUnitFilter(null);
    setFilters((prev) => ({
      ...prev,
      filterText: '',
      filterCallsign: '',
      filterPosition: '',
      filterFullName: '',
      filterComment: '',
      filterUnit: '',
      filterDeveloping: 'OnlyNonDeveloping',
      isIgnoringDateFilter: true,
    }));
  }, [setFilters, setSelectedSidebarUnitFilter]);

  const setCallsignSelected = useCallback(
    (callsignId: number, checked: boolean) => {
      setSelectedCallsignIds((prev) => {
        if (checked) {
          if (prev.includes(callsignId)) return prev;
          return [...prev, callsignId];
        }
        return prev.filter((id) => id !== callsignId);
      });
    },
    [setSelectedCallsignIds],
  );

  const setAllCallsignsSelected = useCallback(
    (callsignIds: number[], checked: boolean) => {
      if (callsignIds.length === 0) return;
      setSelectedCallsignIds((prev) => {
        if (checked) {
          const selected = new Set(prev);
          for (const callsignId of callsignIds) selected.add(callsignId);
          return Array.from(selected);
        }
        const toRemove = new Set(callsignIds);
        return prev.filter((id) => !toRemove.has(id));
      });
    },
    [setSelectedCallsignIds],
  );

  const clearSelectedCallsigns = useCallback(() => {
    setSelectedCallsignIds((prev) => (prev.length === 0 ? prev : []));
  }, [setSelectedCallsignIds]);

  const onOpenEdit = useCallback(
    (callsign: Callsign) => {
      if (!permissions.canEdit) return;
      setEditValidationError(null);
      setEditForm(callsignToEditForm(callsign));
    },
    [permissions.canEdit, setEditForm, setEditValidationError],
  );

  const onCloseEdit = useCallback(() => {
    if (editSubmitting) return;
    setEditValidationError(null);
    setEditForm(null);
  }, [editSubmitting, setEditForm, setEditValidationError]);

  const onSaveEdit = useCallback(async () => {
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
      setEditValidationError(`Помилка оновлення позивного: ${formatErrorMessage(error)}`);
    } finally {
      setEditSubmitting(false);
    }
  }, [
    editForm,
    refreshLookupsAndStats,
    setCallsigns,
    setEditForm,
    setEditSubmitting,
    setEditValidationError,
    setStatus,
  ]);

  const onRequestDelete = useCallback(
    (callsign: Callsign) => {
      if (!permissions.canEdit) return;
      if (bulkDeleteInFlight || deleteInFlightId !== null) return;
      setDeleteTarget(callsign);
    },
    [bulkDeleteInFlight, deleteInFlightId, permissions.canEdit, setDeleteTarget],
  );

  const onCancelDelete = useCallback(() => {
    if (deleteSubmitting || bulkDeleteInFlight || deleteInFlightId !== null) return;
    setDeleteTarget(null);
  }, [bulkDeleteInFlight, deleteInFlightId, deleteSubmitting, setDeleteTarget]);

  const onConfirmDelete = useCallback(async () => {
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
      setStatus({
        kind: 'error',
        text: `Помилка видалення позивного: ${formatErrorMessage(error)}`,
      });
    } finally {
      setDeleteSubmitting(false);
      setDeleteInFlightId(null);
    }
  }, [
    deleteTarget,
    refreshLookupsAndStats,
    setCallsigns,
    setDeleteInFlightId,
    setDeleteSubmitting,
    setDeleteTarget,
    setSelectedCallsignIds,
    setStatus,
  ]);

  const requestBulkDelete = useCallback(() => {
    if (!permissions.canEdit) return;
    if (bulkDeleteInFlight || deleteInFlightId !== null || deleteTarget !== null) return;

    const selectedSet = new Set(selectedCallsignIds);
    const selected = callsigns.filter(
      (callsign) => selectedSet.has(callsign.id) && deleteInFlightId !== callsign.id,
    );
    if (selected.length === 0) return;

    setBulkDeleteDialogCallsigns(selected);
    setBulkDeleteDialogOpen(true);
  }, [
    bulkDeleteInFlight,
    callsigns,
    deleteInFlightId,
    deleteTarget,
    permissions.canEdit,
    selectedCallsignIds,
    setBulkDeleteDialogCallsigns,
    setBulkDeleteDialogOpen,
  ]);

  const cancelBulkDelete = useCallback(() => {
    if (bulkDeleteInFlight || deleteInFlightId !== null) return;
    setBulkDeleteDialogOpen(false);
  }, [bulkDeleteInFlight, deleteInFlightId, setBulkDeleteDialogOpen]);

  const confirmBulkDelete = useCallback(async () => {
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
        } catch (error) {
          failed.push(`${callsign.callsign}: ${formatErrorMessage(error)}`);
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
  }, [
    bulkDeleteDialogCallsigns,
    bulkDeleteInFlight,
    deleteInFlightId,
    refreshLookupsAndStats,
    setBulkDeleteDialogCallsigns,
    setBulkDeleteInFlight,
    setBulkDeleteDialogOpen,
    setCallsigns,
    setDeleteInFlightId,
    setSelectedCallsignIds,
    setStatus,
  ]);

  const onBulkDeleteDialogExited = useCallback(() => {
    if (bulkDeleteDialogOpen || bulkDeleteInFlight) return;
    setBulkDeleteDialogCallsigns([]);
  }, [bulkDeleteDialogOpen, bulkDeleteInFlight, setBulkDeleteDialogCallsigns]);

  const onDownload = useCallback(
    async (kind: DownloadKind) => {
      setStatus(null);
      setDownloadInProgress(kind);
      try {
        const req = buildListCallsignsReq({
          filters,
          sort,
          query: { afterId: null, limit: null },
          sidebarUnitHierarchyFilter:
            selectedSidebarUnitFilter?.kind === 'group'
              ? selectedSidebarUnitFilter.hierarchy
              : null,
        });
        const blob =
          kind === 'csv' ? await downloadCallsignsCsv(req) : await downloadCallsignsXlsx(req);
        downloadBlob(blob, kind === 'csv' ? 'callsigns.csv' : 'callsigns.xlsx');
      } catch (error) {
        setStatus({
          kind: 'error',
          text: `Помилка завантаження ${kind.toUpperCase()}: ${formatErrorMessage(error)}`,
        });
      } finally {
        setDownloadInProgress(null);
      }
    },
    [filters, selectedSidebarUnitFilter, setDownloadInProgress, setStatus, sort],
  );

  const onLoadMore = useCallback(async () => {
    if (loadingMore || !showLoadMore || callsigns.length === 0) return;
    const last = callsigns[callsigns.length - 1];
    if (!last) return;
    await runListFetch({ append: true, afterId: last.id, announceLoading: true });
  }, [callsigns, loadingMore, runListFetch, showLoadMore]);

  const onPickUnitFilter = useCallback(
    (filter: SelectedSidebarUnitFilter) => {
      setSelectedSidebarUnitFilter((prevSelected) => {
        const nextSelected = areSidebarFiltersEqual(prevSelected, filter) ? null : filter;
        setFilters((prev) => ({
          ...prev,
          filterUnit:
            nextSelected?.kind === 'leaf'
              ? nextSelected.unitName
              : prevSelected?.kind === 'leaf'
                ? ''
                : prev.filterUnit,
        }));
        return nextSelected;
      });
    },
    [setFilters, setSelectedSidebarUnitFilter],
  );

  const onClearUnitFilter = useCallback(() => {
    setSelectedSidebarUnitFilter((prevSelected) => {
      if (!prevSelected || prevSelected.kind === 'leaf') {
        setFilters((prev) => ({
          ...prev,
          filterUnit: '',
        }));
      }
      return null;
    });
  }, [setFilters, setSelectedSidebarUnitFilter]);

  return {
    ...addActions,
    onFiltersChange,
    onSort,
    onRefresh,
    onClearFilters,
    setCallsignSelected,
    setAllCallsignsSelected,
    clearSelectedCallsigns,
    onOpenEdit,
    onCloseEdit,
    onSaveEdit,
    onRequestDelete,
    onCancelDelete,
    onConfirmDelete,
    requestBulkDelete,
    cancelBulkDelete,
    confirmBulkDelete,
    onBulkDeleteDialogExited,
    onDownload,
    onLoadMore,
    onPickUnitFilter,
    onClearUnitFilter,
  };
}
