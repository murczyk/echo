export const DEBUG_SCHEMA_VERSION = 1 as const;
export const DEBUG_STORAGE_KEY = 'echo-browser-debug-recorder-v1';
export const DEBUG_RECORDER_SLOT_ID = 'echo-debug-recorder-slot';
export const DEBUG_RECORDING_MS = 60_000;
export const DEBUG_READY_TTL_MS = 600_000;
export const DEBUG_MAX_EVENTS = 1_000;
export const DEBUG_MAX_BYTES = 1_048_576;
export const DEBUG_MAX_ALIASES = 2_048;
export const DEBUG_PERSIST_DEBOUNCE_MS = 250;
export const DEBUG_ACTIVATOR_PRESSES = 8;
export const DEBUG_ACTIVATOR_WINDOW_MS = 4_000;

export const DEBUG_ANOMALY_SCROLL_MIN_PX = 320;
export const DEBUG_ANOMALY_SCROLL_VIEWPORT_RATIO = 0.5;
export const DEBUG_ANOMALY_SCROLL_INTENT_WINDOW_MS = 750;
export const DEBUG_ANOMALY_SCROLL_CORRELATION_WINDOW_MS = 500;
export const DEBUG_ANOMALY_DOM_REPLACEMENT_COUNT = 3;
export const DEBUG_ANOMALY_DOM_REPLACEMENT_WINDOW_MS = 2_000;
export const DEBUG_ANOMALY_SKELETON_TRANSITION_COUNT = 4;
export const DEBUG_ANOMALY_SKELETON_TRANSITION_WINDOW_MS = 2_000;
export const DEBUG_ANOMALY_SKELETON_STUCK_MS = 10_000;
export const DEBUG_ANOMALY_HTTP_STORM_COUNT = 10;
export const DEBUG_ANOMALY_HTTP_STORM_WINDOW_MS = 5_000;
export const DEBUG_ANOMALY_HTTP_RETRY_COUNT = 3;
export const DEBUG_ANOMALY_HTTP_RETRY_WINDOW_MS = 10_000;
export const DEBUG_ANOMALY_HTTP_SLOW_MS = 3_000;
export const DEBUG_ANOMALY_LOG_REPEAT_COUNT = 3;
export const DEBUG_ANOMALY_LOG_REPEAT_WINDOW_MS = 5_000;
export const DEBUG_ANOMALY_LONG_TASK_MS = 50;
export const DEBUG_ANOMALY_MAIN_THREAD_STALL_MS = 1_000;
export const DEBUG_ANOMALY_RENDER_STORM_COUNT = 20;
export const DEBUG_ANOMALY_RENDER_STORM_WINDOW_MS = 1_000;
export const DEBUG_ANOMALY_MAX_KEYS = 256;
export const DEBUG_ANOMALY_MAX_TIMESTAMPS_PER_KEY = 64;
export const DEBUG_SCROLL_HEARTBEAT_MS = 250;
export const DEBUG_SCROLL_BASELINE_INSPECTION_LIMIT = 1_000;
export const DEBUG_DOM_SUBSTANTIAL_SUBTREE_SIZE = 50;
export const DEBUG_DOM_MUTATION_INSPECTION_LIMIT = 1_000;

export const DEBUG_MAX_STRING_LENGTH = 160;
export const DEBUG_MAX_OBJECT_DEPTH = 3;
export const DEBUG_MAX_OBJECT_KEYS = 32;
export const DEBUG_MAX_ARRAY_LENGTH = 32;

export const DEBUG_SAFE_DETAIL_KEYS = new Set([
  'abortReason',
  'active',
  'activeFilterCount',
  'addedCount',
  'arrowResultFingerprint',
  'atBottom',
  'atBottomThresholdPx',
  'atTop',
  'bottomDistance',
  'bottomAnchorSpacerPx',
  'bottomLoadBufferPx',
  'bottomSettleActive',
  'browserEvent',
  'byteCount',
  'canRemove',
  'centerTab',
  'centerTabPending',
  'clientHeight',
  'code',
  'concurrent',
  'count',
  'delta',
  'deltaX',
  'deltaY',
  'devicePixelRatio',
  'documentVisibility',
  'directMessageActive',
  'directMessageFocusActive',
  'directMessageLoading',
  'durationMs',
  'entryType',
  'errorClass',
  'failedCount',
  'feedCount',
  'fingerprint',
  'forced',
  'filtersLoading',
  'height',
  'hasReachedStart',
  'hasError',
  'hasLoadedInitialMessages',
  'hasSearch',
  'hasValidationError',
  'initiatorType',
  'inputType',
  'initialAnchors',
  'initialItemIds',
  'initialPositioningReady',
  'initialScrollHeight',
  'initialScrollTop',
  'index',
  'isWatchMode',
  'itemCount',
  'leftPanelOpen',
  'kind',
  'layoutShiftValue',
  'liveBottomFollow',
  'loadNewerTriggered',
  'loadOlderTriggered',
  'loading',
  'loadingNewer',
  'loadingOlder',
  'messageCount',
  'messagesLoading',
  'messagesOverallCount',
  'messagesPaging',
  'messagesTotalCount',
  'messagesTotalLoading',
  'messageViewportPreserving',
  'maxWidth',
  'method',
  'navigationType',
  'narrowScreen',
  'nearBottom',
  'newestFirst',
  'noMoreToLoad',
  'offsetTop',
  'outcome',
  'overflowAnchor',
  'pageIndex',
  'phase',
  'physicallyAtBottom',
  'pendingNewerCount',
  'pendingNewerFlushNeeded',
  'previousScrollTop',
  'reason',
  'removedCount',
  'requestCount',
  'readIdCount',
  'rightPanelOpen',
  'rightSidebarTab',
  'role',
  'sameOrigin',
  'scrollDelta',
  'scrollBehavior',
  'scrollHeight',
  'scrollTop',
  'selectedFilterValueCount',
  'skeletonVisible',
  'status',
  'summaryLoading',
  'suppressedCount',
  'tag',
  'tailAvailability',
  'testId',
  'topLoadBufferPx',
  'visible',
  'visiblePageIndex',
  'visibleAnchorCount',
  'visibleCount',
  'viewportAnchorActive',
  'width',
  'windowedUnreadCount',
  'countsLoading',
  'editorOpen',
  'paginationLoading',
  'targetAnchorPreserved',
  'frames',
  'anchorOffsetTop',
  'enabled',
  'autoScrollAllowed',
  'bottomUnreadCount',
  'unreadCount',
  'unreadPrefetchNeeded',
  'scrollTrackingEnabled',
]);

export const DEBUG_IDENTIFIER_DETAIL_KEYS = new Set([
  'anchorId',
  'feedId',
  'firstItemId',
  'firstVisibleId',
  'itemId',
  'lastItemId',
  'lastVisibleId',
  'messageId',
  'pendingNewerTailId',
  'requestId',
]);
