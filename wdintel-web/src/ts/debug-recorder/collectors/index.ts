import type { DebugCollectorCleanup, DebugCollectorSupport, DebugEventSink } from '../types';
import { attachDomLoadingCollector } from './dom-loading';
import { attachErrorCollector } from './errors';
import { attachHttpCollector } from './http';
import { attachInteractionNavigationCollector } from './interaction-navigation';
import {
  attachScrollPerformanceCollector,
  type DebugCollectorCapabilityReporter,
} from './scroll-performance';

export type DebugCollectorFactory = (
  sink: DebugEventSink,
  report?: DebugCollectorCapabilityReporter,
) => DebugCollectorCleanup;

export type GlobalCollectorOptions = {
  collectors?: Array<[name: string, factory: DebugCollectorFactory]>;
  recordingStartedAt?: number;
};

const defaultCollectors = (recordingStartedAt?: number): Array<[string, DebugCollectorFactory]> => [
  [
    'interaction-navigation',
    (sink) => attachInteractionNavigationCollector(sink, { recordingStartedAt }),
  ],
  ['http', attachHttpCollector],
  ['errors', attachErrorCollector],
  [
    'scroll-performance',
    (sink, report) => attachScrollPerformanceCollector(sink, { captureIntent: false, report }),
  ],
  ['dom-loading', attachDomLoadingCollector],
];

function addUnique(values: string[], value: string): void {
  if (!values.includes(value)) values.push(value);
}

function remove(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) values.splice(index, 1);
}

export function attachGlobalCollectors(
  sink: DebugEventSink,
  options: GlobalCollectorOptions = {},
): { cleanup: DebugCollectorCleanup; support: DebugCollectorSupport } {
  const support: DebugCollectorSupport = { supported: [], unsupported: [], failed: [] };
  const attached: Array<{
    name: string;
    cleanup: DebugCollectorCleanup;
    active: boolean;
    cleaning: boolean;
  }> = [];
  let cleaned = false;

  for (const [name, factory] of options.collectors ??
    defaultCollectors(options.recordingStartedAt)) {
    const entry = {
      name,
      cleanup: (() => {}) as DebugCollectorCleanup,
      active: true,
      cleaning: false,
    };
    const detach = () => {
      if (!entry.active) return;
      entry.active = false;
      if (entry.cleaning) return;
      entry.cleaning = true;
      try {
        entry.cleanup();
      } catch {
        remove(support.supported, name);
        addUnique(support.failed, name);
      } finally {
        entry.cleaning = false;
      }
    };
    const collectorSink: DebugEventSink = (input) => {
      if (!entry.active) return;
      try {
        sink(input);
      } catch {
        remove(support.supported, name);
        addUnique(support.failed, name);
        detach();
      }
    };
    const report: DebugCollectorCapabilityReporter = (capability, status) => {
      remove(support.supported, capability);
      remove(support.unsupported, capability);
      remove(support.failed, capability);
      if (status === 'supported') addUnique(support.supported, capability);
      else if (status === 'unsupported') addUnique(support.unsupported, capability);
      else addUnique(support.failed, capability);
    };
    try {
      entry.cleanup = factory(collectorSink, report);
      attached.push(entry);
      if (entry.active) addUnique(support.supported, name);
      else entry.cleanup();
    } catch {
      entry.active = false;
      addUnique(support.failed, name);
    }
  }

  return {
    support,
    cleanup: () => {
      if (cleaned) return;
      cleaned = true;
      for (const entry of [...attached].reverse()) {
        if (!entry.active) continue;
        entry.cleaning = true;
        try {
          entry.cleanup();
        } catch {
          remove(support.supported, entry.name);
          addUnique(support.failed, entry.name);
        } finally {
          entry.cleaning = false;
          entry.active = false;
        }
      }
    },
  };
}
