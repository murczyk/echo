import { useCallback } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import {
  addKnownCallsignsToNetwork,
  createNetworkCallsign,
  updateNetworkCallsign,
} from '../../services/api/callsigns';
import {
  formatErrorMessage,
  canManageNetworkCallsignActions,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import {
  buildNetworkCallsignTabData,
  mergeNetworkCallsigns,
  normalizeCallsignDisplay,
  removeKnownCallsignIdsFromNetworkCallsignGroups,
  type NetworkCallsignRowView,
} from './network-callsigns';
import { buildNetworkCallsignWritePayload } from './use-rer-network-details-neo-page.callsign-write';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
  defaultNetworkUnitId: number | null;
};

export function useRerNetworkDetailsNeoPageCallsignMutations({ state, setState, defaultNetworkUnitId }: Args) {
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);

  const addKnownCallsignsToCurrentNetwork = useCallback(async (knownCallsignId: number) => {
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
      const createdNetworkCallsign = await createNetworkCallsign(
        buildNetworkCallsignWritePayload({
          networkId: network.id,
          callsign: normalizedCallsign,
          position: '',
          comment: '',
          sourceId: null,
          radioFreq: '',
          unitId: defaultNetworkUnitId,
          unitDeveloping: false,
          developing,
          mainRadioStation: false,
          commandControl: false,
        }),
      );

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
        ...buildNetworkCallsignWritePayload(
          {
            networkId: networkCallsign.networkId,
            callsign: networkCallsign.callsign,
            position: networkCallsign.position,
            comment: networkCallsign.comment,
            sourceId: networkCallsign.sourceId,
            radioFreq: networkCallsign.radioFreq ?? '',
            unitId: networkCallsign.unitId,
            unitDeveloping: networkCallsign.unitDeveloping,
            developing: networkCallsign.developing,
            mainRadioStation: networkCallsign.mainRadioStation,
            commandControl: networkCallsign.commandControl,
          },
          { mainRadioStation: nextMainRadioStation },
        ),
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
        ...buildNetworkCallsignWritePayload(
          {
            networkId: networkCallsign.networkId,
            callsign: networkCallsign.callsign,
            position: networkCallsign.position,
            comment: networkCallsign.comment,
            sourceId: networkCallsign.sourceId,
            radioFreq: networkCallsign.radioFreq ?? '',
            unitId: networkCallsign.unitId,
            unitDeveloping: networkCallsign.unitDeveloping,
            developing: networkCallsign.developing,
            mainRadioStation: networkCallsign.mainRadioStation,
            commandControl: networkCallsign.commandControl,
          },
          { commandControl: nextCommandControl },
        ),
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
    addKnownCallsignsToNetwork: addKnownCallsignsToCurrentNetwork,
    addInterceptedCallsignToNetwork,
    toggleNetworkCallsignMainRadioStation,
    toggleNetworkCallsignCommandControl,
  };
}
