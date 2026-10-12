import {
  forwardRef,
  useImperativeHandle,
  useMemo,
  type ForwardedRef,
  type ReactElement,
  type RefAttributes,
} from 'react';
import { MessageFeedViewport, type MessageFeedViewportProps } from './MessageFeedViewport';
import { MessageFeedItemRegistration } from './MessageFeedItem';
import { MessageFeedSkeletons } from './MessageFeedSkeletons';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';
import type { MessageFeedHandle, MessageFeedScrollOptions } from './message-feed.types';
import './message-feed.css';

export { MessageFeedRows } from './MessageFeedViewport';

export type MessageFeedProps<T> = Omit<MessageFeedViewportProps<T>, 'scroll'> & {
  scrollOptions: MessageFeedScrollOptions;
  isLoading?: boolean;
  loadingAbove?: boolean;
  loadingBelow?: boolean;
  skeletonCount?: number;
};

function MessageFeedInner<T>(
  {
    scrollOptions,
    loadingAbove = false,
    loadingBelow = false,
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
            {loadingAbove ? <MessageFeedSkeletons listTag={listTag} position="above" /> : null}
            {showInitialSkeleton ? (
              <MessageFeedSkeletons count={skeletonCount} listTag={listTag} />
            ) : null}
            {beforeMessages}
          </>
        }
        afterMessages={
          <>
            {afterMessages}
            {loadingBelow ? <MessageFeedSkeletons listTag={listTag} position="below" /> : null}
          </>
        }
      />
    </MessageFeedItemRegistration>
  );
}

export const MessageFeed = forwardRef(MessageFeedInner) as <T>(
  props: MessageFeedProps<T> & RefAttributes<MessageFeedHandle>,
) => ReactElement;
