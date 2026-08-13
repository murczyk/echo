/**
 * @vitest-environment happy-dom
 */
import { act, useEffect, useRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isDutyScrollDebugEnabled,
  recordDutyScrollDebugEvent,
  recordDutyScrollDebugMetrics,
  registerDutyScrollDebugBellPress,
  setDutyScrollDebugEnabled,
  useDutyScrollDebugFeed,
  type DutyScrollDebugFeedSnapshot,
  type DutyScrollDebugMetrics,
} from './duty-scroll-debug';

function sampleMetrics(overrides: Partial<DutyScrollDebugMetrics> = {}): DutyScrollDebugMetrics {
  return {
    capturedAtMs: 1,
    scrollTop: 0,
    previousScrollTop: 0,
    scrollDelta: 0,
    scrollHeight: 1000,
    clientHeight: 400,
    bottomDistance: 600,
    topLoadBufferPx: 160,
    bottomLoadBufferPx: 640,
    atBottomThresholdPx: 25,
    atTop: false,
    atBottom: false,
    physicallyAtBottom: false,
    nearBottom: true,
    liveBottomFollow: false,
    bottomSettleActive: false,
    loadOlderTriggered: false,
    loadNewerTriggered: false,
    visibleAnchorCount: 0,
    firstVisibleId: null,
    lastVisibleId: null,
    anchorId: null,
    anchorOffsetTop: null,
    itemCount: 0,
    firstItemId: null,
    lastItemId: null,
    enabled: true,
    isWatchMode: false,
    overflowAnchor: 'auto',
    scrollBehavior: 'auto',
    ...overrides,
  };
}

function FeedProbe({
  feedId,
  onUpdate,
}: {
  feedId: string;
  onUpdate: (snapshot: DutyScrollDebugFeedSnapshot, renderCount: number) => void;
}) {
  const snapshot = useDutyScrollDebugFeed(feedId);
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;
  useEffect(() => {
    onUpdate(snapshot, renderCountRef.current);
  });
  return null;
}

describe('duty scroll debug activation', () => {
  afterEach(() => setDutyScrollDebugEnabled(false));

  it('enables after eight presses within four seconds', () => {
    for (let press = 0; press < 8; press += 1) {
      registerDutyScrollDebugBellPress(1000 + press * 400);
    }

    expect(isDutyScrollDebugEnabled()).toBe(true);
  });

  it('does not enable when the eight presses span more than four seconds', () => {
    for (let press = 0; press < 8; press += 1) {
      registerDutyScrollDebugBellPress(1000 + press * 600);
    }

    expect(isDutyScrollDebugEnabled()).toBe(false);
  });
});

describe('duty scroll debug subscriptions', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    vi.useFakeTimers();
    setDutyScrollDebugEnabled(true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
      container.remove();
    });
    setDutyScrollDebugEnabled(false);
    vi.useRealTimers();
  });

  it('does not notify unrelated feed subscribers when metrics update', () => {
    let feedARenders = 0;
    let feedBRenders = 0;
    let feedBSnapshot: DutyScrollDebugFeedSnapshot | null = null;

    act(() => {
      root.render(
        <>
          <FeedProbe
            feedId="feed-a"
            onUpdate={(_snapshot, renderCount) => {
              feedARenders = renderCount;
            }}
          />
          <FeedProbe
            feedId="feed-b"
            onUpdate={(snapshot, renderCount) => {
              feedBRenders = renderCount;
              feedBSnapshot = snapshot;
            }}
          />
        </>,
      );
    });

    const initialBRenders = feedBRenders;
    const initialBSnapshot = feedBSnapshot;
    const initialARenders = feedARenders;

    act(() => {
      recordDutyScrollDebugMetrics('feed-a', sampleMetrics({ scrollTop: 10 }));
    });
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(feedARenders).toBeGreaterThan(initialARenders);
    expect(feedBRenders).toBe(initialBRenders);
    expect(feedBSnapshot).toBe(initialBSnapshot);
  });

  it('throttles metric subscriber notifications', () => {
    let renderCount = 0;
    let latestTop = 0;

    act(() => {
      root.render(
        <FeedProbe
          feedId="feed-a"
          onUpdate={(snapshot, count) => {
            renderCount = count;
            latestTop = snapshot.metrics?.scrollTop ?? 0;
          }}
        />,
      );
    });
    const afterMount = renderCount;

    act(() => {
      recordDutyScrollDebugMetrics('feed-a', sampleMetrics({ scrollTop: 1 }));
      recordDutyScrollDebugMetrics('feed-a', sampleMetrics({ scrollTop: 2 }));
      recordDutyScrollDebugMetrics('feed-a', sampleMetrics({ scrollTop: 3 }));
    });
    const afterBurst = renderCount;

    act(() => {
      vi.advanceTimersByTime(100);
    });
    const afterIdle = renderCount;

    expect(latestTop).toBe(3);
    // Three metric writes collapse to a single subscriber wake during the burst.
    expect(afterBurst - afterMount).toBe(1);
    // Trailing timer may no-op when the snapshot reference is already current.
    expect(afterIdle - afterBurst).toBeLessThanOrEqual(1);
  });

  it('notifies the matching feed immediately for events', () => {
    let lastEventName: string | undefined;

    act(() => {
      root.render(
        <FeedProbe
          feedId="feed-a"
          onUpdate={(snapshot) => {
            lastEventName = snapshot.events.at(-1)?.name;
          }}
        />,
      );
    });

    act(() => {
      recordDutyScrollDebugEvent('feed-a', 'load-newer:trigger', 'distance=12');
    });

    expect(lastEventName).toBe('load-newer:trigger');
  });
});
