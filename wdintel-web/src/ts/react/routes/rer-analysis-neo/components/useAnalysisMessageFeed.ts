import { useCallback, useMemo } from 'react';
import type { InboxMessage } from '../../../../../Bindings';
import type { MessageFeedPolicy, MessageFeedScrollOptions } from '../../shared/message-feed';
import type { AnalysisDirectMessageNavigation } from '../types';
import { ANALYSIS_MESSAGES_PAGE_SIZE } from '../helpers';

export const ANALYSIS_MESSAGE_FEED_POLICY: MessageFeedPolicy = {
  initialPosition: 'start',
  followAtBottom: false,
  aboveLoadBufferPx: 480,
  belowLoadBufferPx: 480,
  atBottomThresholdPx: 25,
  underfilledEdgeLoading: true,
  belowLoadStrategy: 'immediate',
  serializeEdgeLoads: true,
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
  firstLoadedMessageIndex: number;
  hasMoreBeforeWindow: boolean;
  hasMoreAfterWindow: boolean;
  loadingBeforeWindow: boolean;
  loadingAfterWindow: boolean;
  isLoading: boolean;
  pageNavigationTarget: number | null;
  viewportPreservationKey: number;
  edgeLoadRetryKey: number;
  onViewportCaptureChange: (capture: (() => void) | null) => void;
  scrollResetKey: string;
  onLoadPreviousMessages: () => Promise<boolean>;
  onLoadMoreMessages: () => Promise<boolean>;
  onVisiblePageChange: (pageIndex: number) => void;
  onPageNavigationHandled: () => void;
};

export function useAnalysisMessageFeed({
  messages,
  directMessageNavigation,
  firstLoadedMessageIndex,
  hasMoreBeforeWindow,
  hasMoreAfterWindow,
  loadingBeforeWindow,
  loadingAfterWindow,
  isLoading,
  pageNavigationTarget,
  viewportPreservationKey,
  edgeLoadRetryKey,
  onViewportCaptureChange,
  scrollResetKey,
  onLoadPreviousMessages,
  onLoadMoreMessages,
  onVisiblePageChange,
  onPageNavigationHandled,
}: Options) {
  const onFirstVisibleMessage = useCallback(
    (_id: number, index: number) => {
      onVisiblePageChange(
        directMessageNavigation?.focusActive
          ? Math.floor(directMessageNavigation.targetMessageIndex / ANALYSIS_MESSAGES_PAGE_SIZE)
          : Math.max(
              0,
              Math.floor((firstLoadedMessageIndex + index) / ANALYSIS_MESSAGES_PAGE_SIZE),
            ),
      );
    },
    [directMessageNavigation, firstLoadedMessageIndex, onVisiblePageChange],
  );
  const pageMessageId =
    pageNavigationTarget === null
      ? null
      : (messages[
          pageNavigationTarget * ANALYSIS_MESSAGES_PAGE_SIZE - firstLoadedMessageIndex
        ]?.[0] ?? null);
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
  const isDirectionLoading = (direction: 'earlier' | 'later' | null) =>
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
  const loadingAbove = directMessageNavigation
    ? Boolean(isDirectionLoading(above))
    : loadingBeforeWindow;
  const loadingBelow = directMessageNavigation
    ? Boolean(isDirectionLoading(below))
    : loadingAfterWindow;
  const hasMoreAbove = directMessageNavigation ? Boolean(canLoad(above)) : hasMoreBeforeWindow;
  const hasMoreBelow = directMessageNavigation ? Boolean(canLoad(below)) : hasMoreAfterWindow;
  const scrollOptions: MessageFeedScrollOptions = {
    policy: ANALYSIS_MESSAGE_FEED_POLICY,
    focus,
    navigationTarget,
    viewportPreservationKey,
    edgeLoadRetryKey,
    onViewportCaptureChange,
    resetKey: scrollResetKey,
    initialPositioningReady: !directMessageNavigation?.contextLoading,
    loadEdgesOnLayout: !isLoading && !directMessageNavigation?.contextLoading,
    hasReachedStart: isLoading || !hasMoreAbove,
    onLoadOlder: directMessageNavigation
      ? (load(above) ?? (() => undefined))
      : onLoadPreviousMessages,
    onLoadNewer: directMessageNavigation ? load(below) : onLoadMoreMessages,
    unreadPrefetchNeeded: !isLoading && hasMoreBelow,
    onFirstVisibleMessage,
  };
  return {
    scrollOptions,
    displayedMessages,
    loadingAbove,
    loadingBelow,
    hasMoreAbove,
    hasMoreBelow,
  };
}
