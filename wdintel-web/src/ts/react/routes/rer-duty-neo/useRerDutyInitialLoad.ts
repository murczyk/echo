import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  CallsignInfoRes,
  InboxMessage,
  InboxMessagesReq,
  InboxMessagesRsp,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/inbox';
import { fetchMessagesByIdsWithMetadata } from '../../services/api/inbox-messages';
import {
  DUTY_FEED_MESSAGE_WINDOW_LIMIT,
  messageOrderCursor,
  windowInitialMessageItems,
} from './utils';
import type { DutyFeedFilterOptions, MessageFeedState } from './utils';
import type { MessageCursor } from './utils';

export function createEmptyFeedState(
  id: string,
  filter: MessageFeedState['filter'],
  options: Partial<DutyFeedFilterOptions> = {},
): MessageFeedState {
  return {
    id,
    messageSortBy: 'IMSTimestamp',
    filter,
    items: [],
    loading: true,
    loadingOlder: false,
    hasReachedStart: false,
    evictedNewerTailId: null,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    windowedUnreadItems: new Map<number, number>(),
    unreadCount: 0,
    adjacentFreqsRange: options.adjacentFreqsRange ?? 0,
    highlightSignalsEnabled: options.highlightSignalsEnabled ?? false,
    onlyMyUnitTagsEnabled: options.onlyMyUnitTagsEnabled ?? false,
  };
}

type Params = {
  messageFeeds: MessageFeedState[];
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  buildReqForFeed: (
    feed: MessageFeedState,
    options: {
      loadLatest?: boolean;
      beforeIdNoninclusive?: number | null;
      sinceIdNoninclusive?: number | null;
    },
  ) => InboxMessagesReq;
  getFeedLoadGeneration: (feedId: string) => number;
  mergeInboxCallsigns: (
    feedId: string,
    callsigns: CallsignInfoRes[] | null | undefined,
    options?: { replace?: boolean },
  ) => void;
  setProfiles: Dispatch<SetStateAction<Record<string, SignalProfileEntry | null>>>;
  setGroupInfos: Dispatch<SetStateAction<Record<string, SignalGroupEntry>>>;
  clearFeedUnreadBaselines: (feedId: string) => void;
  completeFeedReload: (feedId: string) => void;
  setFeedUnreadCursor: (feedId: string, cursor: MessageCursor | null) => void;
  feedInitialTargetByFeedIdRef?: MutableRefObject<
    Record<string, { beforeIdNoninclusive: number; messageIds: number[] } | undefined>
  >;
  installFeedUnreadCursorAndBaseline: (
    feed: MessageFeedState,
    cursor: MessageCursor | null,
  ) => void;
  recoverFeedUnreadBaselineAfterFailedLoad: (
    feed: MessageFeedState,
    fallbackCursor: MessageCursor | null,
  ) => void;
};

function preserveUnreadState(
  feed: MessageFeedState,
  items: Array<[number, InboxMessage]>,
): Pick<
  MessageFeedState,
  | 'readIds'
  | 'windowedUnreadItems'
  | 'unresolvedUnreadIds'
  | 'unresolvedUnreadCount'
  | 'unreadCount'
> {
  const itemIds = new Set(items.map(([id]) => id));
  const readIds = new Set(feed.readIds);
  const knownUnreadIds = new Set([
    ...feed.windowedUnreadItems.keys(),
    ...(feed.unresolvedUnreadIds ?? []),
    ...feed.items.filter(([id]) => !feed.readIds.has(id)).map(([id]) => id),
    ...(feed.pendingNewerItems ?? []).filter(([id]) => !feed.readIds.has(id)).map(([id]) => id),
  ]);
  const unresolvedUnreadIds = new Set([...knownUnreadIds].filter((id) => !itemIds.has(id)));
  const previousUnresolvedUnreadCount = Math.max(
    feed.unresolvedUnreadCount ?? 0,
    feed.unreadCount - knownUnreadIds.size,
  );
  const newlyMaterializedUnreadCount = items.filter(
    ([id]) => !readIds.has(id) && !knownUnreadIds.has(id),
  ).length;
  const unresolvedUnreadCount = Math.max(
    0,
    previousUnresolvedUnreadCount - newlyMaterializedUnreadCount,
  );
  const loadedUnreadCount = items.filter(([id]) => !readIds.has(id)).length;
  const windowedUnreadItems = new Map<number, number>();
  return {
    readIds,
    windowedUnreadItems,
    unresolvedUnreadIds,
    unresolvedUnreadCount,
    unreadCount: loadedUnreadCount + unresolvedUnreadIds.size + unresolvedUnreadCount,
  };
}

