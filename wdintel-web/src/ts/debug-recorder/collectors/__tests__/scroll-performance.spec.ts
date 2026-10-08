/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  attachScrollPerformanceCollector,
  type DebugCollectorCapabilityReporter,
} from '../scroll-performance';
import type { DebugEventInput } from '../../types';

type ObserverCallback = (entries: PerformanceEntry[]) => void;

const originalWindowScroll = window.scroll;
const originalWindowScrollTo = window.scrollTo;
const originalWindowScrollBy = window.scrollBy;
const originalElementScroll = Element.prototype.scroll;
const originalElementScrollTo = Element.prototype.scrollTo;
const originalElementScrollBy = Element.prototype.scrollBy;

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.documentElement.scrollTop = 0;
  window.scroll = originalWindowScroll;
  window.scrollTo = originalWindowScrollTo;
  window.scrollBy = originalWindowScrollBy;
  Element.prototype.scroll = originalElementScroll;
  Element.prototype.scrollTo = originalElementScrollTo;
  Element.prototype.scrollBy = originalElementScrollBy;
  document.body.replaceChildren();
});

describe('scroll and performance collector', () => {
  it('distinguishes intent and programmatic scrolling and coalesces geometry per frame', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    window.scroll = vi.fn();
    window.scrollTo = vi.fn();
    window.scrollBy = vi.fn();
    Element.prototype.scroll = vi.fn();
    Element.prototype.scrollTo = vi.fn();
    Element.prototype.scrollBy = vi.fn();
    const events: DebugEventInput[] = [];
    const cleanup = attachScrollPerformanceCollector((input) => events.push(input));

    window.dispatchEvent(new WheelEvent('wheel'));
    window.dispatchEvent(new TouchEvent('touchstart'));
    window.dispatchEvent(new PointerEvent('pointerdown'));
    window.dispatchEvent(new Event('keydown'));
    document.body.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));
    window.scroll(0, 10);
    window.scrollTo(0, 20);
    window.scrollBy(0, 5);

    const scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      scrollTop: { value: 400, writable: true },
      scrollHeight: { value: 1_200 },
      clientHeight: { value: 600 },
    });
    document.body.append(scroller);
    scroller.scroll(0, 1);
    scroller.scrollTo(0, 2);
    scroller.scrollBy(0, 3);
    scroller.dispatchEvent(new Event('scroll'));
    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event('scroll'));
    callbacks.splice(0).forEach((callback) => callback(16));

    expect(
      events.filter((event) => event.kind === 'scroll.intent').map((event) => event.details?.kind),
    ).toEqual(['wheel', 'touch', 'pointer', 'keyboard', 'focus']);
    expect(
      events
        .filter((event) => event.kind === 'scroll.programmatic')
        .map((event) => event.details?.method),
    ).toEqual(['scroll', 'scrollTo', 'scrollBy', 'scroll', 'scrollTo', 'scrollBy']);
    expect(events.filter((event) => event.kind === 'scroll.sample')).toEqual([
      {
        kind: 'scroll.sample',
        source: 'collector',
        details: { scrollTop: 500, scrollHeight: 1_200, clientHeight: 600, delta: 500 },
      },
    ]);
    cleanup();
  });

  it('uses the current window offset as the initial scroll baseline', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const originalScrollY = Object.getOwnPropertyDescriptor(window, 'scrollY');
    let scrollY = 5_000;
    Object.defineProperty(window, 'scrollY', { configurable: true, get: () => scrollY });
    const events: DebugEventInput[] = [];
    const cleanup = attachScrollPerformanceCollector((input) => events.push(input));

    try {
      scrollY = 5_400;
      document.dispatchEvent(new Event('scroll'));
      callbacks.splice(0).forEach((callback) => callback(16));

      expect(events.find((event) => event.kind === 'scroll.sample')?.details?.delta).toBe(400);
    } finally {
      cleanup();
      if (originalScrollY) Object.defineProperty(window, 'scrollY', originalScrollY);
      else Reflect.deleteProperty(window, 'scrollY');
    }
  });

  it('captures initial offsets for element scroll containers present at attachment', () => {
    const callbacks: FrameRequestCallback[] = [];
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      callbacks.push(callback);
      return callbacks.length;
    });
    const scroller = document.createElement('div');
    Object.defineProperties(scroller, {
      scrollTop: { value: 400, writable: true },
      scrollHeight: { value: 1_200 },
      clientHeight: { value: 600 },
    });
    document.body.append(scroller);
    const events: DebugEventInput[] = [];
    const cleanup = attachScrollPerformanceCollector((input) => events.push(input));

    scroller.scrollTop = 500;
    scroller.dispatchEvent(new Event('scroll'));
    callbacks.splice(0).forEach((callback) => callback(16));

    expect(events.find((event) => event.kind === 'scroll.sample')?.details?.delta).toBe(100);
    cleanup();
  });

  it('records resize and structural performance entries while coalescing map tiles', () => {
    let observerCallback: ObserverCallback = () => {};
    const disconnect = vi.fn();
    class FakePerformanceObserver {
      static supportedEntryTypes = ['layout-shift', 'longtask', 'resource', 'navigation'];
      constructor(callback: PerformanceObserverCallback) {
        observerCallback = (entries) =>
          callback({ getEntries: () => entries } as PerformanceObserverEntryList, this as never);
      }
      observe() {}
      disconnect = disconnect;
    }
    vi.stubGlobal('PerformanceObserver', FakePerformanceObserver);
    const support: Array<[string, string]> = [];
    const report: DebugCollectorCapabilityReporter = (name, status) => support.push([name, status]);
    const events: DebugEventInput[] = [];
    const cleanup = attachScrollPerformanceCollector((input) => events.push(input), { report });

    window.dispatchEvent(new Event('resize'));
    observerCallback([
      { entryType: 'layout-shift', value: 0.25, hadRecentInput: false } as PerformanceEntry,
      { entryType: 'longtask', duration: 75 } as PerformanceEntry,
      {
        entryType: 'resource',
        name: 'https://tiles.secret.example/12/345/678.png?token=secret',
        initiatorType: 'img',
        duration: 20,
      } as PerformanceEntry,
      {
        entryType: 'resource',
        name: 'https://tiles.secret.example/12/346/679.png',
        initiatorType: 'img',
        duration: 30,
      } as PerformanceEntry,
      { entryType: 'navigation', type: 'back_forward', duration: 100 } as PerformanceEntry,
    ]);

    expect(events.map((event) => event.kind)).toEqual([
      'viewport.resize',
      'performance.layout-shift',
      'performance.long-task',
      'performance.resource',
      'performance.navigation',
    ]);
    expect(events[3]).toMatchObject({
      route: '/map-tile',
      details: { kind: 'map-tile', count: 2, durationMs: 50 },
    });
    expect(JSON.stringify(events)).not.toContain('tiles.secret.example');
    expect(JSON.stringify(events)).not.toContain('/345/');
    expect(support).toEqual([
      ['performance.layout-shift', 'supported'],
      ['performance.longtask', 'supported'],
      ['performance.resource', 'supported'],
      ['performance.navigation', 'supported'],
    ]);
    cleanup();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('reports unsupported performance capabilities without throwing', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    const support: Array<[string, string]> = [];
    const cleanup = attachScrollPerformanceCollector(() => {}, {
      report: (name, status) => support.push([name, status]),
    });

    expect(support).toEqual([
      ['performance.layout-shift', 'unsupported'],
      ['performance.longtask', 'unsupported'],
      ['performance.resource', 'unsupported'],
      ['performance.navigation', 'unsupported'],
    ]);
    cleanup();
  });

  it('emits one heartbeat stall for at least one second of drift', () => {
    vi.stubGlobal('PerformanceObserver', undefined);
    let now = 0;
    const events: DebugEventInput[] = [];
    const cleanup = attachScrollPerformanceCollector((input) => events.push(input), {
      now: () => now,
    });

    now = 1_500;
    vi.advanceTimersByTime(250);
    now = 1_750;
    vi.advanceTimersByTime(250);
    now = 2_000;
    vi.advanceTimersByTime(250);

    expect(events.filter((event) => event.kind === 'performance.timer-stall')).toEqual([
      {
        kind: 'performance.timer-stall',
        source: 'collector',
        details: { durationMs: 1_250 },
      },
    ]);
    cleanup();
  });
});
