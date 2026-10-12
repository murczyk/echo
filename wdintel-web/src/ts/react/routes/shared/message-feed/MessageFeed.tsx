import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
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
import { isAtPhysicalBottom } from './internal/scroll-math';
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
  const scroll = useWindowedFeedScroll({
    ...scrollOptions,
    itemIds,
    loadingOlder: loadingAbove,
    loadingNewer: loadingBelow,
  });
  const [atNewestEdge, setAtNewestEdge] = useState(false);
  const newestEdge = newestNavigation?.edge;
  const updateNewestEdge = useCallback(() => {
    const scroller = scroll.scrollerRef.current;
    if (!scroller || !newestEdge) return;
    const atEdge = newestEdge === 'top' ? scroller.scrollTop <= 0 : isAtPhysicalBottom(scroller);
    setAtNewestEdge((previous) => (previous === atEdge ? previous : atEdge));
  }, [newestEdge, scroll.scrollerRef]);
  useLayoutEffect(updateNewestEdge, [updateNewestEdge, items, scroll.bottomSpacerPx]);
  useImperativeHandle(
    ref,
    () => ({
      scrollToBottom: scroll.scrollToBottom,
      scrollToMessage: scroll.scrollToItem,
      getItemElement: scroll.getItemElement,
      getScrollerElement: () => scroll.scrollerRef.current,
      getBottomSpacerPx: () => scroll.bottomSpacerPx,
    }),
    [
      scroll.bottomSpacerPx,
      scroll.getItemElement,
      scroll.scrollerRef,
      scroll.scrollToBottom,
      scroll.scrollToItem,
    ],
  );
  const showInitialSkeleton = isLoading && items.length === 0;
  const showRefreshSkeleton = isLoading && items.length > 0;
  const showAboveSkeleton = items.length > 0 && hasMoreAbove;
  const showBelowSkeleton = items.length > 0 && hasMoreBelow;
  return (
    <MessageFeedItemRegistration setItemRef={scroll.setItemRef}>
      <MessageFeedViewport
        {...viewportProps}
        scroll={scroll}
        items={items}
        getMessageId={getMessageId}
        listTag={listTag}
        scrollerProps={{
          ...scrollerProps,
          'aria-busy': isLoading || loadingAbove || loadingBelow,
          'data-message-feed-refreshing': showRefreshSkeleton ? 'true' : undefined,
          onScroll: (event) => {
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
              <MessageFeedSkeletons listTag={listTag} position="above" loading={loadingAbove} />
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
              <MessageFeedSkeletons listTag={listTag} position="below" loading={loadingBelow} />
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
