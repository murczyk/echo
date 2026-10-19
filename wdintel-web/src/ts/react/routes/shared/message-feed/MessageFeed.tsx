import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ForwardedRef,
  type ReactElement,
  type ReactNode,
  type RefAttributes,
} from 'react';
import { MessageFeedViewport, type MessageFeedViewportProps } from './MessageFeedViewport';
import { MessageFeedItemRegistration } from './MessageFeedItem';
import { MessageFeedSkeletons } from './MessageFeedSkeletons';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';
import {
  areNumberArraysEqual,
  isAtPhysicalBottom,
  LOAD_NEWER_SCROLL_IDLE_MS,
  nowMs,
} from './internal/scroll-math';
import type { MessageFeedHandle, MessageFeedScrollOptions } from './message-feed.types';
import './message-feed.css';

export { MessageFeedRows } from './MessageFeedViewport';

export type MessageFeedNewestNavigation = {
  edge: 'top' | 'bottom';
  renderControl: (atNewestEdge: boolean) => ReactNode;
};

export function shouldShowNewestNavigation(atNewestEdge: boolean, newestLoaded: boolean): boolean {
  return !atNewestEdge || !newestLoaded;
}

export type MessageFeedProps<T> = Omit<MessageFeedViewportProps<T>, 'scroll'> & {
  scrollOptions: MessageFeedScrollOptions;
  newestNavigation?: MessageFeedNewestNavigation;
  isLoading?: boolean;
  loadingAbove?: boolean;
  loadingBelow?: boolean;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  skeletonCount?: number;
  editorHighlightedMessageId?: number | null;
};

