import { type Dispatch, type MutableRefObject, type SetStateAction } from 'react';

import type { ListNetworksReq, Network } from '../../../../Bindings';
import { isUnauthorizedError } from '../../services/api/client';
import {
  createNetwork,
  deleteNetwork,
  updateNetwork,
  updateNetworkPosts,
  updateNetworkUnits,
} from '../../services/api/networks';
import type { NetworkEtalonkaReportState } from '../rer-network-details-neo/use-rer-network-details-neo-page.etalonka-report';
import { getRestoreNetworkOnEditValue } from '../rer-network-details-neo/network-status';
import {
  createDefaultNetworkUpsertForm,
  getNetworkUpsertValidationError,
  normalizeNetworkUnitMask,
  shouldIncludeNetworkCreateFrequency,
  toCreateNetworkReq,
  toNetworkEditForm,
} from '../rer-network-details-neo/use-rer-network-details-neo-page.forms';
import type { NetworkUpsertForm } from '../rer-network-details-neo/use-rer-network-details-neo-page.types';
import type { NetworksFilterState } from './helpers';
import { formatErrorMessage } from './use-rer-networks-neo-page.shared';
import { redirectToLogin } from '../../auth-redirect';
import { navigateWithinSpa } from '../../utils/browser';
import type { NetworksQuerySnapshot, UiMessage } from './use-rer-networks-neo-page.types';

type MutationArgs = {
  networks: Network[];
  filters: Pick<NetworksFilterState, 'status' | 'unitText' | 'showOnlyInvestigating'>;
  querySnapshot: NetworksQuerySnapshot;
  latestQuerySnapshotRef: MutableRefObject<NetworksQuerySnapshot | null>;
  lastExecutedFullQueryKeyRef: MutableRefObject<string | null>;
  editDialog: NetworkUpsertForm | null;
  createDialog: NetworkUpsertForm | null;
  supportNonRerInterceptions: boolean;
  deleteDialogNetwork: Network | null;
  editSubmitting: boolean;
  createSubmitting: boolean;
  loadNetworks: (
    snapshot: NetworksQuerySnapshot,
    options?: { includeLookups?: boolean; append?: boolean; force?: boolean },
  ) => Promise<void>;
  refreshStatusCounts: () => Promise<void>;
  setStatus: Dispatch<SetStateAction<UiMessage>>;
  setEditDialog: Dispatch<SetStateAction<NetworkUpsertForm | null>>;
  setEditSubmitting: Dispatch<SetStateAction<boolean>>;
  setEditError: Dispatch<SetStateAction<string | null>>;
  setCreateDialog: Dispatch<SetStateAction<NetworkUpsertForm | null>>;
  setCreateSubmitting: Dispatch<SetStateAction<boolean>>;
  setCreateError: Dispatch<SetStateAction<string | null>>;
  setDeleteDialogNetwork: Dispatch<SetStateAction<Network | null>>;
  setDeleteSubmitting: Dispatch<SetStateAction<boolean>>;
  setNetworks: Dispatch<SetStateAction<Network[]>>;
  setActivityByNetworkId: Dispatch<
    SetStateAction<Map<number, Record<string, Record<string, number>>>>
  >;
};

