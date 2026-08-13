import { useCallback, useSyncExternalStore } from 'react';
import type { TailAvailability } from './types';

export type FeedColumnFabState = {
  bottomUnreadCount: number;
  arrowResultMessage: string | null;
  tailAvailability: TailAvailability;
};

const EMPTY_FAB_STATE: FeedColumnFabState = {
  bottomUnreadCount: 0,
  arrowResultMessage: null,
  tailAvailability: 'unknown',
};

const fabByFeedId = new Map<string, FeedColumnFabState>();
const listenersByFeedId = new Map<string, Set<() => void>>();

function emit(feedId: string): void {
  listenersByFeedId.get(feedId)?.forEach((listener) => listener());
}

export function publishFeedColumnFab(feedId: string, fab: FeedColumnFabState): void {
  const previous = fabByFeedId.get(feedId);
  if (
    previous &&
    previous.bottomUnreadCount === fab.bottomUnreadCount &&
    previous.arrowResultMessage === fab.arrowResultMessage &&
    previous.tailAvailability === fab.tailAvailability
  ) {
    return;
  }
  fabByFeedId.set(feedId, fab);
  emit(feedId);
}

export function clearFeedColumnFab(feedId: string): void {
  if (!fabByFeedId.has(feedId)) return;
  fabByFeedId.delete(feedId);
  emit(feedId);
}

function subscribe(feedId: string, listener: () => void): () => void {
  let listeners = listenersByFeedId.get(feedId);
  if (!listeners) {
    listeners = new Set();
    listenersByFeedId.set(feedId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) listenersByFeedId.delete(feedId);
  };
}

function getSnapshot(feedId: string): FeedColumnFabState {
  return fabByFeedId.get(feedId) ?? EMPTY_FAB_STATE;
}

export function useFeedColumnFab(feedId: string): FeedColumnFabState {
  const subscribeFeed = useCallback(
    (listener: () => void) => subscribe(feedId, listener),
    [feedId],
  );
  const get = useCallback(() => getSnapshot(feedId), [feedId]);
  return useSyncExternalStore(subscribeFeed, get, get);
}
