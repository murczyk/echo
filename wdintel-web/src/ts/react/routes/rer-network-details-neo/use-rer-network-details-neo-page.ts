import { useMemo, useRef, useState } from 'react';
import { useRerNetworkDetailsNeoPageActions } from './use-rer-network-details-neo-page.actions';
import {
  EMPTY_STATE,
  buildLookupMap,
  canDeleteNetwork,
  canEditNetwork,
  canManageDescriptions,
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
  const reloadGeneration = useRef(0);

  const reload = useRerNetworkDetailsNeoPageLoad(networkId, setState, reloadGeneration);

  const unitsById = useMemo(() => buildLookupMap(state.units), [state.units]);
  const postsById = useMemo(() => buildLookupMap(state.posts), [state.posts]);
  const aorsById = useMemo(() => buildLookupMap(state.aors), [state.aors]);
  const modulationsById = useMemo(() => buildLookupMap(state.modulations), [state.modulations]);

  const canDelete = useMemo(() => canDeleteNetwork(state.currentUser), [state.currentUser]);
  const canEdit = useMemo(() => canEditNetwork(state.currentUser), [state.currentUser]);
  const canManageDescriptionActions = useMemo(() => canManageDescriptions(state.currentUser), [state.currentUser]);
  const status = useMemo(() => networkStatusDisplay(state.network), [state.network]);

  const aorOptions = useMemo(() => buildOptions(state.aors), [state.aors]);
  const unitOptions = useMemo(() => buildOptions(state.units), [state.units]);
  const postOptions = useMemo(() => buildOptions(state.posts), [state.posts]);

  const confirmationDescriptions = useMemo(() => {
    const descriptions = state.network?.descriptions ?? [];
    return sortDescriptionsByCreatedAtDesc(descriptions.filter((description) => description.descrType === 'Confirmation'));
  }, [state.network?.descriptions]);

  const unitNames = useMemo(() => {
    const unitIds = state.network?.unitIds ?? [];
    return unitIds
      .map((unitId) => unitsById.get(unitId) ?? `#${unitId}`)
      .filter((label) => label.trim() !== '');
  }, [state.network?.unitIds, unitsById]);

  const actions = useRerNetworkDetailsNeoPageActions({ state, setState, unitNames });

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
    unitNames,
    aorItems,
    postItems,
    rangeLabel,
    transferTypeLabel,
    aorOptions,
    unitOptions,
    postOptions,
    confirmationDescriptions,
    expandedDescriptionIds: state.expandedDescriptionIds,
    toggleDescriptionExpanded: actions.toggleDescriptionExpanded,
    descriptionDrawerOpen: state.descriptionDrawerOpen,
    descriptionDrawerMode: state.descriptionDrawerMode,
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
    reload,
  };
}
