import {
  DEBUG_ANOMALY_DOM_REPLACEMENT_COUNT,
  DEBUG_ANOMALY_DOM_REPLACEMENT_WINDOW_MS,
  DEBUG_ANOMALY_HTTP_RETRY_COUNT,
  DEBUG_ANOMALY_HTTP_RETRY_WINDOW_MS,
  DEBUG_ANOMALY_HTTP_SLOW_MS,
  DEBUG_ANOMALY_HTTP_STORM_COUNT,
  DEBUG_ANOMALY_HTTP_STORM_WINDOW_MS,
  DEBUG_ANOMALY_LOG_REPEAT_COUNT,
  DEBUG_ANOMALY_LOG_REPEAT_WINDOW_MS,
  DEBUG_ANOMALY_LONG_TASK_MS,
  DEBUG_ANOMALY_MAIN_THREAD_STALL_MS,
  DEBUG_ANOMALY_MAX_KEYS,
  DEBUG_ANOMALY_MAX_TIMESTAMPS_PER_KEY,
  DEBUG_ANOMALY_RENDER_STORM_COUNT,
  DEBUG_ANOMALY_RENDER_STORM_WINDOW_MS,
  DEBUG_ANOMALY_SCROLL_CORRELATION_WINDOW_MS,
  DEBUG_ANOMALY_SCROLL_INTENT_WINDOW_MS,
  DEBUG_ANOMALY_SCROLL_MIN_PX,
  DEBUG_ANOMALY_SCROLL_VIEWPORT_RATIO,
  DEBUG_ANOMALY_SKELETON_STUCK_MS,
  DEBUG_ANOMALY_SKELETON_TRANSITION_COUNT,
  DEBUG_ANOMALY_SKELETON_TRANSITION_WINDOW_MS,
} from './config';
import type {
  DebugAnomalyDetector,
  DebugAnomalySummary,
  DebugEvent,
  DebugEventInput,
  DebugSafeValue,
} from './types';

type TimestampMap = Map<string, number[]>;
type ActiveRequest = { key: string; startedAt: number };
type ScrollCandidate = { atMs: number; delta: number; clientHeight: number };

const SLOW_REQUEST_EXEMPT_ROUTES = new Set(['/api/event-stream/long-poll']);
const COALESCED_HTTP_RULES = new Set([
  'event-stream-long-poll',
  'background-task-status',
  'messenger-media-status',
]);
const FAILED_HTTP_OUTCOMES = new Set(['aborted', 'error', 'http-error', 'network-error', 'failed']);
const SCROLL_CORRELATION_KINDS = new Set([
  'performance.layout-shift',
  'interaction.focus',
  'interaction.click',
  'dom.replacement',
]);
const RENDER_KINDS = new Set(['semantic.render', 'semantic.commit', 'duty.render', 'duty.commit']);

function detailString(event: DebugEvent, key: string): string | null {
  const value = event.details?.[key];
  return typeof value === 'string' ? value : null;
}

