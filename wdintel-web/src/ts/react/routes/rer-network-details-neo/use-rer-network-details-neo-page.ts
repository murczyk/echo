import { useEffect, useMemo, useRef, useState } from 'react';
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
  networkStatusDisplay,
  sortDescriptionsByCreatedAtDesc,
  type NetworkDetailsNeoPageState,
  type NetworkOption,
} from './use-rer-network-details-neo-page.shared';
import { sortNetworkAorsForDisplay } from '../rer-networks-neo/helpers';
import { useRerNetworkDetailsNeoPageLoad } from './use-rer-network-details-neo-page.load';
import { useRerNetworkDetailsNeoPageTabControls } from './use-rer-network-details-neo-page.tab-controls';
import { useRerNetworkDetailsNeoPageTabEffects } from './use-rer-network-details-neo-page.tab-effects';
import { buildSelectableUnitOptions, buildUnitLookupOptions } from '../../utils/unit-search';
import { canUseRadioFeatures, hasRole } from '../../utils/roles';
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

  const {
    reload,
    loadCallsigns,
    loadNetworkCallsignStats,
    loadRelations,
    loadNetworkActivity,
    loadPelengPoints,
  } = useRerNetworkDetailsNeoPageLoad(networkId, setState, pageReloadGeneration);

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
  const radioFeaturesAllowed = canUseRadioFeatures(state.currentUser?.roles);
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
    loadNetworkCallsignStats,
  });

  const tabControls = useRerNetworkDetailsNeoPageTabControls(
    setState,
    setRequestedNetworkDetailsTab,
  );

  useRerNetworkDetailsNeoPageTabEffects({
    state,
    networkIdValue,
    radioFeaturesAllowed,
    canViewActivityTab,
    canViewRelationsTab,
    loadFrequencies: actions.loadFrequencies,
    loadCallsigns,
    loadRelations,
    loadNetworkActivity,
    loadPelengPoints,
  });

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

    if (!state.currentUserLoaded) return;
    const canResolveGatedTabs = state.currentUserLoaded;
    const requestedTab = resolveRequestedNetworkDetailsTab(
      requestedNetworkDetailsTab,
      canResolveGatedTabs ? canViewActivityTab : true,
      canResolveGatedTabs ? canViewRelationsTab : true,
    );

    const nextTab =
      !radioFeaturesAllowed &&
      (requestedTab === 'frequencies' || requestedTab === 'direction-finding')
        ? 'descriptions'
        : requestedTab;

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
    radioFeaturesAllowed,
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
    ...tabControls,
    loadRelations,
    loadPelengPoints,
    loadNetworkActivity,
    reload,
    actions,
    setEtalonkaReportProgressExpanded: actions.setEtalonkaReportProgressExpanded,
  });
}

export type RerNetworkDetailsNeoPage = ReturnType<typeof useRerNetworkDetailsNeoPage>;
