import { useCallback, useSyncExternalStore } from 'react';
import type { TailAvailability } from './types';

export type FeedColumnChrome = {
  bottomUnreadCount: number;
  arrowResultMessage: string | null;
  tailAvailability: TailAvailability;
};

const EMPTY_CHROME: FeedColumnChrome = {
  bottomUnreadCount: 0,
  arrowResultMessage: null,
  tailAvailability: 'unknown',
};

const chromeByFeedId = new Map<string, FeedColumnChrome>();
const listenersByFeedId = new Map<string, Set<() => void>>();

function emit(feedId: string): void {
  listenersByFeedId.get(feedId)?.forEach((listener) => listener());
}

export function publishFeedColumnChrome(feedId: string, chrome: FeedColumnChrome): void {
  const previous = chromeByFeedId.get(feedId);
  if (
    previous &&
    previous.bottomUnreadCount === chrome.bottomUnreadCount &&
    previous.arrowResultMessage === chrome.arrowResultMessage &&
    previous.tailAvailability === chrome.tailAvailability
  ) {
    return;
  }
  chromeByFeedId.set(feedId, chrome);
  emit(feedId);
}

export function clearFeedColumnChrome(feedId: string): void {
  if (!chromeByFeedId.has(feedId)) return;
  chromeByFeedId.delete(feedId);
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

function getSnapshot(feedId: string): FeedColumnChrome {
  return chromeByFeedId.get(feedId) ?? EMPTY_CHROME;
}

export function useFeedColumnChrome(feedId: string): FeedColumnChrome {
  const subscribeFeed = useCallback(
    (listener: () => void) => subscribe(feedId, listener),
    [feedId],
  );
  const get = useCallback(() => getSnapshot(feedId), [feedId]);
  return useSyncExternalStore(subscribeFeed, get, get);
}
