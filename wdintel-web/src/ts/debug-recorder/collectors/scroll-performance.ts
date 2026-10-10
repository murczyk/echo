import {
  DEBUG_ANOMALY_MAIN_THREAD_STALL_MS,
  DEBUG_SCROLL_BASELINE_INSPECTION_LIMIT,
  DEBUG_SCROLL_HEARTBEAT_MS,
} from '../config';
import { createDebugSanitizer } from '../sanitize';
import type { DebugCollectorCleanup, DebugEventInput, DebugEventSink } from '../types';

export type DebugCollectorCapabilityStatus = 'supported' | 'unsupported' | 'failed';
export type DebugCollectorCapabilityReporter = (
  name: string,
  status: DebugCollectorCapabilityStatus,
) => void;

export type ScrollPerformanceCollectorOptions = {
  captureIntent?: boolean;
  report?: DebugCollectorCapabilityReporter;
  now?: () => number;
};

const PERFORMANCE_ENTRY_TYPES = ['layout-shift', 'longtask', 'resource', 'navigation'] as const;
const INTENT_EVENTS = new Map<string, string>([
  ['wheel', 'wheel'],
  ['touchstart', 'touch'],
  ['pointerdown', 'pointer'],
  ['keydown', 'keyboard'],
  ['focusin', 'focus'],
]);

function isRecorderTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-debug-recorder-host], [data-debug-recorder-root]') !== null
  );
}

function isMapTile(name: string, initiatorType: string): boolean {
  if (initiatorType !== 'img' && initiatorType !== 'fetch') return false;
  try {
    const segments = new URL(name, window.location.href).pathname.split('/').filter(Boolean);
    return segments.some(
      (_, index) =>
        /^\d+$/.test(segments[index] ?? '') &&
        /^\d+$/.test(segments[index + 1] ?? '') &&
        /^\d+(?:\.[a-z]+)?$/i.test(segments[index + 2] ?? ''),
    );
  } catch {
    return false;
  }
}

