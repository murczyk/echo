import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { NetworkCallsign } from '../../../../Bindings';
import { deleteNetworkCallsigns } from '../../services/api/callsigns';
import {
  canDeleteCatalogCallsign,
  canManageNetworkCallsignActions,
  formatErrorMessage,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  reloadCallsignsData: () => Promise<void>;
};

/** Mirrors the single-delete rule: only catalog-linked rows outside further reconnaissance. */
export function isCatalogDeletableNetworkCallsign(
  networkCallsign: Pick<NetworkCallsign, 'developing' | 'knownCallsignId'>,
): boolean {
  return !networkCallsign.developing && networkCallsign.knownCallsignId !== null;
}

export function selectNetworkCallsignsByIds(
  networkCallsigns: NetworkCallsign[],
  ids: number[],
): NetworkCallsign[] {
  const idSet = new Set(ids);
  return networkCallsigns.filter((networkCallsign) => idSet.has(networkCallsign.id));
}

export function useRerNetworkDetailsNeoPageCallsignBulkActions({
  state,
  setState,
  reloadCallsignsData,
}: Args) {
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);
  const canDeleteFromCatalog = canDeleteCatalogCallsign(state.currentUser);

  const enterCallsignSelectionMode = useCallback(() => {
    if (!canManageCallsignActions) return;
    setState((current) => ({
      ...current,
      callsignSelectionMode: true,
      selectedNetworkCallsignIds: [],
    }));
  }, [canManageCallsignActions, setState]);

  const exitCallsignSelectionMode = useCallback(() => {
    setState((current) => {
      if (current.callsignBulkDeleteSubmitting) return current;
      return {
        ...current,
        callsignSelectionMode: false,
        selectedNetworkCallsignIds: [],
        callsignBulkDeleteDialogOpen: false,
      };
    });
  }, [setState]);

  const setSelectedNetworkCallsignIds = useCallback(
    (selectedNetworkCallsignIds: number[]) => {
      setState((current) => ({ ...current, selectedNetworkCallsignIds }));
    },
    [setState],
  );

  const openCallsignBulkDeleteDialog = useCallback(() => {
    if (!canManageCallsignActions) return;
    setState((current) => {
      const callsignBulkDeleteTargets = selectNetworkCallsignsByIds(
        current.networkCallsigns,
        current.selectedNetworkCallsignIds,
      );
      if (callsignBulkDeleteTargets.length === 0) return current;
      return {
        ...current,
        callsignBulkDeleteDialogOpen: true,
        callsignBulkDeleteTargets,
        callsignBulkDeleteSubmitting: false,
        callsignBulkDeleteError: null,
        callsignBulkDeleteAlsoFromCatalog: false,
      };
    });
  }, [canManageCallsignActions, setState]);

  const closeCallsignBulkDeleteDialog = useCallback(() => {
    setState((current) => {
      if (current.callsignBulkDeleteSubmitting) return current;
      return { ...current, callsignBulkDeleteDialogOpen: false };
    });
  }, [setState]);

  /** Clears the dialog snapshot once its exit transition has finished. */
  const resetCallsignBulkDeleteDialog = useCallback(() => {
    setState((current) => {
      if (current.callsignBulkDeleteDialogOpen) return current;
      return {
        ...current,
        callsignBulkDeleteTargets: [],
        callsignBulkDeleteError: null,
        callsignBulkDeleteAlsoFromCatalog: false,
      };
    });
  }, [setState]);

  const setCallsignBulkDeleteAlsoFromCatalog = useCallback(
    (callsignBulkDeleteAlsoFromCatalog: boolean) => {
      setState((current) => ({ ...current, callsignBulkDeleteAlsoFromCatalog }));
    },
    [setState],
  );

  const deleteSelectedCallsigns = useCallback(async () => {
    const network = state.network;
    const ids = state.callsignBulkDeleteTargets.map((networkCallsign) => networkCallsign.id);
    if (
      !canManageCallsignActions ||
      !network ||
      ids.length === 0 ||
      state.callsignBulkDeleteSubmitting
    ) {
      return;
    }

    const idSet = new Set(ids);
    const withoutDeletedIds = (inFlightIds: number[]) => inFlightIds.filter((id) => !idSet.has(id));

    setState((current) => ({
      ...current,
      callsignBulkDeleteSubmitting: true,
      callsignBulkDeleteError: null,
      callsignWarning: null,
      callsignDeleteInFlightIds: [...current.callsignDeleteInFlightIds, ...ids],
    }));

    try {
      await deleteNetworkCallsigns({
        networkId: network.id,
        ids,
        alsoDeleteFromCatalog: canDeleteFromCatalog && state.callsignBulkDeleteAlsoFromCatalog,
      });
      setState((current) => ({
        ...current,
        callsignSelectionMode: false,
        selectedNetworkCallsignIds: [],
        callsignBulkDeleteDialogOpen: false,
        callsignBulkDeleteSubmitting: false,
        callsignDeleteInFlightIds: withoutDeletedIds(current.callsignDeleteInFlightIds),
      }));
      await reloadCallsignsData();
    } catch (error) {
      setState((current) => ({
        ...current,
        callsignBulkDeleteSubmitting: false,
        callsignBulkDeleteError: formatErrorMessage(error),
        callsignDeleteInFlightIds: withoutDeletedIds(current.callsignDeleteInFlightIds),
      }));
      void reloadCallsignsData().catch(() => undefined);
    }
  }, [
    canDeleteFromCatalog,
    canManageCallsignActions,
    reloadCallsignsData,
    setState,
    state.callsignBulkDeleteAlsoFromCatalog,
    state.callsignBulkDeleteSubmitting,
    state.callsignBulkDeleteTargets,
    state.network,
  ]);

  return {
    enterCallsignSelectionMode,
    exitCallsignSelectionMode,
    setSelectedNetworkCallsignIds,
    openCallsignBulkDeleteDialog,
    closeCallsignBulkDeleteDialog,
    resetCallsignBulkDeleteDialog,
    setCallsignBulkDeleteAlsoFromCatalog,
    deleteSelectedCallsigns,
  };
}
