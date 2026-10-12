import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { InboxMessage } from '../../../../../Bindings';
import type { MessageFeedPolicy, MessageFeedScrollOptions } from '../../shared/message-feed';
import type { AnalysisDirectMessageNavigation } from '../types';
import { ANALYSIS_MESSAGES_PAGE_SIZE, getFirstLoadedMessagesPageIndex } from '../helpers';

export const ANALYSIS_MESSAGE_FEED_POLICY: MessageFeedPolicy = {
  initialPosition: 'start',
  followAtBottom: false,
  aboveLoadBufferPx: 480,
  belowLoadBufferPx: 480,
  atBottomThresholdPx: 25,
  underfilledEdgeLoading: false,
  belowLoadStrategy: 'immediate',
  expandBelowLoadBuffer: false,
  deferResizeWhileLoadingBelow: false,
};

export function getFocusedLoadDirection(
  position: 'above' | 'below',
  newestFirst: boolean,
): 'earlier' | 'later' {
  return (position === 'above') === newestFirst ? 'later' : 'earlier';
}

type Options = {
  messages: Array<[number, InboxMessage]>;
  directMessageNavigation: AnalysisDirectMessageNavigation | null;
  pageIndex: number;
  pageNavigationTarget: number | null;
  viewportPreservationKey: number;
  onViewportCaptureChange: (capture: (() => void) | null) => void;
  scrollResetKey: string;
  paginationLoading: boolean;
  noMoreToLoad: boolean;
  onLoadMoreMessages: () => Promise<boolean>;
  onVisiblePageChange: (pageIndex: number) => void;
  onPageNavigationHandled: () => void;
};

export function useAnalysisMessageFeed({
  messages,
  directMessageNavigation,
  pageIndex,
  pageNavigationTarget,
  viewportPreservationKey,
  onViewportCaptureChange,
  scrollResetKey,
  paginationLoading,
  noMoreToLoad,
  onLoadMoreMessages,
  onVisiblePageChange,
  onPageNavigationHandled,
}: Options) {
  const appendRequestedRef = useRef(false);
  const loadMore = useCallback(async () => {
    appendRequestedRef.current = true;
    try {
      const loaded = await onLoadMoreMessages();
      if (!loaded) appendRequestedRef.current = false;
      return loaded;
    } catch (error) {
      appendRequestedRef.current = false;
      throw error;
    }
  }, [onLoadMoreMessages]);
  const targetLocalIndex = directMessageNavigation
    ? messages.findIndex(([id]) => id === directMessageNavigation.targetMessageId)
    : -1;
  const firstLoadedIndex =
    directMessageNavigation && targetLocalIndex >= 0
      ? directMessageNavigation.targetMessageIndex - targetLocalIndex
      : getFirstLoadedMessagesPageIndex(pageIndex, messages.length) * ANALYSIS_MESSAGES_PAGE_SIZE;
  const onFirstVisibleMessage = useCallback(
    (_id: number, index: number) => {
      onVisiblePageChange(
        directMessageNavigation?.focusActive
          ? Math.floor(directMessageNavigation.targetMessageIndex / ANALYSIS_MESSAGES_PAGE_SIZE)
          : Math.max(0, Math.floor((firstLoadedIndex + index) / ANALYSIS_MESSAGES_PAGE_SIZE)),
      );
    },
    [directMessageNavigation, firstLoadedIndex, onVisiblePageChange],
  );
  const pageMessageId =
    pageNavigationTarget === null
      ? null
      : (messages[pageNavigationTarget * ANALYSIS_MESSAGES_PAGE_SIZE - firstLoadedIndex]?.[0] ??
        null);
  const navigationTarget = useMemo(
    () =>
      pageMessageId !== null && pageNavigationTarget !== null
        ? {
            messageId: pageMessageId,
            alignment: 'start' as const,
            onAligned: () => {
              onVisiblePageChange(pageNavigationTarget);
              onPageNavigationHandled();
            },
          }
        : null,
    [pageMessageId, pageNavigationTarget, onPageNavigationHandled, onVisiblePageChange],
  );
  const focus = useMemo(
    () =>
      directMessageNavigation
        ? {
            messageId: directMessageNavigation.targetMessageId,
            active: directMessageNavigation.focusActive,
            onRelease: directMessageNavigation.onClearFocus,
          }
        : null,
    [
      directMessageNavigation?.targetMessageId,
      directMessageNavigation?.focusActive,
      directMessageNavigation?.onClearFocus,
    ],
  );
  const displayedMessages = useMemo(
    () =>
      directMessageNavigation?.contextLoading
        ? messages.filter(([id]) => id === directMessageNavigation.targetMessageId)
        : messages,
    [messages, directMessageNavigation?.contextLoading, directMessageNavigation?.targetMessageId],
  );
  const above = directMessageNavigation
    ? getFocusedLoadDirection('above', directMessageNavigation.newestFirst)
    : null;
  const below = directMessageNavigation
    ? getFocusedLoadDirection('below', directMessageNavigation.newestFirst)
    : null;
  const canLoad = (direction: 'earlier' | 'later' | null) =>
    direction === 'earlier'
      ? directMessageNavigation?.canLoadEarlier
      : direction === 'later'
        ? directMessageNavigation?.canLoadLater
        : false;
  const isLoading = (direction: 'earlier' | 'later' | null) =>
    direction === 'earlier'
      ? directMessageNavigation?.loadingEarlier
      : direction === 'later'
        ? directMessageNavigation?.loadingLater
        : false;
  const load = (direction: 'earlier' | 'later' | null) =>
    direction === 'earlier'
      ? directMessageNavigation?.onLoadEarlier
      : direction === 'later'
        ? directMessageNavigation?.onLoadLater
        : undefined;
  const loadingAbove = Boolean(isLoading(above));
  const loadingBelow = Boolean(isLoading(below));
  const scrollOptions: MessageFeedScrollOptions = {
    policy: ANALYSIS_MESSAGE_FEED_POLICY,
    focus,
    navigationTarget,
    viewportPreservationKey,
    onViewportCaptureChange,
    resetKey: scrollResetKey,
    positionResetKey: pageIndex,
    preservePositionOnReset: appendRequestedRef.current,
    initialPositioningReady: !directMessageNavigation?.contextLoading,
    loadEdgesOnLayout: !directMessageNavigation?.contextLoading,
    hasReachedStart: !canLoad(above),
    onLoadOlder: load(above) ?? (() => undefined),
    onLoadNewer: directMessageNavigation ? load(below) : loadMore,
    unreadPrefetchNeeded: directMessageNavigation ? Boolean(canLoad(below)) : !noMoreToLoad,
    onFirstVisibleMessage,
  };
  useLayoutEffect(() => {
    appendRequestedRef.current = false;
  }, [pageIndex]);
  return {
    scrollOptions,
    displayedMessages,
    loadingAbove,
    loadingBelow,
    hasMoreAbove: Boolean(canLoad(above)),
    hasMoreBelow: directMessageNavigation ? Boolean(canLoad(below)) : !noMoreToLoad,
  };
}
