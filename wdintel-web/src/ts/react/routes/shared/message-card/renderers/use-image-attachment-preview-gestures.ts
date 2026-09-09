import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp, clampPan, type Point } from '../message-card-image-utils';
import {
  getNextWheelZoom,
  isInteractivePreviewTarget,
  ZOOM_MAX,
  ZOOM_MIN,
  type DragState,
} from '../message-card-image-preview-utils';

type StageSize = { width: number; height: number };
type TouchPoint = Point;
type TouchGesture =
  | { mode: 'idle' | 'swipe-candidate' }
  | { mode: 'pan'; pointerId: number; start: TouchPoint; origin: Point }
  | {
      mode: 'pinch';
      startZoom: number;
      startPan: Point;
      startDistance: number;
      startMidpoint: TouchPoint;
    };
type PreviewRegion = 'background' | 'content' | 'protected';

function getFittedImageSize(imageSize: StageSize | null, stage: HTMLDivElement): StageSize {
  if (imageSize === null || imageSize.width <= 0 || imageSize.height <= 0)
    return { width: stage.clientWidth, height: stage.clientHeight };
  const fitScale = Math.min(
    1,
    stage.clientWidth / imageSize.width,
    stage.clientHeight / imageSize.height,
  );
  return Number.isFinite(fitScale)
    ? { width: imageSize.width * fitScale, height: imageSize.height * fitScale }
    : { width: stage.clientWidth, height: stage.clientHeight };
}

