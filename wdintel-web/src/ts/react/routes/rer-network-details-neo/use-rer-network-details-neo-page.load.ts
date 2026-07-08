import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';
import type { NetworkCallsignRelationsRsp, NetworkCallsignRes } from '../../../../Bindings';

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
  getNetworkCallsignsActivity,
  listSources,
} from '../../services/api/callsigns';
import { getUnitsList } from '../../services/api/units';
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
import { normalizeCallsignDisplay } from './network-callsigns.utils';
import { buildNetworkCallsignRelationFreqState } from './network-relations';

type ReloadGenerationRef = MutableRefObject<number>;

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

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

type CallsignDerivedDataOverrides = {
  networkCallsignGroups?: NetworkDetailsNeoPageState['networkCallsignGroups'];
  callsignActivityMap?: NetworkDetailsNeoPageState['callsignActivityMap'];
  networkCallsigns?: NetworkDetailsNeoPageState['networkCallsigns'];
};

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

function recomputeCallsignDerivedData(
  current: NetworkDetailsNeoPageState,
  overrides: CallsignDerivedDataOverrides = {},
) {
  const networkCallsignGroups = overrides.networkCallsignGroups ?? current.networkCallsignGroups;
  const callsignActivityMap = overrides.callsignActivityMap ?? current.callsignActivityMap;
  const networkCallsigns = overrides.networkCallsigns ?? current.networkCallsigns;

  return buildNetworkCallsignTabData(networkCallsignGroups, callsignActivityMap, networkCallsigns);
}

