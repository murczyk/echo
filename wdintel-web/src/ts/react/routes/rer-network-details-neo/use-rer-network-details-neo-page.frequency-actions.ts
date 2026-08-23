import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type { AddNetworkFreqReq, Network, NetworkFreqsRes } from '../../../../Bindings';
import {
  addFreqToNetworkV2,
  deleteNetworkFreq,
  getNetworkFreqCallsigns,
  getNetworkFreqCallsignsBatch,
  getNetworkFreqsActivity,
  getSingleNetworkFreqs,
  updateNetworkFreqV2,
} from '../../services/api/networks';
import {
  formatErrorMessage,
  getFrequencyFormatError,
  parseNetworkDetailsDateInput,
  toNetworkFreqCreateWizardForm,
  toNetworkFreqEditForm,
  type NetworkFreqCallsignsStatus,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import { buildNetworkFreqActivityByFreq, sortNetworkFreqsByTableOrder } from './frequency-utils';
import type {
  NetworkFreqCreateWizardForm,
  NetworkFreqEditForm,
} from './use-rer-network-details-neo-page.shared';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  reloadGeneration: MutableRefObject<number>;
  currentNetworkIdRef: MutableRefObject<number | null>;
};

function resetFreqCreateWizardState(
  current: NetworkDetailsNeoPageState,
): NetworkDetailsNeoPageState {
  return {
    ...current,
    freqCreateWizardOpen: false,
    freqCreateWizardForm: toNetworkFreqCreateWizardForm(),
    freqCreateWizardSaving: false,
    freqCreateWizardError: null,
  };
}

function resetFreqEditDrawerState(current: NetworkDetailsNeoPageState): NetworkDetailsNeoPageState {
  return {
    ...current,
    freqEditDrawerOpen: false,
    freqEditDrawerForm: null,
    freqEditDrawerSaving: false,
    freqEditDrawerError: null,
  };
}

function toCreateNetworkFreqReq(
  freqForm: NetworkFreqCreateWizardForm,
  networkId: number,
): AddNetworkFreqReq {
  return {
    networkId,
    freqRec: {
      freq: freqForm.freq.trim(),
      modulation: freqForm.modulation,
      encryptionId: freqForm.encryptionId,
      encryptionKeyIds: [...freqForm.encryptionKeyIds],
      description: null,
      activeFrom: parseNetworkDetailsDateInput(freqForm.activeFrom),
      activeTo: parseNetworkDetailsDateInput(freqForm.activeTo),
    },
  };
}

function findNetworkFreq(
  state: NetworkDetailsNeoPageState,
  networkFreqId: number,
): NetworkFreqsRes | null {
  return state.freqs.find((freq) => freq.networkFreqId === networkFreqId) ?? null;
}

function upsertNetworkFreqRow(freqs: NetworkFreqsRes[], freq: NetworkFreqsRes): NetworkFreqsRes[] {
  return sortNetworkFreqsByTableOrder([
    ...freqs.filter((currentFreq) => currentFreq.networkFreqId !== freq.networkFreqId),
    freq,
  ]);
}

function applyNetworkFreqMutationResponse(
  state: NetworkDetailsNeoPageState,
  responseFreq: NetworkFreqsRes | null,
  mode: 'create' | 'edit',
): Pick<NetworkDetailsNeoPageState, 'freqs' | 'freqActivityByFreq' | 'freqCallsignsById'> | null {
  if (!responseFreq) {
    return null;
  }

  const freqs = upsertNetworkFreqRow(state.freqs, responseFreq);
  const existingCallsigns = state.freqCallsignsById.get(responseFreq.networkFreqId) ?? [];
  const nextCallsigns = responseFreq.callsigns ?? existingCallsigns;
  const freqCallsignsById = new Map([
    ...state.freqCallsignsById,
    [responseFreq.networkFreqId, nextCallsigns],
  ]);
  const freqActivityByFreq =
    mode === 'create'
      ? {
          ...state.freqActivityByFreq,
          [responseFreq.networkFreqId]: state.freqActivityByFreq[responseFreq.networkFreqId] ?? [],
        }
      : state.freqActivityByFreq;

  return {
    freqs,
    freqActivityByFreq,
    freqCallsignsById,
  };
}

function buildFreqCallsignsStatusPatch(
  status: NetworkFreqCallsignsStatus,
): Pick<NetworkDetailsNeoPageState, 'freqCallsignsById' | 'freqCallsignsStatus'> {
  return {
    freqCallsignsById: new Map(),
    freqCallsignsStatus: status,
  };
}

