import { useCallback, type Dispatch, type SetStateAction } from 'react';

import { buildNetworkCallsignRelationFreqState } from './network-relations';
import {
  getPublicNetworkDetailsTab,
  updateCurrentNetworkDetailsTabUrl,
} from './network-details-tab-url';
import {
  normalizeNetworkPelengSinceChange,
  normalizeNetworkPelengTillChange,
  normalizeNetworkRelationsSinceChange,
  normalizeNetworkRelationsTillChange,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import { canUseRadioFeatures } from '../../utils/roles';

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

export function useRerNetworkDetailsNeoPageTabControls(
  setState: SetState,
  setRequestedNetworkDetailsTab: (tab: string | null) => void,
) {
  const setRelationsSearch = useCallback(
    (relationsSearch: string) => {
      setState((current) => ({ ...current, relationsSearch }));
    },
    [setState],
  );

  const setRelationsEnabledFreqs = useCallback(
    (relationsEnabledFreqs: string[]) => {
      setState((current) => {
        const { defaultEnabledFreqs, resolvedEnabledFreqs } = buildNetworkCallsignRelationFreqState(
          current.relations,
          relationsEnabledFreqs,
        );
        const relationsEnabledFreqsCustomized =
          resolvedEnabledFreqs.length !== defaultEnabledFreqs.length ||
          resolvedEnabledFreqs.some((freq) => !defaultEnabledFreqs.includes(freq));

        return {
          ...current,
          relationsEnabledFreqs: resolvedEnabledFreqs,
          relationsEnabledFreqsCustomized,
        };
      });
    },
    [setState],
  );

  const setRelationsMinIntensity = useCallback(
    (relationsMinIntensity: number) => {
      setState((current) => ({ ...current, relationsMinIntensity }));
    },
    [setState],
  );

  const setRelationsShowLabels = useCallback(
    (relationsShowLabels: boolean) => {
      setState((current) => ({ ...current, relationsShowLabels }));
    },
    [setState],
  );

  const setRelationsSelectedNodeId = useCallback(
    (relationsSelectedNodeId: string | null) => {
      setState((current) => ({
        ...current,
        relationsSelectedNodeId,
        relationsSelectedEdgeId: null,
      }));
    },
    [setState],
  );

  const setRelationsSelectedEdgeId = useCallback(
    (relationsSelectedEdgeId: string | null) => {
      setState((current) => ({
        ...current,
        relationsSelectedEdgeId,
        relationsSelectedNodeId: null,
      }));
    },
    [setState],
  );

  const setRelationsSince = useCallback(
    (relationsSince: string) => {
      setState((current) => {
        const next = normalizeNetworkRelationsSinceChange(
          current.relationsSince,
          current.relationsTill,
          relationsSince,
        );
        return {
          ...current,
          ...next,
          relationsLoaded: false,
          relationsError: null,
        };
      });
    },
    [setState],
  );

  const setRelationsTill = useCallback(
    (relationsTill: string) => {
      setState((current) => {
        const next = normalizeNetworkRelationsTillChange(
          current.relationsSince,
          current.relationsTill,
          relationsTill,
        );
        return {
          ...current,
          ...next,
          relationsLoaded: false,
          relationsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengSince = useCallback(
    (pelengSince: string) => {
      setState((current) => {
        const next = normalizeNetworkPelengSinceChange(
          current.pelengSince,
          current.pelengTill,
          pelengSince,
        );
        return {
          ...current,
          ...next,
          pelengPointsLoaded: false,
          pelengPointsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengTill = useCallback(
    (pelengTill: string) => {
      setState((current) => {
        const next = normalizeNetworkPelengTillChange(
          current.pelengSince,
          current.pelengTill,
          pelengTill,
        );
        return {
          ...current,
          ...next,
          pelengPointsLoaded: false,
          pelengPointsError: null,
        };
      });
    },
    [setState],
  );

  const setPelengSearch = useCallback(
    (pelengSearch: string) => {
      setState((current) => ({ ...current, pelengSearch }));
    },
    [setState],
  );

  const setPelengEnabledFreqs = useCallback(
    (pelengEnabledFreqs: string[]) => {
      setState((current) => ({ ...current, pelengEnabledFreqs: [...pelengEnabledFreqs] }));
    },
    [setState],
  );

  const setPelengShowLabels = useCallback(
    (pelengShowLabels: boolean) => {
      setState((current) => ({ ...current, pelengShowLabels }));
    },
    [setState],
  );

  const setPelengBaseLayerId = useCallback(
    (pelengBaseLayerId: NetworkDetailsNeoPageState['pelengBaseLayerId']) => {
      setState((current) => ({ ...current, pelengBaseLayerId }));
    },
    [setState],
  );

  const setPelengHeatmapEnabled = useCallback(
    (pelengHeatmapEnabled: boolean) => {
      setState((current) => ({ ...current, pelengHeatmapEnabled }));
    },
    [setState],
  );

  const setActiveNetworkDetailsTab = useCallback(
    (activeNetworkDetailsTab: NetworkDetailsNeoPageState['activeNetworkDetailsTab']) => {
      setState((current) => {
        const nextTab =
          !canUseRadioFeatures(current.currentUser?.roles) &&
          (activeNetworkDetailsTab === 'frequencies' ||
            activeNetworkDetailsTab === 'direction-finding')
            ? 'descriptions'
            : activeNetworkDetailsTab;
        if (
          current.activeNetworkDetailsTab === nextTab &&
          current.callsignSectionMode === 'network'
        ) {
          return current;
        }
        return {
          ...current,
          activeNetworkDetailsTab: nextTab,
          callsignSectionMode: 'network',
        };
      });
      setRequestedNetworkDetailsTab(getPublicNetworkDetailsTab(activeNetworkDetailsTab));
      updateCurrentNetworkDetailsTabUrl(activeNetworkDetailsTab, 'push');
    },
    [setRequestedNetworkDetailsTab, setState],
  );

  return {
    setRelationsSearch,
    setRelationsEnabledFreqs,
    setRelationsMinIntensity,
    setRelationsShowLabels,
    setRelationsSelectedNodeId,
    setRelationsSelectedEdgeId,
    setRelationsSince,
    setRelationsTill,
    setPelengSince,
    setPelengTill,
    setPelengSearch,
    setPelengEnabledFreqs,
    setPelengShowLabels,
    setPelengBaseLayerId,
    setPelengHeatmapEnabled,
    setActiveNetworkDetailsTab,
  };
}
