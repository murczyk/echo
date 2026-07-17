import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  CallsignInfoRes,
  InboxMessagesReq,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/inbox';
import { appendWindowedMessageItems, prependWindowedMessageItems } from './utils';
import type { MessageFeedState } from './utils';

type NewerLoadOptions = {
  nolimit?: boolean;
  scrollToEndAfterLoad?: boolean;
  markAllReadAfterAppend?: boolean;
  skipIfNewestExhausted?: boolean;
};

type DirectionalOperation = {
  direction: 'older' | 'newer';
  promise: Promise<void>;
  resolve: () => void;
  newerOptions: Required<NewerLoadOptions>;
  phase: 'running' | 'awaitingCommit';
  run: () => Promise<void>;
};

type DirectionalLane = {
  active: DirectionalOperation | null;
  queued: DirectionalOperation[];
};

type Params = {
  messageFeeds: MessageFeedState[];
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  loadingNewerFeedIds: Set<string>;
  setLoadingNewerFeedIds: Dispatch<SetStateAction<Set<string>>>;
  buildReqForFeed: (
    feed: MessageFeedState,
    options: {
      beforeIdNoninclusive?: number;
      sinceIdNoninclusive?: number;
      nolimit?: boolean;
    },
  ) => InboxMessagesReq;
  getFeedLoadGeneration: (feedId: string) => number;
  mergeInboxCallsigns: (feedId: string, callsigns: CallsignInfoRes[] | null | undefined) => void;
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  getFeedCountSignature: (feed: MessageFeedState) => string;
  advanceFeedReadCursor: (
    feedId: string,
    cursorId: number,
    remainingUnreadCount: number,
    requestSignature: string,
  ) => void;
  newestExhaustedCursorByFeedIdRef: MutableRefObject<Record<string, number>>;
  scrollToEndAfterNewerRef: MutableRefObject<Set<string>>;
  nearBottomByFeedIdRef: MutableRefObject<Record<string, boolean>>;
};

function createOperation(
  direction: 'older' | 'newer',
  options?: NewerLoadOptions,
): DirectionalOperation {
  let resolve!: () => void;
  let settled = false;
  const promise = new Promise<void>((settle) => {
    resolve = () => {
      if (settled) return;
      settled = true;
      settle();
    };
  });
  return {
    direction,
    promise,
    resolve,
    newerOptions: {
      nolimit: options?.nolimit ?? false,
      scrollToEndAfterLoad: options?.scrollToEndAfterLoad ?? false,
      markAllReadAfterAppend: options?.markAllReadAfterAppend ?? false,
      skipIfNewestExhausted: options?.skipIfNewestExhausted ?? false,
    },
    phase: 'running',
    run: async () => {},
  };
}