export function useRerNetworkDetailsNeoPageFrequencyActions({
  state,
  setState,
  reloadGeneration,
  currentNetworkIdRef,
}: Args) {
  const freqCallsignsBatchRequestIdRef = useRef(0);
  const freqCallsignsSingleRequestIdRef = useRef(0);
  const setActiveNetworkDetailsTab = useCallback(
    (activeNetworkDetailsTab: NetworkDetailsNeoPageState['activeNetworkDetailsTab']) => {
      setState((current) => ({
        ...current,
        activeNetworkDetailsTab,
        callsignSectionMode: 'network',
      }));
    },
    [setState],
  );

  const loadFrequencies = useCallback(
    async (networkIdArg?: number) => {
      const networkId = networkIdArg ?? currentNetworkIdRef.current;
      if (!networkId || state.freqsLoading) return;

      reloadGeneration.current += 1;
      const generation = reloadGeneration.current;
      const targetNetworkId = networkId;

      setState((current) => ({
        ...current,
        freqsLoading: true,
        freqsError: null,
        ...buildFreqCallsignsStatusPatch('loading'),
      }));

      const isCurrent = () =>
        reloadGeneration.current === generation && currentNetworkIdRef.current === targetNetworkId;

      try {
        const [freqsResponse, activityResponse] = await Promise.all([
          getSingleNetworkFreqs(networkId, false, false),
          getNetworkFreqsActivity(networkId),
        ]);

        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          freqs: sortNetworkFreqsByTableOrder(freqsResponse.freqs),
          freqActivityByFreq: buildNetworkFreqActivityByFreq(activityResponse, freqsResponse.freqs),
          freqsLoading: false,
          freqsLoaded: true,
          freqsError: null,
        }));

        void loadFreqCallsignsBatch(networkId, freqsResponse.freqs, generation);
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          freqsLoading: false,
          freqsLoaded: false,
          freqsError: formatErrorMessage(error),
          ...buildFreqCallsignsStatusPatch('error'),
        }));
      }
    },
    [currentNetworkIdRef, reloadGeneration, setState, state.freqsLoading],
  );

  const loadFreqCallsignsBatch = useCallback(
    async (networkId: number, freqs: NetworkFreqsRes[], generation: number) => {
      const requestId = ++freqCallsignsBatchRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        currentNetworkIdRef.current === networkId &&
        freqCallsignsBatchRequestIdRef.current === requestId;

      const networkFreqIds = freqs.map((freq) => freq.networkFreqId);

      if (networkFreqIds.length === 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          ...buildFreqCallsignsStatusPatch('success'),
        }));
        return;
      }

      setState((current) => ({
        ...current,
        ...buildFreqCallsignsStatusPatch('loading'),
      }));

      try {
        const callsignsById = await getNetworkFreqCallsignsBatch(networkFreqIds);
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          freqCallsignsById: new Map([...callsignsById, ...current.freqCallsignsById]),
          freqCallsignsStatus: 'success',
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          freqCallsignsStatus: 'error',
        }));
      }
    },
    [currentNetworkIdRef, reloadGeneration, setState],
  );

  const loadFreqCallsignsSingle = useCallback(
    async (networkId: number, networkFreqId: number, generation: number) => {
      const requestId = ++freqCallsignsSingleRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        currentNetworkIdRef.current === networkId &&
        freqCallsignsSingleRequestIdRef.current === requestId;

      try {
        const callsigns = await getNetworkFreqCallsigns(networkFreqId);
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          freqCallsignsById: new Map([...current.freqCallsignsById, [networkFreqId, callsigns]]),
        }));
      } catch (error) {
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          freqCallsignsById: new Map([...current.freqCallsignsById, [networkFreqId, []]]),
        }));
      }
    },
    [currentNetworkIdRef, reloadGeneration, setState],
  );

  const openFreqCreateWizard = useCallback(() => {
    setState((current) => ({
      ...current,
      freqCreateWizardOpen: true,
      freqCreateWizardForm: toNetworkFreqCreateWizardForm(),
      freqCreateWizardSaving: false,
      freqCreateWizardError: null,
    }));
  }, [setState]);

  const closeFreqCreateWizard = useCallback(() => {
    setState((current) => {
      if (current.freqCreateWizardSaving) return current;
      return resetFreqCreateWizardState(current);
    });
  }, [setState]);

  const setFreqCreateWizardForm = useCallback(
    (freqCreateWizardForm: NetworkFreqCreateWizardForm) => {
      setState((current) => ({ ...current, freqCreateWizardForm }));
    },
    [setState],
  );

  const openFreqEditDrawer = useCallback(
    (freq: NetworkFreqsRes) => {
      setState((current) => ({
        ...current,
        freqEditDrawerOpen: true,
        freqEditDrawerForm: toNetworkFreqEditForm(freq),
        freqEditDrawerSaving: false,
        freqEditDrawerError: null,
        freqRowActionMenuAnchorEl: null,
        freqRowActionTargetId: null,
      }));
    },
    [setState],
  );

  const closeFreqEditDrawer = useCallback(() => {
    setState((current) => {
      if (current.freqEditDrawerSaving) return current;
      return resetFreqEditDrawerState(current);
    });
  }, [setState]);

  const setFreqEditDrawerForm = useCallback(
    (freqEditDrawerForm: NetworkFreqEditForm | null) => {
      setState((current) => ({ ...current, freqEditDrawerForm }));
    },
    [setState],
  );

  const openFreqRowActions = useCallback(
    (anchorEl: HTMLElement, freqId: number) => {
      setState((current) => ({
        ...current,
        freqRowActionMenuAnchorEl: anchorEl,
        freqRowActionTargetId: freqId,
      }));
    },
    [setState],
  );

  const closeFreqRowActions = useCallback(() => {
    setState((current) => ({
      ...current,
      freqRowActionMenuAnchorEl: null,
      freqRowActionTargetId: null,
    }));
  }, [setState]);

  const openDeleteFreqDialog = useCallback(
    (freq: NetworkFreqsRes) => {
      setState((current) => ({
        ...current,
        freqRowActionMenuAnchorEl: null,
        freqRowActionTargetId: null,
        freqDeleteDialogOpen: true,
        freqDeleteTarget: freq,
        freqDeleteSubmitting: false,
        freqDeleteError: null,
      }));
    },
    [setState],
  );

  const closeDeleteFreqDialog = useCallback(() => {
    setState((current) => {
      if (current.freqDeleteSubmitting) return current;
      return {
        ...current,
        freqDeleteDialogOpen: false,
        freqDeleteTarget: null,
        freqDeleteSubmitting: false,
        freqDeleteError: null,
      };
    });
  }, [setState]);

  const toggleFrequencyGroupExpanded = useCallback(
    (groupId: string) => {
      setState((current) => {
        const isExpanded = current.expandedFrequencyGroupIds.includes(groupId);
        return {
          ...current,
          expandedFrequencyGroupIds: isExpanded
            ? current.expandedFrequencyGroupIds.filter((id) => id !== groupId)
            : [...current.expandedFrequencyGroupIds, groupId],
        };
      });
    },
    [setState],
  );

  const saveFreqCreateWizard = useCallback(async () => {
    const network = state.network;
    const form = state.freqCreateWizardForm;

    if (!network || state.freqCreateWizardSaving) return;
    const generation = reloadGeneration.current;
    const targetNetworkId = network.id;

    const freqError = getFrequencyFormatError(form.freq);
    if (freqError !== null) {
      setState((current) => ({
        ...current,
        freqCreateWizardError: freqError,
      }));
      return;
    }

    setState((current) => ({
      ...current,
      freqCreateWizardSaving: true,
      freqCreateWizardError: null,
    }));

    try {
      const response = await addFreqToNetworkV2(toCreateNetworkFreqReq(form, network.id));
      if (currentNetworkIdRef.current !== targetNetworkId) {
        return;
      }

      setState((current) => {
        const updatedState = applyNetworkFreqMutationResponse(current, response.freq, 'create');
        if (!updatedState) {
          return {
            ...current,
            ...resetFreqCreateWizardState(current),
            network: response.network,
          };
        }

        return {
          ...current,
          ...resetFreqCreateWizardState(current),
          network: response.network,
          freqs: updatedState?.freqs ?? current.freqs,
          freqActivityByFreq: updatedState?.freqActivityByFreq ?? current.freqActivityByFreq,
          freqCallsignsById: updatedState?.freqCallsignsById ?? current.freqCallsignsById,
          freqsLoaded: true,
        };
      });

      if (response.freq) {
        void loadFreqCallsignsSingle(targetNetworkId, response.freq.networkFreqId, generation);
      } else {
        await loadFrequencies(targetNetworkId);
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        freqCreateWizardSaving: false,
        freqCreateWizardError: formatErrorMessage(error),
      }));
    }
  }, [
    currentNetworkIdRef,
    loadFreqCallsignsSingle,
    loadFrequencies,
    reloadGeneration,
    state.freqCreateWizardSaving,
    state.freqCreateWizardForm,
    state.network,
    setState,
  ]);

  const saveFreqEditDrawer = useCallback(async () => {
    const network = state.network;
    const form = state.freqEditDrawerForm;

    if (!network || !form || state.freqEditDrawerSaving) return;
    const generation = reloadGeneration.current;
    const targetNetworkId = network.id;

    const currentFreq = findNetworkFreq(state, form.networkFreqId);
    if (!currentFreq) {
      setState((current) => ({
        ...current,
        freqEditDrawerSaving: false,
        freqEditDrawerError: 'Не вдалося знайти частоту для редагування',
      }));
      return;
    }

    setState((current) => ({
      ...current,
      freqEditDrawerSaving: true,
      freqEditDrawerError: null,
    }));

    try {
      const response = await updateNetworkFreqV2({
        networkId: network.id,
        networkFreqId: currentFreq.networkFreqId,
        freq: currentFreq.freq,
        modulation: form.modulation,
        encryptionId: form.encryptionId,
        encryptionKeyIds: [...form.encryptionKeyIds],
        activeFrom: parseNetworkDetailsDateInput(form.activeFrom) ?? currentFreq.activeFrom,
        activeTo: parseNetworkDetailsDateInput(form.activeTo),
      });
      if (currentNetworkIdRef.current !== targetNetworkId) {
        return;
      }

      setState((current) => {
        const updatedState = applyNetworkFreqMutationResponse(current, response.freq, 'edit');
        if (!updatedState) {
          return {
            ...current,
            ...resetFreqEditDrawerState(current),
            network: response.network,
          };
        }

        return {
          ...current,
          ...resetFreqEditDrawerState(current),
          network: response.network,
          freqs: updatedState?.freqs ?? current.freqs,
          freqActivityByFreq: updatedState?.freqActivityByFreq ?? current.freqActivityByFreq,
          freqCallsignsById: updatedState?.freqCallsignsById ?? current.freqCallsignsById,
          freqsLoaded: true,
        };
      });

      if (response.freq) {
        void loadFreqCallsignsSingle(targetNetworkId, response.freq.networkFreqId, generation);
      } else {
        await loadFrequencies(targetNetworkId);
      }
    } catch (error) {
      setState((current) => ({
        ...current,
        freqEditDrawerSaving: false,
        freqEditDrawerError: formatErrorMessage(error),
      }));
    }
  }, [
    currentNetworkIdRef,
    loadFreqCallsignsSingle,
    loadFrequencies,
    reloadGeneration,
    state.freqEditDrawerForm,
    state.freqEditDrawerSaving,
    state.freqs,
    state.network,
    setState,
  ]);

  const deleteFreq = useCallback(async () => {
    const network = state.network;
    const target = state.freqDeleteTarget;

    if (!network || !target || state.freqDeleteSubmitting) return;

    setState((current) => ({
      ...current,
      freqDeleteSubmitting: true,
      freqDeleteError: null,
    }));

    try {
      const updatedNetwork = await deleteNetworkFreq({
        id: target.networkFreqId,
        networkId: network.id,
        freq: target.freq,
      });

      setState((current) => ({
        ...current,
        network: updatedNetwork,
        freqDeleteDialogOpen: false,
        freqDeleteTarget: null,
        freqDeleteSubmitting: false,
        freqDeleteError: null,
      }));
      await loadFrequencies(network.id);
    } catch (error) {
      setState((current) => ({
        ...current,
        freqDeleteSubmitting: false,
        freqDeleteError: formatErrorMessage(error),
      }));
    }
  }, [
    loadFrequencies,
    state.freqDeleteSubmitting,
    state.freqDeleteTarget,
    state.network,
    setState,
  ]);

  return {
    setActiveNetworkDetailsTab,
    loadFrequencies,
    openFreqCreateWizard,
    closeFreqCreateWizard,
    setFreqCreateWizardForm,
    openFreqEditDrawer,
    closeFreqEditDrawer,
    setFreqEditDrawerForm,
    openFreqRowActions,
    closeFreqRowActions,
    openDeleteFreqDialog,
    closeDeleteFreqDialog,
    toggleFrequencyGroupExpanded,
    saveFreqCreateWizard,
    saveFreqEditDrawer,
    deleteFreq,
  };
}
