import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { rerDutyShortStateCreate, rerDutyShortStateGet } from '../../services/api/inbox';
import { currentSystemSettings } from '../../services/api/system-settings';
import {
  emptyFilter,
  getShortStateIdFromUrl,
  pushShortStateToUrl,
  pushStateToUrl,
  readPersistedDutyFeedOptionsById,
  stableStringify,
  toRerDutyStateFromShort,
  toShortQueryState,
} from './utils';
import type { MessageFeedState } from './utils';
import { createEmptyFeedState } from './useRerDutyInitialLoad';
import { buildPersistedDutyFilterState } from './duty-filter-persistence';

type Params = {
  messageFeeds: MessageFeedState[];
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
};

export function useRerDutyShortState(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const [featureEnabled, setFeatureEnabled] = useState(false);
  const [ready, setReady] = useState(false);
  const cachedStateRef = useRef<{ id: string | null; hash: string | null }>({
    id: null,
    hash: null,
  });
  const requestRef = useRef<{ requestId: number; hash: string | null }>({
    requestId: 0,
    hash: null,
  });
  const mountedRef = useRef(true);
  const shortStateIdRef = useRef(getShortStateIdFromUrl());
  const [persistedFeedOptionsById] = useState(() =>
    shortStateIdRef.current ? readPersistedDutyFeedOptionsById() : new Map(),
  );
  const [filterPersistenceReady, setFilterPersistenceReady] = useState(
    shortStateIdRef.current === null,
  );
  const initialFeedsHashRef = useRef(
    stableStringify(buildPersistedDutyFilterState(params.messageFeeds)),
  );
  const blockHydrationRef = useRef(false);

  useEffect(() => {
    if (filterPersistenceReady) return;
    const currentHash = stableStringify(buildPersistedDutyFilterState(params.messageFeeds));
    if (currentHash !== initialFeedsHashRef.current) {
      blockHydrationRef.current = true;
      setFilterPersistenceReady(true);
    }
  }, [filterPersistenceReady, params.messageFeeds]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const systemSettings = await currentSystemSettings();
        if (cancelled) return;
        const enabled = systemSettings.rerShortUrlEnabled ?? false;
        setFeatureEnabled(enabled);
        const shortId = shortStateIdRef.current;
        if (enabled && shortId) {
          try {
            const response = await rerDutyShortStateGet(shortId);
            if (cancelled) return;
            if (blockHydrationRef.current) {
              setFilterPersistenceReady(true);
              return;
            }
            const current = paramsRef.current;
            const currentHash = stableStringify(
              buildPersistedDutyFilterState(current.messageFeedsRef.current),
            );
            if (currentHash !== initialFeedsHashRef.current) {
              setFilterPersistenceReady(true);
              return;
            }
            const state = toRerDutyStateFromShort(response.state);
            cachedStateRef.current = { id: shortId, hash: stableStringify(response.state) };
            setFilterPersistenceReady(true);
            current.setMessageFeeds(
              (state.messageFeeds ?? [['mf-0', emptyFilter()]]).map(([id, filter]) =>
                createEmptyFeedState(id, filter, persistedFeedOptionsById.get(id)),
              ),
            );
          } catch (error) {
            if (!cancelled) {
              paramsRef.current.setError(error instanceof Error ? error.message : String(error));
            }
          }
        }
      } catch (error) {
        if (!cancelled) {
          paramsRef.current.setError(error instanceof Error ? error.message : String(error));
        }
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const persistStateToUrl = useCallback(
    (next: MessageFeedState[]) => {
      if (shortStateIdRef.current && !ready) blockHydrationRef.current = true;
      if (!featureEnabled) {
        pushStateToUrl({ messageFeeds: next.map((feed) => [feed.id, feed.filter]) });
        return;
      }
      const queryState = toShortQueryState(next);
      const stateHash = stableStringify(queryState);
      const cached = cachedStateRef.current;
      if (cached.id && cached.hash === stateHash) {
        requestRef.current = {
          requestId: requestRef.current.requestId + 1,
          hash: stateHash,
        };
        pushShortStateToUrl(cached.id);
        return;
      }
      pushStateToUrl({ messageFeeds: next.map((feed) => [feed.id, feed.filter]) });
      const requestId = requestRef.current.requestId + 1;
      requestRef.current = { requestId, hash: stateHash };
      rerDutyShortStateCreate(queryState)
        .then((response) => {
          if (!mountedRef.current) return;
          if (requestRef.current.requestId !== requestId) return;
          if (requestRef.current.hash !== stateHash) return;
          cachedStateRef.current = { id: response.id, hash: stateHash };
          pushShortStateToUrl(response.id);
        })
        .catch((error) => {
          if (!mountedRef.current) return;
          if (requestRef.current.requestId !== requestId) return;
          if (requestRef.current.hash !== stateHash) return;
          paramsRef.current.setError(error instanceof Error ? error.message : String(error));
          pushStateToUrl({ messageFeeds: next.map((feed) => [feed.id, feed.filter]) });
        });
    },
    [featureEnabled, ready],
  );

  return { ready, filterPersistenceReady, shortStateIdRef, persistStateToUrl };
}
