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
  it('renders a compact, centered recording control with themed styles', () => {
    const state = controller(recordingSnapshot());
    act(() => root.render(<DebugRecorderPanel controller={state.value} />));

    const panel = container.querySelector<HTMLElement>('[data-debug-recorder-root]')!;
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(panel.textContent).toContain('Запис');
    expect(panel.textContent).toContain('00:00');
    expect(panel.textContent).not.toContain('/ 01:00');
    expect(panel.querySelector('[role="status"]')?.getAttribute('aria-live')).toBe('polite');
    expect(panel.style.top).toBe('8px');
    expect(panel.style.left).toBe('50%');
    expect(panel.style.transform).toBe('translateX(-50%)');
    expect(panel.style.width).toBe('max-content');
    expect(panel.style.backgroundColor).toBe('var(--echo-color-surface-raised)');
    expect(panel.style.color).toBe('var(--echo-color-text)');
    expect(button.textContent).toBe('Завершити');
    expect(button.style.minHeight).toBe('28px');
    expect(panel.querySelector('style')?.textContent).toContain('button:focus-visible');

    act(() => vi.advanceTimersByTime(61_000));
    expect(panel.textContent).toContain('01:00');
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

    expect(container.textContent).toContain('Готово');
    expect(container.textContent).not.toContain('42 подій');
    const button = container.querySelector<HTMLButtonElement>('button')!;
    expect(button.textContent).toBe('Завантажити');
    act(() => button.click());
    expect(container.textContent).toContain('Помилка завантаження');
    expect(button.textContent).toBe('Повторити');

    state.download.mockReturnValueOnce(true);
    act(() => button.click());
    expect(state.download).toHaveBeenCalledTimes(2);
  });
});
