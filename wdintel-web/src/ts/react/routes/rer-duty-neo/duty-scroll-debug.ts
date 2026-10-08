import { useSyncExternalStore } from 'react';

import {
  aliasDebugIdentifier,
  getBrowserDebugRecorderSnapshot,
  isBrowserDebugRecording,
  recordDebugEvent,
  subscribeBrowserDebugRecorder,
} from '../../../debug-recorder';

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

export type DutyScrollDebugTiming = {
  atMs: number;
  phase: 'render' | 'commit';
  durationMs: number;
  reason?: string;
};

const activityCounts = new Map<string, number>();
let activeRecordingId: string | null = null;

function normalizedName(value: string): string {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-z0-9]+/gi, '.')
      .replace(/^\.+|\.+$/g, '')
      .replace(/\.{2,}/g, '.')
      .toLowerCase()
      .slice(0, 72) || 'event'
  );
}

function normalizedToken(value: string): string {
  return (
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
      .slice(0, 64) || 'unknown'
  );
}

function fingerprint(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `duty-${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function safeAlias(scope: string, value: string | number | null): string | undefined {
  if (value === null) return undefined;
  const alias = aliasDebugIdentifier(scope, value);
  return alias && /^\{[a-z0-9_-]+\}$/i.test(alias) ? alias : undefined;
}

function currentRecordingId(): string | null {
  if (!isBrowserDebugRecording()) return null;
  const snapshot = getBrowserDebugRecorderSnapshot();
  if (snapshot.state !== 'recording' || !snapshot.recordingId) return null;
  if (activeRecordingId !== snapshot.recordingId) {
    activityCounts.clear();
    activeRecordingId = snapshot.recordingId;
  }
  return snapshot.recordingId;
}

function identifierDescriptor(key: string, eventName: string) {
  const normalized = key.toLowerCase();
  if (normalized.includes('anchor') || (normalized === 'id' && eventName.includes('anchor'))) {
    return { scope: 'anchor', key: 'anchorId' };
  }
  if (normalized.includes('item')) return { scope: 'item', key: 'itemId' };
  if (
    normalized.includes('message') ||
    normalized === 'tail' ||
    normalized === 'since' ||
    normalized === 'cursor' ||
    normalized === 'id'
  ) {
    return { scope: 'message', key: 'messageId' };
  }
  return null;
}

const NUMBER_DETAIL_KEYS: Record<string, string> = {
  top: 'scrollTop',
  scrolltop: 'scrollTop',
  previousscrolltop: 'previousScrollTop',
  delta: 'scrollDelta',
  scrolldelta: 'scrollDelta',
  height: 'scrollHeight',
  scrollheight: 'scrollHeight',
  clientheight: 'clientHeight',
  distance: 'bottomDistance',
  bottomdistance: 'bottomDistance',
  count: 'count',
  added: 'itemCount',
  itemcount: 'itemCount',
  duration: 'durationMs',
  durationms: 'durationMs',
  frames: 'count',
};

const BOOLEAN_DETAIL_KEYS: Record<string, string> = {
  active: 'active',
  enabled: 'active',
  loading: 'loading',
  near: 'nearBottom',
  nearbottom: 'nearBottom',
  physical: 'physicallyAtBottom',
  physicallyatbottom: 'physicallyAtBottom',
  atbottom: 'atBottom',
};

function legacyDetails(eventName: string, detail: string): Record<string, unknown> {
  if (!detail) return {};
  const output: Record<string, unknown> = { fingerprint: fingerprint(detail) };
  for (const part of detail.split(';').slice(0, 24)) {
    const match = /^\s*([a-z][a-z0-9_-]*)\s*=\s*(.*?)\s*$/i.exec(part);
    if (!match) continue;
    const [, rawKey, rawValue] = match;
    const key = rawKey!.toLowerCase();
    const identifier = identifierDescriptor(key, eventName);
    if (identifier) {
      const identifierValue = rawValue!.match(/[a-z0-9-]+/i)?.[0];
      if (!identifierValue) continue;
      const alias = safeAlias(identifier.scope, identifierValue);
      if (alias) output[identifier.key] = alias;
      continue;
    }
    const numberKey = NUMBER_DETAIL_KEYS[key];
    if (numberKey) {
      const number = Number(rawValue);
      if (Number.isFinite(number)) output[numberKey] = number;
      continue;
    }
    const booleanKey = BOOLEAN_DETAIL_KEYS[key];
    if (booleanKey && (rawValue === 'true' || rawValue === 'false')) {
      output[booleanKey] = rawValue === 'true';
    }
  }
  return output;
}

function feedDetails(feedId: string): Record<string, unknown> | null {
  if (currentRecordingId() === null) return null;
  const feedAlias = safeAlias('feed', feedId);
  return feedAlias ? { feedId: feedAlias } : null;
}

export function useDutyScrollDebugEnabled(): boolean {
  return useSyncExternalStore(
    subscribeBrowserDebugRecorder,
    isBrowserDebugRecording,
    isBrowserDebugRecording,
  );
}

export function isDutyScrollDebugEnabled(): boolean {
  return isBrowserDebugRecording();
}

export function recordDutyScrollDebugEvent(
  feedId: string | undefined,
  name: string,
  detail = '',
): void {
  if (!feedId) return;
  const base = feedDetails(feedId);
  if (!base) return;
  recordDebugEvent({
    kind: `duty.${normalizedName(name)}`,
    source: 'duty',
    details: { ...base, ...legacyDetails(name, detail) },
  });
}

export function recordDutyScrollDebugMetrics(
  feedId: string | undefined,
  metrics: DutyScrollDebugMetrics,
): void {
  if (!feedId) return;
  const base = feedDetails(feedId);
  if (!base) return;
  recordDebugEvent({
    kind: 'duty.metrics',
    source: 'duty',
    details: {
      ...base,
      scrollTop: metrics.scrollTop,
      previousScrollTop: metrics.previousScrollTop,
      scrollDelta: metrics.scrollDelta,
      scrollHeight: metrics.scrollHeight,
      clientHeight: metrics.clientHeight,
      bottomDistance: metrics.bottomDistance,
      topLoadBufferPx: metrics.topLoadBufferPx,
      bottomLoadBufferPx: metrics.bottomLoadBufferPx,
      atBottomThresholdPx: metrics.atBottomThresholdPx,
      atTop: metrics.atTop,
      atBottom: metrics.atBottom,
      physicallyAtBottom: metrics.physicallyAtBottom,
      nearBottom: metrics.nearBottom,
      liveBottomFollow: metrics.liveBottomFollow,
      bottomSettleActive: metrics.bottomSettleActive,
      loadOlderTriggered: metrics.loadOlderTriggered,
      loadNewerTriggered: metrics.loadNewerTriggered,
      visibleAnchorCount: metrics.visibleAnchorCount,
      firstVisibleId: safeAlias('message', metrics.firstVisibleId),
      lastVisibleId: safeAlias('message', metrics.lastVisibleId),
      anchorId: safeAlias('anchor', metrics.anchorId),
      anchorOffsetTop: metrics.anchorOffsetTop,
      itemCount: metrics.itemCount,
      firstItemId: safeAlias('item', metrics.firstItemId),
      lastItemId: safeAlias('item', metrics.lastItemId),
      enabled: metrics.enabled,
      isWatchMode: metrics.isWatchMode,
      overflowAnchor: normalizedToken(metrics.overflowAnchor),
      scrollBehavior: normalizedToken(metrics.scrollBehavior),
    },
  });
}

export function recordDutyScrollDebugTiming(
  feedId: string | undefined,
  timing: Omit<DutyScrollDebugTiming, 'atMs'> & { atMs?: number },
): void {
  if (!feedId) return;
  const base = feedDetails(feedId);
  if (!base) return;
  recordDebugEvent({
    kind: `duty.${timing.phase}`,
    source: 'duty',
    details: {
      ...base,
      phase: timing.phase,
      durationMs: timing.durationMs,
      ...(timing.reason ? { fingerprint: fingerprint(timing.reason) } : {}),
    },
  });
}

export function beginDutyScrollDebugActivity(
  feedId: string,
  activity: DutyScrollDebugActivity,
  detail: string,
): (result: string) => void {
  const base = feedDetails(feedId);
  const recordingId = activeRecordingId;
  if (!base || !recordingId) return () => {};
  const activityName = normalizedToken(activity);
  const key = `${recordingId}:${String(base.feedId)}:${activityName}`;
  const active = (activityCounts.get(key) ?? 0) + 1;
  activityCounts.set(key, active);
  recordDebugEvent({
    kind: 'duty.activity.start',
    source: 'duty',
    details: {
      ...base,
      kind: activityName,
      active,
      ...(detail ? { fingerprint: fingerprint(detail) } : {}),
    },
  });
  let finished = false;
  return (result: string) => {
    if (finished) return;
    finished = true;
    if (currentRecordingId() !== recordingId) return;
    const remaining = Math.max(0, (activityCounts.get(key) ?? 1) - 1);
    if (remaining === 0) activityCounts.delete(key);
    else activityCounts.set(key, remaining);
    recordDebugEvent({
      kind: 'duty.activity.finish',
      source: 'duty',
      details: {
        ...base,
        kind: activityName,
        active: remaining,
        ...(result ? { fingerprint: fingerprint(result) } : {}),
      },
    });
  };
}
