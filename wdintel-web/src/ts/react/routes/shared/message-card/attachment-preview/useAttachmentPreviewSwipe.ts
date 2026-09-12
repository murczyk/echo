import { useEffect, useRef } from 'react';
import type { MessageCardPreviewNavigation } from './message-card-preview.types';

export function useAttachmentPreviewSwipe({
  stageEl,
  navigation,
  enabled = true,
}: {
  stageEl: HTMLElement | null;
  navigation?: MessageCardPreviewNavigation;
  enabled?: boolean;
}) {
  const touchStartRef = useRef<{ x: number; y: number; time: number } | null>(null);
  const pinchRef = useRef(false);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  useEffect(() => {
    if (!stageEl || !navigation || navigation.count <= 1) return;

    const handleTouchStart = (event: TouchEvent) => {
      if (pinchRef.current || !enabledRef.current) {
        touchStartRef.current = null;
        return;
      }
      if (event.touches.length !== 1) {
        touchStartRef.current = null;
        return;
      }
      const touch = event.touches[0];
      if (!touch) return;

      const target = event.target as HTMLElement | null;
      if (
        target?.closest(
          'button, a, input, [role="slider"], .MuiSlider-root, [data-audio-player-host], [data-attachment-preview-controls], [data-attachment-preview-scroll]',
        )
      ) {
        touchStartRef.current = null;
        return;
      }

      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
      };
    };

    const handleTouchEnd = (event: TouchEvent) => {
      if (pinchRef.current || !enabledRef.current) {
        touchStartRef.current = null;
        return;
      }
      const touchStart = touchStartRef.current;
      touchStartRef.current = null;

      if (!touchStart) return;
      const touch = event.changedTouches[0];
      if (!touch) return;

      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      const deltaTime = Date.now() - touchStart.time;

      const minDistance = 40;
      const maxTime = 600;

      if (
        Math.abs(deltaX) >= minDistance &&
        Math.abs(deltaX) > Math.abs(deltaY) * 1.2 &&
        deltaTime <= maxTime
      ) {
        if (deltaX < 0) {
          navigation.onNext();
        } else {
          navigation.onPrevious();
        }
      }
    };

    const handlePinch = () => {
      pinchRef.current = true;
      touchStartRef.current = null;
    };

    const handleGestureEnd = () => {
      pinchRef.current = false;
    };

    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    stageEl.addEventListener('attachment-preview-pinch', handlePinch);
    stageEl.addEventListener('attachment-preview-gesture-end', handleGestureEnd);

    return () => {
      touchStartRef.current = null;
      pinchRef.current = false;
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchend', handleTouchEnd);
      stageEl.removeEventListener('attachment-preview-pinch', handlePinch);
      stageEl.removeEventListener('attachment-preview-gesture-end', handleGestureEnd);
    };
  }, [stageEl, navigation]);

  useEffect(() => {
    if (!enabled) touchStartRef.current = null;
  }, [enabled]);
}
