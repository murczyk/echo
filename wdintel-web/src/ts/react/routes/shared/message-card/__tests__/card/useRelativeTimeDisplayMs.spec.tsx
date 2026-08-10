/**
 * @vitest-environment happy-dom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { messageRenderDistance } from '../../../../rer-duty-neo/utils';
import { useRelativeTimeDisplayMs } from '../../useRelativeTimeDisplayMs';

let intersectionCallback: IntersectionObserverCallback;

class IntersectionObserverMock {
  constructor(callback: IntersectionObserverCallback) {
    intersectionCallback = callback;
  }

  observe = vi.fn();
  unobserve = vi.fn();
  disconnect = vi.fn();
}

function RelativeSeconds({ messageTimestamp }: { messageTimestamp: number }) {
  const [rootRef, displayMs] = useRelativeTimeDisplayMs(Date.now(), messageTimestamp);
  const seconds = displayMs === null ? null : Math.floor((displayMs - messageTimestamp) / 1000);
  return <div ref={rootRef}>{seconds}</div>;
}

function RelativeLabel({
  messageTimestamp,
  onRender,
}: {
  messageTimestamp: number;
  onRender: () => void;
}) {
  onRender();
  const [rootRef, displayMs] = useRelativeTimeDisplayMs(Date.now(), messageTimestamp);
  return (
    <div ref={rootRef}>
      {displayMs === null ? null : messageRenderDistance(messageTimestamp, displayMs)}
    </div>
  );
}

describe('useRelativeTimeDisplayMs', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(8_000);
    vi.stubGlobal('IntersectionObserver', IntersectionObserverMock);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('ticks visible second counters every second', async () => {
    await act(async () => {
      root.render(<RelativeSeconds messageTimestamp={1_000} />);
    });
    await act(async () => {
      intersectionCallback(
        [
          {
            isIntersecting: true,
            target: container.firstElementChild!,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    expect(container.textContent).toBe('7');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(container.textContent).toBe('8');
  });

  it("does not rerender minute labels on another card's second ticks", async () => {
    const onRender = vi.fn();
    await act(async () => {
      root.render(
        <>
          <RelativeSeconds messageTimestamp={1_000} />
          <RelativeLabel messageTimestamp={-62_000} onRender={onRender} />
        </>,
      );
    });
    const [secondsElement, minuteElement] = Array.from(container.children);
    await act(async () => {
      intersectionCallback(
        [secondsElement, minuteElement].map(
          (target) =>
            ({
              isIntersecting: true,
              target,
            }) as IntersectionObserverEntry,
        ),
        {} as IntersectionObserver,
      );
    });

    expect(minuteElement.textContent).toBe('1 хв');
    const rendersBeforeBoundary = onRender.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(49_000);
    });

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeBoundary);
    expect(secondsElement.textContent).toBe('56');
    expect(minuteElement.textContent).toBe('1 хв');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeBoundary + 1);
    expect(minuteElement.textContent).toBe('2 хв');
  });

  it('updates at local midnight during a DST fallback day', async () => {
    vi.stubEnv('TZ', 'America/New_York');
    const messageTimestamp = new Date(2026, 10, 1, 0, 15).getTime();
    vi.setSystemTime(new Date(2026, 10, 1, 23, 45));
    const onRender = vi.fn();

    await act(async () => {
      root.render(<RelativeLabel messageTimestamp={messageTimestamp} onRender={onRender} />);
    });
    await act(async () => {
      intersectionCallback(
        [
          {
            isIntersecting: true,
            target: container.firstElementChild!,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    expect(container.textContent).toBe('24 год');
    const rendersBeforeMidnight = onRender.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(14 * 60 * 1_000 + 59_000);
    });
    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMidnight);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeMidnight + 1);
    expect(container.textContent).toBe('1 дн');
  });

  it('schedules far-future updates in browser-safe chunks', async () => {
    const setTimeoutSpy = vi.spyOn(window, 'setTimeout');
    const onRender = vi.fn();
    const messageTimestamp = Date.now() + 30 * 24 * 60 * 60 * 1_000;

    await act(async () => {
      root.render(<RelativeLabel messageTimestamp={messageTimestamp} onRender={onRender} />);
    });
    await act(async () => {
      intersectionCallback(
        [
          {
            isIntersecting: true,
            target: container.firstElementChild!,
          } as IntersectionObserverEntry,
        ],
        {} as IntersectionObserver,
      );
    });

    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 2_147_000_000);
    const rendersBeforeChunk = onRender.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_147_000_000);
    });

    expect(onRender).toHaveBeenCalledTimes(rendersBeforeChunk);
    expect(vi.getTimerCount()).toBe(1);
  });
});