export function createRerNetworksNeoMutationActions(args: MutationArgs) {
  function openEditDialog(network: Network) {
    args.setEditError(null);
    args.setEditDialog(toNetworkEditForm(network));
    args.setDeleteDialogNetwork(null);
  }

  function openCreateDialog() {
    args.setCreateError(null);
    args.setCreateDialog(createDefaultNetworkUpsertForm());
  }

  function closeCreateDialog() {
    if (args.createSubmitting) return;
    args.setCreateDialog(null);
    args.setCreateError(null);
  }

  function closeEditDialog() {
    if (args.editSubmitting) return;
    args.setEditDialog(null);
    args.setEditError(null);
  }

  function syncNetworkRelations(editForm: NetworkUpsertForm) {
    const networkId = editForm.id;
    if (networkId === null) {
      return Promise.resolve();
    }

    return updateNetworkPosts({
      networkId,
      postIds: [...editForm.postIds],
    }).then(() =>
      updateNetworkUnits({
        networkId,
        unitIds: [...editForm.unitIds],
      }),
    );
  }

  async function saveNetworkEdit(formArg?: NetworkUpsertForm | null) {
    const editDialog = formArg ?? args.editDialog;
    if (!editDialog || editDialog.id === null) return;

    const validationError = getNetworkUpsertValidationError(editDialog, {
      includeFrequency: false,
    });
    if (validationError !== null) {
      args.setEditError(
        validationError.name ??
          validationError.location ??
          validationError.aorIds ??
          'Перевірте форму',
      );
      return;
    }

    args.setEditSubmitting(true);
    args.setEditError(null);

    try {
      const network = args.networks.find((item) => item.id === editDialog.id) ?? null;
      await updateNetwork({
        id: editDialog.id,
        restoreNetwork: getRestoreNetworkOnEditValue(network, editDialog.status),
        areaOfResponsibilityIds: [...editDialog.aorIds],
        name: editDialog.name.trim(),
        location: editDialog.location.trim(),
        radioStation: editDialog.radioStation.trim() === '' ? null : editDialog.radioStation.trim(),
        purpose: editDialog.purpose.trim() === '' ? null : editDialog.purpose.trim(),
        operationMode:
          editDialog.operationMode.trim() === '' ? null : editDialog.operationMode.trim(),
        operationType:
          editDialog.operationType.trim() === '' ? null : editDialog.operationType.trim(),
        operationPeriod:
          editDialog.operationPeriod.trim() === '' ? null : editDialog.operationPeriod.trim(),
        doNotArchive: editDialog.doNotArchive,
        unitMask: args.supportNonRerInterceptions
          ? normalizeNetworkUnitMask(editDialog.unitMask)
          : null,
        descriptions: null,
        status: editDialog.status,
      });
      await syncNetworkRelations(editDialog);
      args.lastExecutedFullQueryKeyRef.current = null;
      void args.loadNetworks(args.latestQuerySnapshotRef.current ?? args.querySnapshot, {
        includeLookups: false,
        append: false,
        force: true,
      });
      void args.refreshStatusCounts();
      args.setStatus({ kind: 'success', text: 'Мережу оновлено.' });
      args.setEditDialog(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setEditError(formatErrorMessage(error));
    } finally {
      args.setEditSubmitting(false);
    }
  }

  async function saveNetworkCreate() {
    if (!args.createDialog) return;

    const includeFrequency = shouldIncludeNetworkCreateFrequency(
      args.createDialog,
      args.supportNonRerInterceptions,
    );
    const validationError = getNetworkUpsertValidationError(args.createDialog, {
      includeFrequency,
    });
    if (validationError !== null) {
      args.setCreateError(
        validationError.name ??
          validationError.location ??
          validationError.aorIds ??
          validationError.freq ??
          validationError.activeFrom ??
          'Перевірте форму',
      );
      return;
    }

    args.setCreateSubmitting(true);
    args.setCreateError(null);

    try {
      const network = await createNetwork(
        toCreateNetworkReq(args.createDialog, { includeFrequency }),
      );
      args.setCreateDialog(null);
      args.setStatus({ kind: 'success', text: 'Мережу створено.' });
      navigateWithinSpa(`/rer-networks-neo/${network.id}`);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setCreateError(formatErrorMessage(error));
    } finally {
      args.setCreateSubmitting(false);
    }
  }

  async function confirmDeleteNetwork() {
    if (!args.deleteDialogNetwork) return;

    args.setDeleteSubmitting(true);
    try {
      const deletedNetwork = await deleteNetwork(args.deleteDialogNetwork.id);
      args.setNetworks((current) =>
        args.filters.status === 'deleted'
          ? current.map((network) => (network.id === deletedNetwork.id ? deletedNetwork : network))
          : current.filter((network) => network.id !== deletedNetwork.id),
      );
      args.setActivityByNetworkId((current) => {
        if (args.filters.status === 'deleted') return current;
        const nextActivity = new Map(current);
        nextActivity.delete(deletedNetwork.id);
        return nextActivity;
      });
      void args.refreshStatusCounts();
      args.setStatus({ kind: 'success', text: 'Мережу видалено.' });
      args.setDeleteDialogNetwork(null);
    } catch (error) {
      if (isUnauthorizedError(error)) {
        redirectToLogin();
        return;
      }
      args.setStatus({
        kind: 'error',
        text: `Помилка видалення мережі: ${formatErrorMessage(error)}`,
      });
    } finally {
      args.setDeleteSubmitting(false);
    }
  }

  return {
    openEditDialog,
    openCreateDialog,
    closeCreateDialog,
    closeEditDialog,
    syncNetworkRelations,
    saveNetworkEdit,
    saveNetworkCreate,
    confirmDeleteNetwork,
  };
}
