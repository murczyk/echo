import { describe, expect, it, vi } from 'vitest';

import { attachGlobalCollectors, type DebugCollectorFactory } from '../index';

describe('global collector orchestration', () => {
  it('forwards collector cleanup output before detaching it', () => {
    const sink = vi.fn();
    const result = attachGlobalCollectors(sink, {
      collectors: [
        [
          'flush-on-cleanup',
          (collectorSink) => () => collectorSink({ kind: 'collector.final-summary' }),
        ],
      ],
    });

    result.cleanup();
    result.cleanup();

    expect(sink).toHaveBeenCalledOnce();
    expect(sink).toHaveBeenCalledWith({ kind: 'collector.final-summary' });
  });

  it('isolates attach and sink failures and cleans up successful collectors in reverse order', () => {
    const cleanupOrder: string[] = [];
    const emissions = new Map<string, () => void>();
    const factory =
      (name: string): DebugCollectorFactory =>
      (sink, report) => {
        if (name === 'attach-failure') throw new Error('attach failed');
        if (name === 'unsupported') report?.('feature-x', 'unsupported');
        emissions.set(name, () => sink({ kind: name }));
        return () => cleanupOrder.push(name);
      };
    const sink = vi.fn((input: { kind: string }) => {
      if (input.kind === 'sink-failure') throw new Error('sink failed');
    });
    const result = attachGlobalCollectors(sink, {
      collectors: [
        ['first', factory('first')],
        ['attach-failure', factory('attach-failure')],
        ['sink-failure', factory('sink-failure')],
        ['unsupported', factory('unsupported')],
        ['last', factory('last')],
      ],
    });

    emissions.get('sink-failure')?.();
    emissions.get('first')?.();
    emissions.get('last')?.();
    expect(result.support).toEqual({
      supported: ['first', 'unsupported', 'last'],
      unsupported: ['feature-x'],
      failed: ['attach-failure', 'sink-failure'],
    });
    expect(cleanupOrder).toEqual(['sink-failure']);
    expect(sink).toHaveBeenCalledTimes(3);

    result.cleanup();
    result.cleanup();
    expect(cleanupOrder).toEqual(['sink-failure', 'last', 'unsupported', 'first']);
  });
});
