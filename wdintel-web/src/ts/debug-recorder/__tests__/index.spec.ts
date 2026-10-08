/**
 * @vitest-environment happy-dom
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUTH_UNAUTHORIZED_EVENT } from '../../react/auth-redirect';
import { DEBUG_STORAGE_KEY } from '../config';
import { createBrowserDebugRecorderRuntime } from '../index';
import { createBrowserDebugRecorder, type DebugRecorderDependencies } from '../store';
import type { DebugEnvironment, DebugEventSink } from '../types';

class MemoryStorage implements Storage {
  readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

const environment: DebugEnvironment = {
  echoVersion: 'configured-version',
  deploymentMode: 'Live',
  browserFamily: 'Chromium',
  browserVersion: '128',
  viewportWidth: 1280,
  viewportHeight: 720,
  devicePixelRatio: 1,
  startRoute: '/source',
};

function recorderDependencies(storage: Storage, now: () => number): DebugRecorderDependencies {
  return {
    storage,
    now,
    createRecordingId: () => 'runtime-recording',
    createAliasSalt: () => 'runtime-salt',
    collectEnvironment: (metadata) => ({ ...environment, ...metadata }),
    getRoute: () => '/source',
    buildMarkdown: () => '# report',
    downloadMarkdown: () => true,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('browser debug recorder runtime', () => {
  it('starts only on eight presses within four seconds and persists configured metadata', () => {
    let clock = 0;
    const storage = new MemoryStorage();
    const recorder = createBrowserDebugRecorder(recorderDependencies(storage, () => clock));
    const collectorCleanup = vi.fn();
    const attachCollectors = vi.fn(() => ({
      cleanup: collectorCleanup,
      support: { supported: ['test'], unsupported: [], failed: [] },
    }));
    const mountPanel = vi.fn();
    const unmountPanel = vi.fn();
    const runtime = createBrowserDebugRecorderRuntime({
      recorder,
      attachCollectors,
      mountPanel,
      unmountPanel,
      eventTarget: new EventTarget(),
    });
    runtime.initialize();
    runtime.configure({ echoVersion: '2026.10.8', deploymentMode: 'Live' });

    expect(runtime.record({ kind: 'ignored' })).toBeUndefined();
    expect(runtime.aliasIdentifier('message', 42)).toBeNull();
    for (let index = 0; index < 7; index += 1) {
      expect(runtime.registerPress(index * 500)).toBe(false);
    }
    expect(runtime.getSnapshot().state).toBe('idle');
    expect(attachCollectors).not.toHaveBeenCalled();
    expect(mountPanel).not.toHaveBeenCalled();

    expect(runtime.registerPress(3_500)).toBe(true);
    expect(runtime.registerPress(3_600)).toBe(false);
    expect(runtime.getSnapshot().state).toBe('recording');
    expect(attachCollectors).toHaveBeenCalledOnce();
    expect(mountPanel).toHaveBeenCalledOnce();
    expect(runtime.aliasIdentifier('message', 42)).toBe('{message_1}');
    runtime.record({ kind: 'semantic.render' });
    recorder.flush();

    const persisted = JSON.parse(storage.values.get(DEBUG_STORAGE_KEY)!);
    expect(persisted.environment).toMatchObject({
      echoVersion: '2026.10.8',
      deploymentMode: 'Live',
    });
    expect(persisted.collectorSupport.supported).toEqual(['test']);

    runtime.finish();
    expect(collectorCleanup).toHaveBeenCalledOnce();
    expect(mountPanel).toHaveBeenCalledOnce();
    runtime.clear();
    expect(unmountPanel).toHaveBeenCalledOnce();
    runtime.destroy();
  });

  it('resets a slow press sequence and ignores seven presses', () => {
    const storage = new MemoryStorage();
    const recorder = createBrowserDebugRecorder(recorderDependencies(storage, () => 0));
    const runtime = createBrowserDebugRecorderRuntime({
      recorder,
      attachCollectors: () => ({
        cleanup: () => {},
        support: { supported: [], unsupported: [], failed: [] },
      }),
      mountPanel: () => {},
      unmountPanel: () => {},
      eventTarget: new EventTarget(),
    });
    runtime.initialize();
    for (let index = 0; index < 7; index += 1) runtime.registerPress(index * 500);
    for (let index = 0; index < 7; index += 1) runtime.registerPress(5_000 + index * 500);
    expect(runtime.getSnapshot().state).toBe('idle');
    runtime.destroy();
  });

  it('restores once, attaches once, and detaches on the original timeout', () => {
    let clock = 1_000;
    const storage = new MemoryStorage();
    const first = createBrowserDebugRecorder(recorderDependencies(storage, () => clock));
    first.start();
    first.flush();
    const restored = createBrowserDebugRecorder(recorderDependencies(storage, () => clock));
    const collectorCleanup = vi.fn();
    const mountPanel = vi.fn();
    const runtime = createBrowserDebugRecorderRuntime({
      recorder: restored,
      attachCollectors: () => ({
        cleanup: collectorCleanup,
        support: { supported: [], unsupported: [], failed: [] },
      }),
      mountPanel,
      unmountPanel: vi.fn(),
      eventTarget: new EventTarget(),
    });

    runtime.initialize();
    runtime.initialize();
    expect(mountPanel).toHaveBeenCalledOnce();
    expect(runtime.getSnapshot().deadlineAt).toBe(61_000);
    clock = 61_000;
    vi.advanceTimersByTime(60_000);
    expect(runtime.getSnapshot().state).toBe('ready');
    expect(collectorCleanup).toHaveBeenCalledOnce();
    runtime.destroy();
    first.clear();
  });

  it('clears synchronously on unauthorized and same-origin HTTP 401 signals', () => {
    const storage = new MemoryStorage();
    const eventTarget = new EventTarget();
    let collectorSink: DebugEventSink = () => {};
    const cleanup = vi.fn();
    const recorder = createBrowserDebugRecorder(recorderDependencies(storage, () => 0));
    const runtime = createBrowserDebugRecorderRuntime({
      recorder,
      attachCollectors: (sink) => {
        collectorSink = sink;
        return { cleanup, support: { supported: [], unsupported: [], failed: [] } };
      },
      mountPanel: () => {},
      unmountPanel: () => {},
      eventTarget,
    });
    runtime.initialize();
    for (let index = 0; index < 8; index += 1) runtime.registerPress(index);
    eventTarget.dispatchEvent(new Event(AUTH_UNAUTHORIZED_EVENT));
    expect(runtime.getSnapshot().state).toBe('idle');
    expect(storage.values.has(DEBUG_STORAGE_KEY)).toBe(false);
    expect(cleanup).toHaveBeenCalledOnce();

    for (let index = 0; index < 8; index += 1) runtime.registerPress(100 + index);
    collectorSink({
      kind: 'http.completed',
      details: { status: 401, sameOrigin: true },
    });
    expect(runtime.getSnapshot().state).toBe('idle');
    expect(cleanup).toHaveBeenCalledTimes(2);
    runtime.destroy();
  });
});
