import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import {
  deleteNetwork,
  updateNetwork,
  updateNetworkPosts,
  updateNetworkUnits,
} from '../../services/api/networks';
import {
  addKnownCallsignsToNetwork,
  createNetworkCallsign,
  deleteNetworkCallsign,
  updateNetworkCallsign,
} from '../../services/api/callsigns';
import { navigateWithinSpa } from '../../utils/browser';
import {
  formatClassicNetworkHeaderName,
  formatErrorMessage,
  canManageNetworkCallsignActions,
  toNetworkEditForm,
  type NetworkDetailsNeoPageState,
  type NetworkEditForm,
} from './use-rer-network-details-neo-page.shared';
import {
  createDefaultNetworkCallsignDrawerForm,
  createNetworkCallsignDrawerForm,
  type NetworkCallsignDrawerForm,
  mergeNetworkCallsigns,
  removeKnownCallsignIdsFromNetworkCallsignGroups,
  type NetworkCallsignRowView,
  type NetworkCallsignSectionMode,
  type NetworkCallsignStatusFilter,
  normalizeCallsignDisplay,
  NetworkCallsignSourceId,
  buildNetworkCallsignTabData,
} from './network-callsigns';
import { useRerNetworkDetailsNeoPageDescriptionActions } from './use-rer-network-details-neo-page.description-actions';
import { useRerNetworkDetailsNeoPageFrequencyActions } from './use-rer-network-details-neo-page.frequency-actions';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  unitNames: string[];
  reloadGeneration: MutableRefObject<number>;
  currentNetworkIdRef: MutableRefObject<number | null>;
  loadCallsigns: (networkId: number) => Promise<void>;
};

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

