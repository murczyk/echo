import { canUseRadioFeatures } from '../../utils/roles';
import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { CallsignsLoadPeriods } from './use-rer-network-details-neo-page.load';
import type { NetworkFreqCallsignsPeriod } from '../../../../Bindings';

import {
  createNetworkCallsign,
  deleteCallsign as deleteCatalogCallsign,
  deleteNetworkCallsign,
  updateNetworkCallsign,
} from '../../services/api/callsigns';
import { blurActiveElement } from '../../utils/focus';
import {
  formatErrorMessage,
  canManageNetworkCallsignActions,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import {
  createDefaultNetworkCallsignDrawerForm,
  createNetworkCallsignDrawerForm,
  getNetworkCallsignDrawerSaveError,
  getNetworkCallsignMarkerMode,
  getNetworkCallsignMarkerState,
} from './network-callsigns.forms';
import type {
  NetworkCallsignDrawerForm,
  NetworkCallsignRowView,
  NetworkCallsignSectionMode,
  NetworkCallsignStatusFilter,
} from './network-callsigns.types';
import { resolveNetworkCallsignStatsPeriod } from './network-callsigns.stats';
import { normalizeCallsignDisplay } from './network-callsigns.utils';
import { buildNetworkCallsignWritePayload } from './use-rer-network-details-neo-page.callsign-write';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  loadCallsigns: (networkId: number, periods?: CallsignsLoadPeriods) => Promise<void>;
  loadNetworkCallsignStats: (
    networkId: number,
    period: NetworkFreqCallsignsPeriod,
  ) => Promise<void>;
};

