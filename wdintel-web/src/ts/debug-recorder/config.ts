export const DEBUG_SCHEMA_VERSION = 1 as const;
export const DEBUG_STORAGE_KEY = 'echo-browser-debug-recorder-v1';
export const DEBUG_RECORDING_MS = 60_000;
export const DEBUG_READY_TTL_MS = 600_000;
export const DEBUG_MAX_EVENTS = 1_000;
export const DEBUG_MAX_BYTES = 1_048_576;
export const DEBUG_PERSIST_DEBOUNCE_MS = 250;
export const DEBUG_ACTIVATOR_PRESSES = 8;
export const DEBUG_ACTIVATOR_WINDOW_MS = 4_000;

export const DEBUG_MAX_STRING_LENGTH = 160;
export const DEBUG_MAX_OBJECT_DEPTH = 3;
export const DEBUG_MAX_OBJECT_KEYS = 32;
export const DEBUG_MAX_ARRAY_LENGTH = 32;

export const DEBUG_SAFE_DETAIL_KEYS = new Set([
  'abortReason',
  'active',
  'atBottom',
  'bottomDistance',
  'browserEvent',
  'byteCount',
  'clientHeight',
  'code',
  'concurrent',
  'count',
  'delta',
  'deltaX',
  'deltaY',
  'durationMs',
  'entryType',
  'errorClass',
  'failedCount',
  'fingerprint',
  'forced',
  'height',
  'initiatorType',
  'inputType',
  'itemCount',
  'kind',
  'layoutShiftValue',
  'loading',
  'method',
  'navigationType',
  'nearBottom',
  'offsetTop',
  'outcome',
  'phase',
  'reason',
  'requestCount',
  'role',
  'sameOrigin',
  'scrollDelta',
  'scrollHeight',
  'scrollTop',
  'status',
  'suppressedCount',
  'tag',
  'testId',
  'visible',
  'visibleCount',
  'width',
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
  'requestId',
]);
