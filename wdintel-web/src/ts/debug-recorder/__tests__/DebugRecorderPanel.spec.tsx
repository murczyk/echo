/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DebugRecorderPanel, type DebugRecorderPanelController } from '../DebugRecorderPanel';
import type { DebugRecorderSnapshot } from '../types';

function recordingSnapshot(): DebugRecorderSnapshot {
  return {
    state: 'recording',
    recordingId: 'recording-1',
    startedAt: Date.now(),
    deadlineAt: Date.now() + 60_000,
    elapsedMs: 0,
    eventCount: 3,
    droppedEvents: 0,
    anomalyCount: 1,
    persistenceFailed: false,
    downloadError: false,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-08T12:00:00.000Z'));
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

function controller(initial: DebugRecorderSnapshot) {
  let snapshot = initial;
  const listeners = new Set<() => void>();
  const finish = vi.fn();
  const download = vi.fn(() => true);
  const value: DebugRecorderPanelController = {
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => snapshot,
    finish,
    download,
  };
  return {
    value,
    finish,
    download,
    update(next: DebugRecorderSnapshot) {
      snapshot = next;
      act(() => listeners.forEach((listener) => listener()));
    },
  };
}

describe('DebugRecorderPanel', () => {
  it('shows accessible recording status, capped elapsed time and reachable controls', () => {
    const state = controller(recordingSnapshot());
    act(() => root.render(<DebugRecorderPanel controller={state.value} />));

    const panel = container.querySelector<HTMLElement>('[data-debug-recorder-root]')!;
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(panel.textContent).toContain('Запис діагностики');
    expect(panel.textContent).toContain('00:00 / 01:00');
    expect(panel.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(panel.style.maxWidth).toBe('calc(100vw - 16px)');
    expect(panel.style.overflow).toBe('auto');
    expect(button.textContent).toBe('Завершити');
    expect(panel.querySelector('style')?.textContent).toContain('button:focus-visible');

    act(() => vi.advanceTimersByTime(61_000));
    expect(panel.textContent).toContain('01:00 / 01:00');
    act(() => button.click());
    expect(state.finish).toHaveBeenCalledOnce();
    expect(state.download).toHaveBeenCalledOnce();
  });

  it('shows ready counts and keeps failed downloads retryable', () => {
    const ready: DebugRecorderSnapshot = {
      ...recordingSnapshot(),
      state: 'ready',
      elapsedMs: 60_000,
      eventCount: 42,
      droppedEvents: 2,
      anomalyCount: 4,
    };
    const state = controller(ready);
    state.download.mockImplementationOnce(() => {
      state.update({ ...ready, downloadError: true });
      return false;
    });
    act(() => root.render(<DebugRecorderPanel controller={state.value} />));

    expect(container.textContent).toContain('Запис готовий');
    expect(container.textContent).toContain('42 подій');
    expect(container.textContent).toContain('4 аномалії');
    expect(container.textContent).toContain('2 пропущено');
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Завантажити');
    act(() => button.click());
    expect(container.textContent).toContain('Не вдалося завантажити');
    expect(button.textContent).toBe('Повторити завантаження');

    state.download.mockReturnValueOnce(true);
    act(() => button.click());
    expect(state.download).toHaveBeenCalledTimes(2);
  });
});
