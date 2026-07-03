/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';

function TestScroller(props: {
  ids: number[];
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  loadingNewer?: boolean;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onVisibleMessageIds?: (ids: number[], opts?: { atBottom?: boolean }) => void;
}) {
  const scroll = useWindowedFeedScroll({
    items: props.ids.map((id) => ({ id })),
    loadingOlder: false,
    loadingNewer: props.loadingNewer ?? false,
    hasReachedStart: false,
    onLoadOlder: props.onLoadOlder ?? vi.fn(),
    onLoadNewer: props.onLoadNewer,
    onNearBottomChange: props.onNearBottomChange,
    onAtBottomChange: props.onAtBottomChange,
    onVisibleMessageIds: props.onVisibleMessageIds,
    topLoadBufferPx: 80,
    bottomLoadBufferPx: 80,
    atBottomThresholdPx: 10,
  });

  return (
    <div
      ref={scroll.scrollerRef}
      data-testid="scroller"
      onScroll={scroll.handleScroll}
      style={{ height: 100, overflowY: 'auto' }}
    >
      {props.ids.map((id) => (
        <div key={id} ref={scroll.setItemRef(id)} data-testid={`item-${id}`} style={{ height: 50 }}>
          item {id}
        </div>
      ))}
      <button type="button" data-testid="scroll-bottom" onClick={() => scroll.scrollToBottom()}>
        bottom
      </button>
    </div>
  );
}

function setScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  Object.defineProperty(el, 'scrollTop', {
    value: metrics.scrollTop,
    writable: true,
    configurable: true,
  });
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', { value: metrics.scrollHeight, configurable: true });
}

async function waitForAnimationFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => resolve());
  });
}

describe('useWindowedFeedScroll', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('calls onLoadOlder when the scroller enters the top load buffer', async () => {
    const onLoadOlder = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLoadOlder={onLoadOlder} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 20, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('reports near-bottom and at-bottom state from DOM scroll metrics', async () => {
    const onNearBottomChange = vi.fn();
    const onAtBottomChange = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onNearBottomChange).toHaveBeenLastCalledWith(true);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
  });

  it('calls onLoadNewer before the scroller reaches the bottom edge', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLoadNewer={onLoadNewer} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('does not repeatedly call onLoadNewer while already loading newer items', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} loadingNewer onLoadNewer={onLoadNewer} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('scrolls to the bottom using the current scroll height', async () => {
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      (container.querySelector('[data-testid="scroll-bottom"]') as HTMLButtonElement).click();
    });

    expect(scroller.scrollTop).toBe(240);
  });

  it('keeps the initial render pinned to bottom while layout height settles', async () => {
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} />);
    });

    expect(scroller.scrollTop).toBe(240);

    Object.defineProperty(scroller, 'scrollHeight', { value: 290, configurable: true });
    await act(async () => {
      await waitForAnimationFrame();
    });

    expect(scroller.scrollTop).toBe(290);
  });
});
