/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useFeedIdleViewportOffload } from '../useFeedIdleViewportOffload';

function Harness({
  enabled,
  itemIds,
  idleMs,
  onSnapshot,
}: {
  enabled: boolean;
  itemIds: number[];
  idleMs: number;
  onSnapshot: (value: {
    offloadActive: boolean;
    mountedCount: number | null;
    mountedIds: number[] | null;
    hasPlaceholderHeight: boolean;
  }) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const offload = useFeedIdleViewportOffload({
    enabled,
    scrollerRef,
    itemIds,
    idleMs,
    overscanPx: 0,
  });
  onSnapshot({
    offloadActive: offload.offloadActive,
    mountedCount: offload.mountedItemIds?.size ?? null,
    mountedIds:
      offload.mountedItemIds != null ? [...offload.mountedItemIds].sort((a, b) => a - b) : null,
    hasPlaceholderHeight: offload.placeholderHeightPx(itemIds[0] ?? 0) > 0,
  });
  return (
    <div
      ref={scrollerRef}
      data-testid="scroller"
      style={{ height: 100, overflow: 'auto', position: 'relative' }}
    >
      {itemIds.map((id, index) => (
        <div
          key={id}
          data-duty-message-id={String(id)}
          style={{ height: 50, marginTop: index === 0 ? 0 : 0 }}
        >
          card-{id}
        </div>
      ))}
    </div>
  );
}

// @test-scope safeguard: prevents offscreen feed cards from being reactivated before their viewport state is current.
describe('useFeedIdleViewportOffload', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: {
    offloadActive: boolean;
    mountedCount: number | null;
    mountedIds: number[] | null;
    hasPlaceholderHeight: boolean;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = {
      offloadActive: false,
      mountedCount: null,
      mountedIds: null,
      hasPlaceholderHeight: false,
    };
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
    vi.useRealTimers();
  });

  it('offloads off-viewport cards after the idle timeout', async () => {
    await act(async () => {
      root.render(
        <Harness
          enabled
          itemIds={[1, 2, 3, 4]}
          idleMs={10_000}
          onSnapshot={(value) => {
            latest = value;
          }}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    // Only the first two 50px rows fit in the 100px scroller.
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }),
    });
    scroller.querySelectorAll<HTMLElement>('[data-duty-message-id]').forEach((node, index) => {
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 50 });
      Object.defineProperty(node, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: index * 50,
          bottom: index * 50 + 50,
          left: 0,
          right: 100,
          width: 100,
          height: 50,
          x: 0,
          y: index * 50,
          toJSON() {},
        }),
      });
    });

    expect(latest.offloadActive).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });

    expect(latest.offloadActive).toBe(true);
    expect(latest.mountedCount).toBe(2);
    expect(latest.hasPlaceholderHeight).toBe(true);
  });

  // @test-scope safeguard: prevents follow scrolling from leaving the visible duty cards unmounted
  it('refreshes mounted ids on programmatic scroll without waking', async () => {
    await act(async () => {
      root.render(
        <Harness
          enabled
          itemIds={[1, 2, 3, 4]}
          idleMs={10_000}
          onSnapshot={(value) => {
            latest = value;
          }}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }),
    });
    const layoutRows = (scrollTop: number) => {
      scroller.querySelectorAll<HTMLElement>('[data-duty-message-id]').forEach((node, index) => {
        const top = index * 50 - scrollTop;
        Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 50 });
        Object.defineProperty(node, 'getBoundingClientRect', {
          configurable: true,
          value: () => ({
            top,
            bottom: top + 50,
            left: 0,
            right: 100,
            width: 100,
            height: 50,
            x: 0,
            y: top,
            toJSON() {},
          }),
        });
      });
    };
    layoutRows(0);

    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(latest.offloadActive).toBe(true);
    expect(latest.mountedIds).toEqual([1, 2]);

    // Stick-bottom / follow ease moves scrollTop without pointer/wheel wake.
    layoutRows(100);
    await act(async () => {
      scroller.dispatchEvent(new Event('scroll', { bubbles: true }));
      vi.advanceTimersByTime(16);
    });

    expect(latest.offloadActive).toBe(true);
    expect(latest.mountedIds).toEqual([3, 4]);
  });

  it('wakes and remounts on pointer interaction', async () => {
    await act(async () => {
      root.render(
        <Harness
          enabled
          itemIds={[1, 2, 3]}
          idleMs={5_000}
          onSnapshot={(value) => {
            latest = value;
          }}
        />,
      );
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }),
    });
    scroller.querySelectorAll<HTMLElement>('[data-duty-message-id]').forEach((node, index) => {
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 80 });
      Object.defineProperty(node, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: index * 80,
          bottom: index * 80 + 80,
          left: 0,
          right: 100,
          width: 100,
          height: 80,
          x: 0,
          y: index * 80,
          toJSON() {},
        }),
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(latest.offloadActive).toBe(true);

    await act(async () => {
      scroller.dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(latest.offloadActive).toBe(false);
    expect(latest.mountedCount).toBeNull();
  });

  it('exposes imperative wakeFromOffload for scroll FAB / arrow', async () => {
    let wakeFromOffload: (() => void) | null = null;
    function ImperativeHarness() {
      const scrollerRef = useRef<HTMLDivElement | null>(null);
      const offload = useFeedIdleViewportOffload({
        enabled: true,
        scrollerRef,
        itemIds: [1, 2, 3, 4],
        idleMs: 5_000,
        overscanPx: 0,
      });
      wakeFromOffload = offload.wakeFromOffload;
      latest = {
        offloadActive: offload.offloadActive,
        mountedCount: offload.mountedItemIds?.size ?? null,
        mountedIds:
          offload.mountedItemIds != null ? [...offload.mountedItemIds].sort((a, b) => a - b) : null,
        hasPlaceholderHeight: offload.placeholderHeightPx(1) > 0,
      };
      return (
        <div
          ref={scrollerRef}
          data-testid="scroller"
          style={{ height: 100, overflow: 'auto', position: 'relative' }}
        >
          {[1, 2, 3, 4].map((id) => (
            <div key={id} data-duty-message-id={String(id)} style={{ height: 50 }}>
              card-{id}
            </div>
          ))}
        </div>
      );
    }

    await act(async () => {
      root.render(<ImperativeHarness />);
    });

    const scroller = container.querySelector('[data-testid="scroller"]') as HTMLElement;
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      configurable: true,
      value: () => ({
        top: 0,
        bottom: 100,
        left: 0,
        right: 100,
        width: 100,
        height: 100,
        x: 0,
        y: 0,
        toJSON() {},
      }),
    });
    scroller.querySelectorAll<HTMLElement>('[data-duty-message-id]').forEach((node, index) => {
      Object.defineProperty(node, 'offsetHeight', { configurable: true, value: 50 });
      Object.defineProperty(node, 'getBoundingClientRect', {
        configurable: true,
        value: () => ({
          top: index * 50,
          bottom: index * 50 + 50,
          left: 0,
          right: 100,
          width: 100,
          height: 50,
          x: 0,
          y: index * 50,
          toJSON() {},
        }),
      });
    });

    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(latest.offloadActive).toBe(true);
    expect(latest.mountedCount).toBe(2);

    await act(async () => {
      wakeFromOffload?.();
    });
    expect(latest.offloadActive).toBe(false);
    expect(latest.mountedCount).toBeNull();
  });

  it('does not arm when disabled', async () => {
    await act(async () => {
      root.render(
        <Harness
          enabled={false}
          itemIds={[1, 2]}
          idleMs={1_000}
          onSnapshot={(value) => {
            latest = value;
          }}
        />,
      );
    });
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(latest.offloadActive).toBe(false);
    expect(latest.mountedCount).toBeNull();
  });
});