function MessageFeedInner<T>(
  {
    scrollOptions,
    newestNavigation,
    loadingAbove = false,
    loadingBelow = false,
    hasMoreAbove = false,
    hasMoreBelow = false,
    isLoading = false,
    skeletonCount = 3,
    editorHighlightedMessageId = null,
    items,
    getMessageId,
    scrollerProps,
    listTag = 'div',
    beforeList,
    beforeMessages,
    afterMessages,
    ...viewportProps
  }: MessageFeedProps<T>,
  ref: ForwardedRef<MessageFeedHandle>,
) {
  const itemIds = useMemo(() => items.map(getMessageId), [items, getMessageId]);
  const incoming = {
    items,
    children: viewportProps.children,
    isLoading,
    loadingAbove,
    loadingBelow,
    hasMoreAbove,
    hasMoreBelow,
    resetKey: scrollOptions.resetKey,
    viewportPreservationKey: scrollOptions.viewportPreservationKey,
  };
  const latestRef = useRef(incoming);
  latestRef.current = incoming;
  const [shown, setShown] = useState(incoming);
  const lastWheelAtRef = useRef<number | null>(null);
  const commitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduleCommit = useCallback((delayMs: number) => {
    if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    commitTimerRef.current = setTimeout(() => {
      commitTimerRef.current = null;
      lastWheelAtRef.current = null;
      setShown(latestRef.current);
    }, delayMs);
  }, []);
  useLayoutEffect(() => {
    const sameWindow = areNumberArraysEqual(shown.items.map(getMessageId), itemIds);
    const unchanged =
      shown.items === items &&
      shown.children === viewportProps.children &&
      shown.isLoading === isLoading &&
      shown.loadingAbove === loadingAbove &&
      shown.loadingBelow === loadingBelow &&
      shown.hasMoreAbove === hasMoreAbove &&
      shown.hasMoreBelow === hasMoreBelow &&
      shown.resetKey === scrollOptions.resetKey &&
      shown.viewportPreservationKey === scrollOptions.viewportPreservationKey;
    if (unchanged) return;
    const elapsed = lastWheelAtRef.current === null ? Infinity : nowMs() - lastWheelAtRef.current;
    const canDefer =
      !sameWindow &&
      elapsed < LOAD_NEWER_SCROLL_IDLE_MS &&
      shown.resetKey === scrollOptions.resetKey &&
      shown.viewportPreservationKey === scrollOptions.viewportPreservationKey &&
      !scrollOptions.navigationTarget;
    if (canDefer) {
      scheduleCommit(LOAD_NEWER_SCROLL_IDLE_MS - elapsed);
    } else {
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
      commitTimerRef.current = null;
      setShown(incoming);
    }
  }, [
    getMessageId,
    itemIds,
    items,
    viewportProps.children,
    isLoading,
    loadingAbove,
    loadingBelow,
    hasMoreAbove,
    hasMoreBelow,
    scrollOptions.resetKey,
    scrollOptions.viewportPreservationKey,
    scrollOptions.navigationTarget,
    scheduleCommit,
    shown,
  ]);
  useLayoutEffect(
    () => () => {
      if (commitTimerRef.current !== null) clearTimeout(commitTimerRef.current);
    },
    [],
  );
  const visibleItems = shown.items;
  const visibleItemIds = useMemo(
    () => visibleItems.map(getMessageId),
    [visibleItems, getMessageId],
  );
  const scroll = useWindowedFeedScroll({
    ...scrollOptions,
    itemIds: visibleItemIds,
    loadingOlder: shown.loadingAbove,
    loadingNewer: shown.loadingBelow,
  });
  const [linkedHighlightedMessageId, setLinkedHighlightedMessageId] = useState<number | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);
  const highlightedWindowRef = useRef<readonly number[] | null>(null);
  const highlightLoadStartRef = useRef<{ items: readonly T[]; ids: readonly number[] } | null>(
    null,
  );
  const highlightedMessageId = editorHighlightedMessageId ?? linkedHighlightedMessageId;
  useLayoutEffect(() => {
    const loadingContent =
      shown.isLoading ||
      (shown.hasMoreAbove && shown.loadingAbove) ||
      (shown.hasMoreBelow && shown.loadingBelow);
    if (linkedHighlightedMessageId === null) {
      highlightLoadStartRef.current = null;
    } else if (loadingContent || scrollOptions.pendingNewerFlushNeeded) {
      highlightLoadStartRef.current ??= { items: visibleItems, ids: visibleItemIds };
    } else if (highlightLoadStartRef.current !== null) {
      const started = highlightLoadStartRef.current;
      if (started.items !== visibleItems || !areNumberArraysEqual(started.ids, visibleItemIds)) {
        highlightLoadStartRef.current = null;
        setLinkedHighlightedMessageId(null);
      } else if (items === visibleItems) {
        highlightLoadStartRef.current = null;
      }
    }
    if (
      linkedHighlightedMessageId !== null &&
      (!visibleItemIds.includes(linkedHighlightedMessageId) ||
        (highlightedWindowRef.current !== null &&
          !areNumberArraysEqual(highlightedWindowRef.current, visibleItemIds)))
    ) {
      setLinkedHighlightedMessageId(null);
    }
  }, [
    items,
    linkedHighlightedMessageId,
    scrollOptions.pendingNewerFlushNeeded,
    shown,
    visibleItemIds,
    visibleItems,
  ]);
  useLayoutEffect(() => {
    const nextElement =
      highlightedMessageId === null ? null : scroll.getItemElement(highlightedMessageId);
    if (highlightedElementRef.current !== nextElement) {
      highlightedElementRef.current?.removeAttribute('data-message-feed-highlighted');
      highlightedElementRef.current = nextElement;
    }
    nextElement?.setAttribute('data-message-feed-highlighted', 'true');
    return () => nextElement?.removeAttribute('data-message-feed-highlighted');
  }, [highlightedMessageId, scroll.getItemElement, shown.children, visibleItems]);
  const highlightLinkedMessage = useCallback(
    (id: number) => {
      if (!scroll.getItemElement(id)) return false;
      highlightLoadStartRef.current = null;
      highlightedWindowRef.current = visibleItemIds;
      setLinkedHighlightedMessageId(id);
      return true;
    },
    [scroll.getItemElement, visibleItemIds],
  );
  const [atNewestEdge, setAtNewestEdge] = useState(false);
  const newestEdge = newestNavigation?.edge;
  const updateNewestEdge = useCallback(() => {
    const scroller = scroll.scrollerRef.current;
    if (!scroller || !newestEdge) return;
    const atEdge = newestEdge === 'top' ? scroller.scrollTop <= 0 : isAtPhysicalBottom(scroller);
    setAtNewestEdge((previous) => (previous === atEdge ? previous : atEdge));
  }, [newestEdge, scroll.scrollerRef]);
  useLayoutEffect(updateNewestEdge, [updateNewestEdge, visibleItems, scroll.bottomSpacerPx]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: scroll.scrollToBottom,
      scrollToMessage: scroll.scrollToItem,
      highlightLinkedMessage,
      getItemElement: scroll.getItemElement,
      getScrollerElement: () => scroll.scrollerRef.current,
      getBottomSpacerPx: () => scroll.bottomSpacerPx,
    }),
    [
      scroll.bottomSpacerPx,
      scroll.getItemElement,
      highlightLinkedMessage,
      scroll.scrollerRef,
      scroll.scrollToBottom,
      scroll.scrollToItem,
    ],
  );
  const showInitialSkeleton = shown.isLoading && visibleItems.length === 0;
  const showRefreshSkeleton = shown.isLoading && visibleItems.length > 0;
  const showAboveSkeleton = visibleItems.length > 0 && shown.hasMoreAbove;
  const showBelowSkeleton = visibleItems.length > 0 && shown.hasMoreBelow;
  return (
    <MessageFeedItemRegistration setItemRef={scroll.setItemRef}>
      <MessageFeedViewport
        {...viewportProps}
        children={shown.children}
        scroll={scroll}
        items={visibleItems}
        getMessageId={getMessageId}
        listTag={listTag}
        scrollerProps={{
          ...scrollerProps,
          'aria-busy': shown.isLoading || shown.loadingAbove || shown.loadingBelow,
          'data-message-feed-refreshing': showRefreshSkeleton ? 'true' : undefined,
          onWheel: (event) => {
            if (event.deltaY !== 0 && !event.defaultPrevented) {
              lastWheelAtRef.current = nowMs();
              if (commitTimerRef.current !== null) scheduleCommit(LOAD_NEWER_SCROLL_IDLE_MS);
            }
            scrollerProps?.onWheel?.(event);
          },
          onScroll: (event) => {
            if (lastWheelAtRef.current !== null) {
              const atMs = nowMs();
              if (atMs - lastWheelAtRef.current < LOAD_NEWER_SCROLL_IDLE_MS) {
                lastWheelAtRef.current = atMs;
                if (commitTimerRef.current !== null) scheduleCommit(LOAD_NEWER_SCROLL_IDLE_MS);
              } else {
                lastWheelAtRef.current = null;
              }
            }
            updateNewestEdge();
            scrollerProps?.onScroll?.(event);
          },
        }}
        beforeList={
          <>
            {beforeList}
            {showRefreshSkeleton ? (
              <div className="message-feed-refresh-overlay">
                <MessageFeedSkeletons count={skeletonCount} position="refresh" />
              </div>
            ) : null}
          </>
        }
        beforeMessages={
          <>
            {showAboveSkeleton ? (
              <MessageFeedSkeletons
                listTag={listTag}
                position="above"
                loading={shown.loadingAbove}
              />
            ) : null}
            {showInitialSkeleton ? (
              <MessageFeedSkeletons count={skeletonCount} listTag={listTag} />
            ) : null}
            {beforeMessages}
          </>
        }
        afterMessages={
          <>
            {afterMessages}
            {showBelowSkeleton ? (
              <MessageFeedSkeletons
                listTag={listTag}
                position="below"
                loading={shown.loadingBelow}
              />
            ) : null}
          </>
        }
      />
      {newestNavigation?.renderControl(atNewestEdge)}
    </MessageFeedItemRegistration>
  );
}

export const MessageFeed = forwardRef(MessageFeedInner) as <T>(
  props: MessageFeedProps<T> & RefAttributes<MessageFeedHandle>,
) => ReactElement;
