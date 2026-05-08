import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { AddNetworkFreqReq, Network, NetworkFreqsRes } from '../../../../Bindings';
import {
  addFreqToNetwork,
  deleteNetworkFreq,
  getNetworkFreqsActivity,
  getSingleNetworkFreqs,
  updateNetworkFreq,
} from '../../services/api/networks';
import {
  formatErrorMessage,
  getFrequencyFormatError,
  parseNetworkDetailsDateInput,
  toNetworkFreqCreateWizardForm,
  toNetworkFreqEditForm,
  toNetworkFreqTechDataForm,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import { buildNetworkFreqActivityByFreq } from './frequency-utils';
import type { NetworkFreqCreateWizardForm, NetworkFreqEditForm, NetworkFreqTechDataForm } from './use-rer-network-details-neo-page.shared';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
};

function resetFreqCreateWizardState(current: NetworkDetailsNeoPageState): NetworkDetailsNeoPageState {
  return {
    ...current,
    freqCreateWizardOpen: false,
    freqCreateWizardStep: 1,
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

function resetFreqTechDrawerState(current: NetworkDetailsNeoPageState): NetworkDetailsNeoPageState {
  return {
    ...current,
    freqTechDrawerOpen: false,
    freqTechDrawerForm: null,
    freqTechDrawerSaving: false,
    freqTechDrawerError: null,
  };
}

function toCreateNetworkFreqReq(freqForm: NetworkFreqCreateWizardForm, networkId: number): AddNetworkFreqReq {
  return {
    networkId,
    freqRec: {
      freq: freqForm.freq.trim(),
      kind: freqForm.kind === 'DMR' ? 'DMR' : 'VHF',
      modulationId: freqForm.modulationId,
      encryptionKeyIds: [...freqForm.encryptionKeyIds],
      description:
        freqForm.description.trim() === ''
          ? null
          : {
              descrType: 'Confirmation',
              description: freqForm.description.trim(),
              freq: freqForm.freq.trim(),
            },
      activeFrom: parseNetworkDetailsDateInput(freqForm.activeFrom),
      activeTo: parseNetworkDetailsDateInput(freqForm.activeTo),
    },
  };
}

function toBackendNetworkFreqKind(kind: NetworkFreqEditForm['kind']): string {
  return kind === 'DMR' ? 'DMR' : 'VHF';
}

function findNetworkFreq(state: NetworkDetailsNeoPageState, networkFreqId: number): NetworkFreqsRes | null {
  return state.freqs.find((freq) => freq.networkFreqId === networkFreqId) ?? null;
}

function buildCreatedFreqLabel(key: { id: number | null; key?: string | null; description?: string | null }): string {
  const parts = [key.description?.trim(), key.key?.trim()].filter((value) => value && value !== '');
  if (parts.length === 0) {
    return `#${key.id ?? '—'}`;
  }

  return parts.join(' • ');
}

function buildCreatedFreq(
  currentFreqs: NetworkFreqsRes[],
  updatedNetwork: Network,
  form: NetworkFreqCreateWizardForm,
  modulationsById: Map<number, string>,
): NetworkFreqsRes | null {
  const currentFreqIds = new Set(currentFreqs.map((freq) => freq.networkFreqId));
  const createdFreq = updatedNetwork.freqs.find((freq) => !currentFreqIds.has(freq.id)) ?? null;
  if (!createdFreq) return null;

  return {
    networkFreqId: createdFreq.id,
    freq: createdFreq.freq,
    modulationId: createdFreq.modulationId,
    modulation: createdFreq.modulationId === null ? null : modulationsById.get(createdFreq.modulationId) ?? null,
    encryptionKeyIds: [...form.encryptionKeyIds],
    encryptionKeys: createdFreq.encryptionKeys.map((key) => buildCreatedFreqLabel(key)),
    messageCount: 0,
    callsigns: [],
    lastDatetime: null,
    lastDatetimeInAor: null,
    createdAt: createdFreq.createdAt,
    isActive: createdFreq.activeTo === null,
    activeFrom: createdFreq.activeFrom,
    activeTo: createdFreq.activeTo,
    kind: createdFreq.kind === 'DMR' ? 'DMR' : 'VHF',
  };
}

function syncUpdatedFreqs(
  currentFreqs: NetworkFreqsRes[],
  updatedNetwork: Network,
  modulationsById: Map<number, string>,
): NetworkFreqsRes[] {
  const updatedFreqsById = new Map(updatedNetwork.freqs.map((freq) => [freq.id, freq]));

  return currentFreqs.map((freq) => {
    const updatedFreq = updatedFreqsById.get(freq.networkFreqId);
    if (!updatedFreq) return freq;

    return {
      ...freq,
      freq: updatedFreq.freq,
      modulationId: updatedFreq.modulationId,
      modulation: updatedFreq.modulationId === null ? null : modulationsById.get(updatedFreq.modulationId) ?? null,
      encryptionKeyIds: updatedFreq.encryptionKeys.flatMap((key) => (key.id === null ? [] : [key.id])),
      encryptionKeys: updatedFreq.encryptionKeys.map((key) => buildCreatedFreqLabel(key)),
      activeFrom: updatedFreq.activeFrom,
      activeTo: updatedFreq.activeTo,
      createdAt: updatedFreq.createdAt,
      kind: updatedFreq.kind === 'DMR' ? 'DMR' : 'VHF',
      isActive: updatedFreq.activeTo === null,
    };
  });
}

export function useRerNetworkDetailsNeoPageFrequencyActions({ state, setState }: Args) {
  const setActiveNetworkDetailsTab = useCallback((activeNetworkDetailsTab: NetworkDetailsNeoPageState['activeNetworkDetailsTab']) => {
    setState((current) => ({ ...current, activeNetworkDetailsTab }));
  }, [setState]);

  const loadFrequencies = useCallback(async (networkIdArg?: number) => {
    const networkId = networkIdArg ?? state.network?.id;
    if (!networkId || state.freqsLoading) return;

    setState((current) => ({
      ...current,
      freqsLoading: true,
      freqsError: null,
    }));

    try {
      const [freqsResponse, activityResponse] = await Promise.all([
        getSingleNetworkFreqs(networkId, true),
        getNetworkFreqsActivity(networkId),
      ]);

      setState((current) => ({
        ...current,
        freqs: freqsResponse.freqs,
        freqActivityByFreq: buildNetworkFreqActivityByFreq(activityResponse, freqsResponse.freqs),
        freqsLoading: false,
        freqsLoaded: true,
        freqsError: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        freqsLoading: false,
        freqsLoaded: false,
        freqsError: formatErrorMessage(error),
      }));
    }
  }, [setState, state.freqsLoading, state.network?.id]);

  const openFreqCreateWizard = useCallback(() => {
    setState((current) => ({
      ...current,
      freqCreateWizardOpen: true,
      freqCreateWizardStep: 1,
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

  const setFreqCreateWizardForm = useCallback((freqCreateWizardForm: NetworkFreqCreateWizardForm) => {
    setState((current) => ({ ...current, freqCreateWizardForm }));
  }, [setState]);

  const setFreqCreateWizardStep = useCallback((freqCreateWizardStep: 1 | 2) => {
    setState((current) => ({ ...current, freqCreateWizardStep }));
  }, [setState]);

  const openFreqEditDrawer = useCallback((freq: NetworkFreqsRes) => {
    setState((current) => ({
      ...current,
      freqEditDrawerOpen: true,
      freqEditDrawerForm: toNetworkFreqEditForm(freq),
      freqEditDrawerSaving: false,
      freqEditDrawerError: null,
      freqRowActionMenuAnchorEl: null,
      freqRowActionTargetId: null,
    }));
  }, [setState]);

  const closeFreqEditDrawer = useCallback(() => {
    setState((current) => {
      if (current.freqEditDrawerSaving) return current;
      return resetFreqEditDrawerState(current);
    });
  }, [setState]);

  const setFreqEditDrawerForm = useCallback((freqEditDrawerForm: NetworkFreqEditForm | null) => {
    setState((current) => ({ ...current, freqEditDrawerForm }));
  }, [setState]);

  const openFreqTechDrawer = useCallback((freq: NetworkFreqsRes) => {
    setState((current) => ({
      ...current,
      freqTechDrawerOpen: true,
      freqTechDrawerForm: toNetworkFreqTechDataForm(freq),
      freqTechDrawerSaving: false,
      freqTechDrawerError: null,
      freqRowActionMenuAnchorEl: null,
      freqRowActionTargetId: null,
    }));
  }, [setState]);

  const closeFreqTechDrawer = useCallback(() => {
    setState((current) => {
      if (current.freqTechDrawerSaving) return current;
      return resetFreqTechDrawerState(current);
    });
  }, [setState]);

  const setFreqTechDrawerForm = useCallback((freqTechDrawerForm: NetworkFreqTechDataForm | null) => {
    setState((current) => ({ ...current, freqTechDrawerForm }));
  }, [setState]);

  const openFreqRowActions = useCallback((anchorEl: HTMLElement, freqId: number) => {
    setState((current) => ({
      ...current,
      freqRowActionMenuAnchorEl: anchorEl,
      freqRowActionTargetId: freqId,
    }));
  }, [setState]);

  const closeFreqRowActions = useCallback(() => {
    setState((current) => ({
      ...current,
      freqRowActionMenuAnchorEl: null,
      freqRowActionTargetId: null,
    }));
  }, [setState]);

  const openDeleteFreqDialog = useCallback((freq: NetworkFreqsRes) => {
    setState((current) => ({
      ...current,
      freqRowActionMenuAnchorEl: null,
      freqRowActionTargetId: null,
      freqDeleteDialogOpen: true,
      freqDeleteTarget: freq,
      freqDeleteSubmitting: false,
      freqDeleteError: null,
    }));
  }, [setState]);

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

  const toggleFrequencyGroupExpanded = useCallback((groupId: string) => {
    setState((current) => {
      const isExpanded = current.expandedFrequencyGroupIds.includes(groupId);
      return {
        ...current,
        expandedFrequencyGroupIds: isExpanded
          ? current.expandedFrequencyGroupIds.filter((id) => id !== groupId)
          : [...current.expandedFrequencyGroupIds, groupId],
      };
    });
  }, [setState]);

  const saveFreqCreateWizard = useCallback(async () => {
    const network = state.network;
    const form = state.freqCreateWizardForm;

    if (!network || state.freqCreateWizardSaving) return;

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
      const updatedNetwork = await addFreqToNetwork(toCreateNetworkFreqReq(form, network.id));
      const modulationsById = new Map(state.modulations.map((modulation) => [modulation.id, modulation.name]));
      const createdFreq = buildCreatedFreq(state.freqs, updatedNetwork, form, modulationsById);
      setState((current) => ({
        ...current,
        ...resetFreqCreateWizardState(current),
        network: updatedNetwork,
        freqs: createdFreq ? [...current.freqs, createdFreq] : current.freqs,
        freqActivityByFreq: createdFreq
          ? {
              ...current.freqActivityByFreq,
              [createdFreq.networkFreqId]: [],
            }
          : current.freqActivityByFreq,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        freqCreateWizardSaving: false,
        freqCreateWizardError: formatErrorMessage(error),
      }));
    }
  }, [loadFrequencies, state.freqCreateWizardSaving, state.freqCreateWizardForm, state.network, setState]);

  const saveFreqEditDrawer = useCallback(async () => {
    const network = state.network;
    const form = state.freqEditDrawerForm;

    if (!network || !form || state.freqEditDrawerSaving) return;

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
      const updatedNetwork = await updateNetworkFreq({
        networkId: network.id,
        freq: currentFreq.freq,
        kind: toBackendNetworkFreqKind(form.kind),
        modulationId: form.modulationId,
        encryptionKeyIds: [...currentFreq.encryptionKeyIds],
        activeFrom: parseNetworkDetailsDateInput(form.activeFrom) ?? currentFreq.activeFrom,
        activeTo: parseNetworkDetailsDateInput(form.activeTo),
      });

      setState((current) => ({
        ...current,
        ...resetFreqEditDrawerState(current),
        network: updatedNetwork,
        freqs: syncUpdatedFreqs(
          current.freqs,
          updatedNetwork,
          new Map(current.modulations.map((modulation) => [modulation.id, modulation.name])),
        ),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        freqEditDrawerSaving: false,
        freqEditDrawerError: formatErrorMessage(error),
      }));
    }
  }, [state.freqEditDrawerForm, state.freqEditDrawerSaving, state.freqs, state.network, setState]);

  const saveFreqTechDrawer = useCallback(async () => {
    const network = state.network;
    const form = state.freqTechDrawerForm;

    if (!network || !form || state.freqTechDrawerSaving) return;

    const currentFreq = findNetworkFreq(state, form.networkFreqId);
    if (!currentFreq) {
      setState((current) => ({
        ...current,
        freqTechDrawerSaving: false,
        freqTechDrawerError: 'Не вдалося знайти частоту для редагування',
      }));
      return;
    }

    setState((current) => ({
      ...current,
      freqTechDrawerSaving: true,
      freqTechDrawerError: null,
    }));

    try {
      const updatedNetwork = await updateNetworkFreq({
        networkId: network.id,
        freq: currentFreq.freq,
        kind: currentFreq.kind ?? 'VHF',
        modulationId: currentFreq.modulationId,
        encryptionKeyIds: [...form.encryptionKeyIds],
        activeFrom: currentFreq.activeFrom,
        activeTo: currentFreq.activeTo,
      });

      setState((current) => ({
        ...current,
        ...resetFreqTechDrawerState(current),
        network: updatedNetwork,
        freqs: syncUpdatedFreqs(
          current.freqs,
          updatedNetwork,
          new Map(current.modulations.map((modulation) => [modulation.id, modulation.name])),
        ),
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        freqTechDrawerSaving: false,
        freqTechDrawerError: formatErrorMessage(error),
      }));
    }
  }, [state.freqTechDrawerForm, state.freqTechDrawerSaving, state.freqs, state.network, setState]);

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
        networkId: null,
        freq: null,
      });

      setState((current) => ({
        ...current,
        network: updatedNetwork,
        freqs: current.freqs.filter((freq) => freq.networkFreqId !== target.networkFreqId),
        freqActivityByFreq: (() => {
          const next = { ...current.freqActivityByFreq };
          delete next[target.networkFreqId];
          return next;
        })(),
        freqDeleteDialogOpen: false,
        freqDeleteTarget: null,
        freqDeleteSubmitting: false,
        freqDeleteError: null,
      }));
    } catch (error) {
      setState((current) => ({
        ...current,
        freqDeleteSubmitting: false,
        freqDeleteError: formatErrorMessage(error),
      }));
    }
  }, [state.freqDeleteSubmitting, state.freqDeleteTarget, state.network, setState]);

  return {
    setActiveNetworkDetailsTab,
    loadFrequencies,
    openFreqCreateWizard,
    closeFreqCreateWizard,
    setFreqCreateWizardForm,
    setFreqCreateWizardStep,
    openFreqEditDrawer,
    closeFreqEditDrawer,
    setFreqEditDrawerForm,
    openFreqTechDrawer,
    closeFreqTechDrawer,
    setFreqTechDrawerForm,
    openFreqRowActions,
    closeFreqRowActions,
    openDeleteFreqDialog,
    closeDeleteFreqDialog,
    toggleFrequencyGroupExpanded,
    saveFreqCreateWizard,
    saveFreqEditDrawer,
    saveFreqTechDrawer,
    deleteFreq,
  };
}
