import type { MutableRefObject, RefObject, UIEventHandler } from 'react';

export type WindowedFeedScrollItem = { id: number };

export type VisibleAnchor = {
  id: number;
  index: number;
  offsetTop: number;
};

export type AnchorSnapshot = {
  anchors: VisibleAnchor[];
  itemOffsets: Map<number, number>;
  itemIds: readonly number[];
  scrollTop: number;
  scrollHeight: number;
};

export type TopStatus = 'loading' | 'reached-start' | 'none';

export enum ScrollNavigationIntent {
  Initial = 'initial',
  AutomaticFollow = 'automatic-follow',
  Explicit = 'explicit',
}

/** A single explicit arrow navigation. The scroll owner is the only producer of landed. */
export type ExplicitScrollNavigation = {
  feedId: string;
  generation: number;
  targetId: number;
  isCurrent: () => boolean;
  onLanded: () => void;
  onUnavailable: () => void;
};

export type FollowScrollWait = {
  debugReason: string;
  intent: ScrollNavigationIntent;
  startedAtMs: number;
  lastHeight: number;
  stableFrames: number;
  enableFollow: boolean;
};

export type ScrollStateOpts = {
  allowLoadOlder?: boolean;
  allowLoadNewer?: boolean;
  allowTopReached?: boolean;
  /** Buffered arrivals are consumed only in response to reader scroll input. */
  allowPendingFlush?: boolean;
};

export type WindowedFeedScrollCallbacks = {
  onLoadOlder: () => void;
  onLoadNewer?: () => void;
  onFlushPendingNewer?: (context: {
    physicallyAtBottom: boolean;
    visibleAnchorIds: readonly number[];
  }) => void;
  onScrollToTop?: () => void;
  onReachedBottom?: (context: { hasSeenNotAtBottom: boolean }) => boolean | void;
  onLeftBottom?: () => void;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
};

export type UseWindowedFeedScrollOptions = {
  itemIds: readonly number[];
  loadingOlder: boolean;
  loadingNewer?: boolean;
  hasReachedStart: boolean;
  onLoadOlder: () => void;
  onLoadNewer?: () => void;
  onScrollToTop?: () => void;
  onReachedBottom?: (context: { hasSeenNotAtBottom: boolean }) => boolean | void;
  onLeftBottom?: () => void;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  topLoadBufferPx?: number;
  bottomLoadBufferPx?: number;
  atBottomThresholdPx?: number;
  resetKey?: string | number | null;
  isWatchMode?: boolean;
  /** Global authorization for automatic positioning. Explicit arrow navigation bypasses this. */
  autoScrollAllowed?: boolean;
  /** The persisted auto-scroll preference has resolved (including a safe failed-OFF result). */
  initialPositioningReady?: boolean;
  enabled?: boolean;
  debugFeedId?: string;
  /**
   * When false, near-bottom will not arm another newer load (unread runway after
   * last-seen is already full enough). Defaults to true.
   */
  unreadPrefetchNeeded?: boolean;
  /** When true, flush buffered newer pages into the window after scroll idle. */
  pendingNewerFlushNeeded?: boolean;
  onFlushPendingNewer?: (context: {
    physicallyAtBottom: boolean;
    visibleAnchorIds: readonly number[];
  }) => void;
};

export type WindowedFeedScrollHandle = {
  scrollerRef: RefObject<HTMLDivElement>;
  listRef: RefObject<HTMLDivElement>;
  handleScroll: UIEventHandler<HTMLDivElement>;
  setItemRef: (id: number) => (node: HTMLDivElement | null) => void;
  scrollToBottom: (
    behavior?: ScrollBehavior,
    intent?: ScrollNavigationIntent,
    navigation?: ExplicitScrollNavigation,
  ) => void;
};

