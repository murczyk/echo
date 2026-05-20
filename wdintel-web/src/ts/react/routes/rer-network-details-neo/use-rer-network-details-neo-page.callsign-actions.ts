import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import { createNetworkCallsign, deleteNetworkCallsign, updateNetworkCallsign } from '../../services/api/callsigns';
import {
  formatErrorMessage,
  canManageNetworkCallsignActions,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import {
  createDefaultNetworkCallsignDrawerForm,
  createNetworkCallsignDrawerForm,
  type NetworkCallsignDrawerForm,
  type NetworkCallsignRowView,
  type NetworkCallsignSectionMode,
  type NetworkCallsignStatusFilter,
  normalizeCallsignDisplay,
  NetworkCallsignSourceId,
} from './network-callsigns';
import { buildNetworkCallsignWritePayload } from './use-rer-network-details-neo-page.callsign-write';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  defaultNetworkUnitId: number | null;
  loadCallsigns: (networkId: number) => Promise<void>;
};

export function useRerNetworkDetailsNeoPageCallsignActions({ state, setState, defaultNetworkUnitId, loadCallsigns }: Args) {
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);

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

    const payload = buildNetworkCallsignWritePayload({
      networkId: network.id,
      callsign,
      position: form.position,
      comment: form.comment,
      sourceId: form.sourceId,
      radioFreq: form.radioFreq,
      unitId: form.unitId,
      unitDeveloping: form.unitDeveloping,
      developing: form.developing,
      mainRadioStation: form.mainRadioStation,
      commandControl: form.commandControl,
    });
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

  return {
    loadCallsigns: reloadCallsignsData,
    reloadCallsignsData,
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
  };
}
