import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRerNetworkDetailsNeoPageActions } from './use-rer-network-details-neo-page.actions';
import { buildRerNetworkDetailsNeoPageViewModel } from './use-rer-network-details-neo-page.view-model';
import {
  EMPTY_STATE,
  buildLookupMap,
  canDeleteNetwork,
  canEditNetwork,
  canManageDescriptions,
  canDeleteCatalogCallsign,
  canManageNetworkCallsignActions,
  canViewNetworkActivityTab,
  canViewNetworkRelationsTab,
  formatNetworkFreqRange,
  formatTransferTypeLabel,
  normalizeNetworkRelationsSinceChange,
  normalizeNetworkRelationsTillChange,
  normalizeNetworkPelengSinceChange,
  normalizeNetworkPelengTillChange,
  networkStatusDisplay,
  sortDescriptionsByCreatedAtDesc,
  type NetworkDetailsNeoPageState,
  type NetworkOption,
} from './use-rer-network-details-neo-page.shared';
import { sortNetworkAorsForDisplay } from '../rer-networks-neo/helpers';
import { useRerNetworkDetailsNeoPageLoad } from './use-rer-network-details-neo-page.load';
import { parseDateInputExclusiveEndInTimeZone, parseDateInputInTimeZone } from '../../utils/misc';
import { buildSelectableUnitOptions, buildUnitLookupOptions } from '../../utils/unit-search';
import { hasRole } from '../../utils/roles';
import {
  getPublicNetworkDetailsTab,
  readRequestedNetworkDetailsTab,
  resolveRequestedNetworkDetailsTab,
  updateCurrentNetworkDetailsTabUrl,
} from './network-details-tab-url';

function buildOptions<T extends { id: number; name: string }>(items: T[]): NetworkOption[] {
  return items.map((item) => ({ id: item.id, label: item.name }));
}

