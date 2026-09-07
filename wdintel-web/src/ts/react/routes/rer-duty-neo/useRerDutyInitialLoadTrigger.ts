import { useEffect, useRef } from 'react';
import type { MutableRefObject } from 'react';

import type { MessageFeedState } from './utils';

type Params = {
  messageFeeds: MessageFeedState[];
  shortStateReady: boolean;
  hasShortState: boolean;
  pendingReloadFeedIdsRef: MutableRefObject<Set<string>>;
  editReloadFeedIdsRef: MutableRefObject<Set<string>>;
  loadGenerationByFeedIdRef: MutableRefObject<Record<string, number>>;
  loadFeedInitialMessages: (
    feedId: string,
    options?: { preserveUnread?: boolean },
  ) => Promise<unknown>;
};

/** Starts each initial/reload generation once after its state is ready. */
export function useRerDutyInitialLoadTrigger(params: Params) {
  const startedKeysRef = useRef<Set<string>>(new Set());
  const loadRef = useRef(params.loadFeedInitialMessages);
  loadRef.current = params.loadFeedInitialMessages;

  useEffect(() => {
    if (params.hasShortState && !params.shortStateReady) return;
    const needingLoad = params.messageFeeds.filter(
      (feed) =>
        feed.loading &&
        (feed.items.length === 0 || params.pendingReloadFeedIdsRef.current.has(feed.id)),
    );
    const keyFor = (feed: MessageFeedState) =>
      `${feed.id}:${params.loadGenerationByFeedIdRef.current[feed.id] ?? 0}:${JSON.stringify(feed.filter)}`;
    const neededKeys = new Set(needingLoad.map(keyFor));
    startedKeysRef.current.forEach((key) => {
      if (!neededKeys.has(key)) startedKeysRef.current.delete(key);
    });
    needingLoad.forEach((feed) => {
      const key = keyFor(feed);
      if (startedKeysRef.current.has(key)) return;
      startedKeysRef.current.add(key);
      const preserveUnread = params.editReloadFeedIdsRef.current.delete(feed.id);
      void loadRef.current(feed.id, { preserveUnread });
    });
  }, [
    params.editReloadFeedIdsRef,
    params.hasShortState,
    params.loadGenerationByFeedIdRef,
    params.messageFeeds,
    params.pendingReloadFeedIdsRef,
    params.shortStateReady,
  ]);
}