export function useRerDutyDirectionalLoads(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;
  const lanesRef = useRef<Record<string, DirectionalLane>>({});
  const invalidatedLoadingFeedIdsRef = useRef<Set<string>>(new Set());
  const startOperationRef = useRef<(feedId: string) => void>(() => {});

  const getLane = useCallback((feedId: string): DirectionalLane => {
    return (lanesRef.current[feedId] ??= { active: null, queued: [] });
  }, []);

  useLayoutEffect(() => {
    params.messageFeedsRef.current = params.messageFeeds;
    Object.entries(lanesRef.current).forEach(([feedId, lane]) => {
      if (lane.active?.phase === 'awaitingCommit') {
        lane.active.resolve();
        lane.active = null;
      }
      startOperationRef.current(feedId);
    });
    if (invalidatedLoadingFeedIdsRef.current.size > 0) {
      const invalidatedFeedIds = invalidatedLoadingFeedIdsRef.current;
      invalidatedLoadingFeedIdsRef.current = new Set();
      params.setLoadingNewerFeedIds((previous) => {
        const next = new Set(previous);
        invalidatedFeedIds.forEach((feedId) => {
          if (lanesRef.current[feedId]?.active?.direction !== 'newer') next.delete(feedId);
        });
        return next.size === previous.size ? previous : next;
      });
    }
  }, [params.loadingNewerFeedIds, params.messageFeeds, params.messageFeedsRef]);

  const loadFeedOlderMessages = useCallback(
    (feedId: string) => {
      const currentParams = paramsRef.current;
      const feed = currentParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (!feed || feed.items.length === 0 || feed.hasReachedStart) return Promise.resolve();
      const lane = getLane(feedId);
      if (lane.active?.direction === 'older') return lane.active.promise;
      const queuedOlder = lane.queued.find((operation) => operation.direction === 'older');
      if (queuedOlder) return queuedOlder.promise;
      const operation = createOperation('older');
      operation.run = async () => {
        const runParams = paramsRef.current;
        const currentFeed = runParams.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        if (!currentFeed || currentFeed.items.length === 0 || currentFeed.hasReachedStart) {
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        const requestGeneration = runParams.getFeedLoadGeneration(feedId);
        const beforeIdNoninclusive = currentFeed.items[0][0];
        runParams.setMessageFeeds((previous) =>
          previous.map((feed) => (feed.id === feedId ? { ...feed, loadingOlder: true } : feed)),
        );
        runParams.setError(null);
        try {
          const response = await fetchInboxMessages(
            runParams.buildReqForFeed(currentFeed, { beforeIdNoninclusive }),
          );
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const accepted = Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items[0]?.[0] === beforeIdNoninclusive,
          );
          if (accepted) {
            runParams.mergeInboxCallsigns(feedId, response.callsigns);
            if (response.signalProfiles) {
              runParams.setProfiles((previous) => ({ ...previous, ...response.signalProfiles }));
            }
            if (response.signalGroups?.length) {
              const groups: Record<string, SignalGroupEntry> = {};
              response.signalGroups.forEach((group) => {
                groups[group.masterKey] = group;
              });
              runParams.setGroupInfos((previous) => ({ ...previous, ...groups }));
            }
          }
          if (accepted) {
            runParams.setMessageFeeds((previous) =>
              previous.map((feed) => {
                if (feed.id !== feedId) return feed;
                const windowed = prependWindowedMessageItems(feed.items, response.inboxItems);
                return {
                  ...feed,
                  items: windowed.items,
                  readIds: new Set<number>([
                    ...feed.readIds,
                    ...windowed.addedItems.map(([id]) => id),
                  ]),
                  loadingOlder: false,
                  hasReachedStart: windowed.addedItems.length === 0,
                };
              }),
            );
          }
        } catch (error) {
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const stillCurrent = Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items[0]?.[0] === beforeIdNoninclusive,
          );
          if (stillCurrent) {
            runParams.setError(error instanceof Error ? error.message : String(error));
            runParams.setMessageFeeds((previous) =>
              previous.map((feed) =>
                feed.id === feedId ? { ...feed, loadingOlder: false } : feed,
              ),
            );
          }
        }
        operation.phase = 'awaitingCommit';
        operation.resolve();
      };
      if (lane.active) lane.queued.push(operation);
      else {
        lane.active = operation;
        void operation.run();
      }
      return operation.promise;
    },
    [getLane],
  );

  const loadFeedNewerMessages = useCallback(
    (feedId: string, options?: NewerLoadOptions) => {
      const currentParams = paramsRef.current;
      const lane = getLane(feedId);
      const activeNewer = lane.active?.direction === 'newer' ? lane.active : null;
      const queuedNewer = lane.queued.find((operation) => operation.direction === 'newer');
      const existing = activeNewer?.phase === 'running' ? activeNewer : queuedNewer;
      if (existing) {
        existing.newerOptions.nolimit ||= options?.nolimit === true;
        existing.newerOptions.scrollToEndAfterLoad ||= options?.scrollToEndAfterLoad === true;
        existing.newerOptions.markAllReadAfterAppend ||= options?.markAllReadAfterAppend === true;
        if (options?.skipIfNewestExhausted !== true) {
          existing.newerOptions.skipIfNewestExhausted = false;
        }
        return existing.promise;
      }
      const feed = currentParams.messageFeedsRef.current.find(
        (candidate) => candidate.id === feedId,
      );
      if (!feed || feed.items.length === 0) return Promise.resolve();
      const operation = createOperation('newer', options);
      operation.run = async () => {
        const runParams = paramsRef.current;
        const currentFeed = runParams.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        if (!currentFeed || currentFeed.items.length === 0) {
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        const requestGeneration = runParams.getFeedLoadGeneration(feedId);
        const lastId = currentFeed.items.at(-1)![0];
        if (
          operation.newerOptions.skipIfNewestExhausted &&
          runParams.newestExhaustedCursorByFeedIdRef.current[feedId] === lastId
        ) {
          lane.active = null;
          operation.resolve();
          startOperationRef.current(feedId);
          return;
        }
        runParams.setLoadingNewerFeedIds((previous) => new Set(previous).add(feedId));
        try {
          const response = await fetchInboxMessages(
            runParams.buildReqForFeed(currentFeed, {
              sinceIdNoninclusive: lastId,
              nolimit: operation.newerOptions.nolimit || undefined,
            }),
          );
          const latestFeed = runParams.messageFeedsRef.current.find(
            (candidate) => candidate.id === feedId,
          );
          const accepted = Boolean(
            latestFeed &&
            runParams.getFeedLoadGeneration(feedId) === requestGeneration &&
            latestFeed.items.at(-1)?.[0] === lastId,
          );
          if (accepted) {
            runParams.mergeInboxCallsigns(feedId, response.callsigns);
            if (response.signalProfiles) {
              runParams.setProfiles((previous) => ({ ...previous, ...response.signalProfiles }));
            }
            if (response.signalGroups?.length) {
              const groups: Record<string, SignalGroupEntry> = {};
              response.signalGroups.forEach((group) => {
                groups[group.masterKey] = group;
              });
              runParams.setGroupInfos((previous) => ({ ...previous, ...groups }));
            }
          }
          if (!accepted || !latestFeed) return;
          const latestWindowed = appendWindowedMessageItems(latestFeed.items, response.inboxItems);
          const addedCount = latestWindowed.addedItems.length;
          const newestCursor = latestWindowed.items.at(-1)?.[0] ?? null;
          const followTail = operation.newerOptions.scrollToEndAfterLoad;
          const markAllRead = followTail || operation.newerOptions.markAllReadAfterAppend;
          if (markAllRead && newestCursor != null) {
            runParams.advanceFeedReadCursor(
              feedId,
              newestCursor,
              0,
              runParams.getFeedCountSignature(latestFeed!),
            );
          }
          if (addedCount > 0) {
            delete runParams.newestExhaustedCursorByFeedIdRef.current[feedId];
          } else {
            runParams.newestExhaustedCursorByFeedIdRef.current[feedId] = lastId;
          }
          if (followTail) {
            runParams.scrollToEndAfterNewerRef.current.add(feedId);
            runParams.nearBottomByFeedIdRef.current = {
              ...runParams.nearBottomByFeedIdRef.current,
              [feedId]: true,
            };
          }
          if (addedCount > 0 || markAllRead || followTail) {
            runParams.setMessageFeeds((previous) =>
              previous.map((feed) => {
                if (feed.id !== feedId) return feed;
                const windowed = appendWindowedMessageItems(feed.items, response.inboxItems);
                if (windowed.addedItems.length === 0) {
                  if (markAllRead) {
                    return {
                      ...feed,
                      readIds: new Set<number>([...feed.readIds, ...feed.items.map(([id]) => id)]),
                      unreadCount: 0,
                    };
                  }
                  if (followTail) return { ...feed };
                  return feed;
                }
                const unreadAddedCount = windowed.addedItems.filter(
                  ([id]) => !feed.readIds.has(id),
                ).length;
                return {
                  ...feed,
                  items: windowed.items,
                  readIds: markAllRead
                    ? new Set<number>([...feed.readIds, ...windowed.items.map(([id]) => id)])
                    : feed.readIds,
                  unreadCount: markAllRead ? 0 : Math.max(feed.unreadCount, unreadAddedCount),
                  hasReachedStart: windowed.removedItems.length > 0 ? false : feed.hasReachedStart,
                };
              }),
            );
          }
        } catch {
          // Keep polling and the previously loaded messages after a transient failure.
        } finally {
          if (lanesRef.current[feedId]?.active === operation) {
            runParams.setLoadingNewerFeedIds((previous) => {
              if (!previous.has(feedId)) return previous;
              const next = new Set(previous);
              next.delete(feedId);
              return next;
            });
          }
          operation.phase = 'awaitingCommit';
          operation.resolve();
        }
      };
      if (lane.active) lane.queued.push(operation);
      else {
        lane.active = operation;
        void operation.run();
      }
      return operation.promise;
    },
    [getLane],
  );

  startOperationRef.current = (feedId: string) => {
    const lane = lanesRef.current[feedId];
    if (!lane || lane.active) return;
    const operation = lane.queued.shift();
    if (!operation) return;
    lane.active = operation;
    operation.phase = 'running';
    void operation.run();
  };

  const invalidateFeedLoads = useCallback((feedId: string) => {
    const lane = lanesRef.current[feedId];
    lane?.queued.forEach((operation) => operation.resolve());
    lane?.active?.resolve();
    delete lanesRef.current[feedId];
    invalidatedLoadingFeedIdsRef.current.add(feedId);
  }, []);

  const removeFeedLoads = useCallback(
    (feedId: string) => {
      invalidateFeedLoads(feedId);
    },
    [invalidateFeedLoads],
  );

  return {
    loadFeedOlderMessages,
    loadFeedNewerMessages,
    invalidateFeedLoads,
    removeFeedLoads,
  };
}
