/** @vitest-environment happy-dom */
import { act, startTransition, Suspense } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageFeed } from '../MessageFeed';
import { useWindowedFeedScroll } from '../useWindowedFeedScroll';
import {
  ScrollNavigationIntent,
  type UseWindowedFeedScrollOptions,
  type WindowedFeedScrollHandle,
} from '../windowed-feed-scroll-shared';
import type { MessageFeedPolicy } from '../message-feed.types';

let scroll: WindowedFeedScrollHandle;
let itemHeight = 50;
let width = 200;
let viewportHeight = 100;
let resize: () => void;
const getId = (id: number) => id;
const renderMessage = (id: number) => <div data-message-id={id}>message {id}</div>;

const historyPolicy: MessageFeedPolicy = {
  initialPosition: 'start',
  followAtBottom: false,
  aboveLoadBufferPx: 480,
  belowLoadBufferPx: 480,
  atBottomThresholdPx: 25,
  underfilledEdgeLoading: false,
  deferResizeWhileLoadingBelow: false,
};

function TestFeed({
  ids,
  resetKey = 'one',
  options,
  suspend,
}: {
  ids: number[];
  resetKey?: string;
  options?: Partial<UseWindowedFeedScrollOptions>;
  suspend?: Promise<never>;
}) {
  scroll = useWindowedFeedScroll({
    itemIds: ids,
    loadingOlder: false,
    hasReachedStart: true,
    onLoadOlder: () => undefined,
    autoScrollAllowed: false,
    resetKey,
    ...options,
  });
  if (suspend) throw suspend;
  if (ids.length === 0) return <div>No messages</div>;
  return (
    <MessageFeed scroll={scroll} items={ids} getMessageId={getId} renderMessage={renderMessage} />
  );
}

