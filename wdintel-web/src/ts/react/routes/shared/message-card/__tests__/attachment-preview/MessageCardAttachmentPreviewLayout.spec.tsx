/**
 * @vitest-environment happy-dom
 */
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MessageCardAttachmentPreviewLayout } from '../../attachment-preview/MessageCardAttachmentPreviewLayout';

function Carousel() {
  const [index, setIndex] = useState(0);
  const labels = ['first', 'second'];
  return (
    <MessageCardAttachmentPreviewLayout
      stage={<div data-slide={labels[index]}>{labels[index]}</div>}
      navigation={{
        index,
        count: labels.length,
        onPrevious: () => setIndex((current) => (current + labels.length - 1) % labels.length),
        onNext: () => setIndex((current) => (current + 1) % labels.length),
      }}
    />
  );
}

describe('MessageCardAttachmentPreviewLayout', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
    vi.useRealTimers();
  });

  it('replaces the slide immediately without rendering an outgoing animation layer', async () => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => root?.render(<Carousel />));

    const swipeContent = container.querySelector(
      '[data-attachment-preview-swipe-content]',
    ) as HTMLElement;
    const stage = swipeContent.parentElement as HTMLElement;
    Object.defineProperty(stage, 'clientWidth', { configurable: true, value: 400 });

    stage.dispatchEvent(
      new TouchEvent('touchstart', {
        touches: [{ clientX: 240, clientY: 100 } as Touch],
      }),
    );
    await act(async () => {
      stage.dispatchEvent(
        new TouchEvent('touchmove', {
          cancelable: true,
          touches: [{ clientX: 120, clientY: 102 } as Touch],
        }),
      );
    });
    await act(async () => {
      stage.dispatchEvent(
        new TouchEvent('touchend', {
          changedTouches: [{ clientX: 80, clientY: 102 } as Touch],
        }),
      );
    });

    expect(container.querySelector('[data-slide="first"]')).toBeNull();
    expect(container.querySelector('[data-slide="second"]')).not.toBeNull();
    expect(container.querySelector('[data-attachment-preview-swipe-outgoing]')).toBeNull();
  });
});
