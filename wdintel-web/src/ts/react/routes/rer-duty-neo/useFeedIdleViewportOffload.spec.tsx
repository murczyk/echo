/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useRef } from 'react';
import { useFeedIdleViewportOffload } from './useFeedIdleViewportOffload';

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

describe('useFeedIdleViewportOffload', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: {
    offloadActive: boolean;
    mountedCount: number | null;
    hasPlaceholderHeight: boolean;
  };

  beforeEach(() => {
    vi.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = { offloadActive: false, mountedCount: null, hasPlaceholderHeight: false };
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