function bounds(top: number, height: number): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    width,
    left: 0,
    right: width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('MessageFeed integration — https://github.com/echoua/echo/issues/3689', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    itemHeight = 50;
    width = 200;
    viewportHeight = 100;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const callbacks = new Set<ResizeObserverCallback>();
    vi.stubGlobal(
      'ResizeObserver',
      class {
        constructor(private callback: ResizeObserverCallback) {
          callbacks.add(callback);
        }
        observe() {}
        disconnect() {
          callbacks.delete(this.callback);
        }
      },
    );
    resize = () => callbacks.forEach((callback) => callback([], {} as ResizeObserver));
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => viewportHeight);
    vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(function () {
      const spacer = this.querySelector<HTMLElement>('[data-direct-message-anchor-spacer]');
      return (
        this.querySelectorAll('[data-message-id]').length * itemHeight +
        Number.parseFloat(spacer?.style.height ?? '0')
      );
    });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const scroller = this.closest<HTMLElement>('[data-message-feed-scroller]');
      if (!scroller || this === scroller) return bounds(0, 100);
      const items = Array.from(scroller.querySelectorAll('[data-message-id]'));
      const index = items.indexOf(this);
      return bounds(index < 0 ? 0 : index * itemHeight - scroller.scrollTop, itemHeight);
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('preserves the reading card through prepend and viewport resize', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => root.render(<TestFeed ids={[-1, 0, 1, 2, 3, 4]} />));
    const anchor = container.querySelector<HTMLElement>('[data-message-id="2"]')!;
    expect(anchor.getBoundingClientRect().top).toBe(-1);
    await act(async () => {
      width = 100;
      itemHeight = 100;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      resize();
    });
    expect(anchor.getBoundingClientRect().top).toBe(-1);
  });

  it('cancels a deferred navigation when the feed is replaced', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const onLanded = vi.fn();
    let current = true;
    await act(async () => {
      scroll.scrollToBottom('smooth', ScrollNavigationIntent.Explicit, {
        feedId: 'one',
        generation: 1,
        targetId: 4,
        isCurrent: () => current,
        onLanded,
        onUnavailable: vi.fn(),
      });
      current = false;
      root.render(<TestFeed ids={[5, 6, 7, 8]} resetKey="two" />);
    });
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 27;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 550));
    });
    expect(scroller.scrollTop).toBe(27);
    expect(onLanded).not.toHaveBeenCalled();
  });

  it('verifies nonanimated explicit landing only after pending window layout settles', async () => {
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} />));
    const onLanded = vi.fn();
    await act(async () => {
      scroll.scrollToBottom('auto', ScrollNavigationIntent.Explicit, {
        feedId: 'one',
        generation: 1,
        targetId: 4,
        isCurrent: () => true,
        onLanded,
        onUnavailable: vi.fn(),
      });
      expect(onLanded).not.toHaveBeenCalled();
      root.render(<TestFeed ids={[2, 3, 4, 5]} />);
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    expect(onLanded).toHaveBeenCalledTimes(1);
    expect(scroll.scrollerRef.current!.scrollTop).toBe(200);
  });

  it('measures committed message ids while a replacement render is suspended', async () => {
    const onAnchorSnapshotChange = vi.fn();
    const options = { onAnchorSnapshotChange };
    await act(async () =>
      root.render(
        <Suspense fallback={<div>Loading</div>}>
          <TestFeed ids={[1, 2, 3, 4]} options={options} />
        </Suspense>,
      ),
    );
    const committedScroll = scroll;
    await act(async () => {
      startTransition(() =>
        root.render(
          <Suspense fallback={<div>Loading</div>}>
            <TestFeed ids={[2, 3, 4, 5]} options={options} suspend={new Promise(() => {})} />
          </Suspense>,
        ),
      );
    });
    expect(container.querySelector('[data-message-id="1"]')).not.toBeNull();
    expect(container.querySelector('[data-message-id="5"]')).toBeNull();
    await act(async () => committedScroll.scrollToBottom('auto', ScrollNavigationIntent.Explicit));
    expect(onAnchorSnapshotChange.mock.lastCall?.[0]?.itemIds).toEqual([1, 2, 3, 4]);
  });

  it('starts at the leading edge and does not follow an appended history page', async () => {
    const options = { policy: historyPolicy };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4, 5, 6]} options={options} />));
    expect(scroller.scrollTop).toBe(51);
  });

  it('binds underfilled history input when the first response mounts the viewport', async () => {
    const onLoadOlder = vi.fn();
    const options = {
      policy: { ...historyPolicy, underfilledEdgeLoading: true },
      hasReachedStart: false,
      onLoadOlder,
    };
    await act(async () => root.render(<TestFeed ids={[]} options={options} />));
    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    onLoadOlder.mockClear();
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
    });
    expect(onLoadOlder).toHaveBeenCalledTimes(1);
  });

  it('does not fetch a page when a hidden tab becomes eligible for prefetch', async () => {
    const onLoadNewer = vi.fn();
    const options = {
      policy: { ...historyPolicy, belowLoadStrategy: 'immediate' as const },
      loadEdgesOnLayout: true,
      onLoadNewer,
      unreadPrefetchNeeded: false,
    };
    await act(async () => root.render(<TestFeed ids={[1]} options={options} />));
    await act(async () => {
      viewportHeight = 0;
      width = 0;
      root.render(<TestFeed ids={[1]} options={{ ...options, unreadPrefetchNeeded: true }} />);
    });
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('preserves the leading edge on refresh, but a message anchor while reading history', async () => {
    let capture: (() => void) | null = null;
    const options = {
      policy: historyPolicy,
      onViewportCaptureChange: (callback: (() => void) | null) => {
        capture = callback;
      },
    };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(capture).not.toBeNull();
    capture!();
    await act(async () =>
      root.render(
        <TestFeed ids={[-1, 0, 1, 2, 3, 4]} options={{ ...options, viewportPreservationKey: 1 }} />,
      ),
    );
    expect(scroller.scrollTop).toBe(0);
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: 80 }));
      scroller.scrollTop = 151;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    capture!();
    await act(async () =>
      root.render(
        <TestFeed
          ids={[-3, -2, -1, 0, 1, 2, 3, 4]}
          options={{ ...options, viewportPreservationKey: 2 }}
        />,
      ),
    );
    expect(container.querySelector('[data-message-id="2"]')!.getBoundingClientRect().top).toBe(-1);
  });

  it('centers a boundary target with a spacer and releases retention on wheel input', async () => {
    const release = vi.fn();
    const focus = { messageId: 4, active: true, onRelease: release };
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ policy: historyPolicy, focus }} />),
    );
    const target = container.querySelector('[data-message-id="4"]')!;
    expect(target.getBoundingClientRect().top).toBe(25);
    expect(
      container.querySelector<HTMLElement>('[data-direct-message-anchor-spacer]')?.style.height,
    ).toBe('25px');
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
      scroll.scrollerRef.current!.scrollTop = 25;
      scroll.scrollerRef.current!.dispatchEvent(new Event('scroll', { bubbles: true }));
      resize();
    });
    expect(release).toHaveBeenCalledTimes(1);
    expect(scroll.scrollerRef.current!.scrollTop).toBe(25);
    expect(scroll.bottomSpacerPx).toBe(0);
  });

  it('aligns a loaded page boundary without fetching or retaining the old focus', async () => {
    const onLoadNewer = vi.fn();
    const onAligned = vi.fn();
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ policy: historyPolicy, onLoadNewer }} />),
    );
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4]}
          options={{
            policy: historyPolicy,
            onLoadNewer,
            navigationTarget: { messageId: 3, alignment: 'start', onAligned },
          }}
        />,
      ),
    );
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    expect(container.querySelector('[data-message-id="3"]')!.getBoundingClientRect().top).toBe(0);
    expect(onAligned).toHaveBeenCalledTimes(1);
    expect(onLoadNewer).not.toHaveBeenCalled();
  });

  it('removes surplus boundary space after released focus gains real messages below', async () => {
    const options = {
      policy: historyPolicy,
      focus: { messageId: 4, active: true },
    };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    expect(scroll.bottomSpacerPx).toBe(25);
    await act(async () => {
      scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -80 }));
    });
    const previousTop = scroller.scrollTop;
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4, 5, 6]}
          options={{ ...options, focus: { messageId: 4, active: false } }}
        />,
      ),
    );
    expect(scroll.bottomSpacerPx).toBe(0);
    expect(scroller.scrollTop).toBe(previousTop);
  });

  it('preserves a history reading anchor when a card resizes during a below-page request', async () => {
    const options = { policy: historyPolicy };
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    const scroller = scroll.scrollerRef.current!;
    await act(async () => {
      scroller.scrollTop = 51;
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
    });
    await act(async () =>
      root.render(<TestFeed ids={[1, 2, 3, 4]} options={{ ...options, loadingNewer: true }} />),
    );
    await act(async () => {
      itemHeight = 100;
      resize();
    });
    expect(container.querySelector('[data-message-id="2"]')!.getBoundingClientRect().top).toBe(-1);
  });

  it('waits for usable viewport geometry before recentering a responsive hidden feed', async () => {
    await act(async () =>
      root.render(
        <TestFeed
          ids={[1, 2, 3, 4]}
          options={{ policy: historyPolicy, focus: { messageId: 4, active: true } }}
        />,
      ),
    );
    const previousTop = scroll.scrollerRef.current!.scrollTop;
    await act(async () => {
      width = 0;
      itemHeight = 10000;
      resize();
    });
    expect(scroll.scrollerRef.current!.scrollTop).toBe(previousTop);
    await act(async () => {
      width = 100;
      itemHeight = 100;
      resize();
    });
    expect(container.querySelector('[data-message-id="4"]')!.getBoundingClientRect().top).toBe(0);
  });

  it('releases focus after the first response mounts a previously empty viewport', async () => {
    const release = vi.fn();
    const options = {
      policy: historyPolicy,
      focus: { messageId: 4, active: true, onRelease: release },
    };
    await act(async () => root.render(<TestFeed ids={[]} options={options} />));
    await act(async () => root.render(<TestFeed ids={[1, 2, 3, 4]} options={options} />));
    await act(async () => {
      scroll.scrollerRef.current!.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, deltaY: -80 }),
      );
    });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
