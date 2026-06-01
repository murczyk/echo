import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { deleteNetwork, updateNetwork, updateNetworkPosts, updateNetworkUnits } from '../../services/api/networks';
import { navigateWithinSpa } from '../../utils/browser';
import { NO_DATA_LABEL } from '../../utils/misc';
import {
  formatAorSummaryText,
  formatClassicNetworkHeaderName,
  formatErrorMessage,
  toNetworkEditForm,
  type NetworkDetailsNeoPageState,
  type NetworkEditForm,
} from './use-rer-network-details-neo-page.shared';
import { formatUnitSummaryText, type MainInfoSnapshot } from './components/NetworkDetailsLeftPanel.shared';
import { useRerNetworkDetailsNeoPageDescriptionActions } from './use-rer-network-details-neo-page.description-actions';
import { useRerNetworkDetailsNeoPageReportActions } from './use-rer-network-details-neo-page.report-actions';
import { useRerNetworkDetailsNeoPageFrequencyActions } from './use-rer-network-details-neo-page.frequency-actions';
import { useRerNetworkDetailsNeoPageCallsignActions } from './use-rer-network-details-neo-page.callsign-actions';
import { useRerNetworkDetailsNeoPageCallsignMutations } from './use-rer-network-details-neo-page.callsign-mutations';

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

function addCopyLine(lines: string[], label: string, value: string | null | undefined) {
  const trimmed = value?.trim() ?? '';
  if (trimmed === '' || trimmed === NO_DATA_LABEL || trimmed === '—') return;
  lines.push(`${label}: ${trimmed}`);
}

export function buildMainInfoCopyText({
  unitNames,
  location,
  aorLabels,
  aorCollapsedCount,
  callsignCount,
  activityLabel,
}: {
  unitNames: string[];
  location: string | null | undefined;
  aorLabels: string[];
  aorCollapsedCount: number;
  callsignCount: number | null;
  activityLabel: string | null;
}) {
  const lines: string[] = [];
  const units = unitNames.map((unitName) => unitName.trim()).filter((unitName) => unitName !== '');
  const unitsText = formatUnitSummaryText(units);
  if (unitsText) {
    lines.push(`${units.length === 1 ? 'Підрозділ' : 'Підрозділи'}: ${unitsText}`);
  }

  addCopyLine(lines, 'Район функціонування', location);
  addCopyLine(lines, 'Смуги', formatAorSummaryText(aorLabels, aorCollapsedCount));
  if (callsignCount !== null) {
    lines.push(`Склад кореспондентів: ${callsignCount}`);
  }

  if (activityLabel) {
    lines.push(`Активність: ${activityLabel}`);
  }

  return lines.join('\n');
}

export function useRerNetworkDetailsNeoPageActions({ state, setState, unitNames, reloadGeneration, currentNetworkIdRef, loadCallsigns }: Args) {
  const descriptionActions = useRerNetworkDetailsNeoPageDescriptionActions({ state, setState });
  const reportActions = useRerNetworkDetailsNeoPageReportActions({ state, setState });
  const frequencyActions = useRerNetworkDetailsNeoPageFrequencyActions({
    state,
    setState,
    reloadGeneration,
    currentNetworkIdRef,
  });
  const callsignActions = useRerNetworkDetailsNeoPageCallsignActions({
    state,
    setState,
    defaultNetworkUnitId: state.network?.unitIds?.[0] ?? null,
    loadCallsigns,
  });
  const callsignMutationActions = useRerNetworkDetailsNeoPageCallsignMutations({
    state,
    setState,
    defaultNetworkUnitId: state.network?.unitIds?.[0] ?? null,
  });

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
      setState((current) => ({ ...current, copyStatus: 'Назву й район скопійовано', copyStatusTone: 'success' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null, copyStatusTone: null }));
      }, 1800);
    } catch (error) {
      setState((current) => ({ ...current, copyStatus: formatErrorMessage(error), copyStatusTone: 'error' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null, copyStatusTone: null }));
      }, 2400);
    }
  }, [setState, state.network?.location, state.network?.name, unitNames]);

  const handleCopyMainInfo = useCallback(async (snapshot: MainInfoSnapshot) => {
    const text = buildMainInfoCopyText({
      unitNames: snapshot.unitNames,
      location: snapshot.location,
      aorLabels: snapshot.aorLabels,
      aorCollapsedCount: snapshot.aorCollapsedCount,
      callsignCount: snapshot.callsignCount,
      activityLabel: snapshot.activityLabel,
    });

    if (text.trim() === '') return;

    try {
      await navigator.clipboard.writeText(text);
      setState((current) => ({ ...current, copyStatus: 'Основне скопійовано', copyStatusTone: 'success' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null, copyStatusTone: null }));
      }, 1800);
    } catch (error) {
      setState((current) => ({ ...current, copyStatus: formatErrorMessage(error), copyStatusTone: 'error' }));
      window.setTimeout(() => {
        setState((current) => ({ ...current, copyStatus: null, copyStatusTone: null }));
      }, 2400);
    }
  }, [setState]);

  const setEditForm = useCallback((editForm: NetworkEditForm | null) => {
    setState((current) => ({ ...current, editForm }));
  }, [setState]);

  return {
    ...descriptionActions,
    ...reportActions,
    ...frequencyActions,
    ...callsignActions,
    ...callsignMutationActions,
    openMenu,
    closeMenu,
    openDeleteDialog,
    closeDeleteDialog,
    openEditDrawer,
    closeEditDrawer,
    saveNetworkEdit,
    handleDelete,
    handleCopyNetworkInfo,
    handleCopyMainInfo,
    setEditForm,
  };
}
