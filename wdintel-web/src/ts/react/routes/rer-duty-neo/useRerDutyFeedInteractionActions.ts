import { useCallback } from 'react';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

import { compareMessageTuple, type MessageFeedState } from './utils';
import { getDutyFollowScrollBehavior } from './duty-follow-scroll';
import { ScrollNavigationIntent } from './windowed-feed-scroll-shared';
import type { ExplicitFeedNavigation } from './useRerDutyNavigation';
import type { ExplicitScrollNavigation } from './windowed-feed-scroll-shared';

type Params = {
  messageFeeds: MessageFeedState[];
  showArrowResult: (feedId: string, message: string) => void;
  columnRefsRef: MutableRefObject<
    Record<
      string,
      {
        scrollToEnd: (
          behavior?: ScrollBehavior,
          options?: {
            wakeIdleOffload?: boolean;
            intent?: ScrollNavigationIntent;
            navigation?: ExplicitScrollNavigation;
          },
        ) => void;
      } | null
    >
  >;
  setWatchModeByFeedId: Dispatch<SetStateAction<Record<string, boolean>>>;
  setLoadingNewerFeedIds: Dispatch<SetStateAction<Set<string>>>;
  loadFeedInitialMessages: (
    feedId: string,
  ) => Promise<{ id: number; timestamp: number | null } | null | void>;
  loadFeedNewerMessages: (
    feedId: string,
    opts?: {
      nolimit?: boolean;
      scrollToEndAfterLoad?: boolean;
      markAllReadAfterAppend?: boolean;
      showLoading?: boolean;
      followGeneration?: number;
      explicitNavigation?: boolean;
      explicitOperation?: ExplicitFeedNavigation;
    },
  ) => Promise<{
    ok: boolean;
    addedCount: number;
    target?: { id: number; timestamp: number | null } | null;
  }>;
  flushPendingNewerMessages: (
    feedId: string,
    opts?: { markAllRead?: boolean; urgent?: boolean; allowWindowTrim?: boolean },
  ) => void;
  requestValidatedInboxCount: (feedId: string) => Promise<{
    feedId: string;
    quantity: number;
    cursorId: number | null;
    hasItems: boolean;
  } | null>;
  catchUpFeedUnreadToTail: (
    feedId: string,
    target?: { id: number; timestamp: number | null },
  ) => void;
  dutyDisableAutoScroll: boolean;
  setMessageFeeds: Dispatch<SetStateAction<MessageFeedState[]>>;
  beginExplicitNavigation: (feedId: string) => ExplicitFeedNavigation;
  isExplicitNavigationCurrent: (operation: ExplicitFeedNavigation) => boolean;
  registerExplicitLanding: (
    operation: ExplicitFeedNavigation,
    target: { id: number; timestamp: number | null },
    complete: () => void,
  ) => boolean;
  getExplicitScrollNavigation: (
    feedId: string,
    generation: number,
  ) => ExplicitScrollNavigation | null;
  registerExplicitLoading: (
    operation: ExplicitFeedNavigation,
    releaseLoading: () => void,
  ) => boolean;
  cancelExplicitNavigation: (operation: ExplicitFeedNavigation) => boolean;
  registerExplicitScheduledWork: (operation: ExplicitFeedNavigation, cancel: () => void) => boolean;
  clearExplicitScheduledWork: (operation: ExplicitFeedNavigation) => void;
};

