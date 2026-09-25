/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAttachmentPreviewSwipe } from '../../attachment-preview/useAttachmentPreviewSwipe';

function TestSwipeComponent({
  navigation,
  enabled = true,
  withScrollablePanel = false,
  onDismiss,
}: {
  navigation: { count: number; index: number; onPrevious: () => void; onNext: () => void };
  enabled?: boolean;
  withScrollablePanel?: boolean;
  onDismiss?: () => void;
}) {
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const motion = useAttachmentPreviewSwipe({
    stageEl,
    navigation,
    enabled,
    onDismiss,
  });

  return (
    <div
      data-testid="swipe-stage"
      ref={setStageEl}
      style={{
        transform: motion?.transform,
        opacity: motion?.opacity,
        transition: motion?.transition,
      }}
    >
      {withScrollablePanel ? <div data-attachment-preview-scroll /> : null}
    </div>
  );
}

describe('useAttachmentPreviewSwipe', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  it('changes the image without horizontal motion animation', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onNext = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious: vi.fn(), onNext };

    await act(async () => root?.render(<TestSwipeComponent navigation={navigation} />));
    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientX: 240, clientY: 100 } as Touch],
      }),
    );
    const move = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [{ clientX: 120, clientY: 104 } as Touch],
    });
    await act(async () => stage.dispatchEvent(move));

    expect(move.defaultPrevented).toBe(true);
    expect(stage.style.transform).toBe('translate3d(0px, 0px, 0)');
    expect(onNext).not.toHaveBeenCalled();

    stage.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        changedTouches: [{ clientX: 80, clientY: 104 } as Touch],
      }),
    );

    expect(onNext).toHaveBeenCalledOnce();
  });

  it('accepts a short fast flick without waiting for the animation', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onNext = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious: vi.fn(), onNext };

    await act(async () => root?.render(<TestSwipeComponent navigation={navigation} />));
    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [{ clientX: 200, clientY: 100 } as Touch],
      }),
    );
    vi.advanceTimersByTime(50);
    stage.dispatchEvent(
      new TouchEvent('touchend', {
        changedTouches: [{ clientX: 180, clientY: 101 } as Touch],
      }),
    );

    expect(onNext).toHaveBeenCalledOnce();
  });

  it('accepts a deliberate swipe even when it lasts longer than 600ms', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onNext = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious: vi.fn(), onNext };

    await act(async () => root?.render(<TestSwipeComponent navigation={navigation} />));
    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [{ clientX: 200, clientY: 100 } as Touch],
      }),
    );
    vi.advanceTimersByTime(800);
    stage.dispatchEvent(
      new TouchEvent('touchend', {
        changedTouches: [{ clientX: 150, clientY: 102 } as Touch],
      }),
    );

    expect(onNext).toHaveBeenCalledOnce();
  });

  it.each([
    ['up', 200, -120, 180],
    ['down', 440, 120, 460],
  ])(
    'tracks a vertical image swipe %s and dismisses after the exit animation',
    async (_direction, moveY, expectedOffset, endY) => {
      vi.useFakeTimers();
      container = document.createElement('div');
      document.body.appendChild(container);
      root = createRoot(container);
      const onDismiss = vi.fn();
      const navigation = { count: 1, index: 0, onPrevious: vi.fn(), onNext: vi.fn() };

      await act(async () =>
        root?.render(<TestSwipeComponent navigation={navigation} onDismiss={onDismiss} />),
      );
      const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;
      Object.defineProperty(stage, 'clientHeight', { configurable: true, value: 800 });

      stage.dispatchEvent(
        new TouchEvent('touchstart', {
          bubbles: true,
          touches: [{ clientX: 180, clientY: 320 } as Touch],
        }),
      );
      const move = new TouchEvent('touchmove', {
        bubbles: true,
        cancelable: true,
        touches: [{ clientX: 184, clientY: moveY } as Touch],
      });
      await act(async () => stage.dispatchEvent(move));

      expect(move.defaultPrevented).toBe(true);
      expect(stage.style.transform).toBe(`translate3d(0px, ${expectedOffset}px, 0)`);
      expect(Number(stage.style.opacity)).toBeLessThan(1);
      expect(onDismiss).not.toHaveBeenCalled();

      stage.dispatchEvent(
        new TouchEvent('touchend', {
          bubbles: true,
          changedTouches: [{ clientX: 184, clientY: endY } as Touch],
        }),
      );
      await act(async () => vi.advanceTimersByTime(180));

      expect(onDismiss).toHaveBeenCalledOnce();
    },
  );

  it('triggers onNext on left swipe and onPrevious on right swipe', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious, onNext };

    await act(async () =>
      root?.render(<TestSwipeComponent navigation={navigation} enabled={true} />),
    );

    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;
    expect(stage).not.toBeNull();

    // Simulate Left Swipe (finger starts at 200, ends at 50)
    await act(async () => {
      stage.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [{ clientX: 200, clientY: 100 } as Touch],
        }),
      );
      stage.dispatchEvent(
        new TouchEvent('touchend', {
          changedTouches: [{ clientX: 50, clientY: 100 } as Touch],
        }),
      );
      vi.advanceTimersByTime(340);
    });

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();

    // Simulate Right Swipe (finger starts at 50, ends at 200)
    await act(async () => {
      stage.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [{ clientX: 50, clientY: 100 } as Touch],
        }),
      );
      stage.dispatchEvent(
        new TouchEvent('touchend', {
          changedTouches: [{ clientX: 200, clientY: 100 } as Touch],
        }),
      );
      vi.advanceTimersByTime(340);
    });

    expect(onPrevious).toHaveBeenCalledTimes(1);
  });

  it('does not trigger navigation when enabled is false', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious, onNext };

    await act(async () =>
      root?.render(<TestSwipeComponent navigation={navigation} enabled={false} />),
    );

    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [{ clientX: 200, clientY: 100 } as Touch],
      }),
    );
    stage.dispatchEvent(
      new TouchEvent('touchend', {
        changedTouches: [{ clientX: 50, clientY: 100 } as Touch],
      }),
    );

    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('does not handle gestures that start inside a scrollable preview panel', async () => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);

    const onNext = vi.fn();
    const onPrevious = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious, onNext };

    await act(async () =>
      root?.render(
        <TestSwipeComponent navigation={navigation} enabled={true} withScrollablePanel={true} />,
      ),
    );

    const panel = container.querySelector('[data-attachment-preview-scroll]') as HTMLElement;
    panel.dispatchEvent(
      new TouchEvent('touchstart', {
        bubbles: true,
        touches: [{ clientX: 200, clientY: 100 } as Touch],
      }),
    );
    panel.dispatchEvent(
      new TouchEvent('touchend', {
        bubbles: true,
        changedTouches: [{ clientX: 50, clientY: 100 } as Touch],
      }),
    );

    expect(onNext).not.toHaveBeenCalled();
    expect(onPrevious).not.toHaveBeenCalled();
  });

  it('restores fresh swipes after pinch completion while navigation was disabled #3368', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const onNext = vi.fn();
    const navigation = { count: 3, index: 1, onPrevious: vi.fn(), onNext };

    await act(async () => root?.render(<TestSwipeComponent navigation={navigation} enabled />));
    const stage = container.querySelector('[data-testid="swipe-stage"]') as HTMLElement;
    stage.dispatchEvent(new CustomEvent('attachment-preview-pinch', { bubbles: true }));
    await act(async () =>
      root?.render(<TestSwipeComponent navigation={navigation} enabled={false} />),
    );
    stage.dispatchEvent(new CustomEvent('attachment-preview-gesture-end', { bubbles: true }));
    await act(async () => root?.render(<TestSwipeComponent navigation={navigation} enabled />));

    await act(async () => {
      stage.dispatchEvent(
        new TouchEvent('touchstart', {
          touches: [{ clientX: 200, clientY: 100 } as Touch],
        }),
      );
      stage.dispatchEvent(
        new TouchEvent('touchend', {
          changedTouches: [{ clientX: 50, clientY: 100 } as Touch],
        }),
      );
      vi.advanceTimersByTime(180);
    });
    expect(onNext).toHaveBeenCalledOnce();
  });
});
