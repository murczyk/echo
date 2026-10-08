/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { mountDebugRecorderPanel, unmountDebugRecorderPanel } from '../debug-recorder-root';
import type { DebugRecorderPanelController } from '../DebugRecorderPanel';

const snapshot = {
  state: 'recording' as const,
  recordingId: 'recording-1',
  startedAt: Date.now(),
  deadlineAt: Date.now() + 60_000,
  elapsedMs: 0,
  eventCount: 0,
  droppedEvents: 0,
  anomalyCount: 0,
  persistenceFailed: false,
  downloadError: false,
};

const controller: DebugRecorderPanelController = {
  subscribe: () => () => {},
  getSnapshot: () => snapshot,
  finish: () => {},
  download: () => true,
};

afterEach(() => {
  act(() => unmountDebugRecorderPanel());
  document.body.replaceChildren();
});

describe('debug recorder root', () => {
  it('keeps the panel marker on the rendered panel only', () => {
    act(() => mountDebugRecorderPanel(controller));

    expect(document.querySelectorAll('[data-debug-recorder-root]')).toHaveLength(1);
    expect(document.querySelector('[data-debug-recorder-root]')?.tagName).toBe('SECTION');
    expect(
      document.getElementById('echo-debug-recorder-root')?.hasAttribute('data-debug-recorder-root'),
    ).toBe(false);
    expect(
      document.getElementById('echo-debug-recorder-root')?.hasAttribute('data-debug-recorder-host'),
    ).toBe(true);
  });

  it('recreates a host removed during application bootstrap', () => {
    act(() => mountDebugRecorderPanel(controller));
    const firstHost = document.getElementById('echo-debug-recorder-root')!;
    firstHost.remove();

    act(() => mountDebugRecorderPanel(controller));

    const currentHost = document.getElementById('echo-debug-recorder-root');
    expect(currentHost).not.toBe(firstHost);
    expect(currentHost?.isConnected).toBe(true);
    expect(currentHost?.querySelector('[data-debug-recorder-root]')).not.toBeNull();
  });
});
