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
  onFlushPendingNewer?: () => void;
  loadingOlder?: boolean;
  loadingNewer?: boolean;
  hasReachedStart?: boolean;
  onNearBottomChange?: (near: boolean) => void;
  onAtBottomChange?: (atBottom: boolean) => void;
  onPhysicalBottomChange?: (atBottom: boolean) => void;
  onReachedBottom?: (context: { hasSeenNotAtBottom: boolean }) => boolean | void;
  onLeftBottom?: () => void;
  onVisibleMessageIds?: (lastVisibleId: number, opts?: { atBottom?: boolean }) => void;
  enabled?: boolean;
  isWatchMode?: boolean;
  unreadPrefetchNeeded?: boolean;
  pendingNewerFlushNeeded?: boolean;
  itemHeightPx?: number;
  bottomLoadBufferPx?: number;
}) {
  const scroll = useWindowedFeedScroll({
    itemIds: props.ids,
    loadingOlder: props.loadingOlder ?? false,
    loadingNewer: props.loadingNewer ?? false,
    hasReachedStart: props.hasReachedStart ?? false,
    onLoadOlder: props.onLoadOlder ?? vi.fn(),
    onLoadNewer: props.onLoadNewer,
    onFlushPendingNewer: props.onFlushPendingNewer,
    onNearBottomChange: props.onNearBottomChange,
    onAtBottomChange: props.onAtBottomChange,
    onPhysicalBottomChange: props.onPhysicalBottomChange,
    onReachedBottom: props.onReachedBottom,
    onLeftBottom: props.onLeftBottom,
    onVisibleMessageIds: props.onVisibleMessageIds,
    enabled: props.enabled ?? true,
    isWatchMode: props.isWatchMode ?? true,
    unreadPrefetchNeeded: props.unreadPrefetchNeeded,
    pendingNewerFlushNeeded: props.pendingNewerFlushNeeded,
    topLoadBufferPx: 80,
    bottomLoadBufferPx: props.bottomLoadBufferPx ?? 80,
    atBottomThresholdPx: 10,
  });
  latestScrollHandle = scroll;
  const itemHeightPx = props.itemHeightPx ?? 50;

  return (
    <div
      ref={scroll.scrollerRef}
      data-testid="scroller"
      onScroll={scroll.handleScroll}
      style={{ height: 100, overflowY: 'auto' }}
    >
      {props.loadingOlder ? <div data-testid="top-status">loading</div> : null}
      <div ref={scroll.listRef} data-testid="list">
        {props.ids.map((id) => {
          const itemRef = scroll.setItemRef(id);
          renderedItemRefs.set(id, itemRef);
          return (
            <div key={id} ref={itemRef} data-testid={`item-${id}`} style={{ height: itemHeightPx }}>
              item {id}
            </div>
          );
        })}
      </div>
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

async function flushLoadNewerIdle(): Promise<void> {
  await act(async () => {
    await waitForAnimationFrame();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 160);
    });
  });
}

type ItemLayout = { top: number; height: number };

function rect(top: number, height: number): DOMRect {
  return {
    bottom: top + height,
    height,
    left: 0,
    right: 100,
    top,
    width: 100,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

function mockVerticalLayout(
  scroller: HTMLElement,
  layout: { items: Map<number, ItemLayout> },
  scale = 1,
): void {
  const originalGetBoundingClientRect = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
    if (this === scroller) return rect(0, scroller.clientHeight * scale);
    const id = Number.parseInt(
      (this as HTMLElement).dataset.testid?.replace('item-', '') ?? '',
      10,
    );
    const item = layout.items.get(id);
    if (item) return rect((item.top - scroller.scrollTop) * scale, item.height * scale);
    return originalGetBoundingClientRect.call(this);
  });
}

function installResizeObserverMock() {
  const observers: Array<{
    callback: ResizeObserverCallback;
    disconnected: boolean;
    observed: Set<Element>;
    observer: ResizeObserver;
  }> = [];

  class ResizeObserverMock {
    private readonly record;

    constructor(callback: ResizeObserverCallback) {
      this.record = {
        callback,
        disconnected: false,
        observed: new Set<Element>(),
        observer: this as unknown as ResizeObserver,
      };
      observers.push(this.record);
    }

    observe = (target: Element) => this.record.observed.add(target);
    unobserve = (target: Element) => this.record.observed.delete(target);
    disconnect = () => {
      this.record.disconnected = true;
      this.record.observed.clear();
    };
  }

  vi.stubGlobal('ResizeObserver', ResizeObserverMock);
  return (target: Element) => {
    observers.forEach((entry) => {
      if (!entry.disconnected && entry.observed.has(target)) {
        entry.callback([], entry.observer);
      }
    });
  };
}

