/**
 * @vitest-environment happy-dom
 */
import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useObservedWidth } from '../use-observed-width';

let observedWidth = 0;
let resizeCallback: ResizeObserverCallback | null = null;

class ResizeObserverMock {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback;
  }

  observe() {}

  disconnect() {}
}

function ObservedWidthHarness({
  attach,
  onWidth,
}: {
  attach: boolean;
  onWidth: (width: number | null) => void;
}) {
  const { ref, width } = useObservedWidth<HTMLDivElement>();

  useEffect(() => onWidth(width), [onWidth, width]);

  return attach ? <div ref={ref} /> : null;
}

describe('useObservedWidth', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    observedWidth = 0;
    resizeCallback = null;
    vi.stubGlobal('ResizeObserver', ResizeObserverMock as unknown as typeof ResizeObserver);
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
      () =>
        ({
          bottom: 0,
          height: 0,
          left: 0,
          right: observedWidth,
          top: 0,
          width: observedWidth,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('publishes the element width and follows ResizeObserver updates', async () => {
    let latest: number | null = null;
    const onWidth = (width: number | null) => {
      latest = width;
    };
    observedWidth = 1280;

    await act(async () => root.render(<ObservedWidthHarness attach onWidth={onWidth} />));
    expect(latest).toBe(1280);

    observedWidth = 704;
    await act(async () => resizeCallback?.([], {} as ResizeObserver));

    expect(latest).toBe(704);
  });

  it('returns null until a measurable element is attached', async () => {
    let latest: number | null | undefined;
    await act(async () =>
      root.render(
        <ObservedWidthHarness
          attach={false}
          onWidth={(width) => {
            latest = width;
          }}
        />,
      ),
    );

    expect(latest).toBeNull();
  });
});
