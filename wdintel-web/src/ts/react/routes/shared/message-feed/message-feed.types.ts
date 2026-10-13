import type { MutableRefObject, RefObject, UIEventHandler } from 'react';

export type MessageFeedPolicy = {
  initialPosition: 'start' | 'end';
  followAtBottom: boolean;
  aboveLoadBufferPx: number;
  belowLoadBufferPx: number;
  atBottomThresholdPx: number;
  underfilledEdgeLoading: boolean;
  belowLoadStrategy?: 'scroll-idle' | 'immediate';
  serializeEdgeLoads?: boolean;
  expandBelowLoadBuffer?: boolean;
  deferResizeWhileLoadingBelow?: boolean;
};

export type MessageFeedFocus = {
  messageId: number;
  active: boolean;
  onRelease?: () => void;
};

export type MessageFeedNavigationTarget = {
  messageId: number;
  alignment: 'start';
  onAligned: () => void;
};

export type FeedScrollMetrics = {
  capturedAtMs: number;
  scrollTop: number;
  previousScrollTop: number;
  scrollDelta: number;
  scrollHeight: number;
  clientHeight: number;
  bottomDistance: number;
  topLoadBufferPx: number;
  bottomLoadBufferPx: number;
  atBottomThresholdPx: number;
  atTop: boolean;
  atBottom: boolean;
  physicallyAtBottom: boolean;
  nearBottom: boolean;
  liveBottomFollow: boolean;
  bottomSettleActive: boolean;
  loadOlderTriggered: boolean;
  loadNewerTriggered: boolean;
  visibleAnchorCount: number;
  firstVisibleId: number | null;
  lastVisibleId: number | null;
  anchorId: number | null;
  anchorOffsetTop: number | null;
  itemCount: number;
  firstItemId: number | null;
  lastItemId: number | null;
  enabled: boolean;
  isWatchMode: boolean;
  overflowAnchor: string;
  scrollBehavior: string;
};

export type FeedScrollDiagnostics = {
  enabled: boolean;
  event: (feedId: string | undefined, name: string, detail?: string) => void;
  metrics: (feedId: string, metrics: FeedScrollMetrics) => void;
};

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

export type ReachedBottomContext = {
  hasSeenNotAtBottom: boolean;
  /** Null means the reader reached bottom by scrolling, rather than programmatic navigation. */
  navigationIntent: ScrollNavigationIntent | null;
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
  edgeLoadRetryKey?: string | number;
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

export type MessageFeedScrollOptions = Omit<
  UseWindowedFeedScrollOptions,
  'itemIds' | 'loadingOlder' | 'loadingNewer'
>;

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

export type MessageFeedHandle = {
  scrollToBottom: WindowedFeedScrollHandle['scrollToBottom'];
  scrollToMessage: WindowedFeedScrollHandle['scrollToItem'];
  highlightLinkedMessage: (id: number) => boolean;
  getItemElement: WindowedFeedScrollHandle['getItemElement'];
  getScrollerElement: () => HTMLDivElement | null;
  getBottomSpacerPx: () => number;
};
