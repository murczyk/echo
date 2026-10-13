import { useCallback, useEffect, useRef } from 'react';
import { useFeedScrollDiagnostics } from '../internal/diagnostics';
import type { FeedScrollHelpers } from '../internal/internal.types';

const INTERACTIVE_FALLBACK_WHEEL_TARGET_SELECTOR = [
  'a',
  'button',
  '[data-audio-player-host]',
  'input',
  'select',
  'summary',
  'textarea',
  'option',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="button"]',
  '[role="checkbox"]',
  '[role="combobox"]',
  '[role="gridcell"]',
  '[role="link"]',
  '[role="listbox"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="option"]',
  '[role="radio"]',
  '[role="scrollbar"]',
  '[role="searchbox"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="switch"]',
  '[role="tab"]',
  '[role="textbox"]',
  '[role="treeitem"]',
].join(', ');

export function useMessageFeedInput({
  refs,
  anchors,
  follow,
  enabled,
  resetKey,
  debugFeedId,
  underfilledEdgeLoading,
  serializeEdgeLoads,
  onReaderScrollStart,
  hasItems,
}: Pick<FeedScrollHelpers, 'refs' | 'anchors' | 'follow'> & {
  enabled: boolean;
  resetKey: string | number | null;
  debugFeedId?: string;
  underfilledEdgeLoading: boolean;
  serializeEdgeLoads: boolean;
  onReaderScrollStart: () => void;
  hasItems: boolean;
}) {
  const { event: recordScrollDebugEvent } = useFeedScrollDiagnostics(refs);
  const fallbackInputRef = useRef<{ direction: 'older' | 'newer'; generation: number } | null>(
    null,
  );
  const fallbackInputGenerationRef = useRef(0);
  const clearFallbackInput = useCallback(() => {
    fallbackInputGenerationRef.current += 1;
    fallbackInputRef.current = null;
  }, []);

  const triggerNonScrollableFallback = useCallback(
    (direction: 'older' | 'newer') => {
      const scroller = refs.scrollerRef.current;
      const scrollable = scroller != null && scroller.scrollHeight > scroller.clientHeight + 1;
      const atRequestedBoundary =
        scroller != null &&
        (direction === 'older'
          ? scroller.scrollTop <= 1
          : scroller.scrollTop >= scroller.scrollHeight - scroller.clientHeight - 1);
      if (
        !refs.enabledRef.current ||
        !scroller ||
        refs.itemIdsRef.current.length === 0 ||
        scroller.clientHeight <= 0 ||
        (scrollable && (!serializeEdgeLoads || !atRequestedBoundary)) ||
        refs.loadingOlderRef.current ||
        refs.loadingNewerRef.current ||
        fallbackInputRef.current !== null
      ) {
        return;
      }

      const callbacks = refs.callbacksRef.current;
      if (direction === 'older') {
        if (refs.loadingOlderRef.current || refs.hasReachedStartRef.current) return;
        follow.stopBottomSettle();
        follow.clearFollowScroll();
        if (refs.liveBottomFollowRef.current) {
          refs.liveBottomFollowRef.current = false;
          refs.callbacksRef.current.onLeftBottom?.();
        }
      } else if (refs.pendingNewerFlushNeededRef.current) {
        if (typeof callbacks.onFlushPendingNewer !== 'function') return;
      } else if (
        refs.loadingNewerRef.current ||
        (serializeEdgeLoads && !refs.unreadPrefetchNeededRef.current) ||
        typeof callbacks.onLoadNewer !== 'function'
      ) {
        return;
      }

      anchors.captureAnchorSnapshot();
      const generation = fallbackInputGenerationRef.current;
      fallbackInputRef.current = { direction, generation };
      recordScrollDebugEvent(debugFeedId, 'non-scrollable-input', direction);
      let attempt: void | Promise<unknown>;
      try {
        attempt =
          direction === 'older'
            ? callbacks.onLoadOlder()
            : refs.pendingNewerFlushNeededRef.current
              ? callbacks.onFlushPendingNewer?.({
                  physicallyAtBottom: refs.physicallyAtBottomRef.current === true,
                  visibleAnchorIds:
                    refs.anchorSnapshotRef.current?.anchors.map((anchor) => anchor.id) ?? [],
                })
              : callbacks.onLoadNewer?.();
      } catch (error) {
        clearFallbackInput();
        throw error;
      }
      const settleFallbackInput = () => {
        if (fallbackInputGenerationRef.current === generation) fallbackInputRef.current = null;
      };
      void Promise.resolve(attempt).then(settleFallbackInput, settleFallbackInput);
    },
    [anchors, clearFallbackInput, debugFeedId, follow, refs, serializeEdgeLoads],
  );
  const triggerNonScrollableFallbackRef = useRef(triggerNonScrollableFallback);
  triggerNonScrollableFallbackRef.current = triggerNonScrollableFallback;

  useEffect(() => {
    if (!enabled || !underfilledEdgeLoading) {
      clearFallbackInput();
      return;
    }
    const scroller = refs.scrollerRef.current;
    if (!scroller) return;
    const isExcludedFallbackWheelTarget = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return false;
      for (
        let node: Element | null = target;
        node !== null && node !== scroller;
        node = node.parentElement
      ) {
        if (
          node.scrollHeight > node.clientHeight + 1 ||
          node.matches(INTERACTIVE_FALLBACK_WHEEL_TARGET_SELECTOR)
        ) {
          return true;
        }
      }
      return false;
    };
    const onWheel = (event: WheelEvent) => {
      if (
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        event.metaKey ||
        event.deltaY === 0 ||
        isExcludedFallbackWheelTarget(event.target)
      ) {
        return;
      }
      triggerNonScrollableFallbackRef.current(event.deltaY < 0 ? 'older' : 'newer');
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.target !== scroller ||
        event.ctrlKey ||
        event.altKey ||
        event.metaKey ||
        event.shiftKey
      ) {
        return;
      }
      if (event.key === 'ArrowUp' || event.key === 'Up' || event.key === 'PageUp') {
        triggerNonScrollableFallbackRef.current('older');
      } else if (event.key === 'ArrowDown' || event.key === 'Down' || event.key === 'PageDown') {
        triggerNonScrollableFallbackRef.current('newer');
      }
    };
    scroller.addEventListener('wheel', onWheel, { passive: true });
    scroller.addEventListener('keydown', onKeyDown);
    return () => {
      clearFallbackInput();
      scroller.removeEventListener('wheel', onWheel);
      scroller.removeEventListener('keydown', onKeyDown);
    };
  }, [clearFallbackInput, enabled, refs, resetKey, underfilledEdgeLoading, hasItems]);

  useEffect(() => {
    if (!enabled) return;
    const scroller = refs.scrollerRef.current;
    if (!scroller) return;
    const stopTrackingForUserInteraction = onReaderScrollStart;
    const onPointerDown = (event: PointerEvent) => {
      if (event.target === scroller) stopTrackingForUserInteraction();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End'].includes(event.key))
        stopTrackingForUserInteraction();
    };
    scroller.addEventListener('wheel', stopTrackingForUserInteraction, { passive: true });
    scroller.addEventListener('touchmove', stopTrackingForUserInteraction, { passive: true });
    scroller.addEventListener('pointerdown', onPointerDown);
    scroller.addEventListener('keydown', onKeyDown);
    return () => {
      scroller.removeEventListener('wheel', stopTrackingForUserInteraction);
      scroller.removeEventListener('touchmove', stopTrackingForUserInteraction);
      scroller.removeEventListener('pointerdown', onPointerDown);
      scroller.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, refs, onReaderScrollStart, hasItems, resetKey]);
}
