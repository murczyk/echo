export type MessageFeedPolicy = {
  initialPosition: 'start' | 'end';
  followAtBottom: boolean;
  aboveLoadBufferPx: number;
  belowLoadBufferPx: number;
  atBottomThresholdPx: number;
  underfilledEdgeLoading: boolean;
  belowLoadStrategy?: 'scroll-idle' | 'immediate';
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
