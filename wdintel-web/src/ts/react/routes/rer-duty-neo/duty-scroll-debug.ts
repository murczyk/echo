import { useCallback, useSyncExternalStore } from 'react';

export type DutyScrollDebugActivity =
  'unreadCount' | 'tailCount' | 'newerMessages' | 'olderMessages';

export type DutyScrollDebugMetrics = {
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

export type DutyScrollDebugEvent = {
  sequence: number;
  atMs: number;
  name: string;
  detail: string;
};

type DutyScrollDebugResult = {
  atMs: number;
  detail: string;
};

export type DutyScrollDebugTiming = {
  atMs: number;
  phase: 'render' | 'commit';
  durationMs: number;
  reason?: string;
};

export type DutyScrollDebugFeedSnapshot = {
  activities: Record<DutyScrollDebugActivity, number>;
  events: DutyScrollDebugEvent[];
  lastResults: Partial<Record<DutyScrollDebugActivity, DutyScrollDebugResult>>;
  metrics: DutyScrollDebugMetrics | null;
  timings: DutyScrollDebugTiming[];
};

const DEBUG_BELL_PRESS_COUNT = 8;
const DEBUG_BELL_PRESS_WINDOW_MS = 4000;
const DEBUG_EVENT_LIMIT = 200;
const DEBUG_TIMING_LIMIT = 40;
/** Cap how often metric writes wake React subscribers (scroll is ~1/frame). */
const METRICS_NOTIFY_MIN_MS = 100;

const EMPTY_ACTIVITIES: Record<DutyScrollDebugActivity, number> = {
  unreadCount: 0,
  tailCount: 0,
  newerMessages: 0,
  olderMessages: 0,
};
const EMPTY_FEED_SNAPSHOT: DutyScrollDebugFeedSnapshot = {
  activities: EMPTY_ACTIVITIES,
  events: [],
  lastResults: {},
  metrics: null,
  timings: [],
};

let enabled = false;
let eventSequence = 0;
let bellPresses: number[] = [];
let feedSnapshots = new Map<string, DutyScrollDebugFeedSnapshot>();
const enabledListeners = new Set<() => void>();
const feedListeners = new Map<string, Set<() => void>>();
const metricsNotifyState = new Map<
  string,
  { timer: ReturnType<typeof setTimeout> | null; lastNotifyMs: number }
>();

function emitEnabledChange(): void {
  enabledListeners.forEach((listener) => listener());
}

function emitFeedChange(feedId: string): void {
  const listeners = feedListeners.get(feedId);
  if (!listeners) return;
  listeners.forEach((listener) => listener());
}

function emitAllFeedChanges(): void {
  feedListeners.forEach((listeners) => {
    listeners.forEach((listener) => listener());
  });
}

function clearMetricsNotifyState(): void {
  for (const state of metricsNotifyState.values()) {
    if (state.timer != null) clearTimeout(state.timer);
  }
  metricsNotifyState.clear();
}

function scheduleMetricsNotify(feedId: string): void {
  if (!enabled) return;
  const now = Date.now();
  let state = metricsNotifyState.get(feedId);
  if (!state) {
    state = { timer: null, lastNotifyMs: 0 };
    metricsNotifyState.set(feedId, state);
  }
  const elapsed = now - state.lastNotifyMs;
  if (elapsed >= METRICS_NOTIFY_MIN_MS && state.timer == null) {
    state.lastNotifyMs = now;
    emitFeedChange(feedId);
    return;
  }
  if (state.timer != null) return;
  const waitMs = Math.max(0, METRICS_NOTIFY_MIN_MS - elapsed);
  state.timer = setTimeout(() => {
    state!.timer = null;
    state!.lastNotifyMs = Date.now();
    emitFeedChange(feedId);
  }, waitMs);
}

function subscribeEnabled(listener: () => void): () => void {
  enabledListeners.add(listener);
  return () => {
    enabledListeners.delete(listener);
  };
}

function subscribeFeed(feedId: string, listener: () => void): () => void {
  let listeners = feedListeners.get(feedId);
  if (!listeners) {
    listeners = new Set();
    feedListeners.set(feedId, listeners);
  }
  listeners.add(listener);
  return () => {
    listeners!.delete(listener);
    if (listeners!.size === 0) feedListeners.delete(feedId);
  };
}

function getEnabledSnapshot(): boolean {
  return enabled;
}

function getFeedSnapshot(feedId: string): DutyScrollDebugFeedSnapshot {
  return feedSnapshots.get(feedId) ?? EMPTY_FEED_SNAPSHOT;
}

function updateFeedSnapshot(
  feedId: string,
  update: (current: DutyScrollDebugFeedSnapshot) => DutyScrollDebugFeedSnapshot,
  notify: 'immediate' | 'metrics' | 'none' = 'immediate',
): void {
  feedSnapshots.set(feedId, update(getFeedSnapshot(feedId)));
  if (!enabled || notify === 'none') return;
  if (notify === 'metrics') {
    scheduleMetricsNotify(feedId);
    return;
  }
  emitFeedChange(feedId);
}

export function useDutyScrollDebugEnabled(): boolean {
  return useSyncExternalStore(subscribeEnabled, getEnabledSnapshot, getEnabledSnapshot);
}

export function useDutyScrollDebugFeed(feedId: string): DutyScrollDebugFeedSnapshot {
  const subscribe = useCallback(
    (listener: () => void) => subscribeFeed(feedId, listener),
    [feedId],
  );
  const getSnapshot = useCallback(() => getFeedSnapshot(feedId), [feedId]);
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

export function isDutyScrollDebugEnabled(): boolean {
  return enabled;
}

export function setDutyScrollDebugEnabled(nextEnabled: boolean): void {
  if (enabled === nextEnabled) {
    if (!nextEnabled) bellPresses = [];
    return;
  }
  enabled = nextEnabled;
  bellPresses = [];
  clearMetricsNotifyState();
  if (enabled) {
    eventSequence = 0;
    feedSnapshots = new Map(
      [...feedSnapshots].map(([feedId, snapshot]) => [
        feedId,
        { ...snapshot, events: [], lastResults: {}, timings: [] },
      ]),
    );
  }
  emitEnabledChange();
  emitAllFeedChanges();
}

export function registerDutyScrollDebugBellPress(nowMs = Date.now()): void {
  bellPresses = bellPresses.filter((atMs) => nowMs - atMs <= DEBUG_BELL_PRESS_WINDOW_MS);
  bellPresses.push(nowMs);
  if (bellPresses.length < DEBUG_BELL_PRESS_COUNT) return;
  bellPresses = [];
  setDutyScrollDebugEnabled(true);
}

export function clearDutyScrollDebugEvents(feedId: string): void {
  updateFeedSnapshot(feedId, (current) => ({ ...current, events: [], timings: [] }));
}

export function recordDutyScrollDebugEvent(
  feedId: string | undefined,
  name: string,
  detail = '',
): void {
  if (!enabled || !feedId) return;
  const entry: DutyScrollDebugEvent = {
    sequence: ++eventSequence,
    atMs: Date.now(),
    name,
    detail,
  };
  updateFeedSnapshot(feedId, (current) => ({
    ...current,
    events: [...current.events, entry].slice(-DEBUG_EVENT_LIMIT),
  }));
}

export function recordDutyScrollDebugMetrics(
  feedId: string | undefined,
  metrics: DutyScrollDebugMetrics,
): void {
  if (!enabled || !feedId) return;
  updateFeedSnapshot(feedId, (current) => ({ ...current, metrics }), 'metrics');
}

export function recordDutyScrollDebugTiming(
  feedId: string | undefined,
  timing: Omit<DutyScrollDebugTiming, 'atMs'> & { atMs?: number },
): void {
  if (!enabled || !feedId) return;
  const entry: DutyScrollDebugTiming = {
    atMs: timing.atMs ?? Date.now(),
    phase: timing.phase,
    durationMs: timing.durationMs,
    reason: timing.reason,
  };
  updateFeedSnapshot(
    feedId,
    (current) => ({
      ...current,
      timings: [...(current.timings ?? []), entry].slice(-DEBUG_TIMING_LIMIT),
    }),
    'metrics',
  );
}

export function beginDutyScrollDebugActivity(
  feedId: string,
  activity: DutyScrollDebugActivity,
  detail: string,
): (result: string) => void {
  if (!enabled) return () => {};
  updateFeedSnapshot(feedId, (current) => ({
    ...current,
    activities: {
      ...current.activities,
      [activity]: current.activities[activity] + 1,
    },
  }));
  recordDutyScrollDebugEvent(feedId, `${activity}:start`, detail);
  let finished = false;
  return (result: string) => {
    if (finished) return;
    finished = true;
    updateFeedSnapshot(feedId, (current) => ({
      ...current,
      activities: {
        ...current.activities,
        [activity]: Math.max(0, current.activities[activity] - 1),
      },
      lastResults: {
        ...current.lastResults,
        [activity]: { atMs: Date.now(), detail: result },
      },
    }));
    recordDutyScrollDebugEvent(feedId, `${activity}:finish`, result);
  };
}
