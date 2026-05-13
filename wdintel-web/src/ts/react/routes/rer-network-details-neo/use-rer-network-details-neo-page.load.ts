import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, SetStateAction, MutableRefObject } from 'react';

import { listAors } from '../../services/api/aor';
import { getNetworkById } from '../../services/api/networks';
import { getModulations } from '../../services/api/modulations';
import { listNetworkCallsigns, getNetworkCallsigns, getNetworkCallsignsActivity, listSources } from '../../services/api/callsigns';
import { getUnitsList } from '../../services/api/units';
import { listPosts } from '../../services/api/posts';
import { fetchCurrentUser } from '../../services/api/user';
import {
  EMPTY_STATE,
  formatErrorMessage,
  type NetworkDetailsNeoPageState,
} from './use-rer-network-details-neo-page.shared';
import {
  buildNetworkCallsignTabData,
  createNetworkCallsignActivityMap,
} from './network-callsigns';

type ReloadGenerationRef = MutableRefObject<number>;

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

export function useRerNetworkDetailsNeoPageLoad(
  networkId: number,
  setState: SetState,
  reloadGeneration: ReloadGenerationRef,
): {
  reload: () => () => void;
  loadCallsigns: (networkId: number) => Promise<void>;
} {
  const callsignLoadRequestIdRef = useRef(0);

  const loadCallsigns = useCallback(async (targetNetworkId: number) => {
    const generation = reloadGeneration.current;
    const requestId = ++callsignLoadRequestIdRef.current;
    const isCurrent = () => reloadGeneration.current === generation && callsignLoadRequestIdRef.current === requestId;

    if (!Number.isFinite(targetNetworkId) || targetNetworkId <= 0) {
      if (!isCurrent()) return;
      setState((current) => ({
        ...current,
        callsignsLoading: false,
        callsignsError: 'Некоректний ID мережі',
      }));
      return;
    }

    setState((current) => ({
      ...current,
      callsignsLoading: true,
      callsignsError: null,
    }));

    try {
      const [networkCallsignsRes, callsignsRes, sources] = await Promise.all([
        listNetworkCallsigns({ networkId: targetNetworkId, sortBy: ['NetworkCallsignAsc'] }),
        getNetworkCallsigns({ networkId: targetNetworkId, includeActivityInfo: true }),
        listSources(),
      ]);

      if (!isCurrent()) return;

      const callsignsForActivity = [...new Set(callsignsRes.callsigns.map((item) => item.callsign).filter((callsign) => callsign.trim() !== ''))];
      const activityRes =
        callsignsForActivity.length === 0
          ? { callsignsActivity: [] }
          : await getNetworkCallsignsActivity({ networkId: targetNetworkId, callsigns: callsignsForActivity });

      if (!isCurrent()) return;

      const activityMap = createNetworkCallsignActivityMap(
        (activityRes.callsignsActivity ?? []).map((item) => ({
          callsign: item.callsign,
          activity: item.activity,
        })),
      );
      const derived = buildNetworkCallsignTabData(callsignsRes.callsigns, activityMap, networkCallsignsRes.networkCallsigns);

      setState((current) => ({
        ...current,
        networkCallsigns: networkCallsignsRes.networkCallsigns,
        networkCallsignGroups: callsignsRes.callsigns,
        callsignActivityMap: activityMap,
        catalogCallsignGroups: derived.catalogCallsignGroups,
        unknownInterceptedCallsigns: derived.unknownInterceptedCallsigns,
        sources,
        callsignCount: networkCallsignsRes.networkCallsigns.length,
        callsignsLoaded: true,
        callsignsLoading: false,
        callsignsError: null,
        callsignWarning: null,
      }));
    } catch (error) {
      if (!isCurrent()) return;
      setState((current) => ({
        ...current,
        callsignsLoading: false,
        callsignsError: formatErrorMessage(error),
      }));
    }
  }, [reloadGeneration, setState]);

  const reload = useCallback(() => {
    reloadGeneration.current += 1;
    const generation = reloadGeneration.current;
    setState(EMPTY_STATE);
    reloadGeneration.current = generation;

    const isCurrent = () => reloadGeneration.current === generation;

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
            description: '',
            networkFreqId: null,
          },
          descriptionDrawerSaving: false,
          descriptionDrawerError: null,
          activeNetworkDetailsTab: 'descriptions',
          deleteDescriptionDialogOpen: false,
          deleteDescriptionTarget: null,
          deleteDescriptionSubmitting: false,
          deleteDescriptionError: null,
        }));

        void fetchCurrentUser()
          .then((currentUser) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              currentUser,
            }));
          })
          .catch(() => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              currentUser: null,
            }));
          });
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
        const [units, posts, aors, modulations] = await Promise.all([
          getUnitsList(),
          listPosts(),
          listAors({ sortBy: null }),
          getModulations(),
        ]);
        if (!isCurrent()) return;
        setState((current) => ({
          ...current,
          units,
          posts,
          aors,
          modulations,
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

  return { reload, loadCallsigns };
}
