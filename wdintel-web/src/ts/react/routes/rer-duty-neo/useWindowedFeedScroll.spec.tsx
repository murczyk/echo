/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useWindowedFeedScroll } from './useWindowedFeedScroll';

const renderedItemRefs = new Map<number, (node: HTMLDivElement | null) => void>();
let latestScrollHandle: ReturnType<typeof useWindowedFeedScroll> | null = null;

function TestScroller(props: {
  ids: number[];
  onLoadOlder?: () => void;
  onLoadNewer?: () => void;
  loadingNewer?: boolean;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onReachedBottom?: () => void;
  onLeftBottom?: () => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  enabled?: boolean;
}) {
  const scroll = useWindowedFeedScroll({
    itemIds: props.ids,
    loadingOlder: false,
    loadingNewer: props.loadingNewer ?? false,
    hasReachedStart: false,
    onLoadOlder: props.onLoadOlder ?? vi.fn(),
    onLoadNewer: props.onLoadNewer,
    onNearBottomChange: props.onNearBottomChange,
    onAtBottomChange: props.onAtBottomChange,
    onPhysicalBottomChange: props.onPhysicalBottomChange,
    onReachedBottom: props.onReachedBottom,
    onLeftBottom: props.onLeftBottom,
    onVisibleMessageIds: props.onVisibleMessageIds,
    enabled: props.enabled ?? true,
    topLoadBufferPx: 80,
    bottomLoadBufferPx: 80,
    atBottomThresholdPx: 10,
  });
  latestScrollHandle = scroll;

  return (
    <div
      ref={scroll.scrollerRef}
      data-testid="scroller"
      onScroll={scroll.handleScroll}
      style={{ height: 100, overflowY: 'auto' }}
    >
      {props.ids.map((id) => {
        const itemRef = scroll.setItemRef(id);
        renderedItemRefs.set(id, itemRef);
        return (
          <div key={id} ref={itemRef} data-testid={`item-${id}`} style={{ height: 50 }}>
            item {id}
          </div>
        );
      })}
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

function setClampedScrollMetrics(
  el: HTMLElement,
  metrics: { scrollTop: number; clientHeight: number; scrollHeight: number },
) {
  let scrollTop = metrics.scrollTop;
  Object.defineProperty(el, 'clientHeight', { value: metrics.clientHeight, configurable: true });
  Object.defineProperty(el, 'scrollHeight', {
    get: () => metrics.scrollHeight,
    configurable: true,
  });
  Object.defineProperty(el, 'scrollTop', {
    get: () => scrollTop,
    set: (value: number) => {
      const maxScrollTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
      scrollTop = Math.max(0, Math.min(value, maxScrollTop));
    },
    configurable: true,
  });
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
    renderedItemRefs.clear();
    latestScrollHandle = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    renderedItemRefs.clear();
    latestScrollHandle = null;
    vi.useRealTimers();
    act(() => {
      root.unmount();
      container.remove();
      document.body.innerHTML = '';
    });
  });

  it('keeps a disabled zero-sized scroller from reporting visible ids or bottom state', async () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    const onAtBottomChange = vi.fn();
    const onVisibleMessageIds = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2]}
          enabled={false}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 0, scrollHeight: 0 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(onVisibleMessageIds).not.toHaveBeenCalled();
    expect(onAtBottomChange).not.toHaveBeenCalledWith(true);
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('loads older but not newer when the initial pin is underfilled', async () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();

    await act(async () => {
      root.render(<TestScroller ids={[]} onLoadOlder={onLoadOlder} onLoadNewer={onLoadNewer} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setClampedScrollMetrics(scroller, { scrollTop: 0, clientHeight: 300, scrollHeight: 200 });

    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2, 3]} onLoadOlder={onLoadOlder} onLoadNewer={onLoadNewer} />,
      );
    });
    await act(async () => {
      await waitForAnimationFrame();
      await waitForAnimationFrame();
      await waitForAnimationFrame();
    });

    expect(onLoadOlder).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('does not load older or newer while disabled', async () => {
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          enabled={false}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 20, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('cancels active bottom following when the feed becomes disabled', async () => {
    const onPhysicalBottomChange = vi.fn();
    const onNearBottomChange = vi.fn();
    const onAtBottomChange = vi.fn();
    const onLeftBottom = vi.fn();
    const onReachedBottom = vi.fn();
    const onVisibleMessageIds = vi.fn();
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onPhysicalBottomChange={onPhysicalBottomChange}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onLeftBottom={onLeftBottom}
          onReachedBottom={onReachedBottom}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });
    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    onPhysicalBottomChange.mockClear();
    onNearBottomChange.mockClear();
    onAtBottomChange.mockClear();
    onLeftBottom.mockClear();
    onVisibleMessageIds.mockClear();
    onLoadOlder.mockClear();
    onLoadNewer.mockClear();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          enabled={false}
          onPhysicalBottomChange={onPhysicalBottomChange}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onLeftBottom={onLeftBottom}
          onReachedBottom={onReachedBottom}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });
    expect(onPhysicalBottomChange).toHaveBeenCalledWith(false);
    expect(onNearBottomChange).toHaveBeenCalledWith(false);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    expect(onLeftBottom).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4, 5]}
          enabled={false}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
          onPhysicalBottomChange={onPhysicalBottomChange}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onLeftBottom={onLeftBottom}
          onReachedBottom={onReachedBottom}
          onVisibleMessageIds={onVisibleMessageIds}
        />,
      );
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onVisibleMessageIds).not.toHaveBeenCalled();
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onLoadNewer).not.toHaveBeenCalled();

    onReachedBottom.mockClear();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4, 5]}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
          onPhysicalBottomChange={onPhysicalBottomChange}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onLeftBottom={onLeftBottom}
          onReachedBottom={onReachedBottom}
          onVisibleMessageIds={onVisibleMessageIds}
        />,
      );
      setScrollMetrics(scroller, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onReachedBottom).toHaveBeenCalledTimes(1);
    expect(onPhysicalBottomChange).toHaveBeenLastCalledWith(true);
  });

  it('does not clear unread state when hidden items append', async () => {
    const onVisibleMessageIds = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2]} enabled={false} onVisibleMessageIds={onVisibleMessageIds} />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 0, scrollHeight: 0 });

    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2, 3]} enabled={false} onVisibleMessageIds={onVisibleMessageIds} />,
      );
    });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(onVisibleMessageIds).not.toHaveBeenCalled();
  });

  it('cancels delayed visible-message reports when disabled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const onVisibleMessageIds = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2]} onVisibleMessageIds={onVisibleMessageIds} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 100 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(onVisibleMessageIds).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(16);
    });
    expect(onVisibleMessageIds).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2]} enabled={false} onVisibleMessageIds={onVisibleMessageIds} />,
      );
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(onVisibleMessageIds).toHaveBeenCalledTimes(1);
  });

  it('initializes the first activation at bottom and reports normally', async () => {
    const onAtBottomChange = vi.fn();
    const onVisibleMessageIds = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          enabled={false}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(240);
    expect(onAtBottomChange).toHaveBeenLastCalledWith(true);
    expect(onVisibleMessageIds).toHaveBeenLastCalledWith(4, { atBottom: true });
  });

  it('restores bottom state when reopening an unchanged feed without scrolling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const onNearBottomChange = vi.fn();
    const onAtBottomChange = vi.fn();
    const onVisibleMessageIds = vi.fn();
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(240);
    expect(onAtBottomChange).toHaveBeenCalledWith(true);
    expect(onNearBottomChange).toHaveBeenCalledWith(true);
    expect(onVisibleMessageIds).toHaveBeenCalledWith(4, { atBottom: true });

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          enabled={false}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    expect(onNearBottomChange).toHaveBeenCalledWith(false);

    onNearBottomChange.mockClear();
    onAtBottomChange.mockClear();
    onVisibleMessageIds.mockClear();
    await vi.advanceTimersByTimeAsync(250);

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(240);
    expect(onAtBottomChange).toHaveBeenCalledWith(true);
    expect(onNearBottomChange).toHaveBeenCalledWith(true);
    expect(onVisibleMessageIds).toHaveBeenCalledWith(4, { atBottom: true });
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('restores near-bottom reporting when reopening an unchanged feed at a mid-scroll position', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);

    const onNearBottomChange = vi.fn();
    const onAtBottomChange = vi.fn();
    const onVisibleMessageIds = vi.fn();
    const onLoadOlder = vi.fn();
    const onLoadNewer = vi.fn();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 240 });

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    setScrollMetrics(scroller, { scrollTop: 120, clientHeight: 100, scrollHeight: 240 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await vi.advanceTimersByTimeAsync(250);
    });

    expect(onNearBottomChange).toHaveBeenCalledWith(true);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    expect(onVisibleMessageIds).toHaveBeenCalledWith(4, { atBottom: false });

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          enabled={false}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(120);
    expect(onNearBottomChange).toHaveBeenCalledWith(false);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    onLoadOlder.mockClear();
    onLoadNewer.mockClear();

    onNearBottomChange.mockClear();
    onAtBottomChange.mockClear();
    onVisibleMessageIds.mockClear();
    await vi.advanceTimersByTimeAsync(250);

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onVisibleMessageIds={onVisibleMessageIds}
          onLoadOlder={onLoadOlder}
          onLoadNewer={onLoadNewer}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(120);
    expect(onNearBottomChange).toHaveBeenCalledWith(true);
    expect(onVisibleMessageIds).toHaveBeenCalledWith(4, { atBottom: false });
    expect(onLoadOlder).not.toHaveBeenCalled();
    expect(onLoadNewer).not.toHaveBeenCalled();
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

  it('fires the physical bottom transition once after entering from the threshold zone', async () => {
    const onReachedBottom = vi.fn();
    const onPhysicalBottomChange = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onReachedBottom={onReachedBottom}
          onPhysicalBottomChange={onPhysicalBottomChange}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 180, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    setScrollMetrics(scroller, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(onReachedBottom).toHaveBeenCalledTimes(2);
    expect(onPhysicalBottomChange).toHaveBeenLastCalledWith(true);
  });

  it('cancels follow once for repeated upward scroll events', async () => {
    const onLeftBottom = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLeftBottom={onLeftBottom} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    setScrollMetrics(scroller, { scrollTop: 190, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(onLeftBottom).toHaveBeenCalledTimes(1);
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

  it('reuses callbacks for active ids and recreates callbacks after an id leaves the window', async () => {
    const makeIds = (start: number) => Array.from({ length: 40 }, (_, index) => start + index);

    await act(async () => {
      root.render(<TestScroller ids={makeIds(1)} />);
    });

    const initialItem1 = renderedItemRefs.get(1);
    const initialItem2 = renderedItemRefs.get(2);
    expect(initialItem1).toBeDefined();
    expect(initialItem2).toBeDefined();

    await act(async () => {
      root.render(<TestScroller ids={makeIds(2)} />);
    });

    expect(renderedItemRefs.get(2)).toBe(initialItem2);
    expect(latestScrollHandle?.setItemRef(1)).not.toBe(initialItem1);

    await act(async () => {
      root.render(<TestScroller ids={makeIds(41)} />);
    });

    await act(async () => {
      root.render(<TestScroller ids={makeIds(81)} />);
    });

    await act(async () => {
      root.render(<TestScroller ids={makeIds(1)} />);
    });

    expect(renderedItemRefs.get(1)).not.toBe(initialItem1);
    expect(latestScrollHandle?.setItemRef(1)).toBe(renderedItemRefs.get(1));
  });
});
