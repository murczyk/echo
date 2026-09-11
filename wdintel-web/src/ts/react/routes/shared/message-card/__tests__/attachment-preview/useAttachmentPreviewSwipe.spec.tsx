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
}: {
  navigation: { count: number; index: number; onPrevious: () => void; onNext: () => void };
  enabled?: boolean;
  withScrollablePanel?: boolean;
}) {
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  useAttachmentPreviewSwipe({ stageEl, navigation, enabled });

  return (
    <div data-testid="swipe-stage" ref={setStageEl}>
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
  });

  it('triggers onNext on left swipe and onPrevious on right swipe', async () => {
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

    expect(onNext).toHaveBeenCalledTimes(1);
    expect(onPrevious).not.toHaveBeenCalled();

    // Simulate Right Swipe (finger starts at 50, ends at 200)
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
    expect(onNext).toHaveBeenCalledOnce();
  });
});
