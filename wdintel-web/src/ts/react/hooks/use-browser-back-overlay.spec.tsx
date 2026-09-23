/**
 * @vitest-environment happy-dom
 */
import { StrictMode } from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBrowserBackOverlay } from './use-browser-back-overlay';

function TestOverlay({
  label,
  open = true,
  onClose,
}: {
  label: string;
  open?: boolean;
  onClose: () => boolean | void;
}) {
  const requestClose = useBrowserBackOverlay({ open, onClose });
  return (
    <button type="button" data-testid={`close-${label}`} onClick={requestClose}>
      {label}
    </button>
  );
}

function touch(
  type: 'touchstart' | 'touchmove' | 'touchend' | 'touchcancel',
  clientX: number,
  clientY: number,
) {
  return new TouchEvent(type, {
    bubbles: true,
    cancelable: true,
    touches: type === 'touchend' ? [] : ([{ clientX, clientY }] as unknown as Touch[]),
    changedTouches: [{ clientX, clientY }] as unknown as Touch[],
  });
}

describe('useBrowserBackOverlay', () => {
  let container: HTMLDivElement;
  let root: Root;
  let initialState: { screen: string };
  let initialUrl: string;

  beforeEach(() => {
    initialState = { screen: 'duty' };
    window.history.replaceState(initialState, '', '/rer-duty-neo?state-short=test');
    initialUrl = window.location.href;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    document.documentElement.classList.remove('echo-browser-back-overlay-open');
    vi.restoreAllMocks();
  });

  it('pushes one same-URL history layer in Strict Mode and preserves existing state', async () => {
    const pushState = vi.spyOn(window.history, 'pushState');
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);

    await act(async () => {
      root.render(
        <StrictMode>
          <TestOverlay label="editor" onClose={vi.fn()} />
        </StrictMode>,
      );
    });

    expect(pushState).toHaveBeenCalledTimes(1);
    expect(back).not.toHaveBeenCalled();
    expect(window.location.href).toBe(initialUrl);
    expect(window.history.state).toMatchObject(initialState);
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );
  });

  it('consumes the active history layer when an open overlay unmounts', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={vi.fn()} />));

    await act(async () => root.render(null));

    expect(back).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      false,
    );
  });

  it('consumes every trailing history layer when nested overlays unmount together', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    const go = vi.spyOn(window.history, 'go').mockImplementation(() => undefined);
    await act(async () =>
      root.render(
        <>
          <TestOverlay label="outer" onClose={vi.fn()} />
          <TestOverlay label="inner" onClose={vi.fn()} />
        </>,
      ),
    );

    await act(async () => root.render(null));

    expect(back).not.toHaveBeenCalled();
    expect(go).toHaveBeenCalledOnce();
    expect(go).toHaveBeenCalledWith(-2);
  });

  it('dismisses an overlay when Back restores the pre-overlay state', async () => {
    const onClose = vi.fn();
    await act(async () => root.render(<TestOverlay label="editor" onClose={onClose} />));

    await act(async () => {
      window.history.replaceState(initialState, '', initialUrl);
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }));
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      false,
    );
  });

  it('consumes history and invokes a direct close callback exactly once', async () => {
    const onClose = vi.fn();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={onClose} />));

    container.querySelector<HTMLButtonElement>('[data-testid="close-editor"]')?.click();

    expect(back).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }));
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps the history layer when a direct close is rejected', async () => {
    const onClose = vi.fn(() => false);
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={onClose} />));

    container.querySelector<HTMLButtonElement>('[data-testid="close-editor"]')?.click();

    expect(onClose).toHaveBeenCalledOnce();
    expect(back).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );
  });

  it('restores the history layer when a browser Back close is rejected', async () => {
    const onClose = vi.fn(() => false);
    const pushState = vi.spyOn(window.history, 'pushState');
    await act(async () => root.render(<TestOverlay label="editor" onClose={onClose} />));

    await act(async () => {
      window.history.replaceState(initialState, '', initialUrl);
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }));
    });

    expect(onClose).toHaveBeenCalledOnce();
    expect(pushState).toHaveBeenCalledTimes(2);
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );
  });

  it('consumes the active history layer when open changes to false', async () => {
    const onClose = vi.fn();
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" open onClose={onClose} />));

    await act(async () =>
      root.render(<TestOverlay label="editor" open={false} onClose={onClose} />),
    );

    expect(back).toHaveBeenCalledOnce();
    expect(onClose).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      false,
    );
  });

  it('dismisses nested overlays top-first and keeps protection for the outer overlay', async () => {
    const closeOuter = vi.fn();
    const closeInner = vi.fn();
    await act(async () => root.render(<TestOverlay label="outer" onClose={closeOuter} />));
    const outerState = window.history.state;

    await act(async () =>
      root.render(
        <>
          <TestOverlay label="outer" onClose={closeOuter} />
          <TestOverlay label="inner" onClose={closeInner} />
        </>,
      ),
    );

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: outerState }));
    });
    expect(closeInner).toHaveBeenCalledOnce();
    expect(closeOuter).not.toHaveBeenCalled();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      true,
    );

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }));
    });
    expect(closeOuter).toHaveBeenCalledOnce();
    expect(document.documentElement.classList.contains('echo-browser-back-overlay-open')).toBe(
      false,
    );
  });

  it('dismisses every skipped history layer from inner to outer', async () => {
    const closeOrder: string[] = [];
    await act(async () =>
      root.render(
        <>
          <TestOverlay label="outer" onClose={() => closeOrder.push('outer')} />
          <TestOverlay label="inner" onClose={() => closeOrder.push('inner')} />
        </>,
      ),
    );

    await act(async () => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: initialState }));
    });

    expect(closeOrder).toEqual(['inner', 'outer']);
  });

  it('requests closing the top overlay after a rightward left-edge swipe', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={vi.fn()} />));

    document.dispatchEvent(touch('touchstart', 12, 120));
    const move = touch('touchmove', 58, 124);
    document.dispatchEvent(move);
    document.dispatchEvent(touch('touchend', 96, 126));

    expect(move.defaultPrevented).toBe(true);
    expect(back).toHaveBeenCalledOnce();
  });

  it('ignores short, vertical, and non-edge gestures', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={vi.fn()} />));

    document.dispatchEvent(touch('touchstart', 12, 100));
    document.dispatchEvent(touch('touchend', 60, 102));
    document.dispatchEvent(touch('touchstart', 12, 100));
    document.dispatchEvent(touch('touchmove', 30, 190));
    document.dispatchEvent(touch('touchend', 36, 220));
    document.dispatchEvent(touch('touchstart', 80, 100));
    document.dispatchEvent(touch('touchend', 180, 102));

    expect(back).not.toHaveBeenCalled();
  });

  it('does not close an overlay when the browser cancels the edge gesture', async () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined);
    await act(async () => root.render(<TestOverlay label="editor" onClose={vi.fn()} />));

    document.dispatchEvent(touch('touchstart', 12, 100));
    document.dispatchEvent(touch('touchmove', 90, 102));
    document.dispatchEvent(touch('touchcancel', 100, 102));

    expect(back).not.toHaveBeenCalled();
  });
});
