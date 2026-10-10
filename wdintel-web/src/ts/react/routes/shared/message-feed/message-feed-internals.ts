import type { MutableRefObject } from 'react';
import type {
  AnchorSnapshot,
  TopStatus,
  UseWindowedFeedScrollOptions,
  WindowedFeedScrollRefs,
} from './windowed-feed-scroll-shared';
import type { useWindowedFeedScrollAnchors } from './useWindowedFeedScrollAnchors';
import type { useWindowedFeedScrollFollow } from './useWindowedFeedScrollFollow';
import type { useWindowedFeedScrollTracking } from './useWindowedFeedScrollTracking';
import type { useMessageFeedViewport } from './message-feed-viewport';

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
