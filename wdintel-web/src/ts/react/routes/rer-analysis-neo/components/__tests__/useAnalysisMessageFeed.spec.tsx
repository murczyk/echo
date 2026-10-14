/**
 * @vitest-environment happy-dom
 */
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import type { InboxMessage } from '../../../../../../Bindings';
import { useAnalysisMessageFeed } from '../useAnalysisMessageFeed';

const roots: Array<{ root: ReturnType<typeof createRoot>; container: HTMLDivElement }> = [];

afterEach(() => {
  for (const { root, container } of roots.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

it('maps bounded Analysis coordinates and both loading edges to the shared feed', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  const onVisiblePageChange = vi.fn();
  const onLoadPreviousMessages = vi.fn().mockResolvedValue(true);
  const onLoadMoreMessages = vi.fn().mockResolvedValue(true);
  let latest!: ReturnType<typeof useAnalysisMessageFeed>;
  function Harness() {
    latest = useAnalysisMessageFeed({
      messages: Array.from({ length: 30 }, (_, index) => [
        130 - index,
        { text: '' } as InboxMessage,
      ]),
      directMessageNavigation: null,
      firstLoadedMessageIndex: 25,
      hasMoreBeforeWindow: true,
      hasMoreAfterWindow: true,
      loadingBeforeWindow: true,
      loadingAfterWindow: false,
      isLoading: false,
      newestFirst: true,
      pageNavigationTarget: null,
      viewportPreservationKey: 0,
      edgeLoadRetryKey: 0,
      onViewportCaptureChange: vi.fn(),
      scrollResetKey: 'test',
      onLoadPreviousMessages,
      onLoadMoreMessages,
      onVisiblePageChange,
      onPageNavigationHandled: vi.fn(),
    });
    return null;
  }
  act(() => root.render(createElement(Harness)));

  latest.scrollOptions.onFirstVisibleMessage?.(115, 15);
  await act(async () => {
    await latest.scrollOptions.onLoadOlder();
    await latest.scrollOptions.onLoadNewer?.();
  });

  expect(onVisiblePageChange).toHaveBeenCalledWith(2);
  expect(onLoadPreviousMessages).toHaveBeenCalledTimes(1);
  expect(onLoadMoreMessages).toHaveBeenCalledTimes(1);
  expect(latest.loadingAbove).toBe(true);
  expect(latest.loadingBelow).toBe(false);
  expect(latest.hasMoreAbove).toBe(true);
  expect(latest.hasMoreBelow).toBe(true);
  expect(latest.scrollOptions.loadEdgesOnLayout).toBe(true);
});

it('pauses edge requests while the Analysis page is refreshing', async () => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push({ root, container });
  let latest!: ReturnType<typeof useAnalysisMessageFeed>;
  function Harness({ isLoading }: { isLoading: boolean }) {
    latest = useAnalysisMessageFeed({
      messages: [[1, { text: '' } as InboxMessage]],
      directMessageNavigation: null,
      firstLoadedMessageIndex: 20,
      hasMoreBeforeWindow: true,
      hasMoreAfterWindow: true,
      loadingBeforeWindow: false,
      loadingAfterWindow: false,
      isLoading,
      newestFirst: true,
      pageNavigationTarget: null,
      viewportPreservationKey: 0,
      edgeLoadRetryKey: 1,
      onViewportCaptureChange: vi.fn(),
      scrollResetKey: 'test',
      onLoadPreviousMessages: vi.fn().mockResolvedValue(true),
      onLoadMoreMessages: vi.fn().mockResolvedValue(true),
      onVisiblePageChange: vi.fn(),
      onPageNavigationHandled: vi.fn(),
    });
    return null;
  }

  await act(async () => root.render(createElement(Harness, { isLoading: true })));
  expect(latest.scrollOptions.loadEdgesOnLayout).toBe(false);
  expect(latest.scrollOptions.hasReachedStart).toBe(true);
  expect(latest.scrollOptions.unreadPrefetchNeeded).toBe(false);

  await act(async () => root.render(createElement(Harness, { isLoading: false })));
  expect(latest.scrollOptions.loadEdgesOnLayout).toBe(true);
  expect(latest.scrollOptions.hasReachedStart).toBe(false);
  expect(latest.scrollOptions.unreadPrefetchNeeded).toBe(true);
});

it.each([
  { newestFirst: true, edge: 'start' as const },
  { newestFirst: false, edge: 'bottom' as const },
])(
  'reports the chronological newest edge when newestFirst=$newestFirst',
  ({ newestFirst, edge }) => {
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push({ root, container });
    const onChronologicalNewestReached = vi.fn();
    let latest!: ReturnType<typeof useAnalysisMessageFeed>;
    function Harness() {
      latest = useAnalysisMessageFeed({
        messages: [[1, { text: '' } as InboxMessage]],
        directMessageNavigation: null,
        firstLoadedMessageIndex: 0,
        hasMoreBeforeWindow: false,
        hasMoreAfterWindow: false,
        loadingBeforeWindow: false,
        loadingAfterWindow: false,
        isLoading: false,
        newestFirst,
        pageNavigationTarget: null,
        viewportPreservationKey: 0,
        edgeLoadRetryKey: 0,
        onViewportCaptureChange: vi.fn(),
        scrollResetKey: 'group-a',
        onLoadPreviousMessages: vi.fn().mockResolvedValue(false),
        onLoadMoreMessages: vi.fn().mockResolvedValue(false),
        onVisiblePageChange: vi.fn(),
        onPageNavigationHandled: vi.fn(),
        onChronologicalNewestReached,
      });
      return null;
    }
    act(() => root.render(createElement(Harness)));

    if (edge === 'start') latest.scrollOptions.onFirstVisibleMessage?.(1, 0);
    else
      latest.scrollOptions.onReachedBottom?.({ hasSeenNotAtBottom: true, navigationIntent: null });

    expect(onChronologicalNewestReached).toHaveBeenCalledTimes(1);
  },
);