export type WindowedFeedScrollRefs = {
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  listRef: MutableRefObject<HTMLDivElement | null>;
  itemRefsRef: MutableRefObject<Map<number, HTMLDivElement>>;
  itemIdsRef: MutableRefObject<readonly number[]>;
  anchorSnapshotRef: MutableRefObject<AnchorSnapshot | null>;
  callbacksRef: MutableRefObject<WindowedFeedScrollCallbacks>;
  loadOlderTriggeredRef: MutableRefObject<boolean>;
  loadNewerTriggeredRef: MutableRefObject<boolean>;
  loadNewerIdleTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  flushPendingIdleTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  hasSeenNotAtBottomRef: MutableRefObject<boolean>;
  atBottomRef: MutableRefObject<boolean | null>;
  physicallyAtBottomRef: MutableRefObject<boolean | null>;
  previousScrollTopRef: MutableRefObject<number>;
  nearBottomRef: MutableRefObject<boolean | null>;
  atTopRef: MutableRefObject<boolean | null>;
  hasInitialScrolledRef: MutableRefObject<boolean>;
  bottomSettleActiveRef: MutableRefObject<boolean>;
  bottomSettleFramesRemainingRef: MutableRefObject<number>;
  bottomSettleRafRef: MutableRefObject<number | null>;
  bottomSettleTimeoutRef: MutableRefObject<ReturnType<typeof setTimeout> | null>;
  bottomSettleResizeObserverRef: MutableRefObject<ResizeObserver | null>;
  liveBottomFollowRef: MutableRefObject<boolean>;
  smoothFollowUntilMsRef: MutableRefObject<number>;
  followScrollRafRef: MutableRefObject<number | null>;
  followAnimatingRef: MutableRefObject<boolean>;
  followScrollWaitRef: MutableRefObject<FollowScrollWait | null>;
  scheduleFollowScrollWhenStableRef: MutableRefObject<
    | ((
        debugReason: string,
        intent: ScrollNavigationIntent,
        options?: { enableFollow?: boolean },
        navigation?: ExplicitScrollNavigation,
      ) => void)
    | null
  >;
  isRestoringAnchorRef: MutableRefObject<boolean>;
  previousItemIdsRef: MutableRefObject<readonly number[]>;
  previousResetKeyRef: MutableRefObject<string | number | null>;
  previousTopStatusRef: MutableRefObject<TopStatus>;
  isWatchModeRef: MutableRefObject<boolean>;
  autoScrollAllowedRef: MutableRefObject<boolean>;
  loadingNewerRef: MutableRefObject<boolean>;
  unreadPrefetchNeededRef: MutableRefObject<boolean>;
  pendingNewerFlushNeededRef: MutableRefObject<boolean>;
  enabledRef: MutableRefObject<boolean>;
  handleScrollRafRef: MutableRefObject<number | null>;
  reportVisibleMessageIdsRafRef: MutableRefObject<number | null>;
  reportVisibleMessageIdsLastRunRef: MutableRefObject<number>;
  reportVisibleMessageIdsLatestArgsRef: MutableRefObject<boolean>;
};

export const DEFAULT_TOP_LOAD_BUFFER_PX = 160;
export const DEFAULT_BOTTOM_LOAD_BUFFER_PX = 320;
export const DEFAULT_AT_BOTTOM_THRESHOLD_PX = 25;
export const INITIAL_BOTTOM_SETTLE_FRAMES = 12;
export const INITIAL_BOTTOM_SETTLE_TIMEOUT_MS = 2000;
/** Wait for scroll to settle before prefetching newer — avoids mid-fling window commits. */
export const LOAD_NEWER_SCROLL_IDLE_MS = 140;
/** Same idle gate: push buffered newer pages into the DOM only when the finger stops. */
export const FLUSH_PENDING_SCROLL_IDLE_MS = LOAD_NEWER_SCROLL_IDLE_MS;

export function areNumberArraysEqual(a: readonly number[], b: readonly number[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  if (a.length === 0) return true;
  if (a[0] !== b[0] || a[a.length - 1] !== b[b.length - 1]) return false;
  for (let i = 1; i < a.length - 1; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

export function distanceToBottom(el: HTMLElement): number {
  return Math.max(0, el.scrollHeight - el.clientHeight - el.scrollTop);
}

/**
 * When unread prefetch is still needed, allow a slightly deeper bottom load zone so
 * tall trailing rows still trigger catch-up — but never more than ~2 viewports.
 * (A "last N messages" zone was too large with tall cards and caused mid-read
 * newer loads + window trim freezes.)
 */
export function effectiveBottomLoadBufferPx(
  scroller: HTMLElement,
  bottomLoadBufferPx: number,
  unreadPrefetchNeeded: boolean,
): number {
  if (!unreadPrefetchNeeded) return bottomLoadBufferPx;
  const viewportCap = Math.max(bottomLoadBufferPx, scroller.clientHeight * 2);
  return Math.min(viewportCap, bottomLoadBufferPx * 2);
}

export function nowMs(): number {
  return typeof performance !== 'undefined' && typeof performance.now === 'function'
    ? performance.now()
    : Date.now();
}
