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
  removeKnownCallsignIdsFromNetworkCallsignGroups,
} from './network-callsigns.tab';
import {
  createDefaultNetworkCallsignDrawerForm,
  getNetworkCallsignMarkerState,
} from './network-callsigns.forms';
import type { NetworkCallsignMarkerMode, NetworkCallsignRowView } from './network-callsigns.types';
import { normalizeCallsignDisplay } from './network-callsigns.utils';
import { buildNetworkCallsignWritePayload } from './use-rer-network-details-neo-page.callsign-write';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

type Args = {
  state: NetworkDetailsNeoPageState;
  setState: SetState;
};

export function useRerNetworkDetailsNeoPageCallsignMutations({ state, setState }: Args) {
  const canManageCallsignActions = canManageNetworkCallsignActions(state.currentUser);

  const addKnownCallsignsToCurrentNetwork = useCallback(
    async (knownCallsignId: number) => {
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
          const nextNetworkCallsigns = mergeNetworkCallsigns(
            current.networkCallsigns,
            addedNetworkCallsigns,
          );
          const nextNetworkCallsignGroups = removeKnownCallsignIdsFromNetworkCallsignGroups(
            current.networkCallsignGroups,
            [knownCallsignId],
          );
          const derived = buildNetworkCallsignTabData(
            nextNetworkCallsignGroups,
            current.callsignActivityMap,
            nextNetworkCallsigns,
          );

          return {
            ...current,
            networkCallsigns: nextNetworkCallsigns,
            networkCallsignGroups: nextNetworkCallsignGroups,
            catalogCallsignGroups: derived.catalogCallsignGroups,
            unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
            callsignCount: nextNetworkCallsigns.length,
            callsignCatalogAddInFlightIds: current.callsignCatalogAddInFlightIds.filter(
              (item) => item !== knownCallsignId,
            ),
            callsignWarning: null,
          };
        });
      } catch (error) {
        const errorMessage = formatErrorMessage(error);
        setState((current) => ({
          ...current,
          callsignCatalogAddInFlightIds: current.callsignCatalogAddInFlightIds.filter(
            (item) => item !== knownCallsignId,
          ),
          callsignWarning: errorMessage,
        }));
        return;
      }
    },
    [canManageCallsignActions, setState, state.callsignCatalogAddInFlightIds, state.network],
  );

  const addInterceptedCallsignToNetwork = useCallback(
    (callsign: string, developing: boolean) => {
      const network = state.network;
      if (!canManageCallsignActions || !network) return;
      const normalizedCallsign = normalizeCallsignDisplay(callsign);
      if (normalizedCallsign === '') return;

      // Instead of creating immediately, open the create drawer so the user must select a source.
      setState((current) => ({
        ...current,
        callsignWarning: null,
        callsignDrawerOpen: true,
        callsignDrawerMode: 'create',
        callsignDrawerForm: {
          ...createDefaultNetworkCallsignDrawerForm(network.id, null),
          callsign: normalizedCallsign,
          developing,
          status: developing ? 'developing' : 'catalog',
          sourceId: null,
          unitId: null,
        },
        callsignDrawerSaving: false,
        callsignDrawerError: null,
      }));
    },
    [canManageCallsignActions, setState, state.network],
  );

  const setNetworkCallsignMarkerMode = useCallback(
    async (networkCallsign: NetworkCallsignRowView, markerMode: NetworkCallsignMarkerMode) => {
      if (!canManageCallsignActions || !state.network) return;
      if (state.callsignUpdateInFlightIds.includes(networkCallsign.id)) return;

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
              fullName: networkCallsign.fullName,
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
            getNetworkCallsignMarkerState(markerMode),
          ),
        });

        setState((current) => {
          const nextNetworkCallsigns = mergeNetworkCallsigns(current.networkCallsigns, [
            updatedNetworkCallsign,
          ]);
          const derived = buildNetworkCallsignTabData(
            current.networkCallsignGroups,
            current.callsignActivityMap,
            nextNetworkCallsigns,
          );

          return {
            ...current,
            networkCallsigns: nextNetworkCallsigns,
            catalogCallsignGroups: derived.catalogCallsignGroups,
            unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
            callsignCount: nextNetworkCallsigns.length,
            callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter(
              (item) => item !== networkCallsign.id,
            ),
            callsignWarning: null,
          };
        });
      } catch (error) {
        const errorMessage = formatErrorMessage(error);
        setState((current) => ({
          ...current,
          callsignUpdateInFlightIds: current.callsignUpdateInFlightIds.filter(
            (item) => item !== networkCallsign.id,
          ),
          callsignWarning: errorMessage,
        }));
      }
    },
    [canManageCallsignActions, setState, state.callsignUpdateInFlightIds, state.network],
  );

  return {
    addKnownCallsignsToNetwork: addKnownCallsignsToCurrentNetwork,
    addInterceptedCallsignToNetwork,
    setNetworkCallsignMarkerMode,
  };
}