function createItemLayouts(ids: number[], startTop = 0, height = 50): Map<number, ItemLayout> {
  return new Map(ids.map((id, index) => [id, { top: startTop + index * height, height }]));
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
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
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

  it('resets bottom state when the feed becomes disabled without cancelling follow', async () => {
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
    expect(onLeftBottom).not.toHaveBeenCalled();

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

  it('resets bottom state on unmount without cancelling follow', async () => {
    const onPhysicalBottomChange = vi.fn();
    const onNearBottomChange = vi.fn();
    const onAtBottomChange = vi.fn();
    const onLeftBottom = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          onPhysicalBottomChange={onPhysicalBottomChange}
          onNearBottomChange={onNearBottomChange}
          onAtBottomChange={onAtBottomChange}
          onLeftBottom={onLeftBottom}
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

    await act(async () => {
      root.unmount();
    });

    expect(onPhysicalBottomChange).toHaveBeenCalledWith(false);
    expect(onNearBottomChange).toHaveBeenCalledWith(false);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    expect(onLeftBottom).not.toHaveBeenCalled();
  });

  it('does not cancel follow across disable and re-enable until an upward scroll', async () => {
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
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} enabled={false} onLeftBottom={onLeftBottom} />);
    });
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLeftBottom={onLeftBottom} />);
    });
    expect(onLeftBottom).not.toHaveBeenCalled();

    setScrollMetrics(scroller, { scrollTop: 190, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLeftBottom).toHaveBeenCalledTimes(1);
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
    expect(onLoadNewer).not.toHaveBeenCalled();
    await flushLoadNewerIdle();

    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('defers near-bottom newer loads until scroll is idle', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLoadNewer={onLoadNewer} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLoadNewer).not.toHaveBeenCalled();

    // Keep flinging — idle timer should keep resetting.
    setScrollMetrics(scroller, { scrollTop: 140, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    });
    expect(onLoadNewer).not.toHaveBeenCalled();

    await flushLoadNewerIdle();
    expect(onLoadNewer).toHaveBeenCalledTimes(1);
  });

  it('flushes pending newer pages only after scroll idle near bottom', async () => {
    const onFlushPendingNewer = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          unreadPrefetchNeeded={false}
          onFlushPendingNewer={onFlushPendingNewer}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    // Near-bottom zone, not physical bottom (distance ~70 with buffer 80).
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    onFlushPendingNewer.mockClear();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          pendingNewerFlushNeeded
          unreadPrefetchNeeded={false}
          onFlushPendingNewer={onFlushPendingNewer}
        />,
      );
    });
    expect(onFlushPendingNewer).not.toHaveBeenCalled();

    setScrollMetrics(scroller, { scrollTop: 140, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
    });
    expect(onFlushPendingNewer).not.toHaveBeenCalled();

    await flushLoadNewerIdle();
    expect(onFlushPendingNewer).toHaveBeenCalledTimes(1);
  });

  it('flushes pending newer pages immediately at physical bottom', async () => {
    const onFlushPendingNewer = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          unreadPrefetchNeeded={false}
          onFlushPendingNewer={onFlushPendingNewer}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 200, clientHeight: 100, scrollHeight: 300 });
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    onFlushPendingNewer.mockClear();

    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4]}
          pendingNewerFlushNeeded
          unreadPrefetchNeeded={false}
          onFlushPendingNewer={onFlushPendingNewer}
        />,
      );
    });

    expect(onFlushPendingNewer).toHaveBeenCalled();
  });
  it('cancels a pending idle newer load when the scroller unmounts', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(<TestScroller ids={[1, 2, 3, 4]} onLoadNewer={onLoadNewer} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLoadNewer).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    await flushLoadNewerIdle();

    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('does not call onLoadNewer near bottom when unread prefetch runway is already full', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2, 3, 4]} onLoadNewer={onLoadNewer} unreadPrefetchNeeded={false} />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });

    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('cancels a pending idle newer load when unread prefetch becomes unnecessary', async () => {
    const onLoadNewer = vi.fn();
    await act(async () => {
      root.render(
        <TestScroller ids={[1, 2, 3, 4]} onLoadNewer={onLoadNewer} unreadPrefetchNeeded />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 130, clientHeight: 100, scrollHeight: 300 });

    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLoadNewer).not.toHaveBeenCalled();

    // Concurrent physical-bottom load fills the runway before the idle timer fires.
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4, 5, 6]}
          loadingNewer
          onLoadNewer={onLoadNewer}
          unreadPrefetchNeeded={false}
        />,
      );
    });
    await act(async () => {
      root.render(
        <TestScroller
          ids={[1, 2, 3, 4, 5, 6]}
          onLoadNewer={onLoadNewer}
          unreadPrefetchNeeded={false}
        />,
      );
    });

    await flushLoadNewerIdle();
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('expands the bottom load buffer when unread prefetch is needed, but not unboundedly', async () => {
    const onLoadNewer = vi.fn();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const itemHeight = 400;
    const metrics = {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 20 * itemHeight,
    };
    setClampedScrollMetrics(scroller, metrics);
    const layout = {
      items: new Map(ids.map((id, index) => [id, { top: index * itemHeight, height: itemHeight }])),
    };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(
        <TestScroller
          ids={ids}
          onLoadNewer={onLoadNewer}
          unreadPrefetchNeeded
          bottomLoadBufferPx={80}
        />,
      );
    });

    // Leave the initial bottom pin; sit beyond the expanded prefetch buffer.
    scroller.scrollTop = metrics.scrollHeight - metrics.clientHeight - 450;
    onLoadNewer.mockClear();
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLoadNewer).not.toHaveBeenCalled();

    // Move into the expanded prefetch buffer (distance 120 <= 160).
    scroller.scrollTop = metrics.scrollHeight - metrics.clientHeight - 120;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    expect(onLoadNewer).not.toHaveBeenCalled();
    await flushLoadNewerIdle();
    expect(onLoadNewer).toHaveBeenCalled();
  });

  it('does not treat a multi-thousand-px trailing message span as near-bottom', async () => {
    const onLoadNewer = vi.fn();
    const ids = Array.from({ length: 20 }, (_, index) => index + 1);
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const itemHeight = 400;
    const metrics = {
      scrollTop: 0,
      clientHeight: 100,
      scrollHeight: 20 * itemHeight,
    };
    setClampedScrollMetrics(scroller, metrics);
    const layout = {
      items: new Map(ids.map((id, index) => [id, { top: index * itemHeight, height: itemHeight }])),
    };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(
        <TestScroller
          ids={ids}
          onLoadNewer={onLoadNewer}
          unreadPrefetchNeeded
          bottomLoadBufferPx={80}
        />,
      );
    });

    // Same shape as the production bug: ~3100px from the end while still in the last tall rows.
    scroller.scrollTop = 12 * itemHeight;
    onLoadNewer.mockClear();
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    expect(metrics.scrollHeight - metrics.clientHeight - scroller.scrollTop).toBe(3100);
    expect(onLoadNewer).not.toHaveBeenCalled();
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

  it('scrolls directly to a message without enabling bottom follow', async () => {
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 200 });
    mockVerticalLayout(scroller, { items: createItemLayouts(ids) });
    await act(async () => {
      root.render(<TestScroller ids={ids} isWatchMode={false} />);
    });

    const targetElement = container.querySelector('[data-testid="item-3"]') as HTMLElement;
    const target = latestScrollHandle?.scrollToItem(3);

    expect(target).toBe(targetElement);
    expect(scroller.scrollTop).toBe(75);

    scroller.scrollTop = 125;
    await act(async () => {
      await waitForAnimationFrame();
    });
    expect(scroller.scrollTop).toBe(75);
  });

  it('compensates the narrow-screen zoom when centering a message', async () => {
    const ids = Array.from({ length: 30 }, (_, index) => index + 1);
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    setScrollMetrics(scroller, { scrollTop: 0, clientHeight: 100, scrollHeight: 1500 });
    mockVerticalLayout(scroller, { items: createItemLayouts(ids) }, 1.125);
    await act(async () => {
      root.render(<TestScroller ids={ids} isWatchMode={false} />);
    });

    latestScrollHandle?.scrollToItem(21);

    expect(scroller.scrollTop).toBe(975);
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

  it('uses the latest scroll position when a newer window commits before the next frame', async () => {
    const initialIds = [1, 2, 3, 4, 5, 6];
    const nextIds = [3, 4, 5, 6, 7, 8];
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 300 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={initialIds} />);
    });
    expect(scroller.scrollTop).toBe(200);

    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    scroller.scrollTop = 125;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));

    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(<TestScroller ids={nextIds} />);
    });

    expect(scroller.scrollTop).toBe(25);
    expect(
      (container.querySelector('[data-testid="item-3"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(-25);
  });

  it('preserves the old bottom anchor when pending newer messages finish loading', async () => {
    const initialIds = [1, 2, 3, 4];
    const nextIds = [1, 2, 3, 4, 5, 6];
    const onReachedBottom = vi.fn(() => false);
    await act(async () => {
      root.render(<TestScroller ids={[]} onReachedBottom={onReachedBottom} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 200 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={initialIds} onReachedBottom={onReachedBottom} />);
    });
    scroller.scrollTop = 50;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    scroller.scrollTop = 100;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 300;
    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(<TestScroller ids={nextIds} onReachedBottom={onReachedBottom} />);
    });

    expect(onReachedBottom).toHaveBeenLastCalledWith({ hasSeenNotAtBottom: true });
    expect(scroller.scrollTop).toBe(100);
  });

  it('preserves the visible anchor when the top loading status changes', async () => {
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 200 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(ids) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={ids} />);
    });
    scroller.scrollTop = 50;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 240;
    layout.items = createItemLayouts(ids, 40);
    await act(async () => {
      root.render(<TestScroller ids={ids} loadingOlder />);
    });

    expect(scroller.scrollTop).toBe(90);
    expect(
      (container.querySelector('[data-testid="item-2"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(0);
  });

  it('preserves a pending top status change when a hidden feed is re-enabled', async () => {
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} loadingOlder />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 240 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(ids, 40) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={ids} loadingOlder />);
    });
    scroller.scrollTop = 91;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    await act(async () => {
      root.render(<TestScroller ids={ids} loadingOlder enabled={false} />);
    });
    metrics.scrollHeight = 200;
    layout.items = createItemLayouts(ids);
    await act(async () => {
      root.render(<TestScroller ids={ids} enabled={false} />);
    });
    await act(async () => {
      root.render(<TestScroller ids={ids} />);
    });

    expect(scroller.scrollTop).toBe(51);
    expect(
      (container.querySelector('[data-testid="item-2"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(-1);
  });

  it('preserves the visible anchor when a rendered card changes height later', async () => {
    const triggerResize = installResizeObserverMock();
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 200 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(ids) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={ids} />);
    });
    scroller.scrollTop = 51;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 230;
    layout.items = new Map([
      [1, { top: 0, height: 80 }],
      [2, { top: 80, height: 50 }],
      [3, { top: 130, height: 50 }],
      [4, { top: 180, height: 50 }],
    ]);
    act(() => triggerResize(container.querySelector('[data-testid="list"]')!));

    expect(scroller.scrollTop).toBe(81);
    expect(
      (container.querySelector('[data-testid="item-2"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(-1);
  });

  it('keeps live follow pinned to the bottom after a later card resize', async () => {
    const triggerResize = installResizeObserverMock();
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 200 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(ids) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={ids} />);
    });
    scroller.scrollTop = 50;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));
    scroller.scrollTop = 100;
    act(() => scroller.dispatchEvent(new Event('scroll', { bubbles: true })));

    metrics.scrollHeight = 230;
    layout.items = new Map([
      [1, { top: 0, height: 80 }],
      [2, { top: 80, height: 50 }],
      [3, { top: 130, height: 50 }],
      [4, { top: 180, height: 50 }],
    ]);
    act(() => triggerResize(container.querySelector('[data-testid="list"]')!));

    expect(scroller.scrollTop).toBe(130);
  });

  it('reports leaving the bottom when a non-watch list grows without moving its anchor', async () => {
    const triggerResize = installResizeObserverMock();
    const onAtBottomChange = vi.fn();
    const onPhysicalBottomChange = vi.fn();
    const ids = [1, 2, 3, 4];
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 200 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(ids) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(
        <TestScroller
          ids={ids}
          isWatchMode={false}
          onAtBottomChange={onAtBottomChange}
          onPhysicalBottomChange={onPhysicalBottomChange}
        />,
      );
    });
    scroller.scrollTop = 50;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    scroller.scrollTop = 100;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    onAtBottomChange.mockClear();
    onPhysicalBottomChange.mockClear();

    metrics.scrollHeight = 230;
    layout.items = new Map([
      [1, { top: 0, height: 50 }],
      [2, { top: 50, height: 50 }],
      [3, { top: 100, height: 50 }],
      [4, { top: 150, height: 80 }],
    ]);
    act(() => triggerResize(container.querySelector('[data-testid="list"]')!));

    expect(scroller.scrollTop).toBe(100);
    expect(onAtBottomChange).toHaveBeenCalledWith(false);
    expect(onPhysicalBottomChange).toHaveBeenCalledWith(false);
  });

  it('keeps near-bottom non-watch position when a newer window start-trims', async () => {
    const onLeftBottom = vi.fn();
    const initialIds = Array.from({ length: 40 }, (_, index) => index + 1);
    const nextIds = Array.from({ length: 40 }, (_, index) => index + 21);
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} onLeftBottom={onLeftBottom} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 2000 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(
        <TestScroller ids={initialIds} isWatchMode={false} onLeftBottom={onLeftBottom} />,
      );
    });
    // Leave bottom into the near-bottom load buffer (distance 50 with buffer 80).
    scroller.scrollTop = 1850;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });
    onLeftBottom.mockClear();

    metrics.scrollHeight = 2000;
    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(<TestScroller ids={nextIds} isWatchMode={false} onLeftBottom={onLeftBottom} />);
    });

    // Trimmed 20×50px from the start; viewing around former id 38 should stay put.
    expect(scroller.scrollTop).toBe(850);
    expect(
      (container.querySelector('[data-testid="item-38"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(0);
    expect(onLeftBottom).not.toHaveBeenCalled();
  });

  it('restores via first common id when a newer window removes every previously visible id', async () => {
    const initialIds = Array.from({ length: 40 }, (_, index) => index + 1);
    // Slide far enough that prior viewport ids 5-6 are gone; first common is 21.
    const nextIds = Array.from({ length: 40 }, (_, index) => index + 21);
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 2000 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={initialIds} isWatchMode={false} bottomLoadBufferPx={2000} />);
    });
    // Viewport shows ids 5-6 only; those are removed by the slide.
    // Large bottom buffer so the scroll-path takes a full offset snapshot for restore.
    scroller.scrollTop = 200;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 2000;
    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(<TestScroller ids={nextIds} isWatchMode={false} bottomLoadBufferPx={2000} />);
    });

    expect(scroller.scrollTop).toBe(0);
    expect(
      (container.querySelector('[data-testid="item-21"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(0);
  });

  it('keeps full mid-list offsets while a newer load is in flight so a trim can restore', async () => {
    const initialIds = Array.from({ length: 40 }, (_, index) => index + 1);
    const nextIds = Array.from({ length: 40 }, (_, index) => index + 21);
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 2000 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(
        <TestScroller ids={initialIds} isWatchMode={false} loadingNewer bottomLoadBufferPx={80} />,
      );
    });
    // Mid-list: away from both load edges, so only loadingNewer forces a full snapshot.
    scroller.scrollTop = 900;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      // Clear physical-bottom / follow on rAF; snapshot was already synced on scroll.
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 2000;
    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(
        <TestScroller
          ids={nextIds}
          isWatchMode={false}
          loadingNewer={false}
          bottomLoadBufferPx={80}
        />,
      );
    });

    expect(scroller.scrollTop).toBe(0);
    expect(
      (container.querySelector('[data-testid="item-21"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(0);
  });

  it('preserves position when start-trim also clears the reached-start banner', async () => {
    const initialIds = Array.from({ length: 40 }, (_, index) => index + 1);
    const nextIds = Array.from({ length: 40 }, (_, index) => index + 21);
    await act(async () => {
      root.render(<TestScroller ids={[]} isWatchMode={false} hasReachedStart />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    const metrics = { scrollTop: 0, clientHeight: 100, scrollHeight: 2040 };
    setClampedScrollMetrics(scroller, metrics);
    const layout = { items: createItemLayouts(initialIds, 40) };
    mockVerticalLayout(scroller, layout);

    await act(async () => {
      root.render(<TestScroller ids={initialIds} isWatchMode={false} hasReachedStart />);
    });
    scroller.scrollTop = 1890;
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await waitForAnimationFrame();
    });

    metrics.scrollHeight = 2000;
    layout.items = createItemLayouts(nextIds);
    await act(async () => {
      root.render(<TestScroller ids={nextIds} isWatchMode={false} hasReachedStart={false} />);
    });

    expect(scroller.scrollTop).toBe(850);
    expect(
      (container.querySelector('[data-testid="item-38"]') as HTMLElement).getBoundingClientRect()
        .top,
    ).toBe(0);
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
