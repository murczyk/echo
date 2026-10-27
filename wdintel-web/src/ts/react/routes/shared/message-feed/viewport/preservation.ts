import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import type { WindowedFeedScrollRefs } from '../internal/internal.types';
import type { AnchorSnapshot } from '../message-feed.types';
import type { useWindowedFeedScrollAnchors } from './anchors';

export type MessageViewportCapture =
  | { position: 'leading-edge' }
  | { position: 'trailing-edge' }
  | { position: 'message-anchor'; snapshot: AnchorSnapshot };

export function useMessageFeedViewport({
  refs,
  anchors,
  resetKey,
  viewportPreservationKey,
  onViewportCaptureChange,
}: {
  refs: WindowedFeedScrollRefs;
  anchors: ReturnType<typeof useWindowedFeedScrollAnchors>;
  resetKey: string | number | null;
  viewportPreservationKey?: number;
  onViewportCaptureChange?: (capture: (() => void) | null) => void;
}) {
  const captureRef = useRef<MessageViewportCapture | null>(null);
  const activeRef = useRef(false);
  const previousKeyRef = useRef(viewportPreservationKey);
  const previousResetRef = useRef(resetKey);

  const capture = useCallback(() => {
    const scroller = refs.scrollerRef.current;
    if (!scroller) return;
    if (scroller.scrollTop <= 1) captureRef.current = { position: 'leading-edge' };
    else if (scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop <= 1) {
      captureRef.current = { position: 'trailing-edge' };
    } else {
      anchors.captureAnchorSnapshot();
      const snapshot = refs.anchorSnapshotRef.current;
      captureRef.current = snapshot ? { position: 'message-anchor', snapshot } : null;
    }
  }, [anchors, refs]);

  const release = useCallback(() => {
    activeRef.current = false;
    captureRef.current = null;
  }, []);
  useLayoutEffect(() => {
    onViewportCaptureChange?.(capture);
    return () => onViewportCaptureChange?.(null);
  }, [capture, onViewportCaptureChange]);
  useLayoutEffect(() => {
    if (previousResetRef.current !== resetKey) {
      previousResetRef.current = resetKey;
      release();
    }
    if (previousKeyRef.current === viewportPreservationKey) return;
    previousKeyRef.current = viewportPreservationKey;
    if (!captureRef.current) capture();
    activeRef.current = captureRef.current !== null;
  }, [capture, release, resetKey, viewportPreservationKey]);

  const restore = useCallback(() => {
    const scroller = refs.scrollerRef.current;
    const capture = captureRef.current;
    if (!activeRef.current || !scroller || !capture) return false;
    if (capture.position === 'message-anchor') {
      anchors.setAnchorSnapshot(capture.snapshot);
      if (anchors.restoreAnchorPosition({ settleSynchronousLayout: true }) === 'missing') {
        release();
        return false;
      }
    } else {
      scroller.scrollTop =
        capture.position === 'leading-edge'
          ? 0
          : Math.max(0, scroller.scrollHeight - scroller.clientHeight);
      refs.restoredScrollTopRef.current = scroller.scrollTop;
    }
    refs.previousScrollTopRef.current = scroller.scrollTop;
    return true;
  }, [anchors, refs, release]);

  return useMemo(() => ({ capture, restore, release }), [capture, restore, release]);
}

export function stabilizeMessageAtContainerTop(
  container: HTMLElement,
  message: HTMLElement,
  onAligned: () => void,
): () => void {
  let frame: number | null = null;
  let checked = 0;
  let stable = 0;
  let cancelled = false;
  const align = () => {
    if (cancelled || !message.isConnected || !container.isConnected) return;
    const offset =
      message.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      container.clientTop;
    if (Math.abs(offset) < 0.5) stable += 1;
    else {
      stable = 0;
      container.scrollTop += offset;
    }
    checked += 1;
    if ((checked >= 4 && stable >= 2) || checked >= 8) {
      onAligned();
      return;
    }
    frame = requestAnimationFrame(align);
  };
  align();
  return () => {
    cancelled = true;
    if (frame !== null) cancelAnimationFrame(frame);
  };
}
