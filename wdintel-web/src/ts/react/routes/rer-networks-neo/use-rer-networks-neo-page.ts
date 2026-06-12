import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MRT_ColumnFiltersState, MRT_SortingState } from 'material-react-table';
import { useTableStateContext } from '../../components/mui-customized/table/table-state-provider';

import type { AreaOfResponsibility, ListNetworksReq, Network, Unit } from '../../../../Bindings';
import { listAors } from '../../services/api/aor';
import { downloadBlob } from '../../utils/download-blob';
import { getUnitsList } from '../../services/api/units';
import {
  buildNetworkRowView,
  buildNetworksListReq,
  buildNetworksReportReq,
  buildNetworksStatusCountsReq,
  createDefaultNetworksFilterState,
  NETWORK_LIST_PAGE_SIZE,
  mergeNetworkUnitStatsWithUnits,
  sanitizeNetworkColumnFilters,
  sortNetworkRows,
  type NetworkRowView,
  type NetworksFilterState,
} from './helpers';
import {
  deleteNetwork,
  downloadNetworkEtalonkaReport,
  downloadNetworksEtalonkaReport,
  downloadNetworkGoiReport,
  getNetworksGroupsActivity,
  getNetworkUnitStats,
  listNetworks,
  updateNetworkPosts,
  updateNetworkUnits,
  updateNetwork,
} from '../../services/api/networks';
import { isUnauthorizedError } from '../../services/api/client';
import type { SelectedSidebarUnitFilter } from '../rer-callsigns-neo/types';
import { listPosts } from '../../services/api/posts';
import type { NetworkEditForm } from '../rer-network-details-neo/use-rer-network-details-neo-page.types';
import { toNetworkEditForm } from '../rer-network-details-neo/use-rer-network-details-neo-page.forms';
import {
  buildEtalonkaNetworksBatchReq,
  buildEtalonkaNetworksReportReq,
  buildEtalonkaReportFilename,
  createDefaultNetworkEtalonkaReportState,
  type NetworkEtalonkaReportState,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';

type UiMessage = { kind: 'info' | 'success' | 'error'; text: string } | null;

type ActivityByNetworkId = Map<number, Record<string, Record<string, number>>>;
type NetworksQuerySnapshot = {
  globalFilter: string;
  columnFilters: MRT_ColumnFiltersState;
  sorting: MRT_SortingState;
  filters: NetworksFilterState;
  fullQueryKey: string;
};

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

function redirectToLogin() {
  window.location.assign('/login');
}

function getActivityRequestUpperBoundMs(): number {
  return dayjs().startOf('day').add(1, 'day').valueOf();
}

function normalizeActivityMap(
  activityByNetworkId: Record<string, Record<string, Record<string, number>>>,
): ActivityByNetworkId {
  const activity = new Map<number, Record<string, Record<string, number>>>();
  for (const [networkId, networkActivity] of Object.entries(activityByNetworkId)) {
    const parsedId = Number(networkId);
    if (!Number.isFinite(parsedId)) continue;
    activity.set(parsedId, networkActivity);
  }
  return activity;
}

function isSameSidebarUnitFilter(left: SelectedSidebarUnitFilter | null, right: SelectedSidebarUnitFilter): boolean {
  if (left === null || left.kind !== right.kind || left.label !== right.label) {
    return false;
  }

  if (left.kind === 'leaf' && right.kind === 'leaf') {
    return left.unitName === right.unitName;
  }

  if (left.kind === 'group' && right.kind === 'group') {
    return (
      left.hierarchy.army === right.hierarchy.army &&
      left.hierarchy.division === right.hierarchy.division &&
      left.hierarchy.regiment === right.hierarchy.regiment &&
      left.hierarchy.battalion === right.hierarchy.battalion
    );
  }

  return false;
}

function getNetworkPermissionsFromRoles(rolesList: string[]) {
  const roles = new Set(rolesList);
  return {
    canEdit: roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full'))),
    canExport: roles.has('Admin') || roles.has('Rer') || roles.has('Full'),
    canDelete: roles.has('Admin') || (roles.has('UnitsEditor') && (roles.has('Rer') || roles.has('Full'))),
  };
}

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
  const [posts, setPosts] = useState<Array<{ id: number; name: string }>>([]);
  const [unitStats, setUnitStats] = useState<Array<{ unitId: number; count: number }>>([]);
  const [activityByNetworkId, setActivityByNetworkId] = useState<ActivityByNetworkId>(new Map());
  const [filters, setFilters] = useState<NetworksFilterState>(() => createDefaultNetworksFilterState());
  const [status, setStatus] = useState<UiMessage>(null);
  const [statusCounts, setStatusCounts] = useState<{ active: number; inactive: number; archived: number } | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [selectedSidebarUnitFilter, setSelectedSidebarUnitFilter] = useState<SelectedSidebarUnitFilter | null>(null);
  const [reportsMenuAnchorEl, setReportsMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [rowMenuAnchorEl, setRowMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [rowMenuNetworkId, setRowMenuNetworkId] = useState<number | null>(null);
  const [downloadInFlight, setDownloadInFlight] = useState<'etalonka' | 'goi' | null>(null);
  const [reportTargetNetworkIds, setReportTargetNetworkIds] = useState<number[] | null>(null);
  const [reportTargetRequest, setReportTargetRequest] = useState<ListNetworksReq | null>(null);
  const [etalonkaReport, setEtalonkaReport] = useState<NetworkEtalonkaReportState>(() => createDefaultNetworkEtalonkaReportState());
  const [editDialog, setEditDialog] = useState<NetworkEditForm | null>(null);
  const [editSubmitting, setEditSubmitting] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
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

  useEffect(() => {
    networksLengthRef.current = networks.length;
  }, [networks.length]);

  const unitsById = useMemo(() => new Map(units.map((unit) => [unit.id, unit])), [units]);
  const aorsById = useMemo(() => new Map(aors.map((aor) => [aor.id, aor])), [aors]);
  const unitStatsView = useMemo(() => mergeNetworkUnitStatsWithUnits(unitStats, unitsById), [unitStats, unitsById]);
  const unitOptions = useMemo(() => units.slice().sort((left, right) => left.name.localeCompare(right.name, 'uk')).map((unit) => ({ id: unit.id, label: unit.name })), [units]);
  const postOptions = useMemo(() => posts.slice().sort((left, right) => left.name.localeCompare(right.name, 'uk')).map((post) => ({ id: post.id, label: post.name })), [posts]);
  const rows = useMemo(
    () => sortNetworkRows(networks.map((network) => buildNetworkRowView(network, unitsById, aorsById, activityByNetworkId))),
    [activityByNetworkId, aorsById, networks, unitsById],
  );
  const aorOptions = useMemo(() => aors.slice().sort((left, right) => left.name.localeCompare(right.name, 'uk')), [aors]);
  const immediateQueryKey = useMemo(
    () =>
      JSON.stringify({
        columnFilters,
        sorting: tableStateContext.sorting,
        status: filters.status,
        unitText: filters.unitText,
        showOnlyInvestigating: filters.showOnlyInvestigating,
      }),
    [columnFilters, filters.showOnlyInvestigating, filters.status, filters.unitText, tableStateContext.sorting],
  );
  const fullQueryKey = useMemo(
    () =>
      JSON.stringify({
        globalFilter: tableStateContext.globalFilter,
        columnFilters,
        sorting: tableStateContext.sorting,
        filters: {
          searchText: filters.searchText,
          unitText: filters.unitText,
          status: filters.status,
          showOnlyInvestigating: filters.showOnlyInvestigating,
        },
      }),
    [
      columnFilters,
      filters.searchText,
      filters.showOnlyInvestigating,
      filters.status,
      filters.unitText,
      tableStateContext.globalFilter,
      tableStateContext.sorting,
    ],
  );

  const querySnapshot = useMemo<NetworksQuerySnapshot>(
    () => ({
      globalFilter: tableStateContext.globalFilter,
      columnFilters,
      sorting: tableStateContext.sorting,
      filters: {
        ...filters,
        searchText: tableStateContext.globalFilter,
      },
      fullQueryKey,
    }),
    [columnFilters, filters, fullQueryKey, tableStateContext.globalFilter, tableStateContext.sorting],
  );

  useEffect(() => {
    latestQuerySnapshotRef.current = querySnapshot;
  }, [querySnapshot]);

  const loadNetworks = useCallback(
    async (snapshot: NetworksQuerySnapshot, options?: { includeLookups?: boolean; append?: boolean }) => {
      const seq = ++requestSeqRef.current;
      const includeLookups = options?.includeLookups ?? false;
      const append = options?.append ?? false;
      const controller = new AbortController();
      if (lastExecutedFullQueryKeyRef.current === snapshot.fullQueryKey && !append && !includeLookups) {
        return;
      }
      if (!append) {
        mainAbortRef.current?.abort();
        mainAbortRef.current = controller;
      }
      const req = buildNetworksListReq({
        searchText: snapshot.globalFilter,
        selectedUnitLabel: snapshot.filters.unitText.trim() === '' ? null : snapshot.filters.unitText.trim(),
        showOnlyInvestigating: snapshot.filters.showOnlyInvestigating,
        status: snapshot.filters.status,
        columnFilters: snapshot.columnFilters,
        sorting: snapshot.sorting,
        limit: NETWORK_LIST_PAGE_SIZE,
        offset: append ? networksLengthRef.current : 0,
      });
      if (includeLookups) {
        setLoading(true);
      } else if (append) {
        setLoadingMore(true);
      } else {
        setRefreshing(true);
      }
      setStatus(null);

      try {
        const lookupsPromise = includeLookups
          ? Promise.all([getUnitsList(), listAors({ sortBy: null }), getNetworkUnitStats(), listPosts()])
          : null;
        const networksPromise = listNetworks(req, { signal: controller.signal });

        const nextLookups = lookupsPromise === null ? null : await lookupsPromise;
        const { list: networksList, statusCounts } = await networksPromise;
        const activityRsp = networksList.length === 0
          ? {}
          : await getNetworksGroupsActivity(
              {
                networkIds: networksList.map((network) => network.id),
                tillDateNoninclusiveMs: getActivityRequestUpperBoundMs(),
              },
              { signal: controller.signal },
            );

        if (requestSeqRef.current !== seq) return;

        if (nextLookups !== null) {
          const [unitsList, aorList, unitStatsList, postsList] = nextLookups;
          setUnits(unitsList);
          setAors(aorList);
          setUnitStats(unitStatsList);
          setPosts(postsList);
          bootstrapLoadedRef.current = true;
        }
        setStatusCounts(statusCounts);

        setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
        setNetworks((current) => (append ? [...current, ...networksList] : networksList));
        setActivityByNetworkId((current) => {
          const nextActivity = append ? new Map(current) : new Map();
          const normalized = normalizeActivityMap(activityRsp);
          for (const [networkId, activity] of normalized.entries()) {
            nextActivity.set(networkId, activity);
          }
          return nextActivity;
        });
        if (!append) {
          lastExecutedFullQueryKeyRef.current = snapshot.fullQueryKey;
        }
      } catch (error) {
        if (requestSeqRef.current !== seq) return;
        if (controller.signal.aborted || isAbortError(error)) return;
        if (isUnauthorizedError(error)) {
          redirectToLogin();
          return;
        }
        setStatus({
          kind: 'error',
          text: `Помилка завантаження мереж: ${formatErrorMessage(error)}`,
        });
      } finally {
        if (requestSeqRef.current === seq) {
          setLoading(false);
          setRefreshing(false);
          setLoadingMore(false);
        }
        if (!append && mainAbortRef.current === controller) {
          mainAbortRef.current = null;
        }
      }
    },
    [],
  );

  const refreshStatusCounts = useCallback(async () => {
    try {
      const countsReq = buildNetworksStatusCountsReq({
        searchText: latestQuerySnapshotRef.current?.globalFilter ?? tableStateContext.globalFilter,
        selectedUnitLabel:
          (latestQuerySnapshotRef.current?.filters.unitText ?? filters.unitText).trim() === ''
            ? null
            : (latestQuerySnapshotRef.current?.filters.unitText ?? filters.unitText).trim(),
        showOnlyInvestigating: latestQuerySnapshotRef.current?.filters.showOnlyInvestigating ?? filters.showOnlyInvestigating,
        columnFilters: latestQuerySnapshotRef.current?.columnFilters ?? columnFilters,
      });
      const { statusCounts } = await listNetworks(
        {
          ...countsReq,
          limit: 0,
          offset: 0,
        },
      );
      setStatusCounts(statusCounts);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setStatus({
        kind: 'error',
        text: `Помилка оновлення лічильників мереж: ${formatErrorMessage(error)}`,
      });
    }
  }, [
    filters.showOnlyInvestigating,
    filters.unitText,
    columnFilters,
    tableStateContext.globalFilter,
  ]);

  useEffect(() => {
    void loadNetworks(querySnapshot, { includeLookups: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!bootstrapLoadedRef.current) return;
    const snapshot = latestQuerySnapshotRef.current;
    if (snapshot) {
      void loadNetworks(snapshot, { includeLookups: false, append: false });
    }
  }, [immediateQueryKey, loadNetworks]);

  useEffect(() => {
    if (!bootstrapLoadedRef.current) return;

    const timeoutId = window.setTimeout(() => {
      const snapshot = latestQuerySnapshotRef.current;
      if (snapshot) {
        void loadNetworks(snapshot, { includeLookups: false, append: false });
      }
    }, 250);

    return () => window.clearTimeout(timeoutId);
  }, [loadNetworks, tableStateContext.globalFilter]);

  function openReportDialog(network: Network) {
    setReportTargetNetworkIds([network.id]);
    setReportTargetRequest(null);
    setEtalonkaReport((current) => ({
      ...current,
      dialogOpen: true,
      downloading: false,
      error: null,
    }));
    setRowMenuAnchorEl(null);
    setRowMenuNetworkId(null);
  }

  function openTopReportDialog() {
    if (rows.length === 0) {
      setStatus({ kind: 'info', text: 'Немає мереж для звіту з активними фільтрами.' });
      setReportsMenuAnchorEl(null);
      return;
    }

    setReportTargetNetworkIds(null);
    setReportTargetRequest(
      buildNetworksReportReq({
        searchText: tableStateContext.globalFilter,
        selectedUnitLabel: filters.unitText.trim() === '' ? null : filters.unitText.trim(),
        showOnlyInvestigating: filters.showOnlyInvestigating,
        status: filters.status,
        columnFilters,
        sorting: tableStateContext.sorting,
      }),
    );
    setEtalonkaReport((current) => ({
      ...current,
      dialogOpen: true,
      downloading: false,
      error: null,
    }));
    setReportsMenuAnchorEl(null);
  }

  function closeReportDialog() {
    setEtalonkaReport((current) => (current.downloading ? current : { ...current, dialogOpen: false, error: null }));
    setReportTargetNetworkIds(null);
    setReportTargetRequest(null);
  }

  async function downloadEtalonkaReport() {
    if (etalonkaReport.downloading) return;
    const isFilteredReport = reportTargetRequest !== null;
    const hasRowReport = reportTargetNetworkIds !== null && reportTargetNetworkIds.length > 0;
    if (!isFilteredReport && !hasRowReport) return;

    const fileName = isFilteredReport
      ? 'etalonka_networks.docx'
      : reportTargetNetworkIds!.length === 1
        ? buildEtalonkaReportFilename(reportTargetNetworkIds![0], etalonkaReport)
        : 'etalonka_networks.docx';

    setEtalonkaReport((current) => ({
      ...current,
      downloading: true,
      error: null,
    }));

    try {
      const blob = isFilteredReport
        ? await downloadNetworksEtalonkaReport(buildEtalonkaNetworksReportReq(reportTargetRequest!, etalonkaReport))
        : await downloadNetworkEtalonkaReport(buildEtalonkaNetworksBatchReq(reportTargetNetworkIds ?? [], etalonkaReport));
      downloadBlob(blob, fileName);
      setEtalonkaReport((current) => ({
        ...current,
        downloading: false,
        error: null,
      }));
    } catch (error) {
      if (isUnauthorizedError(error)) {
        setEtalonkaReport((current) => ({
          ...current,
          downloading: false,
          error: null,
        }));
        redirectToLogin();
        return;
      }
      setEtalonkaReport((current) => ({
        ...current,
        downloading: false,
        error: formatErrorMessage(error),
      }));
    }
  }

  async function runDownload(kind: 'etalonka' | 'goi', networkIdsOverride?: number[]) {
    if (downloadInFlight !== null) return;
    const networkIds = networkIdsOverride ?? rows.map((row) => row.id);
    if (networkIds.length === 0) {
      setStatus({ kind: 'info', text: 'Немає мереж для звіту з активними фільтрами.' });
      return;
    }

    setDownloadInFlight(kind);
    try {
      if (kind === 'etalonka') {
        const blob = await downloadNetworkEtalonkaReport({
          networkIds,
          sortBy: null,
          etalonkaType: {
            AccordingToTheForm: {
              activeFreqsOnly: true,
              includeSigintSigns: true,
              includeConfirmation: true,
            },
          },
        });
        downloadBlob(blob, 'etalonka_networks.docx');
      } else {
        const blob = await downloadNetworkGoiReport();
        downloadBlob(blob, 'goi_report.xlsx');
      }
      setStatus({ kind: 'success', text: kind === 'etalonka' ? 'Звіт завантажено.' : 'Звіт ГОІ завантажено.' });
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setStatus({ kind: 'error', text: `Помилка завантаження звіту: ${formatErrorMessage(error)}` });
    } finally {
      setDownloadInFlight(null);
      setReportsMenuAnchorEl(null);
    }
  }

  function openEditDialog(network: Network) {
    setEditError(null);
    setEditDialog(toNetworkEditForm(network));
    setRowMenuAnchorEl(null);
    setRowMenuNetworkId(null);
  }

  function closeEditDialog() {
    if (editSubmitting) return;
    setEditDialog(null);
    setEditError(null);
  }

  function syncNetworkRelations(editForm: NetworkEditForm) {
    return updateNetworkPosts({
      networkId: editForm.id,
      postIds: [...editForm.postIds],
    }).then(() =>
      updateNetworkUnits({
        networkId: editForm.id,
        unitIds: [...editForm.unitIds],
      }),
    );
  }

  async function saveNetworkEdit() {
    if (!editDialog) return;

    setEditSubmitting(true);
    setEditError(null);

    try {
      const network = networks.find((item) => item.id === editDialog.id) ?? null;
      const updated = await updateNetwork({
        id: editDialog.id,
        restoreNetwork: network?.deleted && editDialog.status === 'NetworkActive' ? true : null,
        areaOfResponsibilityIds: [...editDialog.aorIds],
        name: editDialog.name.trim(),
        location: editDialog.location.trim(),
        radioStation: editDialog.radioStation.trim() === '' ? null : editDialog.radioStation.trim(),
        purpose: editDialog.purpose.trim() === '' ? null : editDialog.purpose.trim(),
        operationMode: editDialog.operationMode.trim() === '' ? null : editDialog.operationMode.trim(),
        operationType: editDialog.operationType.trim() === '' ? null : editDialog.operationType.trim(),
        operationPeriod: editDialog.operationPeriod.trim() === '' ? null : editDialog.operationPeriod.trim(),
        descriptions: null,
        status: editDialog.status,
      });
      await syncNetworkRelations(editDialog);
      setNetworks((current) => current.map((item) => (item.id === updated.id ? updated : item)));
      void refreshStatusCounts();
      setStatus({ kind: 'success', text: 'Мережу оновлено.' });
      setEditDialog(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setEditError(formatErrorMessage(error));
    } finally {
      setEditSubmitting(false);
    }
  }

  async function confirmDeleteNetwork() {
    if (!deleteDialogNetwork) return;

    setDeleteSubmitting(true);
    try {
      const deletedNetwork = await deleteNetwork(deleteDialogNetwork.id);
      setNetworks((current) =>
        filters.status === 'deleted'
          ? current.map((network) => (network.id === deletedNetwork.id ? deletedNetwork : network))
          : current.filter((network) => network.id !== deletedNetwork.id),
      );
      setActivityByNetworkId((current) => {
        if (filters.status === 'deleted') return current;
        const nextActivity = new Map(current);
        nextActivity.delete(deletedNetwork.id);
        return nextActivity;
      });
      void refreshStatusCounts();
      setStatus({ kind: 'success', text: 'Мережу видалено.' });
      setDeleteDialogNetwork(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setStatus({ kind: 'error', text: `Помилка видалення мережі: ${formatErrorMessage(error)}` });
    } finally {
      setDeleteSubmitting(false);
    }
  }

  async function loadMoreNetworks() {
    if (loadingMore || loading || refreshing || noMoreToLoad) return;

    loadMoreAbortRef.current?.abort();
    loadMoreAbortRef.current = new AbortController();
    const seq = ++requestSeqRef.current;
    setLoadingMore(true);
    setStatus(null);

    try {
      const req = buildNetworksListReq({
        searchText: latestQuerySnapshotRef.current?.globalFilter ?? tableStateContext.globalFilter,
        selectedUnitLabel: (latestQuerySnapshotRef.current?.filters.unitText ?? filters.unitText).trim() === '' ? null : (latestQuerySnapshotRef.current?.filters.unitText ?? filters.unitText).trim(),
        showOnlyInvestigating: latestQuerySnapshotRef.current?.filters.showOnlyInvestigating ?? filters.showOnlyInvestigating,
        status: latestQuerySnapshotRef.current?.filters.status ?? filters.status,
        columnFilters: latestQuerySnapshotRef.current?.columnFilters ?? columnFilters,
        sorting: latestQuerySnapshotRef.current?.sorting ?? tableStateContext.sorting,
        limit: NETWORK_LIST_PAGE_SIZE,
        offset: networksLengthRef.current,
      });
      const { list: networksList, statusCounts } = await listNetworks(req, { signal: loadMoreAbortRef.current.signal });
      const activityRsp = networksList.length === 0
        ? {}
        : await getNetworksGroupsActivity(
            {
              networkIds: networksList.map((network) => network.id),
              tillDateNoninclusiveMs: getActivityRequestUpperBoundMs(),
            },
            { signal: loadMoreAbortRef.current.signal },
          );

      if (requestSeqRef.current !== seq) return;

      setNoMoreToLoad(networksList.length < NETWORK_LIST_PAGE_SIZE);
      setStatusCounts(statusCounts);
      setNetworks((current) => [...current, ...networksList]);
      setActivityByNetworkId((current) => {
        const nextActivity = new Map(current);
        const normalized = normalizeActivityMap(activityRsp);
        for (const [networkId, activity] of normalized.entries()) {
          nextActivity.set(networkId, activity);
        }
        return nextActivity;
      });
    } catch (error) {
      if (requestSeqRef.current !== seq) return;
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      setStatus({ kind: 'error', text: `Помилка завантаження мереж: ${formatErrorMessage(error)}` });
    } finally {
      if (requestSeqRef.current === seq) {
        setLoadingMore(false);
      }
    }
  }

  function pickUnitFilter(filter: SelectedSidebarUnitFilter) {
    if (isSameSidebarUnitFilter(selectedSidebarUnitFilter, filter)) {
      setSelectedSidebarUnitFilter(null);
      setFilters((previous) => ({ ...previous, unitText: '', showOnlyInvestigating: false }));
      return;
    }

    setSelectedSidebarUnitFilter(filter);
    setFilters((previous) => ({
      ...previous,
      unitText: filter.label,
      showOnlyInvestigating: false,
    }));
  }

  function toggleInvestigating(next: boolean) {
    setFilters((previous) => ({
      ...previous,
      showOnlyInvestigating: next,
      unitText: '',
    }));
    if (next) {
      setSelectedSidebarUnitFilter(null);
    }
  }

  function clearUnitFilter() {
    setSelectedSidebarUnitFilter(null);
    setFilters((previous) => ({
      ...previous,
      unitText: '',
    }));
  }

  function clearInvestigatingFilter() {
    setFilters((previous) => ({
      ...previous,
      showOnlyInvestigating: false,
    }));
  }

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
    onPickUnitFilter: pickUnitFilter,
    onToggleInvestigating: toggleInvestigating,
    onClearUnitFilter: clearUnitFilter,
    onClearInvestigatingFilter: clearInvestigatingFilter,
    openReportDialog,
    openTopReportDialog,
    closeReportDialog,
    downloadEtalonkaReport,
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
    runDownload,
    loadMoreNetworks,
    editDialog,
    editSubmitting,
    editError,
    openEditDialog,
    closeEditDialog,
    setEditDialog,
    saveNetworkEdit,
    deleteDialogNetwork,
    deleteSubmitting,
    openDeleteDialog: (network: Network) => setDeleteDialogNetwork(network),
    closeDeleteDialog: () => setDeleteDialogNetwork(null),
    confirmDeleteNetwork,
    setNetworks,
  };
}
