import {
  Fragment,
  useCallback,
  useLayoutEffect,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
  type Ref,
} from 'react';
import type { WindowedFeedScrollHandle } from './message-feed.types';

export type FeedElementAttributes<T extends HTMLElement> = HTMLAttributes<T> & {
  [key: `data-${string}`]: string | boolean | undefined;
};

export type MessageFeedViewportProps<T> = {
  scroll: WindowedFeedScrollHandle;
  items: readonly T[];
  getMessageId: (item: T) => number;
  renderMessage?: (item: T) => ReactNode;
  children?: ReactNode;
  scrollerProps?: FeedElementAttributes<HTMLDivElement>;
  listProps?: FeedElementAttributes<HTMLElement>;
  listTag?: 'div' | 'ul';
  itemSelector?: string;
  beforeList?: ReactNode;
  beforeMessages?: ReactNode;
  afterMessages?: ReactNode;
  scrollerRef?: Ref<HTMLDivElement>;
};

export function MessageFeedRows<T>({
  items,
  getMessageId,
  renderMessage,
}: {
  items: readonly T[];
  getMessageId: (item: T) => number;
  renderMessage: (item: T) => ReactNode;
}) {
  return items.map((item) => <Fragment key={getMessageId(item)}>{renderMessage(item)}</Fragment>);
}

export function MessageFeedViewport<T>({
  scroll,
  items,
  getMessageId,
  renderMessage,
  children,
  scrollerProps,
  listProps,
  listTag: List = 'div',
  itemSelector = '[data-message-id]',
  beforeList,
  beforeMessages,
  afterMessages,
  scrollerRef,
}: MessageFeedViewportProps<T>) {
  const setScrollerRef = useCallback(
    (element: HTMLDivElement | null) => {
      (scroll.scrollerRef as MutableRefObject<HTMLDivElement | null>).current = element;
      if (typeof scrollerRef === 'function') scrollerRef(element);
      else if (scrollerRef) (scrollerRef as { current: HTMLDivElement | null }).current = element;
    },
    [scroll.scrollerRef, scrollerRef],
  );
  const setListRef = useCallback(
    (element: HTMLElement | null) => {
      scroll.listRef.current = element;
    },
    [scroll.listRef],
  );
  useLayoutEffect(() => {
    const elements = scroll.listRef.current?.querySelectorAll<HTMLElement>(itemSelector);
    elements?.forEach((element) => {
      const id = Number(element.dataset.messageId ?? element.dataset.dutyMessageId);
      if (Number.isFinite(id)) scroll.setItemRef(id)(element);
    });
  }, [items, itemSelector, scroll.setItemRef]);

  return (
    <div
      {...scrollerProps}
      ref={setScrollerRef}
      data-message-feed-scroller
      className={`message-feed-scroller ${scrollerProps?.className ?? ''}`}
      onScroll={(event) => {
        scroll.handleScroll(event);
        scrollerProps?.onScroll?.(event);
      }}
    >
      {beforeList}
      <List
        {...listProps}
        ref={setListRef}
        className={`message-feed-list ${listProps?.className ?? ''}`}
      >
        {beforeMessages}
        {renderMessage ? (
          <MessageFeedRows
            items={items}
            getMessageId={getMessageId}
            renderMessage={renderMessage}
          />
        ) : (
          children
        )}
        {afterMessages}
      </List>
      {scroll.bottomSpacerPx > 0 ? (
        <div
          aria-hidden="true"
          data-direct-message-anchor-spacer="true"
          style={{ height: scroll.bottomSpacerPx }}
        />
      ) : null}
    </div>
  );
}
