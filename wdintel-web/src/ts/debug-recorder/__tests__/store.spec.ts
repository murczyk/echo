/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEBUG_MAX_BYTES, DEBUG_STORAGE_KEY } from '../config';
import { loadDebugSession } from '../storage';
import { createBrowserDebugRecorder, type DebugRecorderDependencies } from '../store';
import type { DebugBuildMetadata, DebugEnvironment } from '../types';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  failWrites = false;

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

const metadata: DebugBuildMetadata = {
  echoVersion: '2026.10.8',
  deploymentMode: 'Live',
};

const environment: DebugEnvironment = {
  ...metadata,
  browserFamily: 'Chromium',
  browserVersion: '128',
  viewportWidth: 1280,
  viewportHeight: 720,
  devicePixelRatio: 1,
  startRoute: '/messages/{id_1}',
};

function dependencies(
  storage: MemoryStorage,
  overrides: Partial<DebugRecorderDependencies> = {},
): DebugRecorderDependencies {
  return {
    storage,
    now: () => Date.now(),
    createRecordingId: () => 'recording-1',
    createAliasSalt: () => 'private-alias-salt',
    collectEnvironment: () => environment,
    getRoute: () => '/messages/42?token=ECHO_SECRET_SENTINEL',
    buildMarkdown: () => '# report',
    downloadMarkdown: () => true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('browser debug recorder store', () => {
  it('ignores duplicate starts and expires at the original deadline', () => {
    const storage = new MemoryStorage();
    const recorder = createBrowserDebugRecorder(dependencies(storage));
    recorder.configure(metadata);

    recorder.start();
    const started = recorder.getSnapshot();
    vi.advanceTimersByTime(10_000);
    recorder.start();

    expect(recorder.getSnapshot()).toMatchObject({
      state: 'recording',
      recordingId: 'recording-1',
      startedAt: started.startedAt,
      deadlineAt: started.deadlineAt,
    });

    vi.advanceTimersByTime(50_000);
    expect(recorder.getSnapshot().state).toBe('ready');
    vi.advanceTimersByTime(600_000);
    expect(recorder.getSnapshot().state).toBe('idle');
    expect(storage.values.has(DEBUG_STORAGE_KEY)).toBe(false);
  });

  it('restores deadline, sequence and opaque aliases across reload', () => {
    const storage = new MemoryStorage();
    const first = createBrowserDebugRecorder(dependencies(storage));
    first.configure(metadata);
    first.start();
    expect(first.aliasIdentifier('feed', 42)).toBe('{feed_1}');
    first.record({ kind: 'navigation.push', details: { navigationType: 'push' } });
    first.flush();
    const firstDeadline = first.getSnapshot().deadlineAt;
    const persistedRaw = storage.values.get(DEBUG_STORAGE_KEY)!;
    expect(persistedRaw).not.toContain('ECHO_SECRET_SENTINEL');
    expect(persistedRaw).not.toContain('"42"');

    vi.advanceTimersByTime(5_000);
    const restored = createBrowserDebugRecorder(dependencies(storage));
    expect(restored.getSnapshot().deadlineAt).toBe(firstDeadline);
    expect(restored.aliasIdentifier('feed', 42)).toBe('{feed_1}');
    restored.record({ kind: 'navigation.replace', details: { navigationType: 'replace' } });
    restored.flush();

    const session = loadDebugSession(storage, Date.now());
    expect(session?.events.map((event) => event.seq)).toEqual([1, 2]);
    expect(session?.events.every((event) => event.route === '/messages/{id_1}')).toBe(true);
  });

  it('evicts the oldest event when the 1,000-event cap is crossed', () => {
    const storage = new MemoryStorage();
    const recorder = createBrowserDebugRecorder(dependencies(storage));
    recorder.configure(metadata);
    recorder.start();

    for (let index = 0; index < 1_001; index += 1) {
      recorder.record({ kind: 'scroll.sample', details: { scrollTop: index } });
    }
    recorder.flush();

    const session = loadDebugSession(storage, Date.now());
    expect(session?.events).toHaveLength(1_000);
    expect(session?.events[0]?.seq).toBe(2);
    expect(session?.droppedEvents).toBe(1);
  });

  it('evicts oldest events until the serialized session is at most one MiB', () => {
    const storage = new MemoryStorage();
    const recorder = createBrowserDebugRecorder(dependencies(storage));
    recorder.configure(metadata);
    recorder.start();
    const details = {
      outcome: 'x'.repeat(160),
      reason: 'x'.repeat(160),
      fingerprint: 'x'.repeat(160),
      errorClass: 'x'.repeat(160),
      method: 'x'.repeat(160),
      phase: 'x'.repeat(160),
      navigationType: 'x'.repeat(160),
      browserEvent: 'x'.repeat(160),
      initiatorType: 'x'.repeat(160),
      entryType: 'x'.repeat(160),
    };

    for (let index = 0; index < 900; index += 1) {
      recorder.record({ kind: 'semantic.metrics', details });
    }
    recorder.flush();

    const raw = storage.values.get(DEBUG_STORAGE_KEY)!;
    const session = loadDebugSession(storage, Date.now());
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThanOrEqual(DEBUG_MAX_BYTES);
    expect(session?.serializedBytes).toBeLessThanOrEqual(DEBUG_MAX_BYTES);
    expect(session?.droppedEvents).toBeGreaterThan(0);
    expect(session?.events.at(-1)?.seq).toBe(900);
  });

  it('continues in memory and reports a failed persistence write', () => {
    const storage = new MemoryStorage();
    storage.failWrites = true;
    const recorder = createBrowserDebugRecorder(dependencies(storage));
    recorder.configure(metadata);

    recorder.start();
    recorder.record({ kind: 'click', details: { tag: 'button' } });
    recorder.flush();

    expect(recorder.getSnapshot()).toMatchObject({
      state: 'recording',
      eventCount: 1,
      persistenceFailed: true,
    });
  });

  it('keeps ready data after a failed download and clears it after a successful retry', () => {
    const storage = new MemoryStorage();
    const downloadMarkdown = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true);
    const recorder = createBrowserDebugRecorder(dependencies(storage, { downloadMarkdown }));
    recorder.configure(metadata);
    recorder.start();
    recorder.finish();

    expect(recorder.download()).toBe(false);
    expect(recorder.getSnapshot()).toMatchObject({ state: 'ready', downloadError: true });
    expect(recorder.download()).toBe(true);
    expect(recorder.getSnapshot().state).toBe('idle');
    expect(storage.values.has(DEBUG_STORAGE_KEY)).toBe(false);
  });

  it('makes finish and clear idempotent and isolates injected tab storage', () => {
    const firstStorage = new MemoryStorage();
    const secondStorage = new MemoryStorage();
    const first = createBrowserDebugRecorder(dependencies(firstStorage));
    const second = createBrowserDebugRecorder(dependencies(secondStorage));
    first.configure(metadata);
    second.configure(metadata);
    first.start();
    first.finish();
    first.finish();
    first.clear();
    first.clear();

    expect(first.getSnapshot().state).toBe('idle');
    expect(second.getSnapshot().state).toBe('idle');
    expect(secondStorage.values.size).toBe(0);
  });
});
