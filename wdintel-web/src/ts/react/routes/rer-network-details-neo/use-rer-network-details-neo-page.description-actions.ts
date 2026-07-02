import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Network } from '../../../../Bindings';
import {
  addNetworkDescriptions,
  deleteNetworkDescription,
  updateNetworkDescription,
} from '../../services/api/networks';
import {
  formatErrorMessage,
  toNetworkDescriptionForm,
  type NetworkDescriptionForm,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
};

function resolveNetworkDescriptionFrequency(network: Network, networkFreqId: number | null) {
  if (networkFreqId === null) {
    return null;
  }

  return network.freqs.find((freq) => freq.id === networkFreqId) ?? null;
}

function getDescriptionValidationError(): string {
  return 'Матеріали радіоперехоплення не можуть бути порожніми';
}

function resetDescriptionDrawerState(
  current: NetworkDetailsNeoPageState,
  extra: Partial<
    Pick<NetworkDetailsNeoPageState, 'descriptionDrawerDescrType' | 'descriptionDrawerMode'>
  > = {},
): NetworkDetailsNeoPageState {
  return {
    ...current,
    descriptionDrawerOpen: false,
    descriptionDrawerMode: extra.descriptionDrawerMode ?? 'create',
    descriptionDrawerDescrType: extra.descriptionDrawerDescrType ?? 'Confirmation',
    descriptionDrawerDescriptionId: null,
    descriptionDrawerForm: toNetworkDescriptionForm('', '', null),
    descriptionDrawerSaving: false,
    descriptionDrawerError: null,
  };
}

export function useRerNetworkDetailsNeoPageDescriptionActions({ state, setState }: Args) {
  const toggleDescriptionExpanded = useCallback(
    (descriptionId: number) => {
      setState((current) => {
        const isExpanded = current.expandedDescriptionIds.includes(descriptionId);
        return {
          ...current,
          expandedDescriptionIds: isExpanded
            ? current.expandedDescriptionIds.filter((id) => id !== descriptionId)
            : [...current.expandedDescriptionIds, descriptionId],
        };
      });
    },
    [setState],
  );

  const openDescriptionDrawerForCreate = useCallback(
    (descrType: NetworkDetailsNeoPageState['descriptionDrawerDescrType']) => {
      setState((current) => ({
        ...current,
        descriptionDrawerOpen: true,
        descriptionDrawerMode: 'create',
        descriptionDrawerDescrType: descrType,
        descriptionDrawerDescriptionId: null,
        descriptionDrawerForm: toNetworkDescriptionForm('', '', null),
        descriptionDrawerSaving: false,
        descriptionDrawerError: null,
      }));
    },
    [setState],
  );

  const openDescriptionDrawerForEdit = useCallback(
    (description: Network['descriptions'][number]) => {
      setState((current) => ({
        ...current,
        descriptionDrawerOpen: true,
        descriptionDrawerMode: 'edit',
        descriptionDrawerDescrType: description.descrType,
        descriptionDrawerDescriptionId: description.id,
        descriptionDrawerForm: toNetworkDescriptionForm(
          description.topic ?? '',
          description.description,
          description.networkFrequencyId ?? null,
        ),
        descriptionDrawerSaving: false,
        descriptionDrawerError: null,
      }));
    },
    [setState],
  );

  const closeDescriptionDrawer = useCallback(() => {
    setState((current) => {
      if (current.descriptionDrawerSaving) return current;
      return resetDescriptionDrawerState(current);
    });
  }, [setState]);

  const setDescriptionDrawerForm = useCallback(
    (descriptionDrawerForm: NetworkDescriptionForm) => {
      setState((current) => ({ ...current, descriptionDrawerForm }));
    },
    [setState],
  );

  const openDeleteDescriptionDialog = useCallback(
    (description: Network['descriptions'][number]) => {
      setState((current) => ({
        ...current,
        deleteDescriptionDialogOpen: true,
        deleteDescriptionTarget: description,
        deleteDescriptionSubmitting: false,
        deleteDescriptionError: null,
      }));
    },
    [setState],
  );

  const closeDeleteDescriptionDialog = useCallback(() => {
    setState((current) => {
      if (current.deleteDescriptionSubmitting) return current;
      return {
        ...current,
        deleteDescriptionDialogOpen: false,
      };
    });
  }, [setState]);

  const resetDeleteDescriptionDialog = useCallback(() => {
    setState((current) => ({
      ...current,
      deleteDescriptionTarget: null,
      deleteDescriptionSubmitting: false,
      deleteDescriptionError: null,
    }));
  }, [setState]);

  const saveDescription = useCallback(async () => {
    const network = state.network;
    const form = state.descriptionDrawerForm;
    const descriptionId = state.descriptionDrawerDescriptionId;
    const descrType = state.descriptionDrawerDescrType;
    if (!network || state.descriptionDrawerSaving) return;

    const topic = form.topic.trim();
    const description = form.description.trim();
    if (description === '') {
      setState((current) => ({
        ...current,
        descriptionDrawerError: getDescriptionValidationError(),
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
                    descrType,
                    topic: topic === '' ? null : topic,
                    description,
                  },
                ]
              : [],
          frequencyDescriptions:
            selectedFreq === null
              ? []
              : [
                  {
                    descrType,
                    topic: topic === '' ? null : topic,
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
          descrType,
          topic: topic === '' ? null : topic,
          description,
          networkFreqId: form.networkFreqId,
        });
      }

      setState((current) => ({
        ...current,
        ...resetDescriptionDrawerState(current),
        network: updatedNetwork,
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
  }, [
    state.descriptionDrawerDescrType,
    state.descriptionDrawerDescriptionId,
    state.descriptionDrawerForm,
    state.descriptionDrawerMode,
    state.descriptionDrawerSaving,
    state.network,
    setState,
  ]);

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

  return {
    toggleDescriptionExpanded,
    openDescriptionDrawerForCreate,
    openDescriptionDrawerForEdit,
    closeDescriptionDrawer,
    setDescriptionDrawerForm,
    openDeleteDescriptionDialog,
    closeDeleteDescriptionDialog,
    resetDeleteDescriptionDialog,
    saveDescription,
    deleteDescription,
  };
}
