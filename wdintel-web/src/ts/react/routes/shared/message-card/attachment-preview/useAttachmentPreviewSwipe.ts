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

  useEffect(() => {
    if (!stageEl || !navigation || !enabled || navigation.count <= 1) return;

    const handleTouchStart = (event: TouchEvent) => {
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

    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });

    return () => {
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchend', handleTouchEnd);
    };
  }, [stageEl, navigation, enabled]);
}
