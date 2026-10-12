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
      pageNavigationTarget: null,
      viewportPreservationKey: 0,
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
});