export function useRerDutyFeedInteractionActions(params: Params) {
  const {
    messageFeeds,
    showArrowResult,
    columnRefsRef,
    setWatchModeByFeedId,
    setLoadingNewerFeedIds,
    loadFeedInitialMessages,
    loadFeedNewerMessages,
    flushPendingNewerMessages,
    requestValidatedInboxCount,
    catchUpFeedUnreadToTail,
    dutyDisableAutoScroll,
    setMessageFeeds,
    beginExplicitNavigation,
    isExplicitNavigationCurrent,
    registerExplicitLanding,
    getExplicitScrollNavigation,
    registerExplicitLoading,
    cancelExplicitNavigation,
    registerExplicitScheduledWork,
    clearExplicitScheduledWork,
  } = params;

  const busyArrowMessage = 'Оновлення триває, спробуйте ще раз';
  const failureArrowMessage = 'Не вдалося перевірити нові повідомлення';

  const handleArrowClick = useCallback(
    async (feedId: string) => {
      const feed = messageFeeds.find((x) => x.id === feedId);
      if (!feed) return;
      const explicitOperation = beginExplicitNavigation(feedId);
      let landingRequested = false;
      let releasedLoading = false;
      const releaseLoading = () => {
        if (releasedLoading) return;
        releasedLoading = true;
        setLoadingNewerFeedIds((previous) => {
          if (!previous.has(feedId)) return previous;
          const next = new Set(previous);
          next.delete(feedId);
          return next;
        });
      };
      const followGeneration = explicitOperation.generation;
      const isCurrent = () => isExplicitNavigationCurrent(explicitOperation);
      // Buffered arrivals are deliberately consumed only by this explicit arrow.
      // Capture their tail now; a later poll arrival must stay beyond this operation.
      const capturedTarget = feed.pendingNewerItems?.at(-1) ?? feed.items.at(-1);
      const capturedCursor = capturedTarget
        ? { id: capturedTarget[0], timestamp: capturedTarget[1].timestamp }
        : null;
      const requestVerifiedLanding = (
        target: { id: number; timestamp: number | null },
        acknowledge: () => void,
      ) => {
        if (!registerExplicitLanding(explicitOperation, target, acknowledge)) return false;
        landingRequested = true;
        let frame = requestAnimationFrame(() => {
          clearExplicitScheduledWork(explicitOperation);
          if (!isCurrent()) return;
          const navigation = getExplicitScrollNavigation(feedId, explicitOperation.generation);
          const column = columnRefsRef.current[feedId];
          if (!navigation || !column) {
            navigation?.onUnavailable();
            return;
          }
          column.scrollToEnd(getDutyFollowScrollBehavior(), {
            wakeIdleOffload: true,
            intent: ScrollNavigationIntent.Explicit,
            navigation,
          });
        });
        if (
          !registerExplicitScheduledWork(explicitOperation, () => {
            cancelAnimationFrame(frame);
            frame = 0;
          })
        )
          return false;
        return true;
      };
      flushPendingNewerMessages(feedId, { urgent: true });
      if (!dutyDisableAutoScroll) {
        setWatchModeByFeedId((prev) => ({ ...prev, [feedId]: true }));
      }
      setLoadingNewerFeedIds((prev) => new Set(prev).add(feedId));
      registerExplicitLoading(explicitOperation, releaseLoading);
      try {
        if (feed.items.length > 0) {
          const result = await requestValidatedInboxCount(feedId);
          if (!isCurrent()) return;
          if (!result) {
            showArrowResult(feedId, busyArrowMessage);
            return;
          }
          const { quantity } = result;
          if (quantity === 0) {
            if (!capturedCursor) {
              showArrowResult(feedId, 'Немає нових повідомлень');
              return;
            }
            if (
              !requestVerifiedLanding(capturedCursor, () => {
                catchUpFeedUnreadToTail(feedId, capturedCursor);
                showArrowResult(feedId, 'Немає нових повідомлень');
              })
            )
              showArrowResult(feedId, failureArrowMessage);
            return;
          }
          setLoadingNewerFeedIds((prev) => {
            const next = new Set(prev);
            next.add(feedId);
            return next;
          });
          const newerResult = await loadFeedNewerMessages(feedId, {
            nolimit: true,
            scrollToEndAfterLoad: true,
            showLoading: true,
            followGeneration,
            explicitNavigation: true,
            explicitOperation,
          });
          if (!isCurrent()) return;
          if (!newerResult.ok) {
            showArrowResult(feedId, failureArrowMessage);
            return;
          }
          const target = newerResult.target ?? capturedCursor;
          const acknowledge = () => {
            if (!target) return;
            catchUpFeedUnreadToTail(feedId, target);
            showArrowResult(feedId, 'Завантажено нові повідомлення');
          };
          if (target) {
            if (!requestVerifiedLanding(target, acknowledge))
              showArrowResult(feedId, failureArrowMessage);
          } else {
            showArrowResult(feedId, target ? failureArrowMessage : 'Немає нових повідомлень');
          }
        } else if (!feed.loading) {
          const initialTarget = await loadFeedInitialMessages(feedId);
          if (!isCurrent()) return;
          if (initialTarget) {
            if (
              !requestVerifiedLanding(initialTarget, () => {
                catchUpFeedUnreadToTail(feedId, initialTarget);
                showArrowResult(feedId, 'Завантажено нові повідомлення');
              })
            )
              showArrowResult(feedId, failureArrowMessage);
          } else showArrowResult(feedId, 'Немає нових повідомлень');
        }
      } catch {
        if (isCurrent()) showArrowResult(feedId, failureArrowMessage);
      } finally {
        if (!landingRequested) cancelExplicitNavigation(explicitOperation);
      }
    },
    [
      messageFeeds,
      loadFeedNewerMessages,
      loadFeedInitialMessages,
      flushPendingNewerMessages,
      showArrowResult,
      columnRefsRef,
      setWatchModeByFeedId,
      setLoadingNewerFeedIds,
      catchUpFeedUnreadToTail,
      requestValidatedInboxCount,
      dutyDisableAutoScroll,
      beginExplicitNavigation,
      isExplicitNavigationCurrent,
      registerExplicitLanding,
      getExplicitScrollNavigation,
      registerExplicitLoading,
      cancelExplicitNavigation,
      registerExplicitScheduledWork,
      clearExplicitScheduledWork,
    ],
  );

  const handleVisibleMessageIds = useCallback(
    (feedId: string) => (lastVisibleId: number, opts?: { atBottom?: boolean }) => {
      setMessageFeeds((prev) => {
        let changed = false;
        const next = prev.map((f) => {
          if (f.id !== feedId) return f;

          const newlyReadIds: number[] = [];
          let lastVisibleTimestamp: number | null | undefined;
          for (const [id, message] of f.items) {
            if (!f.readIds.has(id)) {
              newlyReadIds.push(id);
            }
            if (id === lastVisibleId) {
              lastVisibleTimestamp = message.timestamp;
              break;
            }
          }

          let windowedUnreadItems = f.windowedUnreadItems ?? new Map<number, number>();
          let clearedWindowedCount = 0;
          if (opts?.atBottom === true && windowedUnreadItems.size > 0) {
            const boundary = { id: lastVisibleId, timestamp: lastVisibleTimestamp ?? null };
            const nextWindowed = new Map<number, number>();
            for (const [id, timestamp] of windowedUnreadItems) {
              if (compareMessageTuple({ id, timestamp }, boundary) <= 0) {
                clearedWindowedCount += 1;
              } else {
                nextWindowed.set(id, timestamp);
              }
            }
            if (clearedWindowedCount > 0) {
              windowedUnreadItems = nextWindowed;
            }
          } else if (newlyReadIds.length > 0) {
            windowedUnreadItems = new Map(windowedUnreadItems);
            newlyReadIds.forEach((id) => windowedUnreadItems.delete(id));
          }

          if (newlyReadIds.length === 0 && clearedWindowedCount === 0) return f;

          changed = true;
          const nextReadIds = new Set(f.readIds);
          newlyReadIds.forEach((id) => nextReadIds.add(id));
          return {
            ...f,
            readIds: nextReadIds,
            windowedUnreadItems,
            unreadCount: Math.max(0, f.unreadCount - newlyReadIds.length - clearedWindowedCount),
          };
        });
        return changed ? next : prev;
      });
    },
    [setMessageFeeds],
  );

  return {
    handleArrowClick,
    handleVisibleMessageIds,
  };
}
