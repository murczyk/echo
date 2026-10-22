import { useEffect, useMemo } from 'react';
import type { NetworkGroupActivityPeriod } from '../../../../Bindings';

import { parseDateInputExclusiveEndInTimeZone, parseDateInputInTimeZone } from '../../utils/misc';
import type { CallsignsLoadPeriods } from './use-rer-network-details-neo-page.load';
import type { NetworkDetailsNeoPageState } from './use-rer-network-details-neo-page.shared';
import { NETWORK_SETTLEMENTS_POLL_INTERVAL_MS } from './use-rer-network-details-neo-page.constants';

type TabEffectsParams = {
  state: NetworkDetailsNeoPageState;
  networkIdValue: number | null;
  radioFeaturesAllowed: boolean;
  canViewActivityTab: boolean;
  canViewRelationsTab: boolean;
  loadFrequencies: (networkId: number) => void | Promise<void>;
  loadCallsigns: (networkId: number, periods?: CallsignsLoadPeriods) => void | Promise<void>;
  loadRelations: (networkId: number, since: number, till: number) => void | Promise<void>;
  loadNetworkActivity: (
    networkId: number,
    period: NetworkGroupActivityPeriod,
  ) => void | Promise<void>;
  loadPelengPoints: (
    networkId: number,
    sinceDateInclusiveMs: number,
    tillDateNoninclusiveMs: number | null,
  ) => void | Promise<void>;
};

export function useRerNetworkDetailsNeoPageTabEffects({
  state,
  networkIdValue,
  radioFeaturesAllowed,
  canViewActivityTab,
  canViewRelationsTab,
  loadFrequencies,
  loadCallsigns,
  loadRelations,
  loadNetworkActivity,
  loadPelengPoints,
}: TabEffectsParams) {
  const relationsDateRangeValid = useMemo(() => {
    const since = parseDateInputInTimeZone(state.relationsSince);
    const till = parseDateInputInTimeZone(state.relationsTill);
    if (since === null || till === null) return false;
    return since <= till;
  }, [state.relationsSince, state.relationsTill]);

  const pelengSinceMs = useMemo(
    () => parseDateInputInTimeZone(state.pelengSince),
    [state.pelengSince],
  );
  const pelengTillMs = useMemo(
    () => parseDateInputExclusiveEndInTimeZone(state.pelengTill),
    [state.pelengTill],
  );
  const pelengDateRangeValid = useMemo(() => {
    if (pelengSinceMs === null || pelengTillMs === null) return false;
    return pelengSinceMs <= pelengTillMs;
  }, [pelengSinceMs, pelengTillMs]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (!radioFeaturesAllowed || state.activeNetworkDetailsTab !== 'frequencies') return;
    if (state.freqsLoaded || state.freqsLoading || state.freqsError !== null) return;
    void loadFrequencies(networkIdValue);
  }, [
    radioFeaturesAllowed,
    loadFrequencies,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.freqsError,
    state.freqsLoaded,
    state.freqsLoading,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'callsigns') return;
    if (state.callsignsLoaded || state.callsignsLoading || state.callsignsError !== null) return;
    void loadCallsigns(networkIdValue, {
      network: state.networkCallsignsPeriod,
      catalog: state.catalogCallsignsPeriod,
      intercepted: state.interceptedCallsignsPeriod,
    });
  }, [
    loadCallsigns,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.callsignsError,
    state.callsignsLoaded,
    state.callsignsLoading,
    state.catalogCallsignsPeriod,
    state.interceptedCallsignsPeriod,
    state.networkCallsignsPeriod,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'relations') return;
    if (!state.currentUserLoaded) return;
    if (!canViewRelationsTab) return;
    if (!relationsDateRangeValid) return;
    if (state.relationsLoaded || state.relationsLoading || state.relationsError !== null) return;
    const since = parseDateInputInTimeZone(state.relationsSince);
    const till = parseDateInputExclusiveEndInTimeZone(state.relationsTill);
    if (since === null || till === null) return;
    void loadRelations(networkIdValue, since, till);
  }, [
    loadRelations,
    state.activeNetworkDetailsTab,
    canViewRelationsTab,
    state.currentUserLoaded,
    state.network,
    state.relationsError,
    state.relationsLoaded,
    state.relationsLoading,
    state.relationsSince,
    state.relationsTill,
    relationsDateRangeValid,
    networkIdValue,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (state.activeNetworkDetailsTab !== 'activity') return;
    if (!state.currentUserLoaded) return;
    if (!canViewActivityTab) return;
    if (
      state.networkActivityLoaded ||
      state.networkActivityLoading ||
      state.networkActivityError !== null
    )
      return;
    void loadNetworkActivity(networkIdValue, state.networkActivityPeriod);
  }, [
    canViewActivityTab,
    loadNetworkActivity,
    networkIdValue,
    state.activeNetworkDetailsTab,
    state.currentUserLoaded,
    state.networkActivityError,
    state.networkActivityLoaded,
    state.networkActivityLoading,
    state.networkActivityPeriod,
  ]);

  useEffect(() => {
    if (networkIdValue === null) return;
    if (!radioFeaturesAllowed || state.activeNetworkDetailsTab !== 'direction-finding') return;

    const pelengWindowMatched =
      state.pelengPointsRequestedFrom === pelengSinceMs &&
      state.pelengPointsRequestedTo === pelengTillMs;

    if (
      pelengWindowMatched &&
      pelengDateRangeValid &&
      state.pelengPointsLoaded &&
      !state.pelengPointsLoading &&
      state.pelengPointsError === null &&
      state.networkSettlementsPending
    ) {
      const timeout = window.setTimeout(() => {
        void loadPelengPoints(networkIdValue, pelengSinceMs ?? 0, pelengTillMs);
      }, NETWORK_SETTLEMENTS_POLL_INTERVAL_MS);
      return () => window.clearTimeout(timeout);
    }

    if (
      pelengWindowMatched &&
      (state.pelengPointsLoaded || state.pelengPointsLoading || state.pelengPointsError !== null)
    )
      return;
    if (!pelengDateRangeValid) return;
    void loadPelengPoints(networkIdValue, pelengSinceMs ?? 0, pelengTillMs);
  }, [
    radioFeaturesAllowed,
    loadPelengPoints,
    pelengDateRangeValid,
    pelengSinceMs,
    pelengTillMs,
    state.activeNetworkDetailsTab,
    networkIdValue,
    state.pelengPointsError,
    state.pelengPointsLoaded,
    state.pelengPointsLoading,
    state.pelengPointsRequestedFrom,
    state.pelengPointsRequestedTo,
    state.networkSettlementsPending,
  ]);
}
