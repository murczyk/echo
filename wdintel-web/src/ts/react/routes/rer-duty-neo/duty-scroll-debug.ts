import { useSyncExternalStore } from 'react';

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

export type DutyScrollDebugFeedSnapshot = {
  activities: Record<DutyScrollDebugActivity, number>;
  events: DutyScrollDebugEvent[];
  lastResults: Partial<Record<DutyScrollDebugActivity, DutyScrollDebugResult>>;
  metrics: DutyScrollDebugMetrics | null;
};

const DEBUG_BELL_PRESS_COUNT = 8;
const DEBUG_BELL_PRESS_WINDOW_MS = 4000;
const DEBUG_EVENT_LIMIT = 200;

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
};

let enabled = false;
let eventSequence = 0;
let bellPresses: number[] = [];
let feedSnapshots = new Map<string, DutyScrollDebugFeedSnapshot>();
const listeners = new Set<() => void>();

function emitChange(): void {
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
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
  notify = enabled,
): void {
  feedSnapshots.set(feedId, update(getFeedSnapshot(feedId)));
  if (notify) emitChange();
}

export function useDutyScrollDebugEnabled(): boolean {
  return useSyncExternalStore(subscribe, getEnabledSnapshot, getEnabledSnapshot);
}

export function useDutyScrollDebugFeed(feedId: string): DutyScrollDebugFeedSnapshot {
  return useSyncExternalStore(
    subscribe,
    () => getFeedSnapshot(feedId),
    () => getFeedSnapshot(feedId),
  );
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
  if (enabled) {
    eventSequence = 0;
    feedSnapshots = new Map(
      [...feedSnapshots].map(([feedId, snapshot]) => [
        feedId,
        { ...snapshot, events: [], lastResults: {} },
      ]),
    );
  }
  emitChange();
}

export function registerDutyScrollDebugBellPress(nowMs = Date.now()): void {
  bellPresses = bellPresses.filter((atMs) => nowMs - atMs <= DEBUG_BELL_PRESS_WINDOW_MS);
  bellPresses.push(nowMs);
  if (bellPresses.length < DEBUG_BELL_PRESS_COUNT) return;
  bellPresses = [];
  setDutyScrollDebugEnabled(true);
}

export function clearDutyScrollDebugEvents(feedId: string): void {
  updateFeedSnapshot(feedId, (current) => ({ ...current, events: [] }));
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
  updateFeedSnapshot(feedId, (current) => ({ ...current, metrics }));
}

export function beginDutyScrollDebugActivity(
  feedId: string,
  activity: DutyScrollDebugActivity,
  detail: string,
): (result: string) => void {
  if (!enabled) return () => {};
  updateFeedSnapshot(
    feedId,
    (current) => ({
      ...current,
      activities: {
        ...current.activities,
        [activity]: current.activities[activity] + 1,
      },
    }),
    enabled,
  );
  recordDutyScrollDebugEvent(feedId, `${activity}:start`, detail);
  let finished = false;
  return (result: string) => {
    if (finished) return;
    finished = true;
    updateFeedSnapshot(
      feedId,
      (current) => ({
        ...current,
        activities: {
          ...current.activities,
          [activity]: Math.max(0, current.activities[activity] - 1),
        },
        lastResults: {
          ...current.lastResults,
          [activity]: { atMs: Date.now(), detail: result },
        },
      }),
      enabled,
    );
    recordDutyScrollDebugEvent(feedId, `${activity}:finish`, result);
  };
}
