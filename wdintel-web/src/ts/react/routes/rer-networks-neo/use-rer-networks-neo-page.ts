import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

import type { AreaOfResponsibility, EncryptionRec, ListNetworksReq, Network, Unit } from '../../../../Bindings';
import {
  buildNetworkRowView,
  createDefaultNetworksFilterState,
  mergeNetworkUnitStatsWithUnits,
  sanitizeNetworkColumnFilters,
  sortNetworkAorsForDisplay,
  type NetworksFilterState,
} from './helpers';
import type { NetworksQuerySnapshot, UiMessage, ActivityByNetworkId } from './use-rer-networks-neo-page.types';
import { createRerNetworksNeoLoadActions } from './use-rer-networks-neo-page.load';
import { createRerNetworksNeoReportActions } from './use-rer-networks-neo-page.reports';
import { createRerNetworksNeoMutationActions } from './use-rer-networks-neo-page.mutations';
import { getNetworkPermissionsFromRoles, isSameSidebarUnitFilter } from './use-rer-networks-neo-page.shared';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';
import { buildSelectableUnitOptions, getUnitDisplayLabel } from '../../utils/unit-search';
import type { NetworkUpsertForm } from '../rer-network-details-neo/use-rer-network-details-neo-page.types';
import {
  createDefaultNetworkEtalonkaReportState,
  type NetworkEtalonkaReportState,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';

export function useRerNetworksNeoPage({ authUserRoles = [] }: { authUserRoles?: string[] } = {}) {
  const tableStateContext = useTableStateContext();
  const shellPermissions = useMemo(() => getNetworkPermissionsFromRoles(authUserRoles), [authUserRoles]);
  const columnFilters = useMemo(
    () => sanitizeNetworkColumnFilters(tableStateContext.columnFilters),
    [tableStateContext.columnFilters],
  );

  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [units, setUnits] = useState<Unit[]>([]);
  const [aors, setAors] = useState<AreaOfResponsibility[]>([]);
  const [modulations, setModulations] = useState<EncryptionRec[]>([]);
  const [posts, setPosts] = useState<Array<{ id: number; name: string }>>([]);
  const [unitStats, setUnitStats] = useState<Array<{ unitId: number; count: number }>>([]);
  const [activityByNetworkId, setActivityByNetworkId] = useState<ActivityByNetworkId>(new Map());
  const [filters, setFilters] = useState<NetworksFilterState>(() => createDefaultNetworksFilterState());
  const [status, setStatus] = useState<UiMessage>(null);
  const [statusCounts, setStatusCounts] = useState<{ active: number; inactive: number; archived: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSidebarUnitFilter, setSelectedSidebarUnitFilter] = useState<SelectedSidebarUnitFilter | null>(null);
  const [bootstrapLoaded, setBootstrapLoaded] = useState(false);
  const [reportsMenuAnchorEl, setReportsMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [rowMenuAnchorEl, setRowMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [rowMenuNetworkId, setRowMenuNetworkId] = useState<number | null>(null);
  const [downloadInFlight, setDownloadInFlight] = useState<'etalonka' | 'goi' | null>(null);
  const [reportTargetNetworkIds, setReportTargetNetworkIds] = useState<number[] | null>(null);
  const [reportTargetRequest, setReportTargetRequest] = useState<ListNetworksReq | null>(null);
  const [etalonkaReport, setEtalonkaReport] = useState<NetworkEtalonkaReportState>(() => createDefaultNetworkEtalonkaReportState());
  const [editDialog, setEditDialog] = useState<NetworkUpsertForm | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [createDialog, setCreateDialog] = useState<NetworkUpsertForm | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [deleteDialogNetwork, setDeleteDialogNetwork] = useState<Network | null>(null);
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [noMoreToLoad, setNoMoreToLoad] = useState(false);

  const requestSeqRef = useRef(0);
  const bootstrapLoadedRef = useRef(false);
  const mainAbortRef = useRef<AbortController | null>(null);
  const loadMoreAbortRef = useRef<AbortController | null>(null);
  const networksLengthRef = useRef(0);
  const latestQuerySnapshotRef = useRef<NetworksQuerySnapshot | null>(null);
  const lastExecutedFullQueryKeyRef = useRef<string | null>(null);
  const selectedSidebarUnitFilterRef = useRef<SelectedSidebarUnitFilter | null>(selectedSidebarUnitFilter);
  const tableStateContextRef = useRef({
    globalFilter: tableStateContext.globalFilter,
    columnFilters: tableStateContext.columnFilters,
    sorting: tableStateContext.sorting,
  });
  const filtersRef = useRef(filters);
  const columnFiltersRef = useRef(columnFilters);

  useEffect(() => {
    networksLengthRef.current = networks.length;
  }, [networks.length]);

  useEffect(() => {
    tableStateContextRef.current = {
      globalFilter: tableStateContext.globalFilter,
      columnFilters: tableStateContext.columnFilters,
      sorting: tableStateContext.sorting,
    };
  }, [tableStateContext.columnFilters, tableStateContext.globalFilter, tableStateContext.sorting]);

  useEffect(() => {
    filtersRef.current = filters;
  }, [filters]);

  useEffect(() => {
    selectedSidebarUnitFilterRef.current = selectedSidebarUnitFilter;
  }, [selectedSidebarUnitFilter]);

  useEffect(() => {
    columnFiltersRef.current = columnFilters;
  }, [columnFilters]);

  const unitsById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const aorsById = useMemo(() => new Map(aors.map((aor) => [aor.id, aor])), [aors]);
  const unitStatsView = useMemo(() => mergeNetworkUnitStatsWithUnits(unitStats, unitsById), [unitStats, unitsById]);
  const unitOptions = useMemo(
    () => buildSelectableUnitOptions(units).map((unit) => ({ id: unit.id, label: getUnitDisplayLabel(unit) })),
    [units],
  );
  const postOptions = useMemo(
    () =>
      posts
        .filter((post) => post.name.trim() !== '')
        .slice()
        .sort((left, right) => left.name.localeCompare(right.name, 'uk'))
        .map((post) => ({ id: post.id, label: post.name })),
    [posts],
  );
  const rows = useMemo(
    () => networks.map((network) => buildNetworkRowView(network, unitsById, aorsById, activityByNetworkId)),
    [activityByNetworkId, aorsById, networks, unitsById],
  );
  const aorOptions = useMemo(() => sortNetworkAorsForDisplay(aors), [aors]);
  const querySnapshot = useMemo<NetworksQuerySnapshot>(
    () => ({
      globalFilter: tableStateContext.globalFilter,
      columnFilters,
      sorting: tableStateContext.sorting,
      filters: {
        ...filters,
        searchText: tableStateContext.globalFilter,
      },
      selectedSidebarUnitFilter,
      fullQueryKey: JSON.stringify({
        globalFilter: tableStateContext.globalFilter,
        columnFilters,
        sorting: tableStateContext.sorting,
        filters: {
          searchText: filters.searchText,
          unitText: filters.unitText,
          status: filters.status,
          showOnlyInvestigating: filters.showOnlyInvestigating,
        },
        selectedSidebarUnitFilter,
      }),
    }),
    [columnFilters, filters, selectedSidebarUnitFilter, tableStateContext.globalFilter, tableStateContext.sorting],
  );
  const immediateQueryKey = useMemo(
    () =>
      JSON.stringify({
        columnFilters,
        sorting: tableStateContext.sorting,
        status: filters.status,
        unitText: filters.unitText,
        showOnlyInvestigating: filters.showOnlyInvestigating,
        selectedSidebarUnitFilter,
      }),
    [columnFilters, filters.showOnlyInvestigating, filters.status, filters.unitText, selectedSidebarUnitFilter, tableStateContext.sorting],
  );

  useEffect(() => {
    latestQuerySnapshotRef.current = querySnapshot;
  }, [querySnapshot]);

  const loadActions = useMemo(
    () =>
      createRerNetworksNeoLoadActions({
        tableStateContext: tableStateContextRef.current,
        tableStateContextRef,
        filtersRef,
        columnFiltersRef,
        latestQuerySnapshotRef,
        requestSeqRef,
        bootstrapLoadedRef,
        mainAbortRef,
        loadMoreAbortRef,
        networksLengthRef,
        lastExecutedFullQueryKeyRef,
        selectedSidebarUnitFilterRef,
        setLoading,
        setRefreshing,
        setLoadingMore,
        setUnits,
        setAors,
        setUnitStats,
        setPosts,
        setModulations,
        setStatus,
        setStatusCounts,
        setNoMoreToLoad,
        setNetworks,
        setActivityByNetworkId,
        setBootstrapLoaded,
      }),
    [],
  );

  const reportActions = useMemo(
    () =>
      createRerNetworksNeoReportActions({
        rows,
        filters: {
          status: filters.status,
          unitText: filters.unitText,
          showOnlyInvestigating: filters.showOnlyInvestigating,
        },
        selectedSidebarUnitFilter,
        columnFilters,
        sorting: tableStateContext.sorting,
        tableGlobalFilter: tableStateContext.globalFilter,
        reportTargetNetworkIds,
        reportTargetRequest,
        etalonkaReport,
        downloadInFlight,
        setReportTargetNetworkIds,
        setReportTargetRequest,
        setEtalonkaReport,
        setReportsMenuAnchorEl,
        setDownloadInFlight,
        setStatus,
      }),
    [
      columnFilters,
      downloadInFlight,
      etalonkaReport,
      filters.showOnlyInvestigating,
      filters.status,
      filters.unitText,
      selectedSidebarUnitFilter,
      reportTargetNetworkIds,
      reportTargetRequest,
      rows,
      tableStateContext.globalFilter,
      tableStateContext.sorting,
    ],
  );

  const mutationActions = useMemo(
    () =>
      createRerNetworksNeoMutationActions({
        networks,
        filters: {
          status: filters.status,
          unitText: filters.unitText,
          showOnlyInvestigating: filters.showOnlyInvestigating,
        },
        querySnapshot,
        latestQuerySnapshotRef,
        lastExecutedFullQueryKeyRef,
        editDialog,
        createDialog,
        deleteDialogNetwork,
        editSubmitting,
        createSubmitting,
        loadNetworks: loadActions.loadNetworks,
        refreshStatusCounts: loadActions.refreshStatusCounts,
        setStatus,
        setEditDialog,
        setEditSubmitting,
        setEditError,
        setCreateDialog,
        setCreateSubmitting,
        setCreateError,
        setDeleteDialogNetwork,
        setDeleteSubmitting,
        setNetworks,
        setActivityByNetworkId,
      }),
    [
      createDialog,
      createSubmitting,
      deleteDialogNetwork,
      editDialog,
      editSubmitting,
      filters.showOnlyInvestigating,
      filters.status,
      filters.unitText,
      selectedSidebarUnitFilter,
      loadActions.loadNetworks,
      loadActions.refreshStatusCounts,
      networks,
      querySnapshot,
    ],
  );

  useEffect(() => {
    void loadActions.loadNetworks(querySnapshot, { includeLookups: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bootstrapLoaded) return;
    const snapshot = latestQuerySnapshotRef.current;
    if (snapshot) {
      void loadActions.loadNetworks(snapshot, { includeLookups: false, append: false });
    }
  }, [bootstrapLoaded, immediateQueryKey, loadActions.loadNetworks]);

  useEffect(() => {
    if (!bootstrapLoaded) return;

    const timeoutId = window.setTimeout(() => {
      const snapshot = latestQuerySnapshotRef.current;
      if (snapshot) {
        void loadActions.loadNetworks(snapshot, { includeLookups: false, append: false });
      }
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [bootstrapLoaded, loadActions.loadNetworks, tableStateContext.globalFilter]);

  const loadMoreNetworks = useCallback(async () => {
    if (loading || refreshing || loadingMore || noMoreToLoad) return;
    await loadActions.loadMoreNetworks();
  }, [loading, loadingMore, loadActions.loadMoreNetworks, noMoreToLoad, refreshing]);

  const onPickUnitFilter = useCallback(
    (filter: SelectedSidebarUnitFilter) => {
      if (isSameSidebarUnitFilter(selectedSidebarUnitFilter, filter)) {
        setSelectedSidebarUnitFilter(null);
        setFilters((previous) => ({ ...previous, unitText: '', showOnlyInvestigating: false }));
        return;
      }

      setSelectedSidebarUnitFilter(filter);
      setFilters((previous) => ({
        ...previous,
        unitText: filter.kind === 'leaf' ? filter.unitName : '',
        showOnlyInvestigating: false,
      }));
    },
    [selectedSidebarUnitFilter],
  );

  const onToggleInvestigating = useCallback((next: boolean) => {
    setFilters((previous) => ({
      ...previous,
      showOnlyInvestigating: next,
      unitText: '',
    }));
    if (next) {
      setSelectedSidebarUnitFilter(null);
    }
  }, []);

  const onClearUnitFilter = useCallback(() => {
    setSelectedSidebarUnitFilter(null);
    setFilters((previous) => ({
      ...previous,
      unitText: '',
    }));
  }, []);

  const onClearInvestigatingFilter = useCallback(() => {
    setFilters((previous) => ({
      ...previous,
      showOnlyInvestigating: false,
    }));
  }, []);

  return {
    loading,
    refreshing,
    loadingMore,
    noMoreToLoad,
    sidebarOpen,
    setSidebarOpen,
    rows,
    allRows: rows,
    filters,
    setFilters,
    posts,
    unitOptions,
    postOptions,
    unitStatsView,
    selectedSidebarUnitFilter,
    onPickUnitFilter,
    onToggleInvestigating,
    onClearUnitFilter,
    onClearInvestigatingFilter,
    openReportDialog: reportActions.openReportDialog,
    openTopReportDialog: reportActions.openTopReportDialog,
    closeReportDialog: reportActions.closeReportDialog,
    downloadEtalonkaReport: reportActions.downloadEtalonkaReport,
    reportTargetNetworkIds,
    reportTargetRequest,
    etalonkaReport,
    setEtalonkaReport,
    status,
    setStatus,
    statusCounts,
    aorOptions,
    permissions: shellPermissions,
    reportsMenuAnchorEl,
    setReportsMenuAnchorEl,
    rowMenuAnchorEl,
    rowMenuNetworkId,
    setRowMenuAnchorEl,
    setRowMenuNetworkId,
    downloadInFlight,
    runDownload: reportActions.runDownload,
    loadMoreNetworks,
    modulations,
    editDialog,
    editSubmitting,
    editError,
    openEditDialog: mutationActions.openEditDialog,
    closeEditDialog: mutationActions.closeEditDialog,
    setEditDialog,
    saveNetworkEdit: mutationActions.saveNetworkEdit,
    createDialog,
    createSubmitting,
    createError,
    openCreateDialog: mutationActions.openCreateDialog,
    closeCreateDialog: mutationActions.closeCreateDialog,
    setCreateDialog,
    saveNetworkCreate: mutationActions.saveNetworkCreate,
    deleteDialogNetwork,
    deleteSubmitting,
    openDeleteDialog: (network: Network) => setDeleteDialogNetwork(network),
    closeDeleteDialog: () => setDeleteDialogNetwork(null),
    confirmDeleteNetwork: mutationActions.confirmDeleteNetwork,
    setNetworks,
  };
}