export function useRerNetworkDetailsNeoPageActions({ state, setState, unitNames, reloadGeneration, currentNetworkIdRef, loadCallsigns }: Args) {
  const descriptionActions = useRerNetworkDetailsNeoPageDescriptionActions({ state, setState });
  const frequencyActions = useRerNetworkDetailsNeoPageFrequencyActions({
    state,
    setState,
    reloadGeneration,
    currentNetworkIdRef,
  });
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);
  const defaultNetworkUnitId = state.network?.unitIds?.[0] ?? null;

  const openMenu = useCallback((anchorEl: HTMLElement) => {
    setState((current) => ({ ...current, menuAnchorEl: anchorEl }));
  }, [setState]);

  const closeMenu = useCallback(() => {
    setState((current) => ({ ...current, menuAnchorEl: null }));
  }, [setState]);

  const openDeleteDialog = useCallback(() => {
    setState((current) => ({ ...current, deleteDialogOpen: true, menuAnchorEl: null }));
  }, [setState]);

  const closeDeleteDialog = useCallback(() => {
    setState((current) => ({ ...current, deleteDialogOpen: false }));
  }, [setState]);

  const openEditDrawer = useCallback(() => {
    setState((current) => {
      if (!current.network) return current;
      return {
        ...current,
        editDrawerOpen: true,
        editForm: toNetworkEditForm(current.network),
        editInProgress: false,
        editError: null,
        menuAnchorEl: null,
      };
    });
  }, [setState]);

  const closeEditDrawer = useCallback(() => {
    setState((current) => {
      if (current.editInProgress) return current;
      return {
        ...current,
        editDrawerOpen: false,
        editForm: null,
        editError: null,
        menuAnchorEl: null,
      };
    });
  }, [setState]);

  const saveNetworkEdit = useCallback(async () => {
    const network = state.network;
    const editForm = state.editForm;

    if (!network || !editForm || state.editInProgress) return;

    setState((current) => ({
      ...current,
      editInProgress: true,
      editError: null,
      menuAnchorEl: null,
    }));

    try {
      const updatedNetwork = await updateNetwork({
        id: editForm.id,
        restoreNetwork: network.deleted && editForm.status === 'NetworkActive' ? true : null,
        areaOfResponsibilityIds: [...editForm.aorIds],
        name: editForm.name,
        location: editForm.location,
        radioStation: editForm.radioStation.trim() === '' ? null : editForm.radioStation,
        purpose: editForm.purpose.trim() === '' ? null : editForm.purpose,
        operationMode: editForm.operationMode.trim() === '' ? null : editForm.operationMode,
        operationType: editForm.operationType.trim() === '' ? null : editForm.operationType,
        operationPeriod: editForm.operationPeriod.trim() === '' ? null : editForm.operationPeriod,
        descriptions: null,
        status: editForm.status,
      });

      await syncNetworkRelations(editForm);

      setState((current) => ({
        ...current,
        network: {
          ...updatedNetwork,
          aorIds: [...editForm.aorIds],
          unitIds: [...editForm.unitIds],
          postIds: [...editForm.postIds],
        },
        editDrawerOpen: false,
        editForm: null,
        editInProgress: false,
        editError: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        editInProgress: false,
        editError: formatErrorMessage(error),
      }));
    }
  }, [state.editForm, state.editInProgress, state.network, setState]);

  const handleDelete = useCallback(async () => {
    if (!state.network) return;
    setState((current) => ({ ...current, deleteInProgress: true }));
    try {
      await deleteNetwork(state.network.id);
      navigateWithinSpa('/rer-networks');
    } catch (error) {
      setState((current) => ({
        ...current,
        deleteInProgress: false,
        deleteDialogOpen: false,
        error: formatErrorMessage(error),
      }));
      return;
    }
  }, [state.network, setState]);

  const handleCopyNetworkInfo = useCallback(async () => {
    const networkName = formatClassicNetworkHeaderName(state.network?.name, unitNames);
    const location = state.network?.location?.trim() ?? '';
    const parts = [networkName, location].filter((value) => value !== '');
    if (parts.length === 0) return;

    try {
      await navigator.clipboard.writeText(parts.join(', '));
      setState((current) => ({ ...current, copyStatus: 'Назву й район скопійовано' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null }));
      }, 1800);
    } catch (error) {
      setState((current) => ({ ...current, copyStatus: formatErrorMessage(error) }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null }));
      }, 2400);
    }
  }, [setState, state.network?.location, state.network?.name, unitNames]);

  const setEditForm = useCallback((editForm: NetworkEditForm | null) => {
    setState((current) => ({ ...current, editForm }));
  }, [setState]);

  const reloadCallsignsData = useCallback(async () => {
    if (!state.network) return;
    await loadCallsigns(state.network.id);
  }, [loadCallsigns, state.network]);

  const setCallsignSectionMode = useCallback((callsignSectionMode: NetworkCallsignSectionMode) => {
    setState((current) => ({ ...current, callsignSectionMode }));
  }, [setState]);

  const setCallsignStatusFilter = useCallback((callsignStatusFilter: NetworkCallsignStatusFilter) => {
    setState((current) => ({ ...current, callsignStatusFilter }));
  }, [setState]);

  const toggleCallsignInterceptedExpanded = useCallback(() => {
    setState((current) => ({ ...current, callsignInterceptedExpanded: !current.callsignInterceptedExpanded }));
  }, [setState]);

  const openCallsignDrawerForCreate = useCallback((overrides?: Partial<NetworkCallsignDrawerForm>) => {
    if (!canManageCallsignActions || !state.network) return;
    setState((current) => ({
      ...current,
      callsignDrawerOpen: true,
      callsignDrawerMode: 'create',
      callsignDrawerForm: {
        ...createDefaultNetworkCallsignDrawerForm(state.network?.id ?? 0, defaultNetworkUnitId),
        ...(overrides ?? {}),
      },
      callsignDrawerSaving: false,
      callsignDrawerError: null,
      callsignWarning: null,
    }));
  }, [canManageCallsignActions, defaultNetworkUnitId, setState, state.network]);

  const openCallsignDrawerForEdit = useCallback((networkCallsign: NetworkCallsignRowView) => {
    if (!canManageCallsignActions || !state.network) return;
    setState((current) => ({
      ...current,
      callsignDrawerOpen: true,
      callsignDrawerMode: 'edit',
      callsignDrawerForm: createNetworkCallsignDrawerForm(state.network?.id ?? 0, networkCallsign),
      callsignDrawerSaving: false,
      callsignDrawerError: null,
      callsignWarning: null,
    }));
  }, [canManageCallsignActions, setState, state.network]);

  const closeCallsignDrawer = useCallback(() => {
    setState((current) => {
      if (current.callsignDrawerSaving) return current;
      return {
        ...current,
        callsignDrawerOpen: false,
        callsignDrawerMode: 'create',
        callsignDrawerForm: null,
        callsignDrawerSaving: false,
        callsignDrawerError: null,
      };
    });
  }, [setState]);

  const setCallsignDrawerForm = useCallback((callsignDrawerForm: NetworkDetailsNeoPageState['callsignDrawerForm']) => {
    setState((current) => ({ ...current, callsignDrawerForm }));
  }, [setState]);

  const openCallsignDeleteDialog = useCallback((networkCallsign: NetworkCallsignRowView) => {
    if (!canManageCallsignActions) return;
    setState((current) => ({
      ...current,
      callsignDeleteDialogOpen: true,
      callsignDeleteTarget: networkCallsign,
      callsignDeleteSubmitting: false,
      callsignDeleteError: null,
    }));
  }, [canManageCallsignActions, setState]);

  const closeCallsignDeleteDialog = useCallback(() => {
    setState((current) => {
      if (current.callsignDeleteSubmitting) return current;
      return {
        ...current,
        callsignDeleteDialogOpen: false,
        callsignDeleteTarget: null,
        callsignDeleteSubmitting: false,
        callsignDeleteError: null,
      };
    });
  }, [setState]);

  const saveCallsignDrawer = useCallback(async () => {
    const network = state.network;
    const form = state.callsignDrawerForm;

    if (!canManageCallsignActions || !network || !form || state.callsignDrawerSaving) return;

    const callsign = normalizeCallsignDisplay(form.callsign);
    if (callsign === '') {
      setState((current) => ({ ...current, callsignDrawerError: 'Позивний є обовʼязковим' }));
      return;
    }

    if (form.sourceId === NetworkCallsignSourceId.RO && form.radioFreq.trim() === '') {
      setState((current) => ({ ...current, callsignDrawerError: 'Для джерела "РО" частота є обовʼязковою' }));
      return;
    }

    const payload = {
      networkId: network.id,
      callsign,
      position: form.position.trim() === '' ? null : form.position.trim(),
      comment: form.comment.trim() === '' ? null : form.comment.trim(),
      sourceId: form.sourceId,
      radioFreq: form.radioFreq.trim() === '' ? null : form.radioFreq.trim(),
      unitId: form.unitId,
      unitDeveloping: form.unitDeveloping,
      developing: form.developing,
      mainRadioStation: form.mainRadioStation,
      commandControl: form.commandControl,
    } as const;
    const updateCallsignId = state.callsignDrawerMode === 'edit' && form.id !== null ? form.id : null;

    setState((current) => ({
      ...current,
      callsignDrawerSaving: true,
      callsignDrawerError: null,
      callsignUpdateInFlightIds:
        updateCallsignId === null
          ? current.callsignUpdateInFlightIds
          : [...current.callsignUpdateInFlightIds, updateCallsignId],
    }));

    try {
      if (state.callsignDrawerMode === 'create') {
        await createNetworkCallsign(payload);
      } else if (form.id !== null) {
        await updateNetworkCallsign({
          id: form.id,
          ...payload,
        });
      }
      setState((current) => ({
        ...current,
        callsignDrawerOpen: false,
        callsignDrawerMode: 'create',
        callsignDrawerForm: null,
        callsignDrawerSaving: false,
        callsignDrawerError: null,
        callsignWarning: null,
        callsignUpdateInFlightIds: updateCallsignId === null
          ? current.callsignUpdateInFlightIds
          : current.callsignUpdateInFlightIds.filter((item) => item !== updateCallsignId),
      }));
      await reloadCallsignsData();
    } catch (error) {
      setState((current) => ({
        ...current,
        callsignDrawerSaving: false,
        callsignDrawerError: formatErrorMessage(error),
        callsignUpdateInFlightIds: updateCallsignId === null
          ? current.callsignUpdateInFlightIds
          : current.callsignUpdateInFlightIds.filter((item) => item !== updateCallsignId),
      }));
    }
  }, [canManageCallsignActions, reloadCallsignsData, setState, state.callsignDrawerForm, state.callsignDrawerMode, state.callsignDrawerSaving, state.network]);

  const deleteCallsign = useCallback(async () => {
    const target = state.callsignDeleteTarget;
    if (!canManageCallsignActions || !target || state.callsignDeleteSubmitting) return;

    setState((current) => ({
      ...current,
      callsignDeleteSubmitting: true,
      callsignDeleteError: null,
      callsignWarning: null,
      callsignDeleteInFlightIds: [...current.callsignDeleteInFlightIds, target.id],
    }));

    try {
      await deleteNetworkCallsign(target.id);
      setState((current) => ({
        ...current,
        callsignDeleteDialogOpen: false,
        callsignDeleteTarget: null,
        callsignDeleteSubmitting: false,
        callsignDeleteError: null,
        callsignWarning: null,
        callsignDeleteInFlightIds: current.callsignDeleteInFlightIds.filter((item) => item !== target.id),
      }));
      await reloadCallsignsData();
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignDeleteSubmitting: false,
        callsignDeleteError: errorMessage,
        callsignWarning: errorMessage,
        callsignDeleteInFlightIds: current.callsignDeleteInFlightIds.filter((item) => item !== target.id),
      }));
    }
  }, [canManageCallsignActions, reloadCallsignsData, setState, state.callsignDeleteSubmitting, state.callsignDeleteTarget]);

  const addKnownCallsigns = useCallback(async (knownCallsignId: number) => {
    const network = state.network;
    if (!canManageCallsignActions || !network) return;
    if (state.callsignCatalogAddInFlightIds.includes(knownCallsignId)) return;

    setState((current) => ({
      ...current,
      callsignWarning: null,
      callsignCatalogAddInFlightIds: [...current.callsignCatalogAddInFlightIds, knownCallsignId],
    }));

    try {
      const addedNetworkCallsigns = await addKnownCallsignsToNetwork({
        networkId: network.id,
        knownCallsignIds: [knownCallsignId],
      });

      setState((current) => {
        const nextNetworkCallsigns = mergeNetworkCallsigns(current.networkCallsigns, addedNetworkCallsigns);
        const nextNetworkCallsignGroups = removeKnownCallsignIdsFromNetworkCallsignGroups(current.networkCallsignGroups, [knownCallsignId]);
        const derived = buildNetworkCallsignTabData(nextNetworkCallsignGroups, current.callsignActivityMap, nextNetworkCallsigns);

        return {
          ...current,
          networkCallsigns: nextNetworkCallsigns,
          networkCallsignGroups: nextNetworkCallsignGroups,
          catalogCallsignGroups: derived.catalogCallsignGroups,
          unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
          callsignCount: nextNetworkCallsigns.length,
          callsignCatalogAddInFlightIds: current.callsignCatalogAddInFlightIds.filter((item) => item !== knownCallsignId),
          callsignWarning: null,
        };
      });
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignCatalogAddInFlightIds: current.callsignCatalogAddInFlightIds.filter((item) => item !== knownCallsignId),
        callsignWarning: errorMessage,
      }));
      return;
    }
  }, [canManageCallsignActions, setState, state.callsignCatalogAddInFlightIds, state.network]);

  const addInterceptedCallsignToNetwork = useCallback(async (callsign: string, developing: boolean) => {
    const network = state.network;
    if (!canManageCallsignActions || !network) return;
    const normalizedCallsign = normalizeCallsignDisplay(callsign);
    if (normalizedCallsign === '') return;
    if (state.callsignCreateInFlightCallsigns.includes(normalizedCallsign)) return;

    setState((current) => ({
      ...current,
      callsignWarning: null,
      callsignCreateInFlightCallsigns: [...current.callsignCreateInFlightCallsigns, normalizedCallsign],
    }));

    try {
      const createdNetworkCallsign = await createNetworkCallsign({
        networkId: network.id,
        callsign: normalizedCallsign,
        position: null,
        comment: null,
        sourceId: null,
        radioFreq: null,
        unitId: defaultNetworkUnitId,
        unitDeveloping: false,
        developing,
        mainRadioStation: false,
        commandControl: false,
      });

      setState((current) => {
        const nextNetworkCallsigns = mergeNetworkCallsigns(current.networkCallsigns, [createdNetworkCallsign]);
        const derived = buildNetworkCallsignTabData(current.networkCallsignGroups, current.callsignActivityMap, nextNetworkCallsigns);

        return {
          ...current,
          networkCallsigns: nextNetworkCallsigns,
          catalogCallsignGroups: derived.catalogCallsignGroups,
          unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
          callsignCount: nextNetworkCallsigns.length,
          callsignCreateInFlightCallsigns: current.callsignCreateInFlightCallsigns.filter((item) => item !== normalizedCallsign),
          callsignWarning: null,
        };
      });
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignCreateInFlightCallsigns: current.callsignCreateInFlightCallsigns.filter((item) => item !== normalizedCallsign),
        callsignWarning: errorMessage,
      }));
      return;
    }
  }, [canManageCallsignActions, defaultNetworkUnitId, setState, state.callsignCreateInFlightCallsigns, state.network]);

  const toggleNetworkCallsignMainRadioStation = useCallback(async (networkCallsign: NetworkCallsignRowView) => {
    if (!canManageCallsignActions || !state.network) return;
    if (state.callsignUpdateInFlightIds.includes(networkCallsign.id)) return;

    const nextMainRadioStation = !networkCallsign.mainRadioStation;

    setState((current) => ({
      ...current,
      callsignWarning: null,
      callsignUpdateInFlightIds: [...current.callsignUpdateInFlightIds, networkCallsign.id],
    }));

    try {
      const updatedNetworkCallsign = await updateNetworkCallsign({
        id: networkCallsign.id,
        networkId: networkCallsign.networkId,
        callsign: networkCallsign.callsign,
        position: networkCallsign.position.trim() === '' ? null : networkCallsign.position.trim(),
        comment: networkCallsign.comment.trim() === '' ? null : networkCallsign.comment.trim(),
        sourceId: networkCallsign.sourceId,
        radioFreq: networkCallsign.radioFreq,
        unitId: networkCallsign.unitId,
        unitDeveloping: networkCallsign.unitDeveloping,
        developing: networkCallsign.developing,
        mainRadioStation: nextMainRadioStation,
        commandControl: networkCallsign.commandControl,
      });

      setState((current) => {
        const nextNetworkCallsigns = mergeNetworkCallsigns(current.networkCallsigns, [updatedNetworkCallsign]);
        const derived = buildNetworkCallsignTabData(current.networkCallsignGroups, current.callsignActivityMap, nextNetworkCallsigns);

        return {
          ...current,
          networkCallsigns: nextNetworkCallsigns,
          catalogCallsignGroups: derived.catalogCallsignGroups,
          unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
          callsignCount: nextNetworkCallsigns.length,
          callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter((item) => item !== networkCallsign.id),
          callsignWarning: null,
        };
      });
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter((item) => item !== networkCallsign.id),
        callsignWarning: errorMessage,
      }));
    }
  }, [canManageCallsignActions, setState, state.callsignUpdateInFlightIds, state.network]);

  const toggleNetworkCallsignCommandControl = useCallback(async (networkCallsign: NetworkCallsignRowView) => {
    if (!canManageCallsignActions || !state.network) return;
    if (state.callsignUpdateInFlightIds.includes(networkCallsign.id)) return;

    const nextCommandControl = !networkCallsign.commandControl;

    setState((current) => ({
      ...current,
      callsignWarning: null,
      callsignUpdateInFlightIds: [...current.callsignUpdateInFlightIds, networkCallsign.id],
    }));

    try {
      const updatedNetworkCallsign = await updateNetworkCallsign({
        id: networkCallsign.id,
        networkId: networkCallsign.networkId,
        callsign: networkCallsign.callsign,
        position: networkCallsign.position.trim() === '' ? null : networkCallsign.position.trim(),
        comment: networkCallsign.comment.trim() === '' ? null : networkCallsign.comment.trim(),
        sourceId: networkCallsign.sourceId,
        radioFreq: networkCallsign.radioFreq,
        unitId: networkCallsign.unitId,
        unitDeveloping: networkCallsign.unitDeveloping,
        developing: networkCallsign.developing,
        mainRadioStation: networkCallsign.mainRadioStation,
        commandControl: nextCommandControl,
      });

      setState((current) => {
        const nextNetworkCallsigns = mergeNetworkCallsigns(current.networkCallsigns, [updatedNetworkCallsign]);
        const derived = buildNetworkCallsignTabData(current.networkCallsignGroups, current.callsignActivityMap, nextNetworkCallsigns);

        return {
          ...current,
          networkCallsigns: nextNetworkCallsigns,
          catalogCallsignGroups: derived.catalogCallsignGroups,
          unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
          callsignCount: nextNetworkCallsigns.length,
          callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter((item) => item !== networkCallsign.id),
          callsignWarning: null,
        };
      });
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter((item) => item !== networkCallsign.id),
        callsignWarning: errorMessage,
      }));
    }
  }, [canManageCallsignActions, setState, state.callsignUpdateInFlightIds, state.network]);

  return {
    ...descriptionActions,
    ...frequencyActions,
    openMenu,
    closeMenu,
    openDeleteDialog,
    closeDeleteDialog,
    openEditDrawer,
    closeEditDrawer,
    saveNetworkEdit,
    handleDelete,
    handleCopyNetworkInfo,
    setEditForm,
    setCallsignSectionMode,
    setCallsignStatusFilter,
    toggleCallsignInterceptedExpanded,
    openCallsignDrawerForCreate,
    openCallsignDrawerForEdit,
    closeCallsignDrawer,
    setCallsignDrawerForm,
    saveCallsignDrawer,
    openCallsignDeleteDialog,
    closeCallsignDeleteDialog,
    deleteCallsign,
    addKnownCallsignsToNetwork: addKnownCallsigns,
    addInterceptedCallsignToNetwork,
    toggleNetworkCallsignMainRadioStation,
    toggleNetworkCallsignCommandControl,
    loadCallsigns: reloadCallsignsData,
  };
}
