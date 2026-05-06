import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Network } from '../../../../Bindings';
import {
  addNetworkDescriptions,
  deleteNetwork,
  deleteNetworkDescription,
  updateNetwork,
  updateNetworkDescription,
  updateNetworkPosts,
  updateNetworkUnits,
} from '../../services/api/networks';
import { navigateWithinSpa } from '../../utils/browser';
import {
  formatClassicNetworkHeaderName,
  formatErrorMessage,
  toNetworkDescriptionForm,
  toNetworkEditForm,
  type NetworkDescriptionForm,
  type NetworkDetailsNeoPageState,
  type NetworkEditForm,
} from './use-rer-network-details-neo-page.shared';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  unitNames: string[];
};

function resolveNetworkDescriptionFrequency(network: Network, networkFreqId: number | null) {
  if (networkFreqId === null) {
    return null;
  }

  return network.freqs.find((freq) => freq.id === networkFreqId) ?? null;
}

function syncNetworkRelations(editForm: NetworkEditForm) {
  return Promise.all([
    updateNetworkPosts({
      networkId: editForm.id,
      postIds: [...editForm.postIds],
    }),
    updateNetworkUnits({
      networkId: editForm.id,
      unitIds: [...editForm.unitIds],
    }),
  ]);
}

export function useRerNetworkDetailsNeoPageActions({ state, setState, unitNames }: Args) {
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

  const toggleDescriptionExpanded = useCallback((descriptionId: number) => {
    setState((current) => {
      const isExpanded = current.expandedDescriptionIds.includes(descriptionId);
      return {
        ...current,
        expandedDescriptionIds: isExpanded
          ? current.expandedDescriptionIds.filter((id) => id !== descriptionId)
          : [...current.expandedDescriptionIds, descriptionId],
      };
    });
  }, [setState]);

  const openDescriptionDrawerForCreate = useCallback(() => {
    setState((current) => ({
      ...current,
      descriptionDrawerOpen: true,
      descriptionDrawerMode: 'create',
      descriptionDrawerDescriptionId: null,
      descriptionDrawerForm: toNetworkDescriptionForm('', null),
      descriptionDrawerSaving: false,
      descriptionDrawerError: null,
    }));
  }, [setState]);

  const openDescriptionDrawerForEdit = useCallback((description: Network['descriptions'][number]) => {
    setState((current) => ({
      ...current,
      descriptionDrawerOpen: true,
      descriptionDrawerMode: 'edit',
      descriptionDrawerDescriptionId: description.id,
      descriptionDrawerForm: toNetworkDescriptionForm(description.description, description.networkFrequencyId ?? null),
      descriptionDrawerSaving: false,
      descriptionDrawerError: null,
    }));
  }, [setState]);

  const closeDescriptionDrawer = useCallback(() => {
    setState((current) => {
      if (current.descriptionDrawerSaving) return current;
      return {
        ...current,
        descriptionDrawerOpen: false,
        descriptionDrawerMode: 'create',
        descriptionDrawerDescriptionId: null,
        descriptionDrawerForm: toNetworkDescriptionForm('', null),
        descriptionDrawerSaving: false,
        descriptionDrawerError: null,
      };
    });
  }, [setState]);

  const setDescriptionDrawerForm = useCallback((descriptionDrawerForm: NetworkDescriptionForm) => {
    setState((current) => ({ ...current, descriptionDrawerForm }));
  }, [setState]);

  const openDeleteDescriptionDialog = useCallback((description: Network['descriptions'][number]) => {
    setState((current) => ({
      ...current,
      deleteDescriptionDialogOpen: true,
      deleteDescriptionTarget: description,
      deleteDescriptionSubmitting: false,
      deleteDescriptionError: null,
    }));
  }, [setState]);

  const closeDeleteDescriptionDialog = useCallback(() => {
    setState((current) => {
      if (current.deleteDescriptionSubmitting) return current;
      return {
        ...current,
        deleteDescriptionDialogOpen: false,
        deleteDescriptionTarget: null,
        deleteDescriptionSubmitting: false,
        deleteDescriptionError: null,
      };
    });
  }, [setState]);

  const saveDescription = useCallback(async () => {
    const network = state.network;
    const form = state.descriptionDrawerForm;
    const descriptionId = state.descriptionDrawerDescriptionId;

    if (!network || state.descriptionDrawerSaving) return;

    const description = form.description.trim();
    if (description === '') {
      setState((current) => ({
        ...current,
        descriptionDrawerError: 'Обґрунтування не може бути порожнім',
      }));
      return;
    }

    const selectedFreq = resolveNetworkDescriptionFrequency(network, form.networkFreqId);
    if (state.descriptionDrawerMode === 'create' && form.networkFreqId !== null && !selectedFreq) {
      setState((current) => ({
        ...current,
        descriptionDrawerError: 'Не вдалося знайти вибрану частоту',
      }));
      return;
    }

    setState((current) => ({
      ...current,
      descriptionDrawerSaving: true,
      descriptionDrawerError: null,
    }));

    try {
      let updatedNetwork: Network;

      if (state.descriptionDrawerMode === 'create') {
        updatedNetwork = await addNetworkDescriptions({
          networkId: network.id,
          networkDescriptions:
            selectedFreq === null
              ? [
                  {
                    descrType: 'Confirmation',
                    description,
                  },
                ]
              : [],
          frequencyDescriptions:
            selectedFreq === null
              ? []
              : [
                  {
                    descrType: 'Confirmation',
                    description,
                    freq: selectedFreq.freq,
                  },
                ],
        });
      } else {
        if (descriptionId === null) {
          setState((current) => ({
            ...current,
            descriptionDrawerSaving: false,
            descriptionDrawerError: 'Не вдалося знайти опис для редагування',
          }));
          return;
        }

        updatedNetwork = await updateNetworkDescription({
          networkId: network.id,
          descriptionId,
          descrType: 'Confirmation',
          description,
          networkFreqId: form.networkFreqId,
        });
      }

      setState((current) => ({
        ...current,
        network: updatedNetwork,
        descriptionDrawerOpen: false,
        descriptionDrawerMode: 'create',
        descriptionDrawerDescriptionId: null,
        descriptionDrawerForm: toNetworkDescriptionForm('', null),
        descriptionDrawerSaving: false,
        descriptionDrawerError: null,
        expandedDescriptionIds: current.expandedDescriptionIds.filter((descriptionId) =>
          updatedNetwork.descriptions.some((description) => description.id === descriptionId),
        ),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        descriptionDrawerSaving: false,
        descriptionDrawerError: formatErrorMessage(error),
      }));
    }
  }, [state.descriptionDrawerDescriptionId, state.descriptionDrawerForm, state.descriptionDrawerMode, state.descriptionDrawerSaving, state.network, setState]);

  const deleteDescription = useCallback(async () => {
    const network = state.network;
    const target = state.deleteDescriptionTarget;

    if (!network || !target || state.deleteDescriptionSubmitting) return;

    setState((current) => ({
      ...current,
      deleteDescriptionSubmitting: true,
      deleteDescriptionError: null,
    }));

    try {
      const updatedNetwork = await deleteNetworkDescription({
        networkId: network.id,
        descriptionId: target.id,
      });

      setState((current) => ({
        ...current,
        network: updatedNetwork,
        deleteDescriptionDialogOpen: false,
        deleteDescriptionTarget: null,
        deleteDescriptionSubmitting: false,
        deleteDescriptionError: null,
        expandedDescriptionIds: current.expandedDescriptionIds.filter((descriptionId) =>
          updatedNetwork.descriptions.some((description) => description.id === descriptionId),
        ),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        deleteDescriptionSubmitting: false,
        deleteDescriptionError: formatErrorMessage(error),
      }));
    }
  }, [state.deleteDescriptionSubmitting, state.deleteDescriptionTarget, state.network, setState]);

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

  return {
    openMenu,
    closeMenu,
    openDeleteDialog,
    closeDeleteDialog,
    openEditDrawer,
    closeEditDrawer,
    toggleDescriptionExpanded,
    openDescriptionDrawerForCreate,
    openDescriptionDrawerForEdit,
    closeDescriptionDrawer,
    setDescriptionDrawerForm,
    saveDescription,
    openDeleteDescriptionDialog,
    closeDeleteDescriptionDialog,
    deleteDescription,
    setEditForm,
    saveNetworkEdit,
    handleDelete,
    handleCopyNetworkInfo,
  };
}
