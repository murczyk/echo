import { useCallback, useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { Dispatch, SetStateAction } from 'react';

import type { Network } from '../../../../Bindings';
import { listAors } from '../../services/api/aor';
import { getNetworkById, getNetworkCallsignsList } from '../../services/api/networks';
import { getModulations } from '../../services/api/modulations';
import { getUnitsList } from '../../services/api/units';
import { listPosts } from '../../services/api/posts';
import { fetchCurrentUser } from '../../services/api/user';
import { EMPTY_STATE, formatErrorMessage, type NetworkDetailsNeoPageState } from './use-rer-network-details-neo-page.shared';

type ReloadGenerationRef = MutableRefObject<number>;

type SetState = Dispatch<SetStateAction<NetworkDetailsNeoPageState>>;

export function useRerNetworkDetailsNeoPageLoad(
  networkId: number,
  setState: SetState,
  reloadGeneration: ReloadGenerationRef,
): () => void {
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
          activeDescriptionTab: 'justifications',
          deleteDescriptionDialogOpen: false,
          deleteDescriptionTarget: null,
          deleteDescriptionSubmitting: false,
          deleteDescriptionError: null,
        }));

        void getNetworkCallsignsList(networkId, true)
          .then((callsignsRes) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              callsignCount: callsignsRes.callsigns.length,
              callsignWarning: null,
            }));
          })
          .catch((error) => {
            if (!isCurrent()) return;
            setState((current) => ({
              ...current,
              callsignCount: null,
              callsignWarning: formatErrorMessage(error),
            }));
          });

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

  return reload;
}
