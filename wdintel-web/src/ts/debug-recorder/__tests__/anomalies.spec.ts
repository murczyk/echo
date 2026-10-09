import { describe, expect, it } from 'vitest';

import { createDebugAnomalyDetector } from '../anomalies';
import type { DebugEvent } from '../types';

function event(
  kind: string,
  tMs: number,
  details: DebugEvent['details'] = {},
  route = '/messages/{id_1}',
): DebugEvent {
  return { seq: tMs + 1, tMs, kind, source: 'collector', route, details };
}

function kinds(events: ReturnType<ReturnType<typeof createDebugAnomalyDetector>['observe']>) {
  return events.map((item) => item.kind);
}

describe('debug anomaly detector', () => {
  it('correlates large scroll jumps and suppresses jumps with recent intent', () => {
    const detector = createDebugAnomalyDetector();

    detector.observe(event('performance.layout-shift', 100, { layoutShiftValue: 0.3 }));
    expect(
      kinds(detector.observe(event('scroll.sample', 500, { delta: 400, clientHeight: 600 }))),
    ).toEqual(['anomaly.scroll-jump']);

    detector.observe(event('scroll.intent', 1_000, { kind: 'wheel' }));
    detector.observe(event('performance.layout-shift', 1_200, { layoutShiftValue: 0.2 }));
    expect(
      detector.observe(event('scroll.sample', 1_300, { delta: 600, clientHeight: 600 })),
    ).toEqual([]);

    detector.observe(event('scroll.programmatic', 2_000, { method: 'scrollTo' }));
    expect(
      detector.observe(event('scroll.sample', 2_100, { delta: 600, clientHeight: 600 })),
    ).toEqual([]);
  });

  it('accepts focus correlation after the scroll candidate', () => {
    const detector = createDebugAnomalyDetector();
    expect(
      detector.observe(event('scroll.sample', 100, { delta: -400, clientHeight: 600 })),
    ).toEqual([]);
    expect(kinds(detector.observe(event('interaction.focus', 500)))).toEqual([
      'anomaly.scroll-jump',
    ]);
  });

  it.each(['interaction.click', 'dom.replacement'])(
    'correlates a large scroll jump with %s',
    (correlationKind) => {
      const detector = createDebugAnomalyDetector();

      detector.observe(event(correlationKind, 100));

      expect(
        detector.observe(event('scroll.sample', 200, { delta: 400, clientHeight: 600 })),
      ).toMatchObject([
        {
          kind: 'anomaly.scroll-jump',
          details: { delta: 400, clientHeight: 600, reason: correlationKind },
        },
      ]);
    },
  );

  it.each([
    ['before', 100, 200],
    ['after', 200, 100],
  ] as const)(
    'correlates a viewport resize %s a large scroll jump',
    (_order, resizeAt, scrollAt) => {
      const detector = createDebugAnomalyDetector();
      const events = [
        event('viewport.resize', resizeAt, { viewportWidth: 800, viewportHeight: 500 }),
        event('scroll.sample', scrollAt, { delta: 400, clientHeight: 600 }),
      ].sort((left, right) => left.tMs - right.tMs);

      const observed = events.flatMap((input) => detector.observe(input));

      expect(observed).toMatchObject([
        {
          kind: 'anomaly.scroll-jump',
          details: { delta: 400, clientHeight: 600, reason: 'viewport.resize' },
        },
      ]);
    },
  );

  it('detects DOM replacement storms and opens one episode until recovery', () => {
    const detector = createDebugAnomalyDetector();
    expect(detector.observe(event('dom.replacement', 0))).toEqual([]);
    expect(detector.observe(event('dom.replacement', 500))).toEqual([]);
    expect(kinds(detector.observe(event('dom.replacement', 1_000)))).toEqual([
      'anomaly.dom-replacement-storm',
    ]);
    expect(detector.observe(event('dom.replacement', 1_500))).toEqual([]);
    expect(detector.observe(event('dom.replacement', 4_000))).toEqual([]);
    expect(detector.observe(event('dom.replacement', 4_500))).toEqual([]);
    expect(kinds(detector.observe(event('dom.replacement', 5_000)))).toEqual([
      'anomaly.dom-replacement-storm',
    ]);
  });

  it('detects skeleton flicker, ten-second stalls and visible-at-finish states', () => {
    const detector = createDebugAnomalyDetector();
    for (const [tMs, visible] of [
      [0, true],
      [400, false],
      [800, true],
    ] as const) {
      expect(detector.observe(event('skeleton.visibility', tMs, { visible }))).toEqual([]);
    }
    expect(
      kinds(detector.observe(event('skeleton.visibility', 1_200, { visible: false }))),
    ).toEqual(['anomaly.skeleton-flicker']);

    detector.observe(event('skeleton.visibility', 3_000, { visible: true }));
    expect(kinds(detector.observe(event('scroll.sample', 13_000, { delta: 1 })))).toEqual([
      'anomaly.skeleton-stuck',
    ]);

    const unfinished = createDebugAnomalyDetector();
    unfinished.observe(event('skeleton.visibility', 500, { visible: true }));
    expect(kinds(unfinished.finish(2_000))).toEqual(['anomaly.skeleton-stuck']);
  });

  it('detects duplicate, storming, retrying and slow HTTP requests', () => {
    const detector = createDebugAnomalyDetector();
    detector.observe(
      event('http.started', 0, { requestId: 'request-1', method: 'GET' }, '/api/messages'),
    );
    expect(
      kinds(
        detector.observe(
          event('http.started', 10, { requestId: 'request-2', method: 'GET' }, '/api/messages'),
        ),
      ),
    ).toContain('anomaly.http-duplicate');

    for (let index = 2; index < 10; index += 1) {
      detector.observe(
        event(
          'http.started',
          100 + index,
          { requestId: `request-${index + 1}`, method: 'GET' },
          '/api/messages',
        ),
      );
    }
    expect(detector.getSummary().counts['anomaly.http-storm']).toBe(1);

    for (let index = 0; index < 3; index += 1) {
      detector.observe(
        event(
          'http.completed',
          1_000 + index,
          {
            requestId: `failed-${index}`,
            method: 'POST',
            outcome: index === 2 ? 'aborted' : 'network-error',
            durationMs: 100,
          },
          '/api/save',
        ),
      );
    }
    expect(detector.getSummary().counts['anomaly.http-retry-loop']).toBe(1);

    expect(
      kinds(
        detector.observe(
          event(
            'http.completed',
            2_000,
            { requestId: 'slow', method: 'GET', outcome: 'success', durationMs: 3_000 },
            '/api/report',
          ),
        ),
      ),
    ).toContain('anomaly.http-slow');
    expect(
      detector.observe(
        event(
          'http.completed',
          2_100,
          { requestId: 'poll', method: 'GET', outcome: 'success', durationMs: 30_000 },
          '/api/event-stream/long-poll',
        ),
      ),
    ).toEqual([]);
  });

  it('does not report coalesced polling as duplicate or storming HTTP', () => {
    const detector = createDebugAnomalyDetector();

    for (let index = 0; index < 20; index += 1) {
      expect(
        detector.observe(
          event(
            'http.started',
            index,
            {
              requestId: `poll-${index}`,
              method: 'GET',
              kind: 'event-stream-long-poll',
            },
            '/api/event-stream/long-poll',
          ),
        ),
      ).toEqual([]);
    }

    expect(detector.getSummary()).toEqual({ total: 0, counts: {} });
  });

  it('detects repeated logs, long tasks, timer stalls and render storms', () => {
    const detector = createDebugAnomalyDetector();
    for (let index = 0; index < 3; index += 1) {
      detector.observe(event('console.warn', index * 100, { fingerprint: 'same-warning' }));
    }
    expect(detector.getSummary().counts['anomaly.repeated-log']).toBe(1);

    expect(
      kinds(detector.observe(event('performance.long-task', 500, { durationMs: 50 }))),
    ).toEqual(['anomaly.long-task']);
    expect(
      kinds(detector.observe(event('performance.timer-stall', 600, { durationMs: 1_000 }))),
    ).toEqual(['anomaly.main-thread-stall']);

    for (let index = 0; index < 20; index += 1) {
      detector.observe(event(index % 2 === 0 ? 'semantic.render' : 'semantic.commit', 700 + index));
    }
    expect(detector.getSummary().counts['anomaly.render-storm']).toBe(1);
  });

  it.each([
    ['navigation.reload', 'anomaly.navigation-reload'],
    ['navigation.bfcache-restored', 'anomaly.bfcache-restored'],
  ])('maps %s to one anomaly episode', (inputKind, anomalyKind) => {
    const detector = createDebugAnomalyDetector();
    expect(kinds(detector.observe(event(inputKind, 0)))).toEqual([anomalyKind]);
    expect(detector.observe(event(inputKind, 1))).toEqual([]);
    expect(detector.getSummary()).toEqual({ total: 1, counts: { [anomalyKind]: 1 } });
  });

  it('ignores detector output recursively and bounds correlation windows', () => {
    const detector = createDebugAnomalyDetector();
    for (let index = 0; index < 10_000; index += 1) {
      detector.observe(
        event('console.error', index * 10, { fingerprint: `fingerprint-${index % 8}` }),
      );
      detector.observe(event('anomaly.long-task', index * 10, { durationMs: 5_000 }));
    }

    expect(detector.getBufferedEventCount()).toBeLessThan(1_000);
    expect(detector.getSummary().counts['anomaly.long-task']).toBeUndefined();
  });
});
