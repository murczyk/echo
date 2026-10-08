import {
  ECHO_NAVIGATION_EVENT,
  type EchoNavigationEventDetail,
} from '../../browser/navigation-guard';
import { createDebugSanitizer } from '../sanitize';
import type { DebugCollectorCleanup, DebugEventInput, DebugEventSink } from '../types';

type NavigationKind = EchoNavigationEventDetail['kind'];
type PendingHistoryEvent = { kind: 'push' | 'replace'; route: string; cancelled: boolean };

export type InteractionNavigationCollectorOptions = {
  recordingStartedAt?: number;
};

const INTERACTION_EVENTS = new Map<string, string>([
  ['click', 'interaction.click'],
  ['submit', 'interaction.submit'],
  ['focusin', 'interaction.focus'],
]);

const INTENT_EVENTS = new Map<string, string>([
  ['wheel', 'wheel'],
  ['touchmove', 'touch'],
]);
const SCROLL_KEY_CODES = new Set([
  'ArrowDown',
  'ArrowUp',
  'End',
  'Home',
  'PageDown',
  'PageUp',
  'Space',
]);

function isRecorderTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest('[data-debug-recorder-host], [data-debug-recorder-root]') !== null
  );
}

function isPersistedPageTransition(event: Event): boolean {
  if (typeof PageTransitionEvent !== 'undefined' && event instanceof PageTransitionEvent) {
    return event.persisted;
  }
  return Object.getOwnPropertyDescriptor(event, 'persisted')?.value === true;
}

export function attachInteractionNavigationCollector(
  sink: DebugEventSink,
  options: InteractionNavigationCollectorOptions = {},
): DebugCollectorCleanup {
  const sanitizer = createDebugSanitizer('interaction-navigation-collector');
  const nativePush = window.history.pushState;
  const nativeReplace = window.history.replaceState;
  const pendingHistoryEvents = new Set<PendingHistoryEvent>();
  const cleanups: Array<() => void> = [];
  let active = true;

  const emit = (input: DebugEventInput) => {
    if (!active) return;
    try {
      sink(input);
    } catch {
      // Diagnostics must never affect user interaction or navigation.
    }
  };

  const currentRoute = () => sanitizer.safeRoute(window.location.href);
  const emitNavigation = (kind: string, details: DebugEventInput['details'] = {}) => {
    emit({ kind, source: 'collector', route: currentRoute(), details });
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

  const onInteraction = (event: Event) => {
    if (isRecorderTarget(event.target)) return;
    const kind = INTERACTION_EVENTS.get(event.type);
    if (!kind) return;
    emit({
      kind,
      source: 'collector',
      target: sanitizer.safeTarget(event.target),
    });
  };

  const onIntent = (event: Event) => {
    if (isRecorderTarget(event.target)) return;
    let kind = INTENT_EVENTS.get(event.type);
    if (event.type === 'keydown') {
      let code: string;
      try {
        code = event instanceof KeyboardEvent ? event.code : '';
      } catch {
        return;
      }
      if (!SCROLL_KEY_CODES.has(code)) return;
      kind = 'keyboard';
    }
    if (!kind) return;
    emit({ kind: 'scroll.intent', source: 'collector', details: { kind } });
  };

  for (const type of INTERACTION_EVENTS.keys()) listen(document, type, onInteraction, true);
  for (const type of INTENT_EVENTS.keys()) listen(window, type, onIntent, true);
  listen(window, 'keydown', onIntent, true);

  const scheduleHistoryEvent = (kind: PendingHistoryEvent['kind']) => {
    const pending = { kind, route: currentRoute(), cancelled: false };
    pendingHistoryEvents.add(pending);
    queueMicrotask(() => {
      pendingHistoryEvents.delete(pending);
      if (!pending.cancelled) emitNavigation(`navigation.${kind}`);
    });
  };

  const wrappedPush: History['pushState'] = function (this: History, data, unused, url) {
    const result = Reflect.apply(nativePush, this, [data, unused, url]);
    scheduleHistoryEvent('push');
    return result;
  };
  const wrappedReplace: History['replaceState'] = function (this: History, data, unused, url) {
    const result = Reflect.apply(nativeReplace, this, [data, unused, url]);
    scheduleHistoryEvent('replace');
    return result;
  };
  window.history.pushState = wrappedPush;
  window.history.replaceState = wrappedReplace;

  const onGuardNavigation = (event: Event) => {
    if (!(event instanceof CustomEvent)) return;
    const detail = event.detail as Partial<EchoNavigationEventDetail> | null;
    const kind = detail?.kind;
    if (kind !== 'push' && kind !== 'replace' && kind !== 'traverse' && kind !== 'load') return;
    const route = currentRoute();
    for (const pending of [...pendingHistoryEvents].reverse()) {
      if (pending.kind === kind && pending.route === route) {
        pending.cancelled = true;
        break;
      }
    }
    emitNavigation(`navigation.${kind}`, { forced: detail?.forced === true });
  };
  listen(window, ECHO_NAVIGATION_EVENT, onGuardNavigation);

  const onPopState = () => {
    const route = currentRoute();
    if ([...pendingHistoryEvents].some((pending) => pending.route === route)) return;
    emitNavigation('navigation.traverse', { navigationType: 'back-forward' });
  };
  listen(window, 'popstate', onPopState);
  listen(window, 'hashchange', () => emitNavigation('navigation.hashchange'));
  listen(window, 'pagehide', (event) =>
    emitNavigation('document.pagehide', {
      browserEvent: 'pagehide',
      active: isPersistedPageTransition(event),
    }),
  );
  listen(window, 'pageshow', (event) => {
    if (isPersistedPageTransition(event)) {
      emitNavigation('navigation.bfcache-restored', { navigationType: 'back-forward' });
    }
  });
  listen(window, 'online', () => emitNavigation('network.online', { active: true }));
  listen(window, 'offline', () => emitNavigation('network.offline', { active: false }));
  listen(document, 'visibilitychange', () =>
    emitNavigation('document.visibility', { visible: document.visibilityState === 'visible' }),
  );

  try {
    const navigation = performance.getEntriesByType('navigation')[0] as
      PerformanceNavigationTiming | undefined;
    const kind =
      navigation?.type === 'reload'
        ? 'navigation.reload'
        : navigation?.type === 'back_forward'
          ? 'navigation.back-forward'
          : navigation?.type === 'navigate'
            ? 'navigation.load'
            : null;
    if (
      kind &&
      options.recordingStartedAt !== undefined &&
      performance.timeOrigin > options.recordingStartedAt
    ) {
      emitNavigation(kind, { navigationType: navigation!.type });
    }
  } catch {
    // Navigation timing is optional in hardened and older browsers.
  }

  return () => {
    if (!active) return;
    active = false;
    for (const pending of pendingHistoryEvents) pending.cancelled = true;
    pendingHistoryEvents.clear();
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    if (window.history.pushState === wrappedPush) window.history.pushState = nativePush;
    if (window.history.replaceState === wrappedReplace) window.history.replaceState = nativeReplace;
  };
}