function windowInitialMessageItemsAroundTarget(
  items: Array<[number, InboxMessage]>,
  targetMessageIds: readonly number[],
  messageSortBy: 'IMSTimestamp' | 'IMSCreatedAt',
): Array<[number, InboxMessage]> {
  const sortedItems = windowInitialMessageItems(items, Math.max(1, items.length), messageSortBy);
  const targetIds = new Set(targetMessageIds);
  const targetIndex = sortedItems.findIndex(([id]) => targetIds.has(id));
  if (targetIndex < 0) return windowInitialMessageItems(sortedItems, undefined, messageSortBy);

  const beforeTarget = Math.floor(DUTY_FEED_MESSAGE_WINDOW_LIMIT / 2);
  let start = Math.max(0, targetIndex - beforeTarget);
  const end = Math.min(sortedItems.length, start + DUTY_FEED_MESSAGE_WINDOW_LIMIT);
  start = Math.max(0, end - DUTY_FEED_MESSAGE_WINDOW_LIMIT);
  return sortedItems.slice(start, end);
}

function mergeInitialLoadMetadata(responses: InboxMessagesRsp[]) {
  const callsigns = responses.flatMap((response) => response.callsigns ?? []);
  const signalProfiles = Object.assign({}, ...responses.map((response) => response.signalProfiles));
  const signalGroups = responses.flatMap((response) => response.signalGroups ?? []);
  return { callsigns, signalProfiles, signalGroups };
}