export function useRerNetworkDetailsNeoPageCallsignActions({
  state,
  setState,
  loadCallsigns,
  loadNetworkCallsignStats,
}: Args) {
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);

  const currentStatsPeriod =
    state.networkCallsignStatsPeriod ??
    resolveNetworkCallsignStatsPeriod(state.networkCallsignsPeriod);

  const reloadCallsignsData = useCallback(async () => {
    if (!state.network) return;
    await loadCallsigns(state.network.id, {
      network: currentStatsPeriod,
      catalog: state.catalogCallsignsPeriod,
      intercepted: state.interceptedCallsignsPeriod,
    });
  }, [
    currentStatsPeriod,
    loadCallsigns,
    state.catalogCallsignsPeriod,
    state.interceptedCallsignsPeriod,
    state.network,
  ]);

  const setNetworkCallsignsPeriod = useCallback(
    (networkCallsignsPeriod: NetworkFreqCallsignsPeriod) => {
      if (networkCallsignsPeriod === state.networkCallsignsPeriod) return;
      setState((current) => ({
        ...current,
        networkCallsignsPeriod,
      }));
      const statsPeriod = resolveNetworkCallsignStatsPeriod(networkCallsignsPeriod);
      const statsRequested =
        state.networkCallsignStatsPeriod === statsPeriod &&
        state.networkCallsignStatsError === null;
      if (state.network && !statsRequested) {
        void loadNetworkCallsignStats(state.network.id, statsPeriod);
      }
    },
    [
      loadNetworkCallsignStats,
      setState,
      state.network,
      state.networkCallsignStatsError,
      state.networkCallsignStatsPeriod,
      state.networkCallsignsPeriod,
    ],
  );

  const retryNetworkCallsignStats = useCallback(() => {
    if (state.network) void loadNetworkCallsignStats(state.network.id, currentStatsPeriod);
  }, [currentStatsPeriod, loadNetworkCallsignStats, state.network]);

  const loadAllTimeNetworkCallsignStats = useCallback(() => {
    if (state.network) void loadNetworkCallsignStats(state.network.id, 'Unlimited');
  }, [loadNetworkCallsignStats, state.network]);

  const setCatalogCallsignsPeriod = useCallback(
    (catalogCallsignsPeriod: NetworkFreqCallsignsPeriod) => {
      if (catalogCallsignsPeriod === state.catalogCallsignsPeriod) return;
      setState((current) => ({
        ...current,
        catalogCallsignsPeriod,
      }));
      if (state.network) {
        void loadCallsigns(state.network.id, { catalog: catalogCallsignsPeriod });
      }
    },
    [loadCallsigns, setState, state.catalogCallsignsPeriod, state.network],
  );

  const setInterceptedCallsignsPeriod = useCallback(
    (interceptedCallsignsPeriod: NetworkFreqCallsignsPeriod) => {
      if (interceptedCallsignsPeriod === state.interceptedCallsignsPeriod) return;
      setState((current) => ({
        ...current,
        interceptedCallsignsPeriod,
      }));
      if (state.network) {
        void loadCallsigns(state.network.id, { intercepted: interceptedCallsignsPeriod });
      }
    },
    [loadCallsigns, setState, state.interceptedCallsignsPeriod, state.network],
  );

  const setCallsignSectionMode = useCallback(
    (callsignSectionMode: NetworkCallsignSectionMode) => {
      setState((current) => ({ ...current, callsignSectionMode }));
    },
    [setState],
  );

  const setCallsignStatusFilter = useCallback(
    (callsignStatusFilter: NetworkCallsignStatusFilter) => {
      setState((current) => ({ ...current, callsignStatusFilter }));
    },
    [setState],
  );

  const toggleCallsignInterceptedExpanded = useCallback(() => {
    setState((current) => ({
      ...current,
      callsignInterceptedExpanded: !current.callsignInterceptedExpanded,
    }));
  }, [setState]);

  const openCallsignDrawerForCreate = useCallback(
    (overrides?: Partial<NetworkCallsignDrawerForm>) => {
      const network = state.network;
      if (!canManageCallsignActions || !network) return;
      const networkUnitIds = network.unitIds ?? [];
      const defaultUnitId = networkUnitIds.length === 1 ? networkUnitIds[0] : null;
      setState((current) => ({
        ...current,
        callsignDrawerOpen: true,
        callsignDrawerMode: 'create',
        callsignDrawerForm: {
          ...createDefaultNetworkCallsignDrawerForm(network.id, defaultUnitId),
          ...(overrides ?? {}),
        },
        callsignDrawerSaving: false,
        callsignDrawerError: null,
        callsignWarning: null,
      }));
    },
    [canManageCallsignActions, setState, state.network],
  );

  const openCallsignDrawerForEdit = useCallback(
    (networkCallsign: NetworkCallsignRowView) => {
      if (!canManageCallsignActions || !state.network) return;
      setState((current) => ({
        ...current,
        callsignDrawerOpen: true,
        callsignDrawerMode: 'edit',
        callsignDrawerForm: createNetworkCallsignDrawerForm(
          state.network?.id ?? 0,
          networkCallsign,
        ),
        callsignDrawerSaving: false,
        callsignDrawerError: null,
        callsignWarning: null,
      }));
    },
    [canManageCallsignActions, setState, state.network],
  );

  const closeCallsignDrawer = useCallback(() => {
    if (state.callsignDrawerSaving) return;

    blurActiveElement();

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
  }, [setState, state.callsignDrawerSaving]);

  const openCallsignDeleteDialog = useCallback(
    (networkCallsign: NetworkCallsignRowView) => {
      if (!canManageCallsignActions) return;
      setState((current) => ({
        ...current,
        callsignDeleteDialogOpen: true,
        callsignDeleteTarget: networkCallsign,
        callsignDeleteSubmitting: false,
        callsignDeleteError: null,
        callsignDeleteAlsoFromCatalog: false,
      }));
    },
    [canManageCallsignActions, setState],
  );

  const closeCallsignDeleteDialog = useCallback(() => {
    setState((current) => {
      if (current.callsignDeleteSubmitting) return current;
      return {
        ...current,
        callsignDeleteDialogOpen: false,
        callsignDeleteTarget: null,
        callsignDeleteSubmitting: false,
        callsignDeleteError: null,
        callsignDeleteAlsoFromCatalog: false,
      };
    });
  }, [setState]);

  const saveCallsignDrawer = useCallback(
    async (form: NetworkCallsignDrawerForm) => {
      const network = state.network;

      if (!canManageCallsignActions || !network || state.callsignDrawerSaving) return;

      const validationError = getNetworkCallsignDrawerSaveError(
        form,
        canUseRadioFeatures(state.currentUser?.roles),
      );
      if (validationError) {
        setState((current) => ({ ...current, callsignDrawerError: validationError }));
        return;
      }

      const callsign = normalizeCallsignDisplay(form.callsign);
      // Enforce exclusive marker state before sending payload: derive canonical mode
      // from the form and pass explicit overrides to the payload builder.
      const markerMode = getNetworkCallsignMarkerMode(form);
      const markerState = getNetworkCallsignMarkerState(markerMode);
      const payload = buildNetworkCallsignWritePayload(
        {
          networkId: network.id,
          callsign,
          fullName: form.fullName,
          position: form.position,
          comment: form.comment,
          sourceId: form.sourceId,
          radioFreq: form.radioFreq,
          unitId: form.unitId,
          unitDeveloping: form.unitDeveloping,
          developing: form.developing,
          mainRadioStation: form.mainRadioStation,
          commandControl: form.commandControl,
        },
        {
          mainRadioStation: markerState.mainRadioStation,
          commandControl: markerState.commandControl,
        },
      );
      const updateCallsignId =
        state.callsignDrawerMode === 'edit' && form.id !== null ? form.id : null;

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
        blurActiveElement();
        setState((current) => ({
          ...current,
          callsignDrawerOpen: false,
          callsignDrawerMode: 'create',
          callsignDrawerForm: null,
          callsignDrawerSaving: false,
          callsignDrawerError: null,
          callsignWarning: null,
          callsignUpdateInFlightIds:
            updateCallsignId === null
              ? current.callsignUpdateInFlightIds
              : current.callsignUpdateInFlightIds.filter((item) => item !== updateCallsignId),
        }));
        await reloadCallsignsData();
      } catch (error) {
        setState((current) => ({
          ...current,
          callsignDrawerSaving: false,
          callsignDrawerError: formatErrorMessage(error),
          callsignUpdateInFlightIds:
            updateCallsignId === null
              ? current.callsignUpdateInFlightIds
              : current.callsignUpdateInFlightIds.filter((item) => item !== updateCallsignId),
        }));
      }
    },
    [
      canManageCallsignActions,
      reloadCallsignsData,
      setState,
      state.callsignDrawerMode,
      state.callsignDrawerSaving,
      state.currentUser,
      state.network,
    ],
  );

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
      if (
        state.callsignDeleteAlsoFromCatalog &&
        target.knownCallsignId !== null &&
        target.status !== 'developing'
      ) {
        await deleteCatalogCallsign(target.knownCallsignId);
      }
      setState((current) => ({
        ...current,
        callsignDeleteDialogOpen: false,
        callsignDeleteTarget: null,
        callsignDeleteSubmitting: false,
        callsignDeleteError: null,
        callsignWarning: null,
        callsignDeleteAlsoFromCatalog: false,
        callsignDeleteInFlightIds: current.callsignDeleteInFlightIds.filter(
          (item) => item !== target.id,
        ),
      }));
      await reloadCallsignsData();
    } catch (error) {
      const errorMessage = formatErrorMessage(error);
      setState((current) => ({
        ...current,
        callsignDeleteSubmitting: false,
        callsignDeleteError: errorMessage,
        callsignWarning: errorMessage,
        callsignDeleteInFlightIds: current.callsignDeleteInFlightIds.filter(
          (item) => item !== target.id,
        ),
      }));
      void reloadCallsignsData().catch(() => undefined);
    }
  }, [
    canManageCallsignActions,
    reloadCallsignsData,
    setState,
    state.callsignDeleteAlsoFromCatalog,
    state.callsignDeleteSubmitting,
    state.callsignDeleteTarget,
  ]);

  const setCallsignDeleteAlsoFromCatalog = useCallback(
    (callsignDeleteAlsoFromCatalog: boolean) => {
      setState((current) => ({ ...current, callsignDeleteAlsoFromCatalog }));
    },
    [setState],
  );

  return {
    loadCallsigns: reloadCallsignsData,
    reloadCallsignsData,
    setNetworkCallsignsPeriod,
    retryNetworkCallsignStats,
    loadAllTimeNetworkCallsignStats,
    setCatalogCallsignsPeriod,
    setInterceptedCallsignsPeriod,
    setCallsignSectionMode,
    setCallsignStatusFilter,
    toggleCallsignInterceptedExpanded,
    openCallsignDrawerForCreate,
    openCallsignDrawerForEdit,
    closeCallsignDrawer,
    saveCallsignDrawer,
    openCallsignDeleteDialog,
    closeCallsignDeleteDialog,
    deleteCallsign,
    setCallsignDeleteAlsoFromCatalog,
  };
}
