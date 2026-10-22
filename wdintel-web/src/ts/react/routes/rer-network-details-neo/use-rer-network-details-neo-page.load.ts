import { canUseRadioFeatures } from '../../utils/roles';
import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type {
  NetworkCallsignRelationsRsp,
  NetworkFreqCallsignsPeriod,
  NetworkGroupActivityPeriod,
} from '../../../../Bindings';

import { listAors } from '../../services/api/aor';
import {
  getNetworkById,
  getNetworkCallsignRelations,
  getNetworkGroupsActivityOne,
  listNetworkPoints,
} from '../../services/api/networks';
import { getEncryptions } from '../../services/api/encryptions';
import {
  listNetworkCallsigns,
  getNetworkCallsigns,
  listSources,
} from '../../services/api/callsigns';
import { getUnitsByIds, getUnitsList, mergeUnitsById } from '../../services/api/units';
import { listPosts } from '../../services/api/posts';
import { fetchCurrentUser } from '../../services/api/user';
import { currentSystemSettings } from '../../services/api/system-settings';
import {
  parseDateInputExclusiveEndInTimeZone,
  parseDateInputInTimeZone,
  sortFrequenciesNumerically,
} from '../../utils/misc';
import { normalizePelengationFrequency } from './components/NetworkDetailsPelengationMap.shared';
import {
  EMPTY_STATE,
  getDefaultNetworkRelationsDateRange,
  getDefaultNetworkPelengDateRange,
  formatErrorMessage,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import {
  buildNetworkCallsignTabData,
  createNetworkCallsignActivityMap,
} from './network-callsigns.tab';
import {
  buildNetworkCallsignRelationFreqState,
  resolveNetworkCallsignRelationFreqs,
} from './network-relations';

type ReloadGenerationRef = MutableRefObject<number>;

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

export type CallsignsLoadPeriods = {
  network?: NetworkFreqCallsignsPeriod;
  catalog?: NetworkFreqCallsignsPeriod;
  intercepted?: NetworkFreqCallsignsPeriod;
};

type CallsignSectionState = Pick<
  NetworkDetailsNeoPageState,
  | 'networkCallsignsLoaded'
  | 'networkCallsignsLoading'
  | 'networkCallsignsError'
  | 'catalogCallsignsLoaded'
  | 'catalogCallsignsLoading'
  | 'catalogCallsignsError'
  | 'interceptedCallsignsLoaded'
  | 'interceptedCallsignsLoading'
  | 'interceptedCallsignsError'
>;

function deriveCallsignsLoading(sectionState: CallsignSectionState): boolean {
  return (
    !(
      sectionState.networkCallsignsLoaded &&
      sectionState.catalogCallsignsLoaded &&
      sectionState.interceptedCallsignsLoaded
    ) &&
    (sectionState.networkCallsignsLoading ||
      sectionState.catalogCallsignsLoading ||
      sectionState.interceptedCallsignsLoading)
  );
}

function deriveCallsignsLoaded(sectionState: CallsignSectionState): boolean {
  return (
    sectionState.networkCallsignsLoaded &&
    sectionState.catalogCallsignsLoaded &&
    sectionState.interceptedCallsignsLoaded
  );
}

function deriveCallsignsError(sectionState: CallsignSectionState): string | null {
  return (
    sectionState.networkCallsignsError ??
    sectionState.catalogCallsignsError ??
    sectionState.interceptedCallsignsError
  );
}

function buildCallsignSectionFlags(
  current: CallsignSectionState,
  next: Partial<CallsignSectionState>,
): Pick<NetworkDetailsNeoPageState, 'callsignsLoaded' | 'callsignsLoading' | 'callsignsError'> {
  const sectionState = {
    networkCallsignsLoaded: next.networkCallsignsLoaded ?? current.networkCallsignsLoaded,
    networkCallsignsLoading: next.networkCallsignsLoading ?? current.networkCallsignsLoading,
    networkCallsignsError: next.networkCallsignsError ?? current.networkCallsignsError,
    catalogCallsignsLoaded: next.catalogCallsignsLoaded ?? current.catalogCallsignsLoaded,
    catalogCallsignsLoading: next.catalogCallsignsLoading ?? current.catalogCallsignsLoading,
    catalogCallsignsError: next.catalogCallsignsError ?? current.catalogCallsignsError,
    interceptedCallsignsLoaded:
      next.interceptedCallsignsLoaded ?? current.interceptedCallsignsLoaded,
    interceptedCallsignsLoading:
      next.interceptedCallsignsLoading ?? current.interceptedCallsignsLoading,
    interceptedCallsignsError: next.interceptedCallsignsError ?? current.interceptedCallsignsError,
  };

  return {
    callsignsLoaded: deriveCallsignsLoaded(sectionState),
    callsignsLoading: deriveCallsignsLoading(sectionState),
    callsignsError: deriveCallsignsError(sectionState),
  };
}

function updateCallsignSectionState(
  current: CallsignSectionState,
  next: Partial<CallsignSectionState>,
): Pick<NetworkDetailsNeoPageState, 'callsignsLoaded' | 'callsignsLoading' | 'callsignsError'> {
  return buildCallsignSectionFlags(current, next);
}

export function deriveRelationsEnabledFreqs(
  currentRelationsEnabledFreqs: string[],
  currentRelations: NetworkCallsignRelationsRsp | null,
  relations: NetworkCallsignRelationsRsp,
  preserveCurrentSelection = true,
): string[] {
  void currentRelations;
  return buildNetworkCallsignRelationFreqState(
    relations,
    preserveCurrentSelection ? currentRelationsEnabledFreqs : [],
  ).resolvedEnabledFreqs;
}

export function isCurrentRelationsWindow(
  currentSince: string,
  currentTill: string,
  sinceDateInclusiveMs: number,
  tillDateNoninclusiveMs: number,
): boolean {
  return (
    parseDateInputInTimeZone(currentSince) === sinceDateInclusiveMs &&
    parseDateInputExclusiveEndInTimeZone(currentTill) === tillDateNoninclusiveMs
  );
}

export function derivePelengEnabledFreqs(
  currentPelengEnabledFreqs: string[],
  pelengPoints: Array<{ freq: string }>,
): string[] {
  const pelengFreqs = sortFrequenciesNumerically([
    ...new Set(pelengPoints.map((point) => normalizePelengationFrequency(point.freq))),
  ]);
  const nextEnabledFreqs = currentPelengEnabledFreqs.filter((freq) => pelengFreqs.includes(freq));
  return nextEnabledFreqs.length > 0 ? nextEnabledFreqs : pelengFreqs;
}

export function useRerNetworkDetailsNeoPageLoad(
  networkId: number,
  setState: SetState,
  reloadGeneration: ReloadGenerationRef,
): {
  reload: () => () => void;
  loadCallsigns: (networkId: number, periods?: CallsignsLoadPeriods) => Promise<void>;
  loadRelations: (
    networkId: number,
    sinceDateInclusiveMs: number,
    tillDateNoninclusiveMs: number,
  ) => Promise<void>;
  loadNetworkActivity: (networkId: number, period: NetworkGroupActivityPeriod) => Promise<void>;
  loadPelengPoints: (
    networkId: number,
    sinceDateInclusiveMs: number,
    tillDateNoninclusiveMs: number | null,
  ) => Promise<void>;
} {
  const networkCallsignsLoadRequestIdRef = useRef(0);
  const catalogCallsignsLoadRequestIdRef = useRef(0);
  const interceptedCallsignsLoadRequestIdRef = useRef(0);
  const relationsLoadRequestIdRef = useRef(0);
  const networkActivityLoadRequestIdRef = useRef(0);
  const pelengPointsLoadRequestIdRef = useRef(0);

  const loadNetworkCallsigns = useCallback(
    async (targetNetworkId: number, period: NetworkFreqCallsignsPeriod) => {
      const generation = reloadGeneration.current;
      const requestId = ++networkCallsignsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        networkCallsignsLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          networkCallsignsLoaded: false,
          networkCallsignsLoading: false,
          networkCallsignsError: 'Некоректний ID мережі',
          ...updateCallsignSectionState(current, {
            networkCallsignsLoaded: false,
            networkCallsignsLoading: false,
            networkCallsignsError: 'Некоректний ID мережі',
          }),
        }));
        return;
      }

      setState((current) => ({
        ...current,
        networkCallsignsLoaded: false,
        networkCallsignsLoading: true,
        networkCallsignsError: null,
        ...updateCallsignSectionState(current, {
          networkCallsignsLoaded: false,
          networkCallsignsLoading: true,
          networkCallsignsError: null,
        }),
      }));

      try {
        const [networkCallsignsRes, sources] = await Promise.all([
          listNetworkCallsigns({
            networkId: targetNetworkId,
            sortBy: ['NetworkCallsignAsc'],
            period,
          }),
          listSources(),
        ]);

        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          networkCallsigns: networkCallsignsRes.networkCallsigns,
          sources,
          callsignCount: networkCallsignsRes.networkCallsigns.length,
          networkCallsignsLoaded: true,
          networkCallsignsLoading: false,
          networkCallsignsError: null,
          callsignWarning: null,
          ...updateCallsignSectionState(current, {
            networkCallsignsLoaded: true,
            networkCallsignsLoading: false,
            networkCallsignsError: null,
          }),
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          networkCallsignsLoaded: false,
          networkCallsignsLoading: false,
          networkCallsignsError: formatErrorMessage(error),
          ...updateCallsignSectionState(current, {
            networkCallsignsLoaded: false,
            networkCallsignsLoading: false,
            networkCallsignsError: formatErrorMessage(error),
          }),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadCatalogCallsigns = useCallback(
    async (targetNetworkId: number, period: NetworkFreqCallsignsPeriod) => {
      const generation = reloadGeneration.current;
      const requestId = ++catalogCallsignsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        catalogCallsignsLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: false,
          catalogCallsignsError: 'Некоректний ID мережі',
          ...updateCallsignSectionState(current, {
            catalogCallsignsLoaded: false,
            catalogCallsignsLoading: false,
            catalogCallsignsError: 'Некоректний ID мережі',
          }),
        }));
        return;
      }

      setState((current) => ({
        ...current,
        catalogCallsignsLoaded: false,
        catalogCallsignsLoading: true,
        catalogCallsignsError: null,
        ...updateCallsignSectionState(current, {
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: true,
          catalogCallsignsError: null,
        }),
      }));

      try {
        const callsignsRes = await getNetworkCallsigns({
          networkId: targetNetworkId,
          includeActivityInfo: true,
          section: 'Catalog',
          period,
        });
        if (!isCurrent()) return;

        const activityMap = createNetworkCallsignActivityMap(
          callsignsRes.callsigns.map((item) => ({
            callsign: item.callsign,
            activity: {
              messageCount: item.messageCount,
              lastDatetime: item.lastDatetime,
              freqs: item.freqs,
            },
          })),
        );
        setState((current) => {
          const derived = buildNetworkCallsignTabData(
            callsignsRes.callsigns,
            activityMap,
            current.networkCallsigns,
          );
          const nextActivityMap = new Map(current.callsignActivityMap);
          activityMap.forEach((value, key) => nextActivityMap.set(key, value));
          return {
            ...current,
            callsignActivityMap: nextActivityMap,
            catalogCallsignGroups: derived.catalogCallsignGroups,
            catalogCallsignsLoaded: true,
            catalogCallsignsLoading: false,
            catalogCallsignsError: null,
            ...updateCallsignSectionState(current, {
              catalogCallsignsLoaded: true,
              catalogCallsignsLoading: false,
              catalogCallsignsError: null,
            }),
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        const errorMessage = formatErrorMessage(error);
        setState((current) => ({
          ...current,
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: false,
          catalogCallsignsError: errorMessage,
          ...updateCallsignSectionState(current, {
            catalogCallsignsLoaded: false,
            catalogCallsignsLoading: false,
            catalogCallsignsError: errorMessage,
          }),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadInterceptedCallsigns = useCallback(
    async (targetNetworkId: number, period: NetworkFreqCallsignsPeriod) => {
      const generation = reloadGeneration.current;
      const requestId = ++interceptedCallsignsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        interceptedCallsignsLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: false,
          interceptedCallsignsError: 'Некоректний ID мережі',
          ...updateCallsignSectionState(current, {
            interceptedCallsignsLoaded: false,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: 'Некоректний ID мережі',
          }),
        }));
        return;
      }

      setState((current) => ({
        ...current,
        interceptedCallsignsLoaded: false,
        interceptedCallsignsLoading: true,
        interceptedCallsignsError: null,
        ...updateCallsignSectionState(current, {
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: true,
          interceptedCallsignsError: null,
        }),
      }));

      try {
        const callsignsRes = await getNetworkCallsigns({
          networkId: targetNetworkId,
          includeActivityInfo: true,
          section: 'Intercepted',
          period,
        });
        if (!isCurrent()) return;

        const activityMap = createNetworkCallsignActivityMap(
          callsignsRes.callsigns.map((item) => ({
            callsign: item.callsign,
            activity: {
              messageCount: item.messageCount,
              lastDatetime: item.lastDatetime,
              freqs: item.freqs,
            },
          })),
        );
        setState((current) => {
          // Keep the intercepted period payload intact. Network-owned rows are
          // hidden at display time so narrowing the network period can restore them.
          const derived = buildNetworkCallsignTabData(callsignsRes.callsigns, activityMap, []);
          const nextActivityMap = new Map(current.callsignActivityMap);
          activityMap.forEach((value, key) => nextActivityMap.set(key, value));
          return {
            ...current,
            callsignActivityMap: nextActivityMap,
            unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
            interceptedCallsignsLoaded: true,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: null,
            ...updateCallsignSectionState(current, {
              interceptedCallsignsLoaded: true,
              interceptedCallsignsLoading: false,
              interceptedCallsignsError: null,
            }),
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        const errorMessage = formatErrorMessage(error);
        setState((current) => ({
          ...current,
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: false,
          interceptedCallsignsError: errorMessage,
          ...updateCallsignSectionState(current, {
            interceptedCallsignsLoaded: false,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: errorMessage,
          }),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadCandidateCallsignsCombined = useCallback(
    async (targetNetworkId: number, period: NetworkFreqCallsignsPeriod) => {
      const generation = reloadGeneration.current;
      const catalogRequestId = ++catalogCallsignsLoadRequestIdRef.current;
      const interceptedRequestId = ++interceptedCallsignsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        catalogCallsignsLoadRequestIdRef.current === catalogRequestId &&
        interceptedCallsignsLoadRequestIdRef.current === interceptedRequestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: false,
          catalogCallsignsError: 'Некоректний ID мережі',
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: false,
          interceptedCallsignsError: 'Некоректний ID мережі',
          ...updateCallsignSectionState(current, {
            catalogCallsignsLoaded: false,
            catalogCallsignsLoading: false,
            catalogCallsignsError: 'Некоректний ID мережі',
            interceptedCallsignsLoaded: false,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: 'Некоректний ID мережі',
          }),
        }));
        return;
      }

      setState((current) => ({
        ...current,
        catalogCallsignsLoaded: false,
        catalogCallsignsLoading: true,
        catalogCallsignsError: null,
        interceptedCallsignsLoaded: false,
        interceptedCallsignsLoading: true,
        interceptedCallsignsError: null,
        ...updateCallsignSectionState(current, {
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: true,
          catalogCallsignsError: null,
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: true,
          interceptedCallsignsError: null,
        }),
      }));

      try {
        const callsignsRes = await getNetworkCallsigns({
          networkId: targetNetworkId,
          includeActivityInfo: true,
          section: 'Everything',
          period,
        });
        if (!isCurrent()) return;

        const activityMap = createNetworkCallsignActivityMap(
          callsignsRes.callsigns.map((item) => ({
            callsign: item.callsign,
            activity: {
              messageCount: item.messageCount,
              lastDatetime: item.lastDatetime,
              freqs: item.freqs,
            },
          })),
        );
        setState((current) => {
          const derived = buildNetworkCallsignTabData(callsignsRes.callsigns, activityMap, []);
          const nextActivityMap = new Map(current.callsignActivityMap);
          activityMap.forEach((value, key) => nextActivityMap.set(key, value));
          return {
            ...current,
            callsignActivityMap: nextActivityMap,
            catalogCallsignGroups: derived.catalogCallsignGroups,
            unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
            catalogCallsignsLoaded: true,
            catalogCallsignsLoading: false,
            catalogCallsignsError: null,
            interceptedCallsignsLoaded: true,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: null,
            ...updateCallsignSectionState(current, {
              catalogCallsignsLoaded: true,
              catalogCallsignsLoading: false,
              catalogCallsignsError: null,
              interceptedCallsignsLoaded: true,
              interceptedCallsignsLoading: false,
              interceptedCallsignsError: null,
            }),
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        const errorMessage = formatErrorMessage(error);
        setState((current) => ({
          ...current,
          catalogCallsignsLoaded: false,
          catalogCallsignsLoading: false,
          catalogCallsignsError: errorMessage,
          interceptedCallsignsLoaded: false,
          interceptedCallsignsLoading: false,
          interceptedCallsignsError: errorMessage,
          ...updateCallsignSectionState(current, {
            catalogCallsignsLoaded: false,
            catalogCallsignsLoading: false,
            catalogCallsignsError: errorMessage,
            interceptedCallsignsLoaded: false,
            interceptedCallsignsLoading: false,
            interceptedCallsignsError: errorMessage,
          }),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadCallsigns = useCallback(
    async (
      targetNetworkId: number,
      periods: CallsignsLoadPeriods = {
        network: 'Last21Days',
        catalog: 'Last21Days',
        intercepted: 'Last21Days',
      },
    ) => {
      const tasks: Array<Promise<void>> = [];
      if (periods.network !== undefined) {
        tasks.push(loadNetworkCallsigns(targetNetworkId, periods.network));
      }

      const catalogPeriod = periods.catalog;
      const interceptedPeriod = periods.intercepted;
      if (
        catalogPeriod !== undefined &&
        interceptedPeriod !== undefined &&
        catalogPeriod === interceptedPeriod
      ) {
        // Same period: one Everything request avoids duplicate analytics work.
        tasks.push(loadCandidateCallsignsCombined(targetNetworkId, catalogPeriod));
      } else {
        if (catalogPeriod !== undefined) {
          tasks.push(loadCatalogCallsigns(targetNetworkId, catalogPeriod));
        }
        if (interceptedPeriod !== undefined) {
          tasks.push(loadInterceptedCallsigns(targetNetworkId, interceptedPeriod));
        }
      }

      await Promise.all(tasks);
    },
    [
      loadCandidateCallsignsCombined,
      loadCatalogCallsigns,
      loadInterceptedCallsigns,
      loadNetworkCallsigns,
    ],
  );

  const loadRelations = useCallback(
    async (
      targetNetworkId: number,
      sinceDateInclusiveMs: number,
      tillDateNoninclusiveMs: number,
    ) => {
      const generation = reloadGeneration.current;
      const requestId = ++relationsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation && relationsLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          relationsLoading: false,
          relationsLoaded: false,
          relationsError: 'Некоректний ID мережі',
        }));
        return;
      }

      setState((current) => ({
        ...current,
        relationsLoading: true,
        relationsError: null,
        relationsSelectedNodeId: null,
        relationsSelectedEdgeId: null,
      }));

      try {
        const relations = await getNetworkCallsignRelations({
          networkId: targetNetworkId,
          sinceDateInclusiveMs,
          tillDateNoninclusiveMs,
        });
        if (!isCurrent()) return;

        setState((current) => {
          if (
            !isCurrentRelationsWindow(
              current.relationsSince,
              current.relationsTill,
              sinceDateInclusiveMs,
              tillDateNoninclusiveMs,
            )
          ) {
            return {
              ...current,
              relationsLoading: false,
              relationsLoaded: false,
              relationsError: null,
            };
          }

          const frequencyResolution = resolveNetworkCallsignRelationFreqs(
            relations,
            current.relationsEnabledFreqs,
            current.relationsEnabledFreqsCustomized,
          );

          return {
            ...current,
            relations,
            relationsLoaded: true,
            relationsLoading: false,
            relationsError: null,
            relationsEnabledFreqs: frequencyResolution.enabledFreqs,
            relationsEnabledFreqsCustomized: frequencyResolution.customized,
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          relationsLoading: false,
          relationsLoaded: false,
          relationsError: formatErrorMessage(error),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadNetworkActivity = useCallback(
    async (targetNetworkId: number, period: NetworkGroupActivityPeriod) => {
      const generation = reloadGeneration.current;
      const requestId = ++networkActivityLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        networkActivityLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          networkActivityLoading: false,
          networkActivityLoaded: false,
          networkActivityError: 'Некоректний ID мережі',
        }));
        return;
      }

      setState((current) => ({
        ...current,
        networkActivityPeriod: period,
        networkActivityLoading: true,
        networkActivityError: null,
      }));

      try {
        const networkActivity = await getNetworkGroupsActivityOne(targetNetworkId, period);
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          networkActivity,
          networkActivityLoaded: true,
          networkActivityLoading: false,
          networkActivityError: null,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          networkActivityLoading: false,
          networkActivityLoaded: false,
          networkActivityError: formatErrorMessage(error),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadPelengPoints = useCallback(
    async (
      targetNetworkId: number,
      sinceDateInclusiveMs: number,
      tillDateNoninclusiveMs: number | null,
    ) => {
      const generation = reloadGeneration.current;
      const requestId = ++pelengPointsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        pelengPointsLoadRequestIdRef.current === requestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          pelengPointsLoading: false,
          pelengPointsLoaded: false,
          pelengPointsError: 'Некоректний ID мережі',
          pelengPointsRequestedFrom: null,
          pelengPointsRequestedTo: null,
          pelengPoints: [],
          networkSettlements: [],
          networkSettlementsPending: false,
        }));
        return;
      }

      setState((current) => ({
        ...current,
        pelengPointsLoading: true,
        pelengPointsError: null,
        pelengPointsLoaded: false,
        pelengPoints: [],
        networkSettlements: [],
        pelengPointsRequestedFrom: sinceDateInclusiveMs,
        pelengPointsRequestedTo: tillDateNoninclusiveMs,
      }));

      try {
        const response = await listNetworkPoints({
          networkId: targetNetworkId,
          sinceDateInclusiveMs,
          tillDateNoninclusiveMs,
        });

        if (!isCurrent()) return;

        setState((current) => {
          if (
            current.pelengPointsRequestedFrom !== sinceDateInclusiveMs ||
            current.pelengPointsRequestedTo !== tillDateNoninclusiveMs
          )
            return current;
          return {
            ...current,
            pelengPoints: response.points ?? [],
            networkSettlements: response.settlements ?? [],
            networkSettlementsPending: response.settlementsPending ?? false,
            pelengEnabledFreqs: derivePelengEnabledFreqs(
              current.pelengEnabledFreqs,
              response.points ?? [],
            ),
            pelengPointsLoaded: true,
            pelengPointsLoading: false,
            pelengPointsError: null,
            pelengPointsRequestedFrom: sinceDateInclusiveMs,
            pelengPointsRequestedTo: tillDateNoninclusiveMs,
          };
        });
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => {
          if (
            current.pelengPointsRequestedFrom !== sinceDateInclusiveMs ||
            current.pelengPointsRequestedTo !== tillDateNoninclusiveMs
          )
            return current;
          return {
            ...current,
            pelengPointsLoading: false,
            pelengPointsLoaded: false,
            pelengPointsError: formatErrorMessage(error),
            pelengPointsRequestedFrom: sinceDateInclusiveMs,
            pelengPointsRequestedTo: tillDateNoninclusiveMs,
          };
        });
      }
    },
    [reloadGeneration, setState],
  );

  const reload = useCallback(() => {
    reloadGeneration.current += 1;
    const generation = reloadGeneration.current;
    setState(EMPTY_STATE);
    reloadGeneration.current = generation;

    const isCurrent = () => reloadGeneration.current === generation;

    const currentUserPromise = fetchCurrentUser();
    void currentUserPromise
      .then((currentUser) => {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          currentUser,
          currentUserLoaded: true,
        }));
      })
      .catch(() => {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          currentUser: null,
          currentUserLoaded: true,
        }));
      });

    const loadCore = async () => {
      if (!Number.isFinite(networkId) || networkId <= 0) {
        setState((current) => ({ ...current, loading: false, error: 'Некоректний ID мережі' }));
        return;
      }

      try {
        const network = await getNetworkById(networkId);
        if (!isCurrent()) return;

        setState((current) => ({
          ...current,
          network,
          loading: false,
          error: null,
          expandedDescriptionIds: [],
          descriptionDrawerOpen: false,
          descriptionDrawerMode: 'create',
          descriptionDrawerDescrType: 'Confirmation',
          descriptionDrawerDescriptionId: null,
          descriptionDrawerForm: {
            topic: '',
            description: '',
            networkFreqId: null,
          },
          descriptionDrawerSaving: false,
          descriptionDrawerError: null,
          activeNetworkDetailsTab: current.activeNetworkDetailsTab,
          deleteDescriptionDialogOpen: false,
          deleteDescriptionTarget: null,
          deleteDescriptionSubmitting: false,
          deleteDescriptionError: null,
          relations: null,
          relationsLoaded: false,
          relationsLoading: false,
          relationsError: null,
          relationsSearch: '',
          relationsEnabledFreqs: [],
          relationsEnabledFreqsCustomized: false,
          relationsMinIntensity: 10,
          relationsShowLabels: true,
          relationsSelectedNodeId: null,
          relationsSelectedEdgeId: null,
          ...getDefaultNetworkRelationsDateRange(),
          ...getDefaultNetworkPelengDateRange(network),
          pelengSearch: '',
          pelengEnabledFreqs: [],
          pelengShowLabels: true,
        }));

        try {
          const referencedUnits = await getUnitsByIds(network.unitIds ?? []);
          if (!isCurrent()) return;
          setState((current) => ({
            ...current,
            units: mergeUnitsById(current.units, referencedUnits),
          }));
        } catch (error) {
          if (!isCurrent()) return;
          setState((current) => ({
            ...current,
            referenceWarning: formatErrorMessage(error),
          }));
        }
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          loading: false,
          error: formatErrorMessage(error),
        }));
      }
    };

    const loadReferences = async () => {
      try {
        const [units, posts, aors, encryptions, systemSettings] = await Promise.all([
          getUnitsList(),
          currentUserPromise.then((user) => (canUseRadioFeatures(user.roles) ? listPosts() : [])),
          listAors({ sortBy: null }),
          currentUserPromise.then((user) =>
            canUseRadioFeatures(user.roles) ? getEncryptions() : [],
          ),
          currentSystemSettings(),
        ]);
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          units: mergeUnitsById(current.units, units),
          posts,
          aors,
          encryptions,
          supportNonRerInterceptions: systemSettings.supportNonRerInterceptions,
          referenceLoading: false,
          referenceWarning: null,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          referenceLoading: false,
          referenceWarning: formatErrorMessage(error),
        }));
      }
    };

    void loadCore();
    void loadReferences();

    return () => {
      if (reloadGeneration.current === generation) {
        reloadGeneration.current += 1;
      }
    };
  }, [networkId, reloadGeneration, setState]);

  useEffect(() => {
    return reload();
  }, [reload]);

  return { reload, loadCallsigns, loadRelations, loadNetworkActivity, loadPelengPoints };
}