export function attachScrollPerformanceCollector(
  sink: DebugEventSink,
  options: ScrollPerformanceCollectorOptions = {},
): DebugCollectorCleanup {
  const sanitizer = createDebugSanitizer('scroll-performance-collector');
  const now = options.now ?? (() => performance.now());
  const captureIntent = options.captureIntent !== false;
  const cleanups: Array<() => void> = [];
  const pendingContainers = new Set<EventTarget>();
  const previousScrollTop = new WeakMap<object, number>();
  let frame: number | null = null;
  let active = true;

  const scrollKey = (container: EventTarget): object =>
    container === window || container === document ? window : (container as object);

  const readScrollTop = (container: EventTarget): number =>
    container === window || container === document
      ? window.scrollY || document.documentElement.scrollTop || 0
      : container instanceof Element
        ? container.scrollTop
        : 0;

  previousScrollTop.set(window, readScrollTop(window));
  const baselineWalker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
  let baselineNode: Node | null = baselineWalker.currentNode;
  let baselineCount = 0;
  while (baselineNode && baselineCount < DEBUG_SCROLL_BASELINE_INSPECTION_LIMIT) {
    if (baselineNode instanceof Element && baselineNode.scrollTop !== 0) {
      previousScrollTop.set(baselineNode, baselineNode.scrollTop);
    }
    baselineCount += 1;
    baselineNode = baselineWalker.nextNode();
  }

  const emit = (input: DebugEventInput) => {
    if (!active) return;
    try {
      sink(input);
    } catch {
      // The orchestrator owns collector failure reporting.
    }
  };

  const listen = (
    target: EventTarget,
    type: string,
    listener: EventListener,
    options?: boolean | AddEventListenerOptions,
  ) => {
    target.addEventListener(type, listener, options);
    cleanups.push(() => target.removeEventListener(type, listener, options));
  };

  if (captureIntent) {
    const onIntent = (event: Event) => {
      if (isRecorderTarget(event.target)) return;
      const kind = INTENT_EVENTS.get(event.type);
      if (kind) emit({ kind: 'scroll.intent', source: 'collector', details: { kind } });
    };
    for (const type of INTENT_EVENTS.keys()) {
      listen(type === 'focusin' ? document : window, type, onIntent, true);
    }
  }

  const wrapMethod = <Target extends object, Key extends keyof Target>(
    target: Target,
    key: Key,
    label: string,
  ) => {
    const native = target[key];
    if (typeof native !== 'function') return;
    const wrapped = function (this: unknown, ...args: unknown[]) {
      if (!(this instanceof Element) || !isRecorderTarget(this)) {
        emit({
          kind: 'scroll.programmatic',
          source: 'collector',
          details: { method: label },
        });
      }
      return Reflect.apply(native, this, args);
    };
    target[key] = wrapped as Target[Key];
    cleanups.push(() => {
      if (target[key] === (wrapped as Target[Key])) target[key] = native;
    });
  };

  wrapMethod(window, 'scroll', 'scroll');
  wrapMethod(window, 'scrollTo', 'scrollTo');
  wrapMethod(window, 'scrollBy', 'scrollBy');
  wrapMethod(Element.prototype, 'scroll', 'scroll');
  wrapMethod(Element.prototype, 'scrollTo', 'scrollTo');
  wrapMethod(Element.prototype, 'scrollBy', 'scrollBy');

  const geometry = (container: EventTarget) => {
    const isWindow = container === window || container === document;
    const scrollTop = readScrollTop(container);
    const scrollHeight = isWindow
      ? document.documentElement.scrollHeight
      : container instanceof Element
        ? container.scrollHeight
        : 0;
    const clientHeight = isWindow
      ? window.innerHeight
      : container instanceof Element
        ? container.clientHeight
        : 0;
    const key = scrollKey(container);
    const previous = previousScrollTop.get(key) ?? 0;
    previousScrollTop.set(key, scrollTop);
    return { scrollTop, scrollHeight, clientHeight, delta: scrollTop - previous };
  };

  const flushScroll = () => {
    frame = null;
    for (const container of pendingContainers) {
      emit({ kind: 'scroll.sample', source: 'collector', details: geometry(container) });
    }
    pendingContainers.clear();
  };

  const onScroll = (event: Event) => {
    if (isRecorderTarget(event.target)) return;
    const container = event.target ?? window;
    pendingContainers.add(container);
    if (frame === null) frame = window.requestAnimationFrame(flushScroll);
  };
  listen(document, 'scroll', onScroll, true);
  listen(window, 'scroll', onScroll, true);

  const emitResize = () => {
    const viewport = window.visualViewport;
    emit({
      kind: 'viewport.resize',
      source: 'collector',
      details: {
        width: viewport?.width ?? window.innerWidth,
        height: viewport?.height ?? window.innerHeight,
        devicePixelRatio: window.devicePixelRatio,
      },
    });
  };
  listen(window, 'resize', emitResize);
  listen(window, 'orientationchange', emitResize);
  if (window.visualViewport) listen(window.visualViewport, 'resize', emitResize);

  let performanceObserver: PerformanceObserver | null = null;
  const supportedTypes =
    typeof PerformanceObserver === 'undefined'
      ? []
      : Array.from(PerformanceObserver.supportedEntryTypes ?? []);
  for (const type of PERFORMANCE_ENTRY_TYPES) {
    options.report?.(
      `performance.${type}`,
      supportedTypes.includes(type) ? 'supported' : 'unsupported',
    );
  }

  if (supportedTypes.some((type) => PERFORMANCE_ENTRY_TYPES.includes(type as never))) {
    try {
      performanceObserver = new PerformanceObserver((list) => {
        let tileCount = 0;
        let tileDuration = 0;
        const flushTiles = () => {
          if (tileCount === 0) return;
          emit({
            kind: 'performance.resource',
            source: 'collector',
            route: '/map-tile',
            details: {
              kind: 'map-tile',
              count: tileCount,
              durationMs: tileDuration,
              initiatorType: 'img',
            },
          });
          tileCount = 0;
          tileDuration = 0;
        };
        for (const entry of list.getEntries()) {
          if (entry.entryType !== 'resource') flushTiles();
          const candidate = entry as PerformanceEntry & {
            value?: number;
            hadRecentInput?: boolean;
            initiatorType?: string;
            type?: string;
          };
          if (entry.entryType === 'layout-shift' && candidate.hadRecentInput !== true) {
            emit({
              kind: 'performance.layout-shift',
              source: 'collector',
              details: { layoutShiftValue: candidate.value ?? 0 },
            });
          } else if (entry.entryType === 'longtask') {
            emit({
              kind: 'performance.long-task',
              source: 'collector',
              details: { durationMs: entry.duration },
            });
          } else if (entry.entryType === 'resource') {
            const initiatorType = candidate.initiatorType ?? 'unknown';
            if (isMapTile(entry.name, initiatorType)) {
              tileCount += 1;
              tileDuration += entry.duration;
              continue;
            } else {
              flushTiles();
              emit({
                kind: 'performance.resource',
                source: 'collector',
                route: sanitizer.safeRoute(entry.name),
                details: { initiatorType, durationMs: entry.duration, count: 1 },
              });
            }
          } else if (entry.entryType === 'navigation') {
            flushTiles();
            emit({
              kind: 'performance.navigation',
              source: 'collector',
              details: {
                navigationType: candidate.type ?? 'unknown',
                durationMs: entry.duration,
              },
            });
          }
        }
        flushTiles();
      });
      const entryTypes = PERFORMANCE_ENTRY_TYPES.filter((type) => supportedTypes.includes(type));
      performanceObserver.observe({ entryTypes });
    } catch {
      performanceObserver?.disconnect();
      performanceObserver = null;
      for (const type of PERFORMANCE_ENTRY_TYPES) {
        if (supportedTypes.includes(type)) options.report?.(`performance.${type}`, 'failed');
      }
    }
  }

  let heartbeatAt = now();
  const heartbeat = window.setInterval(() => {
    const current = now();
    const drift = current - heartbeatAt - DEBUG_SCROLL_HEARTBEAT_MS;
    heartbeatAt = current;
    if (drift >= DEBUG_ANOMALY_MAIN_THREAD_STALL_MS) {
      emit({
        kind: 'performance.timer-stall',
        source: 'collector',
        details: { durationMs: drift },
      });
    }
  }, DEBUG_SCROLL_HEARTBEAT_MS);

  return () => {
    if (!active) return;
    active = false;
    window.clearInterval(heartbeat);
    if (frame !== null) window.cancelAnimationFrame(frame);
    pendingContainers.clear();
    performanceObserver?.disconnect();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  };
}
