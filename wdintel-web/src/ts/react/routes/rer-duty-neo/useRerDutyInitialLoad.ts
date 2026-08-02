import { useCallback, useRef } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import type {
  CallsignInfoRes,
  InboxMessage,
  InboxMessagesReq,
  SignalGroupEntry,
  SignalProfileEntry,
} from '../../../../Bindings';
import { fetchInboxMessages } from '../../services/api/inbox';
import { windowInitialMessageItems } from './utils';
import type { MessageFeedState } from './utils';
import type { MessageCursor } from './utils';

export function createEmptyFeedState(
  id: string,
  filter: MessageFeedState['filter'],
): MessageFeedState {
  return {
    id,
    filter,
    items: [],
    loading: true,
    loadingOlder: false,
    hasReachedStart: false,
    referenceTimeMs: null,
    readIds: new Set<number>(),
    windowedUnreadItems: new Map<number, number>(),
    unreadCount: 0,
    adjacentFreqsRange: 0,
    highlightSignalsEnabled: false,
    onlyMyUnitTagsEnabled: false,
  };
}

type Params = {
  messageFeeds: MessageFeedState[];
  messageFeedsRef: MutableRefObject<MessageFeedState[]>;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  setError: Dispatch<SetStateAction<string | null>>;
  buildReqForFeed: (feed: MessageFeedState, options: { loadLatest: boolean }) => InboxMessagesReq;
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
};

function preserveUnreadState(
  feed: MessageFeedState,
  items: Array<[number, InboxMessage]>,
): Pick<MessageFeedState, 'readIds' | 'windowedUnreadItems' | 'unreadCount'> {
  const itemIds = new Set(items.map(([id]) => id));
  const readIds = new Set([...feed.readIds].filter((id) => itemIds.has(id)));
  const windowedUnreadItems = new Map(feed.windowedUnreadItems);
  let unreadCount = feed.unreadCount;
  items.forEach(([id, message]) => {
    if (!readIds.has(id) && !windowedUnreadItems.has(id) && message.timestamp != null) {
      windowedUnreadItems.set(id, message.timestamp);
      unreadCount += 1;
    }
  });
  return { readIds, windowedUnreadItems, unreadCount };
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
      },
    ) => {
      const current = paramsRef.current;
      const feed = current.messageFeeds.find((candidate) => candidate.id === feedId);
      if (!feed) return;
      const requestGeneration = current.getFeedLoadGeneration(feedId);
      const preserveUnread = overrides?.preserveUnread ?? false;
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
        const response = await fetchInboxMessages(
          current.buildReqForFeed(effectiveFeed, { loadLatest: true }),
        );
        if (current.getFeedLoadGeneration(feedId) !== requestGeneration) return;
        current.mergeInboxCallsigns(feedId, response.callsigns, { replace: true });
        const items = windowInitialMessageItems(response.inboxItems);
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
          current.setFeedUnreadCursor(
            feedId,
            tail ? { id: tail[0], timestamp: tail[1].timestamp } : pollCursor,
          );
        }
        current.setMessageFeeds((previous) =>
          previous.map((candidate) =>
            candidate.id === feedId
              ? {
                  ...candidate,
                  items,
                  loading: false,
                  referenceTimeMs: Date.now(),
                  ...(preserveUnread && previousFeed
                    ? preserveUnreadState(previousFeed, items)
                    : {
                        readIds: new Set<number>(items.map(([id]) => id)),
                        windowedUnreadItems: new Map<number, number>(),
                        unreadCount: 0,
                      }),
                }
              : candidate,
          ),
        );
        if (preserveUnread) current.completeFeedReload(feedId);
        if (response.signalProfiles) {
          current.setProfiles((previous) => ({ ...previous, ...response.signalProfiles }));
        }
        if (response.signalGroups?.length) {
          const groups: Record<string, SignalGroupEntry> = {};
          response.signalGroups.forEach((group) => {
            groups[group.masterKey] = group;
          });
          current.setGroupInfos((previous) => ({ ...previous, ...groups }));
        }
      } catch (error) {
        if (current.getFeedLoadGeneration(feedId) !== requestGeneration) return;
        const currentFeed = current.messageFeedsRef.current.find(
          (candidate) => candidate.id === feedId,
        );
        const tail = currentFeed?.items.at(-1);
        const tailCursor = tail ? { id: tail[0], timestamp: tail[1].timestamp } : null;
        if (preserveUnread) {
          current.completeFeedReload(feedId);
        } else {
          current.clearFeedUnreadBaselines(feedId);
          current.setFeedUnreadCursor(feedId, tailCursor);
        }
        current.setError(error instanceof Error ? error.message : String(error));
        current.setMessageFeeds((previous) =>
          previous.map((candidate) =>
            candidate.id === feedId ? { ...candidate, loading: false } : candidate,
          ),
        );
      }
    },
    [],
  );
}
