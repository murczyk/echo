import { useEffect, useMemo, useRef, useState } from 'react';
import { useRerNetworkDetailsNeoPageActions } from './use-rer-network-details-neo-page.actions';
import {
  EMPTY_STATE,
  buildLookupMap,
  canDeleteNetwork,
  canEditNetwork,
  canManageDescriptions,
  canManageNetworkCallsignActions,
  formatNetworkFreqRange,
  formatTransferTypeLabel,
  networkStatusDisplay,
  sortDescriptionsByCreatedAtDesc,
  type NetworkDetailsNeoPageState,
  type NetworkOption,
} from './use-rer-network-details-neo-page.shared';
import { useRerNetworkDetailsNeoPageLoad } from './use-rer-network-details-neo-page.load';

function buildOptions<T extends { id: number; name: string }>(items: T[]): NetworkOption[] {
  return items.map((item) => ({ id: item.id, label: item.name }));
}

export function useRerNetworkDetailsNeoPage(networkId: number) {
  const [state, setState] = useState<NetworkDetailsNeoPageState>(EMPTY_STATE);
  const pageReloadGeneration = useRef(0);
  const frequencyReloadGeneration = useRef(0);
  const currentNetworkIdRef = useRef<number | null>(null);
  const previousNetworkIdRef = useRef<number | null>(null);

  if (previousNetworkIdRef.current !== networkId) {
    previousNetworkIdRef.current = networkId;
    currentNetworkIdRef.current = networkId;
    frequencyReloadGeneration.current += 1;
  }

  const { reload, loadCallsigns, loadNetworkActivity, loadPelengPoints } = useRerNetworkDetailsNeoPageLoad(networkId, setState, pageReloadGeneration);

  const unitsById = useMemo(() => buildLookupMap(state.units), [state.units]);
  const postsById = useMemo(() => buildLookupMap(state.posts), [state.posts]);
  const aorsById = useMemo(() => buildLookupMap(state.aors), [state.aors]);
  const modulationsById = useMemo(() => buildLookupMap(state.modulations), [state.modulations]);

  const canDelete = useMemo(() => canDeleteNetwork(state.currentUser), [state.currentUser]);
  const canEdit = useMemo(() => canEditNetwork(state.currentUser), [state.currentUser]);
  const canManageDescriptionActions = useMemo(() => canManageDescriptions(state.currentUser), [state.currentUser]);
  const canManageCallsignActions = useMemo(() => canManageNetworkCallsignActions(state.currentUser), [state.currentUser]);
  const status = useMemo(() => networkStatusDisplay(state.network), [state.network]);
  const isAdmin = useMemo(() => (state.currentUser?.roles ?? []).includes('Admin'), [state.currentUser?.roles]);
  const pelengActiveFrom = state.network?.activeFrom ?? null;
  const pelengActiveTo = state.network?.activeTo ?? null;

  const aorOptions = useMemo(() => buildOptions(state.aors), [state.aors]);
  const unitOptions = useMemo(() => buildOptions(state.units), [state.units]);
  const postOptions = useMemo(() => buildOptions(state.posts), [state.posts]);

  const confirmationDescriptions = useMemo(() => {
    const descriptions = state.network?.descriptions ?? [];
    return sortDescriptionsByCreatedAtDesc(descriptions.filter((description) => description.descrType === 'Confirmation'));
  }, [state.network?.descriptions]);

  const signDescriptions = useMemo(() => {
    const descriptions = state.network?.descriptions ?? [];
    return sortDescriptionsByCreatedAtDesc(descriptions.filter((description) => description.descrType === 'Sign'));
  }, [state.network?.descriptions]);

  const unitNames = useMemo(() => {
    const unitIds = state.network?.unitIds ?? [];
    return unitIds
      .map((unitId) => unitsById.get(unitId) ?? `#${unitId}`)
      .filter((label) => label.trim() !== '');
  }, [state.network?.unitIds, unitsById]);

  const actions = useRerNetworkDetailsNeoPageActions({
    state,
    setState,
    unitNames,
    reloadGeneration: frequencyReloadGeneration,
    currentNetworkIdRef,
    loadCallsigns,
  });

  useEffect(() => {
    if (state.network === null) return;
    if (state.freqsLoaded || state.freqsLoading || state.freqsError !== null) return;
    void actions.loadFrequencies(state.network.id);
  }, [actions.loadFrequencies, state.freqsError, state.freqsLoaded, state.freqsLoading, state.network]);

  useEffect(() => {
    if (state.network === null) return;
    if (state.callsignsLoaded || state.callsignsLoading || state.callsignsError !== null) return;
    void loadCallsigns(state.network.id);
  }, [loadCallsigns, state.callsignsError, state.callsignsLoaded, state.callsignsLoading, state.network]);

  useEffect(() => {
    if (state.network === null) return;
    if (state.activeNetworkDetailsTab !== 'activity') return;
    if (state.networkActivityLoaded || state.networkActivityLoading || state.networkActivityError !== null) return;
    void loadNetworkActivity(state.network.id);
  }, [
    loadNetworkActivity,
    state.activeNetworkDetailsTab,
    state.network,
    state.networkActivityError,
    state.networkActivityLoaded,
    state.networkActivityLoading,
  ]);

  useEffect(() => {
    if (state.network === null) return;
    if (state.activeNetworkDetailsTab !== 'pelengation') return;

    const pelengWindowMatched =
      state.pelengPointsRequestedFrom === pelengActiveFrom &&
      state.pelengPointsRequestedTo === pelengActiveTo;

    if (pelengWindowMatched && (state.pelengPointsLoaded || state.pelengPointsLoading || state.pelengPointsError !== null)) return;
    void loadPelengPoints(state.network.id, pelengActiveFrom, pelengActiveTo);
  }, [
    loadPelengPoints,
    pelengActiveFrom,
    pelengActiveTo,
    state.activeNetworkDetailsTab,
    state.network,
    state.pelengPointsError,
    state.pelengPointsLoaded,
    state.pelengPointsLoading,
    state.pelengPointsRequestedFrom,
    state.pelengPointsRequestedTo,
  ]);

  const aorItems = useMemo(() => {
    const aorIds = state.network?.aorIds ?? [];
    return aorIds.map((aorId) => ({ id: aorId, label: aorsById.get(aorId) ?? `#${aorId}` }));
  }, [aorsById, state.network?.aorIds]);

  const postItems = useMemo(() => {
    const postIds = state.network?.postIds ?? [];
    return postIds.map((postId) => ({ id: postId, label: postsById.get(postId) ?? `#${postId}` }));
  }, [postsById, state.network?.postIds]);

  const rangeLabel = useMemo(() => {
    return formatNetworkFreqRange(state.network?.freqs ?? []);
  }, [state.network?.freqs]);

  const transferTypeLabel = useMemo(() => {
    return formatTransferTypeLabel(state.network?.freqs ?? [], modulationsById);
  }, [modulationsById, state.network?.freqs]);

  return {
    ...state,
    status,
    canDelete,
    canEdit,
    canManageDescriptionActions,
    canManageCallsignActions,
    isAdmin,
    unitNames,
    aorItems,
    postItems,
    rangeLabel,
    transferTypeLabel,
    aorOptions,
    unitOptions,
    postOptions,
    confirmationDescriptions,
    signDescriptions,
    activeNetworkDetailsTab: state.activeNetworkDetailsTab,
    setActiveNetworkDetailsTab: actions.setActiveNetworkDetailsTab,
    loadFrequencies: actions.loadFrequencies,
    loadCallsigns: actions.loadCallsigns,
    expandedDescriptionIds: state.expandedDescriptionIds,
    toggleDescriptionExpanded: actions.toggleDescriptionExpanded,
    freqs: state.freqs,
    freqsLoaded: state.freqsLoaded,
    freqsLoading: state.freqsLoading,
    freqsError: state.freqsError,
    freqActivityByFreq: state.freqActivityByFreq,
    networkActivity: state.networkActivity,
    networkActivityLoaded: state.networkActivityLoaded,
    networkActivityLoading: state.networkActivityLoading,
    networkActivityError: state.networkActivityError,
    pelengPoints: state.pelengPoints,
    pelengPointsLoaded: state.pelengPointsLoaded,
    pelengPointsLoading: state.pelengPointsLoading,
    pelengPointsError: state.pelengPointsError,
    expandedFrequencyGroupIds: state.expandedFrequencyGroupIds,
    toggleFrequencyGroupExpanded: actions.toggleFrequencyGroupExpanded,
    openFreqCreateWizard: actions.openFreqCreateWizard,
    closeFreqCreateWizard: actions.closeFreqCreateWizard,
    setFreqCreateWizardForm: actions.setFreqCreateWizardForm,
    setFreqCreateWizardStep: actions.setFreqCreateWizardStep,
    freqCreateWizardOpen: state.freqCreateWizardOpen,
    freqCreateWizardStep: state.freqCreateWizardStep,
    freqCreateWizardForm: state.freqCreateWizardForm,
    freqCreateWizardSaving: state.freqCreateWizardSaving,
    freqCreateWizardError: state.freqCreateWizardError,
    saveFreqCreateWizard: actions.saveFreqCreateWizard,
    openFreqEditDrawer: actions.openFreqEditDrawer,
    closeFreqEditDrawer: actions.closeFreqEditDrawer,
    setFreqEditDrawerForm: actions.setFreqEditDrawerForm,
    freqEditDrawerOpen: state.freqEditDrawerOpen,
    freqEditDrawerForm: state.freqEditDrawerForm,
    freqEditDrawerSaving: state.freqEditDrawerSaving,
    freqEditDrawerError: state.freqEditDrawerError,
    saveFreqEditDrawer: actions.saveFreqEditDrawer,
    openFreqTechDrawer: actions.openFreqTechDrawer,
    closeFreqTechDrawer: actions.closeFreqTechDrawer,
    setFreqTechDrawerForm: actions.setFreqTechDrawerForm,
    freqTechDrawerOpen: state.freqTechDrawerOpen,
    freqTechDrawerForm: state.freqTechDrawerForm,
    freqTechDrawerSaving: state.freqTechDrawerSaving,
    freqTechDrawerError: state.freqTechDrawerError,
    saveFreqTechDrawer: actions.saveFreqTechDrawer,
    openFreqRowActions: actions.openFreqRowActions,
    closeFreqRowActions: actions.closeFreqRowActions,
    freqRowActionMenuAnchorEl: state.freqRowActionMenuAnchorEl,
    freqRowActionTargetId: state.freqRowActionTargetId,
    openDeleteFreqDialog: actions.openDeleteFreqDialog,
    closeDeleteFreqDialog: actions.closeDeleteFreqDialog,
    freqDeleteDialogOpen: state.freqDeleteDialogOpen,
    freqDeleteTarget: state.freqDeleteTarget,
    freqDeleteSubmitting: state.freqDeleteSubmitting,
    freqDeleteError: state.freqDeleteError,
    deleteFreq: actions.deleteFreq,
    callsignSectionMode: state.callsignSectionMode,
    setCallsignSectionMode: actions.setCallsignSectionMode,
    callsignStatusFilter: state.callsignStatusFilter,
    setCallsignStatusFilter: actions.setCallsignStatusFilter,
    callsignInterceptedExpanded: state.callsignInterceptedExpanded,
    toggleCallsignInterceptedExpanded: actions.toggleCallsignInterceptedExpanded,
    networkCallsigns: state.networkCallsigns,
    catalogCallsignGroups: state.catalogCallsignGroups,
    unknownInterceptedCallsigns: state.unknownInterceptedCallsigns,
    callsignsLoaded: state.callsignsLoaded,
    callsignsLoading: state.callsignsLoading,
    callsignsError: state.callsignsError,
    callsignCreateInFlightCallsigns: state.callsignCreateInFlightCallsigns,
    callsignCatalogAddInFlightIds: state.callsignCatalogAddInFlightIds,
    callsignUpdateInFlightIds: state.callsignUpdateInFlightIds,
    callsignDeleteInFlightIds: state.callsignDeleteInFlightIds,
    callsignDrawerOpen: state.callsignDrawerOpen,
    callsignDrawerMode: state.callsignDrawerMode,
    callsignDrawerForm: state.callsignDrawerForm,
    callsignDrawerSaving: state.callsignDrawerSaving,
    callsignDrawerError: state.callsignDrawerError,
    openCallsignDrawerForCreate: actions.openCallsignDrawerForCreate,
    openCallsignDrawerForEdit: actions.openCallsignDrawerForEdit,
    closeCallsignDrawer: actions.closeCallsignDrawer,
    setCallsignDrawerForm: actions.setCallsignDrawerForm,
    saveCallsignDrawer: actions.saveCallsignDrawer,
    callsignDeleteDialogOpen: state.callsignDeleteDialogOpen,
    callsignDeleteTarget: state.callsignDeleteTarget,
    callsignDeleteSubmitting: state.callsignDeleteSubmitting,
    callsignDeleteError: state.callsignDeleteError,
    openCallsignDeleteDialog: actions.openCallsignDeleteDialog,
    closeCallsignDeleteDialog: actions.closeCallsignDeleteDialog,
    deleteCallsign: actions.deleteCallsign,
    addKnownCallsignsToNetwork: actions.addKnownCallsignsToNetwork,
    addInterceptedCallsignToNetwork: actions.addInterceptedCallsignToNetwork,
    toggleNetworkCallsignMainRadioStation: actions.toggleNetworkCallsignMainRadioStation,
    loadPelengPoints,
    descriptionDrawerOpen: state.descriptionDrawerOpen,
    descriptionDrawerMode: state.descriptionDrawerMode,
    descriptionDrawerDescrType: state.descriptionDrawerDescrType,
    descriptionDrawerDescriptionId: state.descriptionDrawerDescriptionId,
    descriptionDrawerForm: state.descriptionDrawerForm,
    descriptionDrawerSaving: state.descriptionDrawerSaving,
    descriptionDrawerError: state.descriptionDrawerError,
    openDescriptionDrawerForCreate: actions.openDescriptionDrawerForCreate,
    openDescriptionDrawerForEdit: actions.openDescriptionDrawerForEdit,
    setDescriptionDrawerForm: actions.setDescriptionDrawerForm,
    closeDescriptionDrawer: actions.closeDescriptionDrawer,
    saveDescription: actions.saveDescription,
    deleteDescriptionDialogOpen: state.deleteDescriptionDialogOpen,
    deleteDescriptionTarget: state.deleteDescriptionTarget,
    deleteDescriptionSubmitting: state.deleteDescriptionSubmitting,
    deleteDescriptionError: state.deleteDescriptionError,
    openDeleteDescriptionDialog: actions.openDeleteDescriptionDialog,
    closeDeleteDescriptionDialog: actions.closeDeleteDescriptionDialog,
    resetDeleteDescriptionDialog: actions.resetDeleteDescriptionDialog,
    deleteDescription: actions.deleteDescription,
    openMenu: actions.openMenu,
    closeMenu: actions.closeMenu,
    openDeleteDialog: actions.openDeleteDialog,
    closeDeleteDialog: actions.closeDeleteDialog,
    openEditDrawer: actions.openEditDrawer,
    closeEditDrawer: actions.closeEditDrawer,
    setEditForm: actions.setEditForm,
    saveNetworkEdit: actions.saveNetworkEdit,
    handleCopyNetworkInfo: actions.handleCopyNetworkInfo,
    handleDelete: actions.handleDelete,
    loadNetworkActivity,
    reload,
  };
}