export function useRerNetworkDetailsNeoPage(networkId: number) {
  const initialRequestedTab =
    typeof window === 'undefined' ? null : readRequestedNetworkDetailsTab(window.location.search);
  const [requestedNetworkDetailsTab, setRequestedNetworkDetailsTab] = useState<string | null>(
    initialRequestedTab,
  );
  const [state, setState] = useState<NetworkDetailsNeoPageState>(() => ({
    ...EMPTY_STATE,
    activeNetworkDetailsTab:
      initialRequestedTab === null
        ? EMPTY_STATE.activeNetworkDetailsTab
        : resolveRequestedNetworkDetailsTab(initialRequestedTab, true, true),
  }));
  const pageReloadGeneration = useRef(0);
  const frequencyReloadGeneration = useRef(0);
  const currentNetworkIdRef = useRef<number | null>(null);
  const previousNetworkIdRef = useRef<number | null>(null);

  if (previousNetworkIdRef.current !== networkId) {
    previousNetworkIdRef.current = networkId;
    currentNetworkIdRef.current = networkId;
    frequencyReloadGeneration.current += 1;
  }

  const { reload, loadCallsigns, loadRelations, loadNetworkActivity, loadPelengPoints } =
    useRerNetworkDetailsNeoPageLoad(networkId, setState, pageReloadGeneration);

  const unitsById = useMemo(() => buildLookupMap(state.units), [state.units]);
  const postsById = useMemo(() => buildLookupMap(state.posts), [state.posts]);
  const aorsById = useMemo(() => buildLookupMap(state.aors), [state.aors]);
  const encryptionsById = useMemo(() => buildLookupMap(state.encryptions), [state.encryptions]);

  const canDelete = useMemo(() => canDeleteNetwork(state.currentUser), [state.currentUser]);
  const canEdit = useMemo(() => canEditNetwork(state.currentUser), [state.currentUser]);
  const canManageDescriptionActions = useMemo(
    () => canManageDescriptions(state.currentUser),
    [state.currentUser],
  );
  const canDeleteCatalogCallsignAction = useMemo(
    () => canDeleteCatalogCallsign(state.currentUser),
    [state.currentUser],
  );
  const canManageCallsignActions = useMemo(
    () => canManageNetworkCallsignActions(state.currentUser),
    [state.currentUser],
  );
  const canViewActivityTab = useMemo(
    () => canViewNetworkActivityTab(state.currentUser),
    [state.currentUser],
  );
  const canViewRelationsTab = useMemo(
    () => canViewNetworkRelationsTab(state.currentUser),
    [state.currentUser],
  );
  const status = useMemo(() => networkStatusDisplay(state.network), [state.network]);
  const isAdmin = useMemo(
    () => hasRole(state.currentUser?.roles, 'Admin'),
    [state.currentUser?.roles],
  );
  const networkIdValue = state.network?.id ?? null;

  const aorOptions = useMemo(
    () => buildOptions(sortNetworkAorsForDisplay(state.aors)),
    [state.aors],
  );
  const selectableUnits = useMemo(() => buildSelectableUnitOptions(state.units), [state.units]);
  const unitOptions = useMemo(() => buildOptions(selectableUnits), [selectableUnits]);
  const editUnitOptions = useMemo(
    () => buildUnitLookupOptions(state.units, state.editForm?.unitIds ?? []),
    [state.editForm?.unitIds, state.units],
  );
  const postOptions = useMemo(
    () => buildOptions(state.posts.filter((post) => post.name.trim() !== '')),
    [state.posts],
  );

  const confirmationDescriptions = useMemo(() => {
    const descriptions = state.network?.descriptions ?? [];
    return sortDescriptionsByCreatedAtDesc(
      descriptions.filter((description) => description.descrType === 'Confirmation'),
    );
  }, [state.network?.descriptions]);

  const signDescriptions = useMemo(() => {
    const descriptions = state.network?.descriptions ?? [];
    return sortDescriptionsByCreatedAtDesc(
      descriptions.filter((description) => description.descrType === 'Sign'),
    );
  }, [state.network?.descriptions]);

  const unitNames = useMemo(() => {
    const unitIds = state.network?.unitIds ?? [];
    return unitIds
      .map((unitId) => unitsById.get(unitId) ?? `#${unitId}`)
      .filter((label) => label.trim() !== '');
  }, [state.network?.unitIds, unitsById]);

  const aorItems = useMemo(() => {
    const aorIds = state.network?.aorIds ?? [];
    return aorIds.map((aorId) => ({ id: aorId, label: aorsById.get(aorId) ?? `#${aorId}` }));
  }, [aorsById, state.network?.aorIds]);

  const rangeLabel = useMemo(() => {
    return formatNetworkFreqRange(state.network?.freqs ?? []);
  }, [state.network?.freqs]);

  const actions = useRerNetworkDetailsNeoPageActions({
    state,
    setState,
    unitNames,
    reloadGeneration: frequencyReloadGeneration,
    currentNetworkIdRef,
    loadCallsigns,
  });

  const setRelationsSearch = useCallback(
    (relationsSearch: string) => {
      setState((current) => ({ ...current, relationsSearch }));
    },
    [setState],
  );

  const setRelationsEnabledFreqs = useCallback(
    (relationsEnabledFreqs: string[]) => {
      setState((current) => ({ ...current, relationsEnabledFreqs: [...relationsEnabledFreqs] }));
    },
    [setState],
  );

  const setRelationsMinIntensity = useCallback(
    (relationsMinIntensity: number) => {
      setState((current) => ({ ...current, relationsMinIntensity }));
    },
    [setState],
  );

  const setRelationsShowLabels = useCallback(
    (relationsShowLabels: boolean) => {
      setState((current) => ({ ...current, relationsShowLabels }));
    },
    [setState],
  );

  const setRelationsSelectedNodeId = useCallback(
    (relationsSelectedNodeId: string | null) => {
      setState((current) => ({
        ...current,
        relationsSelectedNodeId,
        relationsSelectedEdgeId: null,
      }));
    },
    [setState],
  );

  const setRelationsSelectedEdgeId = useCallback(
    (relationsSelectedEdgeId: string | null) => {
      setState((current) => ({
        ...current,
        relationsSelectedEdgeId,
        relationsSelectedNodeId: null,
      }));
    },
    [setState],
  );

  const setRelationsSince = useCallback(
    (relationsSince: string) => {
      setState((current) => {
        const next = normalizeNetworkRelationsSinceChange(
          current.relationsSince,
          current.relationsTill,
          relationsSince,
        );
        return {
          ...current,
          ...next,
          relationsLoaded: false,
          relationsError: null,
        };
      });
    },
    [setState],
  );

  const setRelationsTill = useCallback(
    (relationsTill: string) => {
      setState((current) => {
        const next = normalizeNetworkRelationsTillChange(
          current.relationsSince,
          current.relationsTill,
          relationsTill,
        );
        return {
          ...current,
          ...next,
          relationsLoaded: false,
          relationsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengSince = useCallback(
    (pelengSince: string) => {
      setState((current) => {
        const next = normalizeNetworkPelengSinceChange(
          current.pelengSince,
          current.pelengTill,
          pelengSince,
        );
        return {
          ...current,
          ...next,
          pelengPointsLoaded: false,
          pelengPointsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengTill = useCallback(
    (pelengTill: string) => {
      setState((current) => {
        const next = normalizeNetworkPelengTillChange(
          current.pelengSince,
          current.pelengTill,
          pelengTill,
        );
        return {
          ...current,
          ...next,
          pelengPointsLoaded: false,
          pelengPointsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengSearch = useCallback(
    (pelengSearch: string) => {
      setState((current) => ({ ...current, pelengSearch }));
    },
    [setState],
  );

  const setPelengEnabledFreqs = useCallback(
    (pelengEnabledFreqs: string[]) => {
      setState((current) => ({ ...current, pelengEnabledFreqs: [...pelengEnabledFreqs] }));
    },
    [setState],
  );

  const setPelengShowLabels = useCallback(
    (pelengShowLabels: boolean) => {
      setState((current) => ({ ...current, pelengShowLabels }));
    },
    [setState],
  );

  const setPelengSatelliteEnabled = useCallback(
    (pelengSatelliteEnabled: boolean) => {
      setState((current) => ({ ...current, pelengSatelliteEnabled }));
    },
    [setState],
  );

  const setPelengHeatmapEnabled = useCallback(
    (pelengHeatmapEnabled: boolean) => {
      setState((current) => ({ ...current, pelengHeatmapEnabled }));
    },
    [setState],
  );

  const setActiveNetworkDetailsTab = useCallback(
    (activeNetworkDetailsTab: NetworkDetailsNeoPageState['activeNetworkDetailsTab']) => {
      setState((current) => {
        if (
          current.activeNetworkDetailsTab === activeNetworkDetailsTab &&
          current.callsignSectionMode === 'network'
        ) {
          return current;
        }
        return {
          ...current,
          activeNetworkDetailsTab,
          callsignSectionMode: 'network',
        };
      });
      setRequestedNetworkDetailsTab(getPublicNetworkDetailsTab(activeNetworkDetailsTab));
      updateCurrentNetworkDetailsTabUrl(activeNetworkDetailsTab, 'push');
    },
    [setState],
  );

  const relationsDateRangeValid = useMemo(() => {
    const since = parseDateInputInTimeZone(state.relationsSince);
    const till = parseDateInputInTimeZone(state.relationsTill);
    if (since === null || till === null) return false;
    return since <= till;
  }, [state.relationsSince, state.relationsTill]);

  const pelengSinceMs = useMemo(
    () => parseDateInputInTimeZone(state.pelengSince),
    [state.pelengSince],
  );
  const pelengTillMs = useMemo(
    () => parseDateInputExclusiveEndInTimeZone(state.pelengTill),
    [state.pelengTill],
  );
  const pelengDateRangeValid = useMemo(() => {
    if (pelengSinceMs === null || pelengTillMs === null) return false;
    return pelengSinceMs <= pelengTillMs;
  }, [pelengSinceMs, pelengTillMs]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'frequencies') return;
    if (state.freqsLoaded || state.freqsLoading || state.freqsError !== null) return;
    void actions.loadFrequencies(networkIdValue);
  }, [
    actions.loadFrequencies,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.freqsError,
    state.freqsLoaded,
    state.freqsLoading,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'callsigns') return;
    if (state.callsignsLoaded || state.callsignsLoading || state.callsignsError !== null) return;
    void loadCallsigns(networkIdValue);
  }, [
    loadCallsigns,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.callsignsError,
    state.callsignsLoaded,
    state.callsignsLoading,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'relations') return;
    if (!state.currentUserLoaded) return;
    if (!canViewRelationsTab) return;
    if (!relationsDateRangeValid) return;
    if (state.relationsLoaded || state.relationsLoading || state.relationsError !== null) return;
    const since = parseDateInputInTimeZone(state.relationsSince);
    const till = parseDateInputExclusiveEndInTimeZone(state.relationsTill);
    if (since === null || till === null) return;
    void loadRelations(networkIdValue, since, till);
  }, [
    loadRelations,
    state.activeNetworkDetailsTab,
    canViewRelationsTab,
    state.currentUserLoaded,
    state.network,
    state.relationsError,
    state.relationsLoaded,
    state.relationsLoading,
    state.relationsSince,
    state.relationsTill,
    relationsDateRangeValid,
    networkIdValue,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'activity') return;
    if (!state.currentUserLoaded) return;
    if (!canViewActivityTab) return;
    if (
      state.networkActivityLoaded ||
      state.networkActivityLoading ||
      state.networkActivityError !== null
    )
      return;
    void loadNetworkActivity(networkIdValue);
  }, [
    canViewActivityTab,
    loadNetworkActivity,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.currentUserLoaded,
    state.networkActivityError,
    state.networkActivityLoaded,
    state.networkActivityLoading,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'direction-finding') return;

    const pelengWindowMatched =
      state.pelengPointsRequestedFrom === pelengSinceMs &&
      state.pelengPointsRequestedTo === pelengTillMs;

    if (
      pelengWindowMatched &&
      (state.pelengPointsLoaded || state.pelengPointsLoading || state.pelengPointsError !== null)
    )
      return;
    if (!pelengDateRangeValid) return;
    void loadPelengPoints(networkIdValue, pelengSinceMs ?? 0, pelengTillMs);
  }, [
    loadPelengPoints,
    pelengDateRangeValid,
    pelengSinceMs,
    pelengTillMs,
    state.activeNetworkDetailsTab,
    networkIdValue,
    state.pelengPointsError,
    state.pelengPointsLoaded,
    state.pelengPointsLoading,
    state.pelengPointsRequestedFrom,
    state.pelengPointsRequestedTo,
  ]);

  const postItems = useMemo(() => {
    const postIds = state.network?.postIds ?? [];
    return postIds.map((postId) => ({ id: postId, label: postsById.get(postId) ?? `#${postId}` }));
  }, [postsById, state.network?.postIds]);

  const transferTypeLabel = useMemo(() => {
    return formatTransferTypeLabel(state.network?.freqs ?? [], encryptionsById);
  }, [encryptionsById, state.network?.freqs]);

  useEffect(() => {
    if (typeof window === 'undefined') return;

    const handlePopState = () => {
      setRequestedNetworkDetailsTab(readRequestedNetworkDetailsTab(window.location.search));
    };

    window.addEventListener('popstate', handlePopState);
    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, []);

  useEffect(() => {
    if (requestedNetworkDetailsTab === null) {
      if (typeof window === 'undefined') return;
      const canonicalTab = getPublicNetworkDetailsTab(state.activeNetworkDetailsTab);
      if (readRequestedNetworkDetailsTab(window.location.search) === canonicalTab) return;
      updateCurrentNetworkDetailsTabUrl(state.activeNetworkDetailsTab, 'replace');
      setRequestedNetworkDetailsTab(canonicalTab);
      return;
    }

    const canResolveGatedTabs = state.currentUserLoaded;
    const nextTab = resolveRequestedNetworkDetailsTab(
      requestedNetworkDetailsTab,
      canResolveGatedTabs ? canViewActivityTab : true,
      canResolveGatedTabs ? canViewRelationsTab : true,
    );

    setState((current) =>
      current.activeNetworkDetailsTab === nextTab
        ? current
        : { ...current, activeNetworkDetailsTab: nextTab },
    );

    if (typeof window === 'undefined') return;
    const canonicalTab = getPublicNetworkDetailsTab(nextTab);
    if (readRequestedNetworkDetailsTab(window.location.search) === canonicalTab) return;
    updateCurrentNetworkDetailsTabUrl(nextTab, 'replace');
    setRequestedNetworkDetailsTab(canonicalTab);
  }, [
    canViewActivityTab,
    canViewRelationsTab,
    requestedNetworkDetailsTab,
    state.activeNetworkDetailsTab,
    state.currentUserLoaded,
  ]);

  return buildRerNetworkDetailsNeoPageViewModel({
    state,
    status,
    canDelete,
    canEdit,
    canManageDescriptionActions,
    canDeleteCatalogCallsign: canDeleteCatalogCallsignAction,
    canManageCallsignActions,
    canViewActivityTab,
    canViewRelationsTab,
    isAdmin,
    unitNames,
    aorItems,
    postItems,
    rangeLabel,
    transferTypeLabel,
    aorOptions,
    unitOptions,
    editUnitOptions,
    postOptions,
    confirmationDescriptions,
    signDescriptions,
    setRelationsSearch,
    setRelationsEnabledFreqs,
    setRelationsMinIntensity,
    setRelationsShowLabels,
    setRelationsSelectedNodeId,
    setRelationsSelectedEdgeId,
    setRelationsSince,
    setRelationsTill,
    setPelengSince,
    setPelengTill,
    setPelengSearch,
    setPelengEnabledFreqs,
    setPelengShowLabels,
    setPelengSatelliteEnabled,
    setPelengHeatmapEnabled,
    setActiveNetworkDetailsTab,
    loadRelations,
    loadPelengPoints,
    loadNetworkActivity,
    reload,
    actions,
    setEtalonkaReportProgressExpanded: actions.setEtalonkaReportProgressExpanded,
  });
}

export type RerNetworkDetailsNeoPage = ReturnType<typeof useRerNetworkDetailsNeoPage>;
