/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useInboxChangedMessageIds } from './useInboxChangedMessageIds';

let root: Root | null = null;
let container: HTMLDivElement | null = null;
let onMessageIdsMock = vi.fn();

function renderHook() {
  if (container == null) throw new Error('container not initialized');

  const Harness = () => {
    useInboxChangedMessageIds({
      onMessageIds: onMessageIdsMock,
    });
    return null;
  };

  root = createRoot(container);
  act(() => {
    root?.render(createElement(Harness));
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  onMessageIdsMock = vi.fn().mockResolvedValue(undefined);
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  root = null;
  container?.remove();
  container = null;
});

describe('useInboxChangedMessageIds', () => {
  it('deduplicates message ids from browser events and ignores malformed payloads', () => {
    renderHook();

    window.dispatchEvent(
      new CustomEvent('echo-inbox-changed', {
        detail: { messageIds: [7, 7, 9, 'bad', null, 9] },
      }),
    );
    window.dispatchEvent(
      new CustomEvent('echo-inbox-changed', {
        detail: { notMessageIds: [1, 2, 3] },
      }),
    );
    window.dispatchEvent(new CustomEvent('echo-inbox-changed', { detail: null }));

    expect(onMessageIdsMock).toHaveBeenCalledTimes(1);
    expect(onMessageIdsMock).toHaveBeenCalledWith([7, 9]);
  });

  it('removes the listener on unmount', () => {
    renderHook();
    act(() => {
      root?.unmount();
    });
    root = null;

    window.dispatchEvent(
      new CustomEvent('echo-inbox-changed', {
        detail: { messageIds: [11] },
      }),
    );

    expect(onMessageIdsMock).not.toHaveBeenCalled();
  });
});