export function useRerDutyInitialLoad(params: Params) {
  const paramsRef = useRef(params);
  paramsRef.current = params;

  return useCallback(
    async (
      feedId: string,
      overrides?: {
        highlightSignalsEnabled?: boolean;
        preserveUnread?: boolean;
        beforeIdNoninclusive?: number | null;
        loadLatest?: boolean;
      },
    ) => {
      const current = paramsRef.current;
      const feed = current.messageFeeds.find((candidate) => candidate.id === feedId);
      if (!feed) return;
      const requestGeneration = current.getFeedLoadGeneration(feedId);
      const preserveUnread = overrides?.preserveUnread ?? false;
      const initialTarget = current.feedInitialTargetByFeedIdRef?.current?.[feedId];
      if (initialTarget != null && current.feedInitialTargetByFeedIdRef) {
        delete current.feedInitialTargetByFeedIdRef.current[feedId];
      }
      const effectiveBeforeId =
        overrides?.beforeIdNoninclusive ?? initialTarget?.beforeIdNoninclusive ?? null;
      const effectiveLoadLatest =
        overrides?.loadLatest ?? (effectiveBeforeId != null ? false : true);
      const effectiveFeed = overrides
        ? {
            ...feed,
            ...(overrides.highlightSignalsEnabled === undefined
              ? {}
              : { highlightSignalsEnabled: overrides.highlightSignalsEnabled }),
          }
        : feed;
      current.setMessageFeeds((previous) =>
        previous.map((candidate) =>
          candidate.id === feedId ? { ...candidate, loading: true } : candidate,
        ),
      );
      current.setError(null);
      try {
        const inboxReq = current.buildReqForFeed(effectiveFeed, {
          loadLatest: effectiveLoadLatest,
          beforeIdNoninclusive: effectiveBeforeId,
        });
        let responses: InboxMessagesRsp[];
        if (initialTarget) {
          const newerReq = current.buildReqForFeed(effectiveFeed, {
            loadLatest: false,
            sinceIdNoninclusive: initialTarget.beforeIdNoninclusive,
          });
          const [olderResponse, newerResponse, targetResponse] = await Promise.all([
            fetchInboxMessages(inboxReq),
            fetchInboxMessages(newerReq),
            fetchMessagesByIdsWithMetadata(initialTarget.messageIds, inboxReq),
          ]);
          responses = [olderResponse, newerResponse, targetResponse];
        } else {
          responses = [await fetchInboxMessages(inboxReq)];
        }
        if (current.getFeedLoadGeneration(feedId) !== requestGeneration) return;
        const response = responses[0];
        const metadata = mergeInitialLoadMetadata(responses);
        current.mergeInboxCallsigns(feedId, metadata.callsigns, { replace: true });
        const loadedItems = responses.flatMap((loadedResponse) => loadedResponse.inboxItems);
        const messageSortBy = inboxReq.sortBy === 'IMSCreatedAt' ? 'IMSCreatedAt' : 'IMSTimestamp';
        const items = initialTarget
          ? windowInitialMessageItemsAroundTarget(
              loadedItems,
              initialTarget.messageIds,
              messageSortBy,
            )
          : windowInitialMessageItems(loadedItems, undefined, messageSortBy);
        const previousFeed = current.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        const pollCursor =
          response.pollCursorId == null ? null : { id: response.pollCursorId, timestamp: null };
        if (preserveUnread) {
          current.setFeedUnreadCursor(feedId, items.length === 0 ? pollCursor : null);
        } else {
          current.clearFeedUnreadBaselines(feedId);
          const tail = items.at(-1);
          if (tail) {
            current.installFeedUnreadCursorAndBaseline(
              { ...effectiveFeed, messageSortBy },
              messageOrderCursor(tail[0], tail[1], messageSortBy),
            );
          } else if (pollCursor) {
            current.installFeedUnreadCursorAndBaseline(effectiveFeed, pollCursor);
          } else {
            current.setFeedUnreadCursor(feedId, null);
          }
        }
        current.setMessageFeeds((previous) =>
          previous.map((candidate) =>
            candidate.id === feedId
              ? {
                  ...candidate,
                  messageSortBy,
                  items,
                  loading: false,
                  referenceTimeMs: Date.now(),
                  pendingNewerItems: [],
                  evictedNewerTailId: null,
                  ...(preserveUnread && previousFeed
                    ? preserveUnreadState(previousFeed, items)
                    : {
                        readIds: new Set<number>(items.map(([id]) => id)),
                        windowedUnreadItems: new Map<number, number>(),
                        unresolvedUnreadIds: new Set<number>(),
                        unresolvedUnreadCount: 0,
                        unreadCount: 0,
                      }),
                }
              : candidate,
          ),
        );
        if (preserveUnread) current.completeFeedReload(feedId);
        if (metadata.signalProfiles) {
          current.setProfiles((previous) => ({ ...previous, ...metadata.signalProfiles }));
        }
        if (metadata.signalGroups.length) {
          const groups: Record<string, SignalGroupEntry> = {};
          metadata.signalGroups.forEach((group) => {
            groups[group.masterKey] = group;
          });
          current.setGroupInfos((previous) => ({ ...previous, ...groups }));
        }
        const tail = items.at(-1);
        return tail
          ? messageOrderCursor(
              tail[0],
              tail[1],
              inboxReq.sortBy === 'IMSCreatedAt' ? 'IMSCreatedAt' : 'IMSTimestamp',
            )
          : null;
      } catch (error) {
        if (current.getFeedLoadGeneration(feedId) !== requestGeneration) return;
        const currentFeed = current.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        const effectiveTail = currentFeed?.pendingNewerItems?.at(-1) ?? currentFeed?.items.at(-1);
        const fallbackCursor = effectiveTail
          ? messageOrderCursor(
              effectiveTail[0],
              effectiveTail[1],
              currentFeed?.messageSortBy ?? 'IMSTimestamp',
            )
          : null;
        if (preserveUnread) {
          current.completeFeedReload(feedId);
        } else if (currentFeed) {
          current.recoverFeedUnreadBaselineAfterFailedLoad(currentFeed, fallbackCursor);
        } else {
          current.clearFeedUnreadBaselines(feedId);
        }
        current.setError(error instanceof Error ? error.message : String(error));
        current.setMessageFeeds((previous) =>
          previous.map((candidate) =>
            candidate.id === feedId ? { ...candidate, loading: false } : candidate,
          ),
        );
        return null;
      }
    },
    [],
  );
}
