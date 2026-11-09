import { useEffect, type Dispatch, type SetStateAction } from 'react';

import {
  clamp,
  DOCUMENT_PREVIEW_ZOOM_MAX,
  DOCUMENT_PREVIEW_ZOOM_MIN,
} from '../document-preview-utils';
import { getNextWheelZoom, isInteractivePreviewTarget } from '../message-card-image-preview-utils';

export function useDocumentPreviewZoom(
  stageEl: HTMLDivElement | null,
  enabled: boolean,
  onZoomChange: Dispatch<SetStateAction<number>>,
) {
  useEffect(() => {
    if (stageEl === null || !enabled) return;

    let touchStartDist = 0;
    let touchStartZoom = 100;

    const handleStageWheelNative = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;

      // Ctrl / Cmd + scroll OR trackpad pinch (ctrlKey) -> Zoom in/out content area
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault();
        onZoomChange((currentZoom) =>
          getNextWheelZoom(currentZoom, event.deltaY, event.deltaMode, stageEl.clientHeight),
        );
      }
      // Regular scroll -> Just scroll content naturally
    };

    const handleTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        touchStartDist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        onZoomChange((currentZoom) => {
          touchStartZoom = currentZoom;
          return currentZoom;
        });
      }
    };

    const handleTouchMove = (event: TouchEvent) => {
      if (event.touches.length === 2 && touchStartDist > 0) {
        event.preventDefault();
        const t1 = event.touches[0];
        const t2 = event.touches[1];
        if (!t1 || !t2) return;
        const dist = Math.hypot(t1.clientX - t2.clientX, t1.clientY - t2.clientY);
        const scale = dist / touchStartDist;
        const nextZoom = clamp(
          touchStartZoom * scale,
          DOCUMENT_PREVIEW_ZOOM_MIN,
          DOCUMENT_PREVIEW_ZOOM_MAX,
        );
        onZoomChange(nextZoom);
      }
    };

    const handleTouchEnd = () => {
      touchStartDist = 0;
    };

    let gestureStartZoom = 100;

    const handleGestureStart = (event: Event) => {
      event.preventDefault();
      onZoomChange((currentZoom) => {
        gestureStartZoom = currentZoom;
        return currentZoom;
      });
    };

    const handleGestureChange = (event: Event) => {
      event.preventDefault();
      const gestureEvent = event as unknown as { scale: number };
      if (typeof gestureEvent.scale === 'number') {
        const nextZoom = clamp(
          gestureStartZoom * gestureEvent.scale,
          DOCUMENT_PREVIEW_ZOOM_MIN,
          DOCUMENT_PREVIEW_ZOOM_MAX,
        );
        onZoomChange(nextZoom);
      }
    };

    const handleGestureEnd = (event: Event) => {
      event.preventDefault();
    };

    stageEl.addEventListener('wheel', handleStageWheelNative, { passive: false });
    stageEl.addEventListener('gesturestart', handleGestureStart, { passive: false });
    stageEl.addEventListener('gesturechange', handleGestureChange, { passive: false });
    stageEl.addEventListener('gestureend', handleGestureEnd, { passive: false });
    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    stageEl.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      stageEl.removeEventListener('wheel', handleStageWheelNative);
      stageEl.removeEventListener('gesturestart', handleGestureStart);
      stageEl.removeEventListener('gesturechange', handleGestureChange);
      stageEl.removeEventListener('gestureend', handleGestureEnd);
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchmove', handleTouchMove);
      stageEl.removeEventListener('touchend', handleTouchEnd);
      stageEl.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [enabled, onZoomChange, stageEl]);
}
