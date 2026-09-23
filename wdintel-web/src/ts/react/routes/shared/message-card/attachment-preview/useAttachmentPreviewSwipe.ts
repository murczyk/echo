import { useEffect, useRef, useState } from 'react';
import type { MessageCardPreviewNavigation } from './message-card-preview.types';

const SWIPE_MIN_DISTANCE_PX = 32;
const SWIPE_FLICK_MIN_DISTANCE_PX = 12;
const SWIPE_FLICK_MIN_VELOCITY_PX_MS = 0.18;
const DISMISS_MIN_DISTANCE_PX = 72;
const SWIPE_AXIS_RATIO = 1.2;
const SWIPE_DIRECTION_LOCK_PX = 8;
const SWIPE_ANIMATION_MS = 180;

type SwipeAxis = 'horizontal' | 'vertical' | null;

type TouchStart = {
  x: number;
  y: number;
  time: number;
  axis: SwipeAxis;
};

type SwipeMotion = {
  x: number;
  y: number;
  opacity: number;
  animated: boolean;
};

const idleMotion: SwipeMotion = { x: 0, y: 0, opacity: 1, animated: false };

function getSwipeAxis(
  deltaX: number,
  deltaY: number,
  canNavigate: boolean,
  canDismiss: boolean,
): SwipeAxis {
  if (
    canNavigate &&
    Math.abs(deltaX) >= SWIPE_DIRECTION_LOCK_PX &&
    Math.abs(deltaX) > Math.abs(deltaY) * SWIPE_AXIS_RATIO
  )
    return 'horizontal';
  if (
    canDismiss &&
    Math.abs(deltaY) >= SWIPE_DIRECTION_LOCK_PX &&
    Math.abs(deltaY) > Math.abs(deltaX) * SWIPE_AXIS_RATIO
  )
    return 'vertical';
  return null;
}

