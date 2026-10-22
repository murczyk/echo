import type { MutableRefObject } from 'react';
import type {
  AnchorSnapshot,
  ExplicitScrollNavigation,
  FeedScrollDiagnostics,
  ReachedBottomContext,
  ScrollNavigationIntent,
  UseWindowedFeedScrollOptions,
} from '../message-feed.types';
import type { useWindowedFeedScrollFollow } from '../interaction/follow';
import type { useWindowedFeedScrollTracking } from '../interaction/tracking';
import type { useWindowedFeedScrollAnchors } from '../viewport/anchors';
import type { useMessageFeedViewport } from '../viewport/preservation';

export type TopStatus = 'loading' | 'reached-start' | 'none';

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
  onVisibleMessages?: (ids: readonly number[]) => void;
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

export type FeedScrollHelpers = {
  refs: WindowedFeedScrollRefs;
  anchors: ReturnType<typeof useWindowedFeedScrollAnchors>;
  follow: ReturnType<typeof useWindowedFeedScrollFollow>;
  tracking: ReturnType<typeof useWindowedFeedScrollTracking>;
  viewport: ReturnType<typeof useMessageFeedViewport>;
};

export type FeedLayoutOptions = FeedScrollHelpers &
  Pick<
    UseWindowedFeedScrollOptions,
    | 'focus'
    | 'debugFeedId'
    | 'viewportPreservationKey'
    | 'positionResetKey'
    | 'preservePositionOnReset'
  > & {
    resetKey: string | number | null;
    enabled: boolean;
    enabledBeforeRender: boolean;
    topStatus: TopStatus;
    itemIds: readonly number[];
    initialPosition: 'start' | 'end';
    initialPositioningReady: boolean;
    initialAnchorSnapshotRef: MutableRefObject<AnchorSnapshot | null>;
    directItemTargetIdRef: MutableRefObject<number | null>;
    releasedFocusRef: MutableRefObject<number | null>;
    bottomSpacerPx: number;
    setBottomSpacerPx: (value: number) => void;
    centerTrackedItem: (reason: string) => HTMLElement | null;
    stopDirectItemTracking: () => void;
    stopPendingAnchorRestore: () => void;
    schedulePendingAnchorRestore: () => void;
    deferResizeWhileLoadingBelow: boolean;
    reconcileBottomSpacer: () => void;
  };
