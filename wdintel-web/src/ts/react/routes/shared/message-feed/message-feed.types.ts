import type { MutableRefObject, RefObject, UIEventHandler } from 'react';

/** Opaque item key. The feed only compares ids, so a host may use numbers or strings, not both. */
export type MessageFeedId = number | string;

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

export type MessageFeedFocus<Id extends MessageFeedId = number> = {
  messageId: Id;
  active: boolean;
  constrainToContent?: boolean;
  behavior?: ScrollBehavior;
  onRelease?: () => void;
};

export type MessageFeedNavigationTarget<Id extends MessageFeedId = number> = {
  messageId: Id;
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
  firstVisibleId: MessageFeedId | null;
  lastVisibleId: MessageFeedId | null;
  anchorId: MessageFeedId | null;
  anchorOffsetTop: number | null;
  itemCount: number;
  firstItemId: MessageFeedId | null;
  lastItemId: MessageFeedId | null;
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

export type WindowedFeedScrollItem = { id: MessageFeedId };

export type VisibleAnchor<Id extends MessageFeedId = number> = {
  id: Id;
  index: number;
  offsetTop: number;
};

export type AnchorSnapshot<Id extends MessageFeedId = number> = {
  anchors: VisibleAnchor<Id>[];
  itemOffsets: Map<Id, number>;
  itemIds: readonly Id[];
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
  targetId: MessageFeedId;
  isCurrent: () => boolean;
  onLanded: () => void;
  onUnavailable: () => void;
};

export type ReachedBottomContext = {
  hasSeenNotAtBottom: boolean;
  /** Null means the reader reached bottom by scrolling, rather than programmatic navigation. */
  navigationIntent: ScrollNavigationIntent | null;
};

export type UseWindowedFeedScrollOptions<Id extends MessageFeedId = number> = {
  diagnostics?: FeedScrollDiagnostics;
  policy?: MessageFeedPolicy;
  focus?: MessageFeedFocus<Id> | null;
  navigationTarget?: MessageFeedNavigationTarget<Id> | null;
  viewportPreservationKey?: number;
  onViewportCaptureChange?: (capture: (() => void) | null) => void;
  onFirstVisibleMessage?: (id: Id, index: number) => void;
  onVisibleMessages?: (ids: readonly Id[]) => void;
  loadEdgesOnLayout?: boolean;
  edgeLoadRetryKey?: string | number;
  positionResetKey?: string | number;
  preservePositionOnReset?: boolean;
  itemIds: readonly Id[];
  initialAnchorSnapshot?: AnchorSnapshot<Id> | null;
  onAnchorSnapshotChange?: (snapshot: AnchorSnapshot<Id> | null) => void;
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
  onVisibleMessageIds?: (lastVisibleId: Id, opts?: { atBottom?: boolean }) => void;
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
    visibleAnchorIds: readonly Id[];
  }) => void | Promise<unknown>;
};

export type MessageFeedScrollOptions<Id extends MessageFeedId = number> = Omit<
  UseWindowedFeedScrollOptions<Id>,
  'itemIds' | 'loadingOlder' | 'loadingNewer'
>;

export type WindowedFeedScrollHandle<Id extends MessageFeedId = number> = {
  bottomSpacerPx: number;
  getItemElement: (id: Id) => HTMLElement | null;
  scrollerRef: RefObject<HTMLDivElement>;
  listRef: MutableRefObject<HTMLElement | null>;
  handleScroll: UIEventHandler<HTMLDivElement>;
  setItemRef: (id: Id) => (node: HTMLElement | null) => void;
  scrollToBottom: (
    behavior?: ScrollBehavior,
    intent?: ScrollNavigationIntent,
    navigation?: ExplicitScrollNavigation,
  ) => void;
  scrollToItem: (id: Id, behavior?: ScrollBehavior) => HTMLElement | null;
};

export type MessageFeedHandle<Id extends MessageFeedId = number> = {
  scrollToBottom: WindowedFeedScrollHandle<Id>['scrollToBottom'];
  scrollToMessage: WindowedFeedScrollHandle<Id>['scrollToItem'];
  highlightLinkedMessage: (id: Id) => boolean;
  getItemElement: WindowedFeedScrollHandle<Id>['getItemElement'];
  getScrollerElement: () => HTMLDivElement | null;
  getBottomSpacerPx: () => number;
};
