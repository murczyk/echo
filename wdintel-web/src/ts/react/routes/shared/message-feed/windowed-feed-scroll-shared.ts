import type { MutableRefObject, RefObject, UIEventHandler } from 'react';
import type {
  FeedScrollDiagnostics,
  MessageFeedFocus,
  MessageFeedNavigationTarget,
  MessageFeedPolicy,
} from './message-feed.types';

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
  clientWidth?: number;
  clientHeight?: number;
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
  navigationIntent?: ScrollNavigationIntent;
};

export type ReachedBottomContext = {
  hasSeenNotAtBottom: boolean;
  /** Null means the reader reached bottom by scrolling, rather than programmatic navigation. */
  navigationIntent: ScrollNavigationIntent | null;
};

export type WindowedFeedScrollCallbacks = {
  onLoadOlder: () => void | Promise<unknown>;
  onLoadNewer?: () => void | Promise<unknown>;
  onFlushPendingNewer?: (context: {
    physicallyAtBottom: boolean;
    visibleAnchorIds: readonly number[];
  }) => void | Promise<unknown>;
  onScrollToTop?: () => void;
  onReachedBottom?: (context: ReachedBottomContext) => boolean | void;
  onLeftBottom?: () => void;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  onFirstVisibleMessage?: (id: number, index: number) => void;
};

export type UseWindowedFeedScrollOptions = {
  diagnostics?: FeedScrollDiagnostics;
  policy?: MessageFeedPolicy;
  focus?: MessageFeedFocus | null;
  navigationTarget?: MessageFeedNavigationTarget | null;
  viewportPreservationKey?: number;
  onViewportCaptureChange?: (capture: (() => void) | null) => void;
  onFirstVisibleMessage?: (id: number, index: number) => void;
  loadEdgesOnLayout?: boolean;
  positionResetKey?: string | number;
  preservePositionOnReset?: boolean;
  itemIds: readonly number[];
  initialAnchorSnapshot?: AnchorSnapshot | null;
  onAnchorSnapshotChange?: (snapshot: AnchorSnapshot | null) => void;
  loadingOlder: boolean;
  loadingNewer?: boolean;
  hasReachedStart: boolean;
  onLoadOlder: () => void | Promise<unknown>;
  onLoadNewer?: () => void | Promise<unknown>;
  onScrollToTop?: () => void;
  onReachedBottom?: (context: ReachedBottomContext) => boolean | void;
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
  /** Authorization for continued automatic following. Initial and explicit landings bypass this. */
  autoScrollAllowed?: boolean;
  /** The persisted auto-scroll preference has loaded successfully. */
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
  }) => void | Promise<unknown>;
};

export type WindowedFeedScrollHandle = {
  bottomSpacerPx: number;
  getItemElement: (id: number) => HTMLElement | null;
  scrollerRef: RefObject<HTMLDivElement>;
  listRef: MutableRefObject<HTMLElement | null>;
  handleScroll: UIEventHandler<HTMLDivElement>;
  setItemRef: (id: number) => (node: HTMLElement | null) => void;
  scrollToBottom: (
    behavior?: ScrollBehavior,
    intent?: ScrollNavigationIntent,
    navigation?: ExplicitScrollNavigation,
  ) => void;
  scrollToItem: (id: number, behavior?: ScrollBehavior) => HTMLElement | null;
};

export type WindowedFeedScrollRefs = {
  diagnosticsRef: MutableRefObject<FeedScrollDiagnostics | undefined>;
  scrollerRef: MutableRefObject<HTMLDivElement | null>;
  listRef: MutableRefObject<HTMLElement | null>;
  itemRefsRef: MutableRefObject<Map<number, HTMLElement>>;
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
  preserveBottomAnchorRef: MutableRefObject<boolean>;
  smoothFollowUntilMsRef: MutableRefObject<number>;
  followScrollRafRef: MutableRefObject<number | null>;
  followAnimatingRef: MutableRefObject<boolean>;
  followScrollWaitRef: MutableRefObject<FollowScrollWait | null>;
  scheduleFollowScrollWhenStableRef: MutableRefObject<
    | ((
        debugReason: string,
        intent: ScrollNavigationIntent,
        options?: { enableFollow?: boolean; behavior?: ScrollBehavior },
        navigation?: ExplicitScrollNavigation,
      ) => void)
    | null
  >;
  isRestoringAnchorRef: MutableRefObject<boolean>;
  restoredScrollTopRef: MutableRefObject<number | null>;
  previousItemIdsRef: MutableRefObject<readonly number[]>;
  previousResetKeyRef: MutableRefObject<string | number | null>;
  previousTopStatusRef: MutableRefObject<TopStatus>;
  isWatchModeRef: MutableRefObject<boolean>;
  autoScrollAllowedRef: MutableRefObject<boolean>;
  loadingNewerRef: MutableRefObject<boolean>;
  loadingOlderRef: MutableRefObject<boolean>;
  hasReachedStartRef: MutableRefObject<boolean>;
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

export function hasViewportSizeChanged(
  scroller: HTMLElement,
  snapshot: AnchorSnapshot | null,
): boolean {
  return (
    snapshot !== null &&
    (((snapshot.clientWidth ?? 0) > 0 && snapshot.clientWidth !== scroller.clientWidth) ||
      ((snapshot.clientHeight ?? 0) > 0 && snapshot.clientHeight !== scroller.clientHeight))
  );
}

export function isAtPhysicalBottom(scroller: HTMLElement): boolean {
  const distance = distanceToBottom(scroller);
  if (distance <= 1) return true;
  if (distance > 2 || !scroller.lastElementChild) return false;
  // CSS zoom can compound rounding of the integer scrollHeight/clientHeight.
  const viewport = scroller.getBoundingClientRect();
  const content = scroller.lastElementChild.getBoundingClientRect();
  if (viewport.height <= 0 || content.height <= 0) return false;
  const scale = scroller.offsetHeight > 0 ? viewport.height / scroller.offsetHeight : 1;
  const style = getComputedStyle(scroller);
  const trailingInset =
    (parseFloat(style.paddingBottom) || 0) + (parseFloat(style.borderBottomWidth) || 0);
  return Math.abs(content.bottom + trailingInset * scale - viewport.bottom) <= 1;
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
