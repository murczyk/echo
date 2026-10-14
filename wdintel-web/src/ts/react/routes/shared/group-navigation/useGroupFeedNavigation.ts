import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { AcknowledgeGroupFeedReq } from '../../../../../Bindings';
import { useInboxChangedMessageIds } from '../useInboxChangedMessageIds';
import { groupFeedStateStore, type GroupFeedStateStore } from './group-feed-state-store';
import type {
  GroupFeedNavigationModel,
  GroupNavigationItem,
  GroupScope,
} from './group-navigation.types';

type Options = {
  enabled: boolean;
  scope: GroupScope;
  allUnreadCount?: number;
  onSelect: (scope: GroupScope) => void;
  onError: (error: unknown) => void;
  store?: GroupFeedStateStore;
};

export function useGroupFeedNavigation({
  enabled,
  scope,
  allUnreadCount,
  onSelect,
  onError,
  store = groupFeedStateStore,
}: Options): GroupFeedNavigationModel {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const lastReportedError = useRef<unknown>(null);

  useEffect(() => {
    if (!enabled) return;
    return store.addVisibleConsumer();
  }, [enabled, store]);

  useInboxChangedMessageIds({
    onMessageIds: useCallback(() => {
      if (!enabled) return;
      store.invalidate();
    }, [enabled, store]),
  });

  useEffect(() => {
    if (!enabled) return;
    const revalidate = () => {
      if (document.visibilityState === 'visible') void store.revalidateIfStale();
    };
    window.addEventListener('focus', revalidate);
    document.addEventListener('visibilitychange', revalidate);
    return () => {
      window.removeEventListener('focus', revalidate);
      document.removeEventListener('visibilitychange', revalidate);
    };
  }, [enabled, store]);

  useEffect(() => {
    if (snapshot.error == null || snapshot.error === lastReportedError.current) return;
    lastReportedError.current = snapshot.error;
    onError(snapshot.error);
  }, [onError, snapshot.error]);

  const groups = useMemo<GroupNavigationItem[]>(() => {
    const aggregateUnreadCount =
      allUnreadCount ?? snapshot.groups.reduce((sum, group) => sum + group.unreadCount, 0);
    return [
      {
        kind: 'all',
        masterKey: null,
        name: 'Всі групи',
        unreadCount: aggregateUnreadCount,
        oldestUnreadMessageRef: null,
        latestCursor: null,
      },
      ...snapshot.groups.map((group) => ({ kind: 'group' as const, ...group })),
    ];
  }, [allUnreadCount, snapshot.groups]);
  const selectedGroup =
    scope.kind === 'group'
      ? (groups.find((group) => group.kind === 'group' && group.masterKey === scope.masterKey) ?? {
          kind: 'group' as const,
          masterKey: scope.masterKey,
          name: scope.masterKey,
          ignoreOperativny: false,
          unreadCount: 0,
          oldestUnreadMessageRef: null,
          lastActivityAt: null,
          latestCursor: null,
        })
      : groups[0];

  const acknowledge = useCallback(
    async (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => {
      try {
        return await store.acknowledge(request, signal);
      } catch (error) {
        if (!signal?.aborted) onError(error);
        throw error;
      }
    },
    [onError, store],
  );

  return {
    groups,
    scope,
    ready: !snapshot.stale,
    loading: snapshot.loading,
    error: snapshot.error,
    select: onSelect,
    refresh: store.refresh,
    acknowledge,
    selectedGroup,
    selectedCursor: selectedGroup.latestCursor,
  };
}