export function deriveRelationsEnabledFreqs(
  currentRelationsEnabledFreqs: string[],
  currentRelations: NetworkCallsignRelationsRsp | null,
  relations: NetworkCallsignRelationsRsp,
): string[] {
  void currentRelations;
  return buildNetworkCallsignRelationFreqState(relations, currentRelationsEnabledFreqs)
    .resolvedEnabledFreqs;
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
  loadCallsigns: (networkId: number) => Promise<void>;
  loadRelations: (
    networkId: number,
    sinceDateInclusiveMs: number,
    tillDateNoninclusiveMs: number,
  ) => Promise<void>;
  loadNetworkActivity: (networkId: number) => Promise<void>;
  loadPelengPoints: (
    networkId: number,
    sinceDateInclusiveMs: number,
    tillDateNoninclusiveMs: number | null,
  ) => Promise<void>;
} {
  const networkCallsignsLoadRequestIdRef = useRef(0);
  const catalogCallsignsLoadRequestIdRef = useRef(0);
  const interceptedCallsignsLoadRequestIdRef = useRef(0);
  const callsignActivityLoadRequestIdRef = useRef(0);
  const relationsLoadRequestIdRef = useRef(0);
  const networkActivityLoadRequestIdRef = useRef(0);
  const pelengPointsLoadRequestIdRef = useRef(0);

  const loadNetworkCallsigns = useCallback(
    async (targetNetworkId: number) => {
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
        networkCallsigns: [],
        callsignCount: null,
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
          listNetworkCallsigns({ networkId: targetNetworkId, sortBy: ['NetworkCallsignAsc'] }),
          listSources(),
        ]);

        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          ...recomputeCallsignDerivedData(current, {
            networkCallsigns: networkCallsignsRes.networkCallsigns,
          }),
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

  const loadCandidateCallsigns = useCallback(
    async (targetNetworkId: number) => {
      const generation = reloadGeneration.current;
      const requestId = ++catalogCallsignsLoadRequestIdRef.current;
      const interceptedRequestId = ++interceptedCallsignsLoadRequestIdRef.current;
      const isCurrent = () =>
        reloadGeneration.current === generation &&
        catalogCallsignsLoadRequestIdRef.current === requestId &&
        interceptedCallsignsLoadRequestIdRef.current === interceptedRequestId;

      if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
        if (!isCurrent()) return null;
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
        return null;
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

      let callsignsRes: Awaited<ReturnType<typeof getNetworkCallsigns>>;
      try {
        callsignsRes = await getNetworkCallsigns({
          networkId: targetNetworkId,
          includeActivityInfo: false,
          section: 'Everything',
        });
      } catch (error) {
        if (!isCurrent()) return null;
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
        return null;
      }

      if (!isCurrent()) return null;
      setState((current) => {
        const derived = recomputeCallsignDerivedData(current, {
          networkCallsignGroups: callsignsRes.callsigns,
        });
        return {
          ...current,
          networkCallsignGroups: callsignsRes.callsigns,
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

      return callsignsRes.callsigns;
    },
    [reloadGeneration, setState],
  );

  const loadCallsignActivity = useCallback(
    async (targetNetworkId: number, callsigns: NetworkCallsignRes[]) => {
      const callsignsForActivity = [
        ...new Set(
          callsigns.map((item) => item.callsign).filter((callsign) => callsign.trim() !== ''),
        ),
      ];
      if (callsignsForActivity.length === 0) return;

      const generation = reloadGeneration.current;
      const requestId = ++callsignActivityLoadRequestIdRef.current;

      try {
        const activityRes = await getNetworkCallsignsActivity({
          networkId: targetNetworkId,
          callsigns: callsignsForActivity,
        });
        const isCurrent = () =>
          reloadGeneration.current === generation &&
          callsignActivityLoadRequestIdRef.current === requestId;
        if (!isCurrent()) return;

        const activityMap = createNetworkCallsignActivityMap(
          (activityRes.callsignsActivity ?? []).map((item) => ({
            callsign: item.callsign,
            activity: item.activity,
          })),
        );

        setState((current) => {
          const derived = recomputeCallsignDerivedData(current, {
            callsignActivityMap: activityMap,
          });
          return {
            ...current,
            callsignActivityMap: activityMap,
            catalogCallsignGroups: derived.catalogCallsignGroups,
            unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
          };
        });
      } catch (error) {
        if (
          reloadGeneration.current !== generation ||
          callsignActivityLoadRequestIdRef.current !== requestId
        ) {
          return;
        }

        setState((current) => ({
          ...current,
          callsignsError: formatErrorMessage(error),
        }));
      }
    },
    [reloadGeneration, setState],
  );

  const loadCallsigns = useCallback(
    async (targetNetworkId: number) => {
      const networkCallsignsTask = loadNetworkCallsigns(targetNetworkId);
      const candidateCallsigns = await loadCandidateCallsigns(targetNetworkId);
      const activityTask =
        candidateCallsigns !== null && candidateCallsigns.length > 0
          ? loadCallsignActivity(targetNetworkId, candidateCallsigns)
          : Promise.resolve();
      await Promise.all([networkCallsignsTask, activityTask]);
    },
    [loadCallsignActivity, loadCandidateCallsigns, loadNetworkCallsigns],
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

          return {
            ...current,
            relations,
            relationsLoaded: true,
            relationsLoading: false,
            relationsError: null,
            relationsEnabledFreqs: deriveRelationsEnabledFreqs(
              current.relationsEnabledFreqs,
              current.relations,
              relations,
            ),
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
    async (targetNetworkId: number) => {
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
        networkActivityLoading: true,
        networkActivityError: null,
      }));

      try {
        const networkActivity = await getNetworkGroupsActivityOne(targetNetworkId);
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
        }));
        return;
      }

      setState((current) => ({
        ...current,
        pelengPointsLoading: true,
        pelengPointsError: null,
        pelengPointsLoaded: false,
        pelengPoints: [],
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

        setState((current) => ({
          ...current,
          pelengPoints: response.points ?? [],
          pelengEnabledFreqs: derivePelengEnabledFreqs(
            current.pelengEnabledFreqs,
            response.points ?? [],
          ),
          pelengPointsLoaded: true,
          pelengPointsLoading: false,
          pelengPointsError: null,
          pelengPointsRequestedFrom: sinceDateInclusiveMs,
          pelengPointsRequestedTo: tillDateNoninclusiveMs,
        }));
      } catch (error) {
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          pelengPointsLoading: false,
          pelengPointsLoaded: false,
          pelengPointsError: formatErrorMessage(error),
          pelengPointsRequestedFrom: sinceDateInclusiveMs,
          pelengPointsRequestedTo: tillDateNoninclusiveMs,
        }));
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

    void fetchCurrentUser()
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
          listPosts(),
          listAors({ sortBy: null }),
          getEncryptions(),
          currentSystemSettings(),
        ]);
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          units,
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