export function useAttachmentPreviewSwipe({
  stageEl,
  navigation,
  enabled = true,
  onDismiss,
}: {
  stageEl: HTMLElement | null;
  navigation?: MessageCardPreviewNavigation;
  enabled?: boolean;
  onDismiss?: () => void;
}) {
  const [motion, setMotion] = useState<SwipeMotion>(idleMotion);
  const touchStartRef = useRef<TouchStart | null>(null);
  const pinchRef = useRef(false);
  const animatingRef = useRef(false);
  const enabledRef = useRef(enabled);
  const navigationRef = useRef(navigation);
  const dismissRef = useRef(onDismiss);
  const animationTimerRef = useRef<number | null>(null);
  enabledRef.current = enabled;
  navigationRef.current = navigation;
  dismissRef.current = onDismiss;

  const clearAnimation = () => {
    if (animationTimerRef.current !== null) window.clearTimeout(animationTimerRef.current);
    animationTimerRef.current = null;
    animatingRef.current = false;
  };

  const settleMotion = () => {
    setMotion((current) => ({ ...idleMotion, animated: current.x !== 0 || current.y !== 0 }));
    animationTimerRef.current = window.setTimeout(() => {
      setMotion(idleMotion);
      animatingRef.current = false;
      animationTimerRef.current = null;
    }, SWIPE_ANIMATION_MS);
  };

  useEffect(() => {
    if (!stageEl) return;

    const handleTouchStart = (event: TouchEvent) => {
      if (pinchRef.current || animatingRef.current || !enabledRef.current) {
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

      clearAnimation();
      setMotion(idleMotion);
      touchStartRef.current = {
        x: touch.clientX,
        y: touch.clientY,
        time: Date.now(),
        axis: null,
      };
    };

    const handleTouchMove = (event: TouchEvent) => {
      const touchStart = touchStartRef.current;
      const touch = event.touches[0];
      if (!touchStart || !touch || pinchRef.current || !enabledRef.current) return;

      const deltaX = touch.clientX - touchStart.x;
      const deltaY = touch.clientY - touchStart.y;
      const currentNavigation = navigationRef.current;
      touchStart.axis ??= getSwipeAxis(
        deltaX,
        deltaY,
        (currentNavigation?.count ?? 0) > 1,
        dismissRef.current != null,
      );
      if (touchStart.axis === null) return;

      event.preventDefault();
      if (touchStart.axis === 'horizontal') return;

      const height = Math.max(stageEl.clientHeight, window.innerHeight, 1);
      setMotion({
        x: 0,
        y: deltaY,
        opacity: Math.max(0.35, 1 - (Math.abs(deltaY) / height) * 0.9),
        animated: false,
      });
    };

    const commitNavigation = (direction: 'previous' | 'next') => {
      const currentNavigation = navigationRef.current;
      if (direction === 'next') currentNavigation?.onNext();
      else currentNavigation?.onPrevious();
    };

    const animateDismiss = (deltaY: number) => {
      animatingRef.current = true;
      const height = Math.max(stageEl.clientHeight, window.innerHeight, 1);
      setMotion({
        x: 0,
        y: deltaY < 0 ? -height : height,
        opacity: 0,
        animated: true,
      });
      animationTimerRef.current = window.setTimeout(() => {
        dismissRef.current?.();
        animationTimerRef.current = null;
      }, SWIPE_ANIMATION_MS);
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
      const horizontalDistance = Math.abs(deltaX);
      const horizontalVelocity = horizontalDistance / Math.max(deltaTime, 1);
      const currentNavigation = navigationRef.current;
      const axis =
        touchStart.axis ??
        getSwipeAxis(
          deltaX,
          deltaY,
          (currentNavigation?.count ?? 0) > 1,
          dismissRef.current != null,
        );

      if (
        axis === 'horizontal' &&
        (horizontalDistance >= SWIPE_MIN_DISTANCE_PX ||
          (horizontalDistance >= SWIPE_FLICK_MIN_DISTANCE_PX &&
            horizontalVelocity >= SWIPE_FLICK_MIN_VELOCITY_PX_MS))
      ) {
        commitNavigation(deltaX < 0 ? 'next' : 'previous');
        return;
      }
      if (axis === 'vertical' && Math.abs(deltaY) >= DISMISS_MIN_DISTANCE_PX) {
        animateDismiss(deltaY);
        return;
      }
      if (axis !== null) settleMotion();
    };

    const handlePinch = () => {
      pinchRef.current = true;
      touchStartRef.current = null;
      clearAnimation();
      setMotion(idleMotion);
    };

    const handleGestureEnd = () => {
      pinchRef.current = false;
    };

    const handleTouchCancel = () => {
      touchStartRef.current = null;
      if (!animatingRef.current) settleMotion();
    };

    stageEl.addEventListener('touchstart', handleTouchStart, { passive: true });
    stageEl.addEventListener('touchmove', handleTouchMove, { passive: false });
    stageEl.addEventListener('touchend', handleTouchEnd, { passive: true });
    stageEl.addEventListener('touchcancel', handleTouchCancel, { passive: true });
    stageEl.addEventListener('attachment-preview-pinch', handlePinch);
    stageEl.addEventListener('attachment-preview-gesture-end', handleGestureEnd);

    return () => {
      touchStartRef.current = null;
      pinchRef.current = false;
      clearAnimation();
      stageEl.removeEventListener('touchstart', handleTouchStart);
      stageEl.removeEventListener('touchmove', handleTouchMove);
      stageEl.removeEventListener('touchend', handleTouchEnd);
      stageEl.removeEventListener('touchcancel', handleTouchCancel);
      stageEl.removeEventListener('attachment-preview-pinch', handlePinch);
      stageEl.removeEventListener('attachment-preview-gesture-end', handleGestureEnd);
    };
  }, [stageEl]);

  useEffect(() => {
    if (enabled) return;
    touchStartRef.current = null;
    clearAnimation();
    setMotion(idleMotion);
  }, [enabled]);

  return {
    transform: `translate3d(${motion.x}px, ${motion.y}px, 0)`,
    opacity: motion.opacity,
    transition: motion.animated
      ? `transform ${SWIPE_ANIMATION_MS}ms ease-out, opacity ${SWIPE_ANIMATION_MS}ms ease-out`
      : 'none',
  };
}
