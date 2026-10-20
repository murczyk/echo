import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import type { AcknowledgeGroupFeedReq } from '../../../../../Bindings';
import { HttpRequestError } from '../../../services/api/client';
import { groupFeedStateStore, type GroupFeedStateStore } from './group-feed-state-store';
import type {
  GroupFeedNavigationModel,
  GroupNavigationItem,
  GroupScope,
} from './group-navigation.types';

type Options = {
  enabled: boolean;
  resolveSelectedGroupWhenHidden?: boolean;
  scope: GroupScope;
  allUnreadCount?: number;
  onSelect: (scope: GroupScope, oldestUnreadMessageRef: string | null) => void;
  onError: (error: unknown) => void;
  store?: GroupFeedStateStore;
};

export function useGroupFeedNavigation({
  enabled,
  resolveSelectedGroupWhenHidden = false,
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

  useEffect(() => {
    if (snapshot.error == null || snapshot.error === lastReportedError.current) return;
    lastReportedError.current = snapshot.error;
    onError(snapshot.error);
  }, [onError, snapshot.error]);

  const groups = useMemo<GroupNavigationItem[]>(() => {
    return [
      {
        kind: 'all',
        masterKey: null,
        name: 'Всі групи',
        unreadCount: allUnreadCount ?? 0,
        oldestUnreadMessageRef: null,
        latestCursor: null,
      },
      ...snapshot.groups.map((group) => ({ kind: 'group' as const, ...group })),
    ];
  }, [allUnreadCount, snapshot.groups]);
  const selectedGroupFromState =
    scope.kind === 'group'
      ? groups.find((group) => group.kind === 'group' && group.masterKey === scope.masterKey)
      : groups[0];
  const shouldResolveSelectedGroup =
    resolveSelectedGroupWhenHidden &&
    !enabled &&
    scope.kind === 'group' &&
    selectedGroupFromState == null &&
    !snapshot.loading &&
    snapshot.stale &&
    snapshot.error == null;

  useEffect(() => {
    if (!shouldResolveSelectedGroup) return;
    void store.ensureLoaded();
  }, [shouldResolveSelectedGroup, store]);

  const selectedGroup =
    scope.kind === 'group'
      ? (selectedGroupFromState ?? {
          kind: 'group' as const,
          masterKey: scope.masterKey,
          name: scope.masterKey,
          colorKey: 'blue_grey',
          ignoreOperativny: false,
          unreadCount: 0,
          oldestUnreadMessageRef: null,
          lastReadCreatedAtOrder: null,
          lastReadMessageId: null,
          lastActivityAt: null,
          latestCursor: null,
        })
      : groups[0]!;

  const acknowledge = useCallback(
    async (request: AcknowledgeGroupFeedReq, signal?: AbortSignal) => {
      try {
        return await store.acknowledge(request, signal);
      } catch (error) {
        if (!signal?.aborted && !(error instanceof HttpRequestError && error.status === 409)) {
          onError(error);
        }
        throw error;
      }
    },
    [onError, store],
  );

  const select = useCallback(
    (scope: GroupScope) => {
      const selected = groups.find((group) =>
        scope.kind === 'all'
          ? group.kind === 'all'
          : group.kind === 'group' && group.masterKey === scope.masterKey,
      );
      onSelect(scope, selected?.kind === 'group' ? selected.oldestUnreadMessageRef : null);
    },
    [groups, onSelect],
  );

  return {
    groups,
    scope,
    ready: !snapshot.stale,
    loading: snapshot.loading,
    error: snapshot.error,
    select,
    acknowledge,
    selectedGroup,
  };
}
