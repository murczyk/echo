import {
  forwardRef,
  memo,
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
import { CreateMessageFab } from '../manage-message/CreateMessageFab';
import { MessageFeedScrollFab } from './MessageFeedScrollFab';
import { MessageFeedSkeletons } from './MessageFeedSkeletons';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';
import {
  areIdArraysEqual,
  isAtPhysicalBottom,
  LOAD_NEWER_SCROLL_IDLE_MS,
  nowMs,
} from './internal/scroll-math';
import type {
  MessageFeedHandle,
  MessageFeedId,
  MessageFeedScrollOptions,
} from './message-feed.types';
import './message-feed.css';

export { MessageFeedRows } from './MessageFeedViewport';

// The jump-to-newest control. A host with its own button passes `renderControl`; otherwise the feed
// shows the shared arrow, and only when `onClick` is there to handle it.
export type MessageFeedNewestNavigation = {
  edge: 'top' | 'bottom';
  // Extra classes for the floating stack that holds the arrow (and the create button). Move it with
  // `--message-feed-fab-right` and `--message-feed-fab-bottom` (`-top` for a top edge), e.g.
  // `[--message-feed-fab-right:32px]`.
  className?: string;
} & (
  | { renderControl: (atNewestEdge: boolean) => ReactNode }
  | {
      renderControl?: undefined;
      onClick?: () => void;
      // True once the newest message is loaded; reaching the end of a loaded chunk is not enough.
      newestLoaded: boolean;
      loading?: boolean;
      label?: string;
    }
);

// The jump-to-oldest arrow, opt-in: a host passes it when it can load the start of its list (the
// chat room does). It always sits in the bottom stack, above the jump-to-newest arrow and below the
// create button.
export type MessageFeedOldestNavigation = {
  onClick: () => void;
  // True once the oldest message is loaded; reaching the top of a loaded chunk is not enough.
  oldestLoaded: boolean;
  loading?: boolean;
  label?: string;
};

export function shouldShowOldestNavigation(atOldestEdge: boolean, oldestLoaded: boolean): boolean {
  return !atOldestEdge || !oldestLoaded;
}

export function shouldShowNewestNavigation(atNewestEdge: boolean, newestLoaded: boolean): boolean {
  return !atNewestEdge || !newestLoaded;
}

// A plain function, not a component: it returns null when nothing is to be shown, and the floating
// stack then stays out of the DOM.
function renderDefaultNewestControl(
  navigation: Extract<MessageFeedNewestNavigation, { renderControl?: undefined }>,
  atNewestEdge: boolean,
): ReactNode {
  const { edge, onClick, newestLoaded, loading, label } = navigation;
  if (onClick == null || !shouldShowNewestNavigation(atNewestEdge, newestLoaded)) return null;
  return (
    <MessageFeedScrollFab
      direction={edge === 'bottom' ? 'down' : 'up'}
      ariaLabel={label ?? 'До найновіших повідомлень'}
      onClick={onClick}
      loading={loading}
      disabled={loading}
    />
  );
}

// Memoized: the feed re-renders on scroll-edge and loading changes, the create button does not need to.
const MemoCreateMessageFab = memo(CreateMessageFab);

// The arrow and the create button share one stack, arrow above, so they never overlap. Controls the
// host does not pass are simply absent. A top-edge arrow sits alone at the top.
function MessageFeedFloatingControls({
  edge,
  className,
  newestControl,
  oldestControl,
  onCreateMessage,
}: {
  edge: 'top' | 'bottom';
  className?: string;
  newestControl: ReactNode;
  oldestControl: ReactNode;
  onCreateMessage?: (focusTarget?: HTMLElement) => void;
}) {
  const classes = `message-feed-floating-controls${className ? ` ${className}` : ''}`;
  const arrowOnTop = edge === 'top';
  const stackedArrow = arrowOnTop ? null : newestControl;
  const createButton = onCreateMessage ? (
    <MemoCreateMessageFab placement="inline" onClick={onCreateMessage} />
  ) : null;
  return (
    <>
      {arrowOnTop && newestControl != null ? (
        <div data-message-feed-floating-controls data-edge="top" className={classes}>
          {newestControl}
        </div>
      ) : null}
      {stackedArrow != null || oldestControl != null || createButton != null ? (
        <div data-message-feed-floating-controls data-edge="bottom" className={classes}>
          {oldestControl == null ? (
            // Without the oldest arrow the order is what it always was: newest arrow, then create.
            <>
              {stackedArrow}
              {createButton}
            </>
          ) : (
            <>
              {createButton}
              {oldestControl}
              {stackedArrow}
            </>
          )}
        </div>
      ) : null}
    </>
  );
}

export type MessageFeedProps<T, Id extends MessageFeedId = number> = Omit<
  MessageFeedViewportProps<T, Id>,
  'scroll'
> & {
  scrollOptions: MessageFeedScrollOptions<Id>;
  newestNavigation?: MessageFeedNewestNavigation;
  oldestNavigation?: MessageFeedOldestNavigation;
  // Shows the create button under the arrow. Without it there is no button.
  onCreateMessage?: (focusTarget?: HTMLElement) => void;
  isLoading?: boolean;
  showLoadingSkeleton?: boolean;
  loadingAbove?: boolean;
  loadingBelow?: boolean;
  hasMoreAbove?: boolean;
  hasMoreBelow?: boolean;
  skeletonCount?: number;
  editorHighlightedMessageId?: Id | null;
};

function MessageFeedInner<T, Id extends MessageFeedId = number>(
  {
    scrollOptions,
    newestNavigation,
    oldestNavigation,
    onCreateMessage,
    loadingAbove = false,
    loadingBelow = false,
    hasMoreAbove = false,
    hasMoreBelow = false,
    isLoading = false,
    showLoadingSkeleton = true,
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
  }: MessageFeedProps<T, Id>,
  ref: ForwardedRef<MessageFeedHandle<Id>>,
) {
  const itemIds = useMemo(() => items.map(getMessageId), [items, getMessageId]);
  const incoming = {
    items,
    children: viewportProps.children,
    isLoading,
    showLoadingSkeleton,
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
    const sameWindow = areIdArraysEqual(shown.items.map(getMessageId), itemIds);
    const unchanged =
      shown.items === items &&
      shown.children === viewportProps.children &&
      shown.isLoading === isLoading &&
      shown.showLoadingSkeleton === showLoadingSkeleton &&
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
    showLoadingSkeleton,
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
  const [linkedHighlightedMessageId, setLinkedHighlightedMessageId] = useState<Id | null>(null);
  const highlightedElementRef = useRef<HTMLElement | null>(null);
  const highlightedWindowRef = useRef<readonly Id[] | null>(null);
  const highlightLoadStartRef = useRef<{ items: readonly T[]; ids: readonly Id[] } | null>(null);
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
      if (started.items !== visibleItems || !areIdArraysEqual(started.ids, visibleItemIds)) {
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
          !areIdArraysEqual(highlightedWindowRef.current, visibleItemIds)))
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
      highlightedElementRef.current?.removeAttribute('data-message-feed-highlight-kind');
      highlightedElementRef.current = nextElement;
    }
    const clearLinkedHighlight = (event: AnimationEvent) => {
      if (event.animationName === 'message-feed-linked-highlight') {
        setLinkedHighlightedMessageId((current) =>
          current === linkedHighlightedMessageId ? null : current,
        );
      }
    };
    nextElement?.setAttribute('data-message-feed-highlighted', 'true');
    nextElement?.setAttribute(
      'data-message-feed-highlight-kind',
      editorHighlightedMessageId == null ? 'linked' : 'editor',
    );
    nextElement?.addEventListener('animationend', clearLinkedHighlight);
    return () => {
      nextElement?.removeEventListener('animationend', clearLinkedHighlight);
    };
  }, [
    highlightedMessageId,
    editorHighlightedMessageId,
    linkedHighlightedMessageId,
    scroll.getItemElement,
    shown.children,
    visibleItems,
  ]);
  const highlightLinkedMessage = useCallback(
    (id: Id) => {
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
  const [atOldestEdge, setAtOldestEdge] = useState(true);
  const hasOldestNavigation = oldestNavigation != null;
  const updateOldestEdge = useCallback(() => {
    const scroller = scroll.scrollerRef.current;
    if (!scroller || !hasOldestNavigation) return;
    const atEdge = scroller.scrollTop <= 0;
    setAtOldestEdge((previous) => (previous === atEdge ? previous : atEdge));
  }, [hasOldestNavigation, scroll.scrollerRef]);
  useLayoutEffect(updateOldestEdge, [updateOldestEdge, visibleItems]);
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
  const showInitialSkeleton =
    shown.showLoadingSkeleton && shown.isLoading && visibleItems.length === 0;
  const showRefreshSkeleton =
    shown.showLoadingSkeleton && shown.isLoading && visibleItems.length > 0;
  const showAboveSkeleton = visibleItems.length > 0 && shown.hasMoreAbove;
  const showBelowSkeleton = visibleItems.length > 0 && shown.hasMoreBelow;
  const newestControl =
    newestNavigation == null
      ? null
      : newestNavigation.renderControl != null
        ? newestNavigation.renderControl(atNewestEdge)
        : renderDefaultNewestControl(newestNavigation, atNewestEdge);
  const oldestControl =
    oldestNavigation != null &&
    shouldShowOldestNavigation(atOldestEdge, oldestNavigation.oldestLoaded) ? (
      <MessageFeedScrollFab
        direction="up"
        ariaLabel={oldestNavigation.label ?? 'До найстаріших повідомлень'}
        onClick={oldestNavigation.onClick}
        loading={oldestNavigation.loading}
        disabled={oldestNavigation.loading}
      />
    ) : null;
  const RefreshContainer = listTag === 'ul' ? 'li' : 'div';
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
            updateOldestEdge();
            scrollerProps?.onScroll?.(event);
          },
        }}
        beforeList={beforeList}
        beforeMessages={
          <>
            {showRefreshSkeleton ? (
              <RefreshContainer className="message-feed-refresh-overlay">
                <MessageFeedSkeletons count={skeletonCount} position="refresh" />
              </RefreshContainer>
            ) : null}
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
      <MessageFeedFloatingControls
        edge={newestNavigation?.edge ?? 'bottom'}
        className={newestNavigation?.className}
        newestControl={newestControl}
        oldestControl={oldestControl}
        onCreateMessage={onCreateMessage}
      />
    </MessageFeedItemRegistration>
  );
}

export const MessageFeed = forwardRef(MessageFeedInner) as <T, Id extends MessageFeedId = number>(
  props: MessageFeedProps<T, Id> & RefAttributes<MessageFeedHandle<Id>>,
) => ReactElement;