function detailNumber(event: DebugEvent, key: string): number | null {
  const value = event.details?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function detailBoolean(event: DebugEvent, key: string): boolean | null {
  const value = event.details?.[key];
  return typeof value === 'boolean' ? value : null;
}

function prune(queue: number[], minimum: number): void {
  let firstRetained = 0;
  while (firstRetained < queue.length && queue[firstRetained]! < minimum) firstRetained += 1;
  if (firstRetained > 0) queue.splice(0, firstRetained);
}

function boundedQueue(map: TimestampMap, key: string): number[] {
  const existing = map.get(key);
  if (existing) return existing;
  if (map.size >= DEBUG_ANOMALY_MAX_KEYS) map.delete(map.keys().next().value as string);
  const queue: number[] = [];
  map.set(key, queue);
  return queue;
}

function appendTimestamp(queue: number[], atMs: number): void {
  queue.push(atMs);
  if (queue.length > DEBUG_ANOMALY_MAX_TIMESTAMPS_PER_KEY) {
    queue.splice(0, queue.length - DEBUG_ANOMALY_MAX_TIMESTAMPS_PER_KEY);
  }
}

function pruneMap(map: TimestampMap, minimum: number): void {
  for (const [key, queue] of map) {
    prune(queue, minimum);
    if (queue.length === 0) map.delete(key);
  }
}

function mapTimestampCount(map: TimestampMap): number {
  let count = 0;
  for (const queue of map.values()) count += queue.length;
  return count;
}

function resetRecoveredKeyedEpisodes(
  openEpisodes: Set<string>,
  map: TimestampMap,
  prefix: string,
  threshold: number,
): void {
  for (const episode of openEpisodes) {
    if (!episode.startsWith(prefix)) continue;
    const key = episode.slice(prefix.length);
    if ((map.get(key)?.length ?? 0) < threshold) openEpisodes.delete(episode);
  }
}

function eventDetails(values: Record<string, DebugSafeValue | undefined>) {
  return Object.fromEntries(
    Object.entries(values).filter(
      (entry): entry is [string, DebugSafeValue] => entry[1] !== undefined,
    ),
  );
}

export function createDebugAnomalyDetector(): DebugAnomalyDetector {
  const summary: DebugAnomalySummary = { total: 0, counts: {} };
  const domReplacements: number[] = [];
  const skeletonTransitions: number[] = [];
  const requestStarts: TimestampMap = new Map();
  const requestFailures: TimestampMap = new Map();
  const repeatedLogs: TimestampMap = new Map();
  const activeRequests = new Map<string, ActiveRequest>();
  const activeRequestCounts = new Map<string, number>();
  const openEpisodes = new Set<string>();
  const navigationEpisodes = new Set<string>();
  const renderEvents: number[] = [];
  const pendingScrolls: ScrollCandidate[] = [];

  let lastScrollIntent = Number.NEGATIVE_INFINITY;
  let lastScrollCorrelation = Number.NEGATIVE_INFINITY;
  let lastScrollCorrelationKind = 'unknown';
  let skeletonVisibleSince: number | null = null;
  let skeletonStuckReported = false;

  const anomaly = (
    kind: string,
    details: Record<string, DebugSafeValue | undefined> = {},
  ): DebugEventInput => {
    summary.total += 1;
    summary.counts[kind] = (summary.counts[kind] ?? 0) + 1;
    return { kind, source: 'detector', details: eventDetails(details) };
  };

  const emitEpisode = (
    episode: string,
    kind: string,
    details: Record<string, DebugSafeValue | undefined> = {},
  ): DebugEventInput[] => {
    if (openEpisodes.has(episode)) return [];
    openEpisodes.add(episode);
    return [anomaly(kind, details)];
  };

  const pruneState = (atMs: number) => {
    prune(domReplacements, atMs - DEBUG_ANOMALY_DOM_REPLACEMENT_WINDOW_MS);
    if (domReplacements.length < DEBUG_ANOMALY_DOM_REPLACEMENT_COUNT) {
      openEpisodes.delete('dom-replacement');
    }
    prune(skeletonTransitions, atMs - DEBUG_ANOMALY_SKELETON_TRANSITION_WINDOW_MS);
    if (skeletonTransitions.length < DEBUG_ANOMALY_SKELETON_TRANSITION_COUNT) {
      openEpisodes.delete('skeleton-flicker');
    }
    prune(renderEvents, atMs - DEBUG_ANOMALY_RENDER_STORM_WINDOW_MS);
    if (renderEvents.length < DEBUG_ANOMALY_RENDER_STORM_COUNT) {
      openEpisodes.delete('render-storm');
    }
    pruneMap(requestStarts, atMs - DEBUG_ANOMALY_HTTP_STORM_WINDOW_MS);
    pruneMap(requestFailures, atMs - DEBUG_ANOMALY_HTTP_RETRY_WINDOW_MS);
    pruneMap(repeatedLogs, atMs - DEBUG_ANOMALY_LOG_REPEAT_WINDOW_MS);
    resetRecoveredKeyedEpisodes(
      openEpisodes,
      requestStarts,
      'http-storm:',
      DEBUG_ANOMALY_HTTP_STORM_COUNT,
    );
    resetRecoveredKeyedEpisodes(
      openEpisodes,
      requestFailures,
      'http-retry:',
      DEBUG_ANOMALY_HTTP_RETRY_COUNT,
    );
    resetRecoveredKeyedEpisodes(openEpisodes, repeatedLogs, 'log:', DEBUG_ANOMALY_LOG_REPEAT_COUNT);
    while (
      pendingScrolls.length > 0 &&
      pendingScrolls[0]!.atMs < atMs - DEBUG_ANOMALY_SCROLL_CORRELATION_WINDOW_MS
    ) {
      pendingScrolls.shift();
    }
    for (const [requestId, request] of activeRequests) {
      if (request.startedAt >= atMs - DEBUG_ANOMALY_HTTP_RETRY_WINDOW_MS) continue;
      activeRequests.delete(requestId);
      const count = Math.max(0, (activeRequestCounts.get(request.key) ?? 1) - 1);
      if (count === 0) activeRequestCounts.delete(request.key);
      else activeRequestCounts.set(request.key, count);
      if (count < 2) openEpisodes.delete(`http-duplicate:${request.key}`);
    }
  };

  const detectSkeletonStall = (atMs: number): DebugEventInput[] => {
    if (
      skeletonVisibleSince === null ||
      skeletonStuckReported ||
      atMs - skeletonVisibleSince < DEBUG_ANOMALY_SKELETON_STUCK_MS
    ) {
      return [];
    }
    skeletonStuckReported = true;
    return [
      anomaly('anomaly.skeleton-stuck', {
        durationMs: atMs - skeletonVisibleSince,
        reason: 'visible-too-long',
      }),
    ];
  };

  const observeScroll = (event: DebugEvent): DebugEventInput[] => {
    if (event.kind === 'scroll.intent' || event.kind === 'scroll.programmatic') {
      lastScrollIntent = event.tMs;
      pendingScrolls.splice(0);
      openEpisodes.delete('scroll-jump');
      return [];
    }
    if (SCROLL_CORRELATION_KINDS.has(event.kind)) {
      lastScrollCorrelation = event.tMs;
      lastScrollCorrelationKind = event.kind;
      const candidate = pendingScrolls.at(-1);
      if (!candidate || event.tMs - candidate.atMs > DEBUG_ANOMALY_SCROLL_CORRELATION_WINDOW_MS) {
        return [];
      }
      pendingScrolls.splice(0);
      return emitEpisode('scroll-jump', 'anomaly.scroll-jump', {
        delta: candidate.delta,
        clientHeight: candidate.clientHeight,
        reason: event.kind,
      });
    }
    if (event.kind !== 'scroll.sample') return [];
    const delta = detailNumber(event, 'delta') ?? detailNumber(event, 'scrollDelta') ?? 0;
    const clientHeight = detailNumber(event, 'clientHeight') ?? 0;
    const threshold = Math.max(
      DEBUG_ANOMALY_SCROLL_MIN_PX,
      clientHeight * DEBUG_ANOMALY_SCROLL_VIEWPORT_RATIO,
    );
    if (Math.abs(delta) < threshold) {
      openEpisodes.delete('scroll-jump');
      return [];
    }
    if (event.tMs - lastScrollIntent <= DEBUG_ANOMALY_SCROLL_INTENT_WINDOW_MS) return [];
    if (event.tMs - lastScrollCorrelation <= DEBUG_ANOMALY_SCROLL_CORRELATION_WINDOW_MS) {
      return emitEpisode('scroll-jump', 'anomaly.scroll-jump', {
        delta,
        clientHeight,
        reason: lastScrollCorrelationKind,
      });
    }
    pendingScrolls.push({ atMs: event.tMs, delta, clientHeight });
    if (pendingScrolls.length > DEBUG_ANOMALY_MAX_TIMESTAMPS_PER_KEY) pendingScrolls.shift();
    return [];
  };

  const observeDomAndSkeleton = (event: DebugEvent): DebugEventInput[] => {
    if (event.kind === 'dom.replacement') {
      appendTimestamp(domReplacements, event.tMs);
      if (domReplacements.length >= DEBUG_ANOMALY_DOM_REPLACEMENT_COUNT) {
        return emitEpisode('dom-replacement', 'anomaly.dom-replacement-storm', {
          count: domReplacements.length,
        });
      }
      return [];
    }
    if (event.kind !== 'skeleton.visibility') return [];
    const visible = detailBoolean(event, 'visible');
    if (visible === null) return [];
    appendTimestamp(skeletonTransitions, event.tMs);
    if (visible) {
      if (skeletonVisibleSince === null) skeletonVisibleSince = event.tMs;
    } else {
      skeletonVisibleSince = null;
      skeletonStuckReported = false;
    }
    if (skeletonTransitions.length >= DEBUG_ANOMALY_SKELETON_TRANSITION_COUNT) {
      return emitEpisode('skeleton-flicker', 'anomaly.skeleton-flicker', {
        count: skeletonTransitions.length,
      });
    }
    return [];
  };

  const observeHttpStarted = (event: DebugEvent): DebugEventInput[] => {
    if (COALESCED_HTTP_RULES.has(detailString(event, 'kind') ?? '')) return [];
    const requestId = detailString(event, 'requestId');
    const method = detailString(event, 'method') ?? 'GET';
    const key = `${method}:${event.route}`;
    const output: DebugEventInput[] = [];
    if (requestId) {
      if (activeRequests.size >= DEBUG_ANOMALY_MAX_KEYS) {
        const oldest = activeRequests.keys().next().value as string;
        const removed = activeRequests.get(oldest);
        activeRequests.delete(oldest);
        if (removed) {
          const count = Math.max(0, (activeRequestCounts.get(removed.key) ?? 1) - 1);
          if (count === 0) activeRequestCounts.delete(removed.key);
          else activeRequestCounts.set(removed.key, count);
          if (count < 2) openEpisodes.delete(`http-duplicate:${removed.key}`);
        }
      }
      activeRequests.set(requestId, { key, startedAt: event.tMs });
      const concurrent = (activeRequestCounts.get(key) ?? 0) + 1;
      activeRequestCounts.set(key, concurrent);
      if (concurrent >= 2) {
        output.push(
          ...emitEpisode(`http-duplicate:${key}`, 'anomaly.http-duplicate', {
            method,
            concurrent,
          }),
        );
      }
    }
    const starts = boundedQueue(requestStarts, event.route);
    appendTimestamp(starts, event.tMs);
    if (starts.length >= DEBUG_ANOMALY_HTTP_STORM_COUNT) {
      output.push(
        ...emitEpisode(`http-storm:${event.route}`, 'anomaly.http-storm', {
          method,
          count: starts.length,
        }),
      );
    }
    return output;
  };

  const completeActiveRequest = (event: DebugEvent): void => {
    const requestId = detailString(event, 'requestId');
    if (!requestId) return;
    const active = activeRequests.get(requestId);
    if (!active) return;
    activeRequests.delete(requestId);
    const concurrent = Math.max(0, (activeRequestCounts.get(active.key) ?? 1) - 1);
    if (concurrent === 0) activeRequestCounts.delete(active.key);
    else activeRequestCounts.set(active.key, concurrent);
    if (concurrent < 2) openEpisodes.delete(`http-duplicate:${active.key}`);
  };

  const observeHttpCompleted = (event: DebugEvent): DebugEventInput[] => {
    completeActiveRequest(event);
    const output: DebugEventInput[] = [];
    const method = detailString(event, 'method') ?? 'GET';
    const outcome = detailString(event, 'outcome') ?? 'unknown';
    const durationMs = detailNumber(event, 'durationMs') ?? 0;
    const status = detailNumber(event, 'status') ?? 0;
    const failed = FAILED_HTTP_OUTCOMES.has(outcome) || status >= 400;
    const key = `${method}:${event.route}`;
    if (failed) {
      const failures = boundedQueue(requestFailures, key);
      appendTimestamp(failures, event.tMs);
      if (failures.length >= DEBUG_ANOMALY_HTTP_RETRY_COUNT) {
        output.push(
          ...emitEpisode(`http-retry:${key}`, 'anomaly.http-retry-loop', {
            method,
            count: failures.length,
            outcome,
          }),
        );
      }
    }
    if (durationMs >= DEBUG_ANOMALY_HTTP_SLOW_MS && !SLOW_REQUEST_EXEMPT_ROUTES.has(event.route)) {
      output.push(anomaly('anomaly.http-slow', { method, durationMs, outcome }));
    }
    return output;
  };

  const observeLog = (event: DebugEvent): DebugEventInput[] => {
    if (event.kind !== 'console.warn' && event.kind !== 'console.error') return [];
    const fingerprint = detailString(event, 'fingerprint');
    if (!fingerprint) return [];
    const logs = boundedQueue(repeatedLogs, fingerprint);
    appendTimestamp(logs, event.tMs);
    if (logs.length < DEBUG_ANOMALY_LOG_REPEAT_COUNT) return [];
    return emitEpisode(`log:${fingerprint}`, 'anomaly.repeated-log', {
      fingerprint,
      count: logs.length,
    });
  };

  const observePerformance = (event: DebugEvent): DebugEventInput[] => {
    if (event.kind === 'performance.long-task') {
      const durationMs = detailNumber(event, 'durationMs') ?? 0;
      return durationMs >= DEBUG_ANOMALY_LONG_TASK_MS
        ? [anomaly('anomaly.long-task', { durationMs })]
        : [];
    }
    if (event.kind === 'performance.timer-stall') {
      const durationMs = detailNumber(event, 'durationMs') ?? 0;
      return durationMs >= DEBUG_ANOMALY_MAIN_THREAD_STALL_MS
        ? [anomaly('anomaly.main-thread-stall', { durationMs })]
        : [];
    }
    if (!RENDER_KINDS.has(event.kind)) return [];
    appendTimestamp(renderEvents, event.tMs);
    if (renderEvents.length < DEBUG_ANOMALY_RENDER_STORM_COUNT) return [];
    return emitEpisode('render-storm', 'anomaly.render-storm', { count: renderEvents.length });
  };

  const observeNavigation = (event: DebugEvent): DebugEventInput[] => {
    const anomalyKind =
      event.kind === 'navigation.reload'
        ? 'anomaly.navigation-reload'
        : event.kind === 'navigation.bfcache-restored'
          ? 'anomaly.bfcache-restored'
          : null;
    if (!anomalyKind || navigationEpisodes.has(anomalyKind)) return [];
    navigationEpisodes.add(anomalyKind);
    return [anomaly(anomalyKind)];
  };

  const observe = (event: DebugEvent): DebugEventInput[] => {
    if (event.source === 'detector' || event.kind.startsWith('anomaly.')) return [];
    pruneState(event.tMs);
    const output = detectSkeletonStall(event.tMs);
    output.push(...observeScroll(event));
    output.push(...observeDomAndSkeleton(event));
    if (event.kind === 'http.started') output.push(...observeHttpStarted(event));
    if (event.kind === 'http.completed') output.push(...observeHttpCompleted(event));
    output.push(...observeLog(event));
    output.push(...observePerformance(event));
    output.push(...observeNavigation(event));
    return output;
  };

  return {
    observe,
    finish: (atMs) => {
      pruneState(atMs);
      if (skeletonVisibleSince === null || skeletonStuckReported) return [];
      skeletonStuckReported = true;
      return [
        anomaly('anomaly.skeleton-stuck', {
          durationMs: Math.max(0, atMs - skeletonVisibleSince),
          reason: 'visible-at-finish',
        }),
      ];
    },
    getSummary: () => ({ total: summary.total, counts: { ...summary.counts } }),
    getBufferedEventCount: () =>
      domReplacements.length +
      skeletonTransitions.length +
      renderEvents.length +
      pendingScrolls.length +
      activeRequests.size +
      mapTimestampCount(requestStarts) +
      mapTimestampCount(requestFailures) +
      mapTimestampCount(repeatedLogs),
  };
}
