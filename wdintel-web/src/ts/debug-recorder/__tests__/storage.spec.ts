/**
 * @vitest-environment happy-dom
 */
import { describe, expect, it } from 'vitest';

import { DEBUG_MAX_BYTES, DEBUG_SCHEMA_VERSION, DEBUG_STORAGE_KEY } from '../config';
import { clearDebugSession, loadDebugSession, saveDebugSession } from '../storage';
import type { PersistedDebugSession } from '../types';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  readonly reads: string[] = [];
  readonly writes: string[] = [];
  readonly removals: string[] = [];
  throwOn: 'get' | 'set' | 'remove' | null = null;

  get length() {
    return this.values.size;
  }

  clear(): void {
    this.values.clear();
  }

  getItem(key: string): string | null {
    this.reads.push(key);
    if (this.throwOn === 'get') throw new DOMException('disabled', 'SecurityError');
    return this.values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.removals.push(key);
    if (this.throwOn === 'remove') throw new DOMException('disabled', 'SecurityError');
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.writes.push(key);
    if (this.throwOn === 'set') throw new DOMException('full', 'QuotaExceededError');
    this.values.set(key, value);
  }
}

function buildSession(overrides: Partial<PersistedDebugSession> = {}): PersistedDebugSession {
  return {
    schemaVersion: DEBUG_SCHEMA_VERSION,
    state: 'recording',
    recordingId: 'recording-1',
    aliasSalt: 'alias-salt',
    startedAt: 1_000,
    deadlineAt: 61_000,
    nextSeq: 2,
    events: [
      {
        seq: 1,
        tMs: 10,
        kind: 'navigation.reload',
        source: 'browser',
        route: '/safe',
      },
    ],
    serializedBytes: 512,
    droppedEvents: 0,
    rejectedEvents: 0,
    truncatedValues: 0,
    persistenceFailed: false,
    aliases: {},
    environment: {
      echoVersion: '2026.10.8',
      deploymentMode: 'Live',
      browserFamily: 'Chromium',
      browserVersion: '128',
      viewportWidth: 1280,
      viewportHeight: 720,
      devicePixelRatio: 1,
      startRoute: '/safe',
    },
    anomalies: { total: 0, counts: {} },
    collectorSupport: { supported: [], unsupported: [], failed: [] },
    ...overrides,
  };
}

describe('debug recorder session storage', () => {
  it('reads, writes and removes only the namespaced recorder key', () => {
    const storage = new MemoryStorage();
    storage.values.set('unrelated', 'ECHO_SECRET_SENTINEL');
    const session = buildSession();

    expect(saveDebugSession(storage, session)).toBe(true);
    expect(loadDebugSession(storage, 2_000)).toMatchObject({ recordingId: 'recording-1' });
    clearDebugSession(storage);

    expect(storage.reads).toEqual([DEBUG_STORAGE_KEY]);
    expect(storage.writes).toEqual([DEBUG_STORAGE_KEY]);
    expect(storage.removals).toEqual([DEBUG_STORAGE_KEY]);
    expect(storage.values.get('unrelated')).toBe('ECHO_SECRET_SENTINEL');
  });

  it('restores valid recording and ready sessions', () => {
    const recordingStorage = new MemoryStorage();
    recordingStorage.values.set(DEBUG_STORAGE_KEY, JSON.stringify(buildSession()));
    expect(loadDebugSession(recordingStorage, 2_000)?.state).toBe('recording');

    const readyStorage = new MemoryStorage();
    readyStorage.values.set(
      DEBUG_STORAGE_KEY,
      JSON.stringify(buildSession({ state: 'ready', readyAt: 2_000 })),
    );
    expect(loadDebugSession(readyStorage, 3_000)?.state).toBe('ready');
  });

  it.each([
    ['malformed JSON', '{'],
    ['wrong schema', JSON.stringify(buildSession({ schemaVersion: 2 as 1 }))],
    ['invalid state', JSON.stringify({ ...buildSession(), state: 'broken' })],
    ['invalid deadline', JSON.stringify(buildSession({ deadlineAt: 500 }))],
    ['invalid sequence', JSON.stringify(buildSession({ nextSeq: 1 }))],
    ['expired ready state', JSON.stringify(buildSession({ state: 'ready', readyAt: 2_000 }))],
  ])('removes %s without reading other storage keys', (_name, raw) => {
    const storage = new MemoryStorage();
    storage.values.set('unrelated', 'keep');
    storage.values.set(DEBUG_STORAGE_KEY, raw);

    expect(loadDebugSession(storage, 700_001)).toBeNull();
    expect(storage.reads).toEqual([DEBUG_STORAGE_KEY]);
    expect(storage.removals).toEqual([DEBUG_STORAGE_KEY]);
    expect(storage.values.get('unrelated')).toBe('keep');
  });

  it('removes a stored value larger than one MiB', () => {
    const storage = new MemoryStorage();
    storage.values.set(DEBUG_STORAGE_KEY, 'x'.repeat(DEBUG_MAX_BYTES + 1));

    expect(loadDebugSession(storage, 0)).toBeNull();
    expect(storage.removals).toEqual([DEBUG_STORAGE_KEY]);
  });

  it('contains disabled and quota-failing storage operations', () => {
    const storage = new MemoryStorage();
    storage.throwOn = 'get';
    expect(loadDebugSession(storage, 0)).toBeNull();

    storage.throwOn = 'set';
    expect(saveDebugSession(storage, buildSession())).toBe(false);

    storage.throwOn = 'remove';
    expect(() => clearDebugSession(storage)).not.toThrow();
  });
});