export function useImageAttachmentPreviewGestures({
  previewKey,
  href,
  failedHref,
  interactionLocked,
  onBackgroundClick,
}: {
  previewKey: string;
  href: string;
  failedHref: string | null;
  interactionLocked: boolean;
  onBackgroundClick: () => void;
}) {
  const [zoom, setZoom] = useState(ZOOM_MIN);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [imageSize, setImageSize] = useState<StageSize | null>(null);
  const [stageEl, setStageEl] = useState<HTMLDivElement | null>(null);
  const stageRef = useRef<HTMLDivElement | null>(null);
  const imageElementRef = useRef<HTMLImageElement | null>(null);
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const imageSizeRef = useRef(imageSize);
  const lockedRef = useRef(interactionLocked);
  const backgroundClickRef = useRef(onBackgroundClick);
  const dragRef = useRef<DragState | null>(null);
  const touchPointsRef = useRef(new Map<number, TouchPoint>());
  const touchGestureRef = useRef<TouchGesture>({ mode: 'idle' });
  const releasedPointerIdsRef = useRef(new Set<number>());
  const cleaningRef = useRef(false);
  const pointerListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  lockedRef.current = interactionLocked;
  backgroundClickRef.current = onBackgroundClick;
  imageSizeRef.current = imageSize;

  const removePointerListeners = useCallback(() => {
    const listeners = pointerListenersRef.current;
    if (listeners === null) return;
    window.removeEventListener('pointermove', listeners.move as EventListener);
    window.removeEventListener('pointerup', listeners.end as EventListener);
    window.removeEventListener('pointercancel', listeners.end as EventListener);
    pointerListenersRef.current = null;
  }, []);

  const cleanup = useCallback(() => {
    if (cleaningRef.current) return;
    cleaningRef.current = true;
    const stage = stageRef.current;
    for (const pointerId of touchPointsRef.current.keys()) {
      try {
        if (stage?.hasPointerCapture(pointerId)) {
          releasedPointerIdsRef.current.add(pointerId);
          stage.releasePointerCapture(pointerId);
        }
      } catch {}
    }
    touchPointsRef.current.clear();
    touchGestureRef.current = { mode: 'idle' };
    dragRef.current = null;
    removePointerListeners();
    stage?.dispatchEvent(new CustomEvent('attachment-preview-gesture-end', { bubbles: true }));
    cleaningRef.current = false;
  }, [removePointerListeners]);

  const reset = useCallback(
    (invalidateImage = false) => {
      cleanup();
      zoomRef.current = ZOOM_MIN;
      panRef.current = { x: 0, y: 0 };
      setZoom(ZOOM_MIN);
      setPan({ x: 0, y: 0 });
      if (invalidateImage) {
        imageElementRef.current = null;
        setImageSize(null);
      }
    },
    [cleanup],
  );

  const clampPreviewPan = useCallback((point: Point, nextZoom = zoomRef.current) => {
    const stage = stageRef.current;
    if (stage === null) return point;
    const size = getFittedImageSize(imageSizeRef.current, stage);
    return clampPan(
      point,
      size.width,
      size.height,
      stage.clientWidth,
      stage.clientHeight,
      nextZoom,
    );
  }, []);

  const setTransform = useCallback(
    (nextZoom: number, nextPan: Point) => {
      const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
      const clampedPan =
        clampedZoom === ZOOM_MIN ? { x: 0, y: 0 } : clampPreviewPan(nextPan, clampedZoom);
      zoomRef.current = clampedZoom;
      panRef.current = clampedPan;
      setZoom(clampedZoom);
      setPan(clampedPan);
    },
    [clampPreviewPan],
  );

  const setPreviewZoom = useCallback(
    (nextZoom: number, cursorPoint: Point = { x: 0, y: 0 }) => {
      const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
      if (clampedZoom === ZOOM_MIN) return setTransform(ZOOM_MIN, { x: 0, y: 0 });
      const stage = stageRef.current;
      const currentPan = panRef.current;
      const size = stage === null ? null : getFittedImageSize(imageSizeRef.current, stage);
      const nextPan =
        stage === null
          ? currentPan
          : clampPan(
              {
                x: cursorPoint.x - (clampedZoom / zoomRef.current) * (cursorPoint.x - currentPan.x),
                y: cursorPoint.y - (clampedZoom / zoomRef.current) * (cursorPoint.y - currentPan.y),
              },
              size?.width ?? 0,
              size?.height ?? 0,
              stage.clientWidth,
              stage.clientHeight,
              clampedZoom,
            );
      setTransform(clampedZoom, nextPan);
    },
    [setTransform],
  );

  const stageRefCallback = useCallback(
    (node: HTMLDivElement | null) => {
      if (stageRef.current !== null && stageRef.current !== node) cleanup();
      stageRef.current = node;
      setStageEl(node);
    },
    [cleanup],
  );

  const getStagePoint = (event: ReactPointerEvent<HTMLDivElement>): TouchPoint => {
    const rect = stageRef.current?.getBoundingClientRect();
    return {
      x: event.clientX - ((rect?.left ?? 0) + (rect?.width ?? 0) / 2),
      y: event.clientY - ((rect?.top ?? 0) + (rect?.height ?? 0) / 2),
    };
  };

  const addPointerListeners = useCallback(() => {
    removePointerListeners();
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      setTransform(zoomRef.current, {
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      });
    };
    const end = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      removePointerListeners();
    };
    pointerListenersRef.current = { move, end };
    window.addEventListener('pointermove', move as EventListener, { passive: false });
    window.addEventListener('pointerup', end as EventListener);
    window.addEventListener('pointercancel', end as EventListener);
  }, [removePointerListeners, setTransform]);

  const beginPinch = () => {
    const [first, second] = Array.from(touchPointsRef.current.values());
    if (first == null || second == null) return;
    touchGestureRef.current = {
      mode: 'pinch',
      startZoom: zoomRef.current,
      startPan: panRef.current,
      startDistance: Math.hypot(first.x - second.x, first.y - second.y),
      startMidpoint: { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 },
    };
    dragRef.current = null;
    removePointerListeners();
    stageRef.current?.dispatchEvent(new CustomEvent('attachment-preview-pinch', { bubbles: true }));
  };

  const updatePinch = () => {
    const gesture = touchGestureRef.current;
    const [first, second] = Array.from(touchPointsRef.current.values());
    if (gesture.mode !== 'pinch' || first == null || second == null || gesture.startDistance <= 0)
      return;
    const midpoint = { x: (first.x + second.x) / 2, y: (first.y + second.y) / 2 };
    const nextZoom = clamp(
      (gesture.startZoom * Math.hypot(first.x - second.x, first.y - second.y)) /
        gesture.startDistance,
      ZOOM_MIN,
      ZOOM_MAX,
    );
    const ratio = nextZoom / gesture.startZoom;
    setTransform(nextZoom, {
      x: midpoint.x - ratio * (gesture.startMidpoint.x - gesture.startPan.x),
      y: midpoint.y - ratio * (gesture.startMidpoint.y - gesture.startPan.y),
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (lockedRef.current || isInteractivePreviewTarget(event.target)) return;
    if (event.pointerType === 'touch') {
      releasedPointerIdsRef.current.delete(event.pointerId);
      const point = getStagePoint(event);
      touchPointsRef.current.set(event.pointerId, point);
      if (touchPointsRef.current.size === 2) beginPinch();
      else if (zoomRef.current > ZOOM_MIN)
        touchGestureRef.current = {
          mode: 'pan',
          pointerId: event.pointerId,
          start: point,
          origin: panRef.current,
        };
      else touchGestureRef.current = { mode: 'swipe-candidate' };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (zoomRef.current === ZOOM_MIN || stageRef.current === null) return;
    const stage = stageRef.current;
    const size = getFittedImageSize(imageSizeRef.current, stage);
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: panRef.current,
      fittedImageWidth: size.width,
      fittedImageHeight: size.height,
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
    };
    addPointerListeners();
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (
      event.pointerType !== 'touch' ||
      lockedRef.current ||
      !touchPointsRef.current.has(event.pointerId)
    )
      return;
    event.preventDefault();
    const point = getStagePoint(event);
    touchPointsRef.current.set(event.pointerId, point);
    const gesture = touchGestureRef.current;
    if (gesture.mode === 'pinch') return updatePinch();
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId)
      setTransform(zoomRef.current, {
        x: gesture.origin.x + point.x - gesture.start.x,
        y: gesture.origin.y + point.y - gesture.start.y,
      });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      touchPointsRef.current.delete(event.pointerId);
      const remaining = Array.from(touchPointsRef.current.entries());
      if (remaining.length === 1) {
        const [pointerId, point] = remaining[0]!;
        touchGestureRef.current = { mode: 'pan', pointerId, start: point, origin: panRef.current };
      } else if (remaining.length === 0) {
        touchGestureRef.current = { mode: 'idle' };
        stageRef.current?.dispatchEvent(
          new CustomEvent('attachment-preview-gesture-end', { bubbles: true }),
        );
      }
      try {
        releasedPointerIdsRef.current.add(event.pointerId);
        event.currentTarget.releasePointerCapture(event.pointerId);
      } catch {}
      return;
    }
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    removePointerListeners();
    try {
      releasedPointerIdsRef.current.add(event.pointerId);
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.pointerType === 'mouse') cleanup();
  };
  const onLostPointerCapture = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (releasedPointerIdsRef.current.delete(event.pointerId) || cleaningRef.current) return;
    onPointerCancel(event);
  };
  const getPrimaryPointerRegion = (event: PointerEvent): PreviewRegion => {
    if (isInteractivePreviewTarget(event.target)) return 'protected';
    const image = imageElementRef.current;
    if (image === null || failedHref === href) return 'background';
    const rect = image.getBoundingClientRect();
    return event.clientX >= rect.left &&
      event.clientX <= rect.right &&
      event.clientY >= rect.top &&
      event.clientY <= rect.bottom
      ? 'content'
      : 'background';
  };
  const onPrimaryClick = (_event: MouseEvent, region: PreviewRegion) => {
    if (lockedRef.current || region === 'protected') return;
    if (region === 'background') return backgroundClickRef.current();
    if (zoomRef.current > ZOOM_MIN) setPreviewZoom(ZOOM_MIN);
    else setTransform(200, { x: 0, y: 0 });
  };
  const registerImage = (image: HTMLImageElement) => {
    imageElementRef.current = image;
    setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
  };

  useEffect(() => {
    reset(true);
  }, [previewKey, reset]);
  useEffect(() => cleanup, [cleanup]);
  useEffect(() => {
    if (interactionLocked) cleanup();
  }, [cleanup, interactionLocked]);
  useEffect(() => {
    if (stageEl === null) return;
    const wheel = (event: WheelEvent) => {
      if (isInteractivePreviewTarget(event.target)) return;
      event.preventDefault();
      const rect = stageEl.getBoundingClientRect();
      const imageRect = imageElementRef.current?.getBoundingClientRect();
      const overImage =
        imageRect != null &&
        event.clientX >= imageRect.left &&
        event.clientX <= imageRect.right &&
        event.clientY >= imageRect.top &&
        event.clientY <= imageRect.bottom;
      setPreviewZoom(
        getNextWheelZoom(zoomRef.current, event.deltaY, event.deltaMode, rect.height),
        overImage
          ? {
              x: event.clientX - (rect.left + rect.width / 2),
              y: event.clientY - (rect.top + rect.height / 2),
            }
          : { x: 0, y: 0 },
      );
    };
    stageEl.addEventListener('wheel', wheel, { passive: false });
    return () => stageEl.removeEventListener('wheel', wheel);
  }, [setPreviewZoom, stageEl]);
  useEffect(() => {
    if (stageEl === null || imageSize === null) return;
    const clampAfterLayoutChange = () => {
      if (zoomRef.current > ZOOM_MIN) setTransform(zoomRef.current, panRef.current);
    };
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(clampAfterLayoutChange);
    observer?.observe(stageEl);
    window.addEventListener('resize', clampAfterLayoutChange);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', clampAfterLayoutChange);
    };
  }, [imageSize, setTransform, stageEl]);

  return {
    zoom,
    pan,
    imageSize,
    stageRef: stageRefCallback,
    registerImage,
    reset,
    cleanup,
    setPreviewZoom,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel,
    onLostPointerCapture,
    getPrimaryPointerRegion,
    onPrimaryClick,
  };
}
