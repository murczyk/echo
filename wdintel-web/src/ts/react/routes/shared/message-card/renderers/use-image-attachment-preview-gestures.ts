import type { PointerEvent as ReactPointerEvent } from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { clamp, clampPan, type Point } from '../message-card-image-utils';
import {
  ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX,
  getNextWheelZoom,
  isInteractivePreviewTarget,
  ZOOM_MAX,
  ZOOM_MIN,
  type DragState,
} from '../message-card-image-preview-utils';

type StageSize = { width: number; height: number };
type GestureStageMetrics = {
  centerX: number;
  centerY: number;
  fittedImageWidth: number;
  fittedImageHeight: number;
  stageWidth: number;
  stageHeight: number;
};
type TouchPoint = Point;
type TouchGesture =
  | { mode: 'idle' }
  | {
      mode: 'swipe-candidate';
      pointerId: number;
      start: TouchPoint;
      moved: boolean;
    }
  | { mode: 'pan'; pointerId: number; start: TouchPoint; origin: Point; moved: boolean }
  | {
      mode: 'pinch';
      startZoom: number;
      startPan: Point;
      startDistance: number;
      startMidpoint: TouchPoint;
    };
type PreviewRegion = 'background' | 'content' | 'protected';

const DOUBLE_TAP_WINDOW_MS = 350;
const DOUBLE_TAP_MAX_DISTANCE_PX = 24;

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
  const gestureStageMetricsRef = useRef<GestureStageMetrics | null>(null);
  const gestureFrameRef = useRef<number | null>(null);
  const lastTouchTapRef = useRef<{ x: number; y: number; at: number } | null>(null);
  const releasedPointerIdsRef = useRef(new Set<number>());
  const cleaningRef = useRef(false);
  const pointerListenersRef = useRef<{
    move: (event: PointerEvent) => void;
    end: (event: PointerEvent) => void;
  } | null>(null);
  lockedRef.current = interactionLocked;
  backgroundClickRef.current = onBackgroundClick;
  imageSizeRef.current = imageSize;

  const applyImageTransform = useCallback((nextZoom: number, nextPan: Point) => {
    const image = imageElementRef.current;
    if (image === null) return;
    image.style.transition = nextZoom === ZOOM_MIN ? 'transform 120ms ease-out' : 'none';
    image.style.transform = `translate(${nextPan.x}px, ${nextPan.y}px) scale(${nextZoom / 100})`;
  }, []);

  const cancelGestureFrame = useCallback(() => {
    if (gestureFrameRef.current === null) return;
    window.cancelAnimationFrame(gestureFrameRef.current);
    gestureFrameRef.current = null;
  }, []);

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
    gestureStageMetricsRef.current = null;
    lastTouchTapRef.current = null;
    dragRef.current = null;
    cancelGestureFrame();
    removePointerListeners();
    stage?.dispatchEvent(new CustomEvent('attachment-preview-gesture-end', { bubbles: true }));
    cleaningRef.current = false;
  }, [cancelGestureFrame, removePointerListeners]);

  const reset = useCallback(
    (invalidateImage = false) => {
      cleanup();
      zoomRef.current = ZOOM_MIN;
      panRef.current = { x: 0, y: 0 };
      applyImageTransform(ZOOM_MIN, panRef.current);
      setZoom(ZOOM_MIN);
      setPan({ x: 0, y: 0 });
      if (invalidateImage) {
        imageElementRef.current = null;
        setImageSize(null);
      }
    },
    [applyImageTransform, cleanup],
  );

  const clampPreviewPan = useCallback(
    (point: Point, nextZoom = zoomRef.current, metrics?: GestureStageMetrics | null) => {
      if (metrics != null)
        return clampPan(
          point,
          metrics.fittedImageWidth,
          metrics.fittedImageHeight,
          metrics.stageWidth,
          metrics.stageHeight,
          nextZoom,
        );
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
    },
    [],
  );

  const updateTransformRefs = useCallback(
    (nextZoom: number, nextPan: Point, metrics?: GestureStageMetrics | null) => {
      const clampedZoom = clamp(nextZoom, ZOOM_MIN, ZOOM_MAX);
      const clampedPan =
        clampedZoom === ZOOM_MIN ? { x: 0, y: 0 } : clampPreviewPan(nextPan, clampedZoom, metrics);
      zoomRef.current = clampedZoom;
      panRef.current = clampedPan;
      return { zoom: clampedZoom, pan: clampedPan };
    },
    [clampPreviewPan],
  );

  const setTransform = useCallback(
    (nextZoom: number, nextPan: Point) => {
      const nextTransform = updateTransformRefs(nextZoom, nextPan);
      applyImageTransform(nextTransform.zoom, nextTransform.pan);
      setZoom(nextTransform.zoom);
      setPan(nextTransform.pan);
    },
    [applyImageTransform, updateTransformRefs],
  );

  const queueGestureTransform = useCallback(
    (nextZoom: number, nextPan: Point) => {
      updateTransformRefs(nextZoom, nextPan, gestureStageMetricsRef.current);
      if (gestureFrameRef.current !== null) return;
      gestureFrameRef.current = window.requestAnimationFrame(() => {
        gestureFrameRef.current = null;
        applyImageTransform(zoomRef.current, panRef.current);
      });
    },
    [applyImageTransform, updateTransformRefs],
  );

  const commitGestureTransform = useCallback(() => {
    cancelGestureFrame();
    applyImageTransform(zoomRef.current, panRef.current);
    setZoom(zoomRef.current);
    setPan(panRef.current);
    gestureStageMetricsRef.current = null;
  }, [applyImageTransform, cancelGestureFrame]);

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

  const measureGestureStage = (): GestureStageMetrics | null => {
    const stage = stageRef.current;
    if (stage === null) return null;
    const rect = stage.getBoundingClientRect();
    const fittedImage = getFittedImageSize(imageSizeRef.current, stage);
    return {
      centerX: rect.left + rect.width / 2,
      centerY: rect.top + rect.height / 2,
      fittedImageWidth: fittedImage.width,
      fittedImageHeight: fittedImage.height,
      stageWidth: stage.clientWidth,
      stageHeight: stage.clientHeight,
    };
  };

  const getStagePoint = (
    event: ReactPointerEvent<HTMLDivElement>,
    metrics = gestureStageMetricsRef.current,
  ): TouchPoint => {
    if (metrics === null) {
      const rect = stageRef.current?.getBoundingClientRect();
      return {
        x: event.clientX - ((rect?.left ?? 0) + (rect?.width ?? 0) / 2),
        y: event.clientY - ((rect?.top ?? 0) + (rect?.height ?? 0) / 2),
      };
    }
    return {
      x: event.clientX - metrics.centerX,
      y: event.clientY - metrics.centerY,
    };
  };

  const addPointerListeners = useCallback(() => {
    removePointerListeners();
    const move = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (drag === null || event.pointerId !== drag.pointerId) return;
      event.preventDefault();
      queueGestureTransform(zoomRef.current, {
        x: drag.origin.x + event.clientX - drag.startX,
        y: drag.origin.y + event.clientY - drag.startY,
      });
    };
    const end = (event: PointerEvent) => {
      if (dragRef.current?.pointerId !== event.pointerId) return;
      dragRef.current = null;
      commitGestureTransform();
      removePointerListeners();
    };
    pointerListenersRef.current = { move, end };
    window.addEventListener('pointermove', move as EventListener, { passive: false });
    window.addEventListener('pointerup', end as EventListener);
    window.addEventListener('pointercancel', end as EventListener);
  }, [commitGestureTransform, queueGestureTransform, removePointerListeners]);

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
    lastTouchTapRef.current = null;
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
    queueGestureTransform(nextZoom, {
      x: midpoint.x - ratio * (gesture.startMidpoint.x - gesture.startPan.x),
      y: midpoint.y - ratio * (gesture.startMidpoint.y - gesture.startPan.y),
    });
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (lockedRef.current || isInteractivePreviewTarget(event.target)) return;
    if (event.pointerType === 'touch') {
      releasedPointerIdsRef.current.delete(event.pointerId);
      if (touchPointsRef.current.size === 0) gestureStageMetricsRef.current = measureGestureStage();
      const point = getStagePoint(event);
      touchPointsRef.current.set(event.pointerId, point);
      if (touchPointsRef.current.size === 2) beginPinch();
      else if (zoomRef.current > ZOOM_MIN)
        touchGestureRef.current = {
          mode: 'pan',
          pointerId: event.pointerId,
          start: point,
          origin: panRef.current,
          moved: false,
        };
      else
        touchGestureRef.current = {
          mode: 'swipe-candidate',
          pointerId: event.pointerId,
          start: point,
          moved: false,
        };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    if (zoomRef.current === ZOOM_MIN || stageRef.current === null) return;
    const stage = stageRef.current;
    const metrics = measureGestureStage();
    gestureStageMetricsRef.current = metrics;
    dragRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      origin: panRef.current,
      fittedImageWidth: metrics?.fittedImageWidth ?? stage.clientWidth,
      fittedImageHeight: metrics?.fittedImageHeight ?? stage.clientHeight,
      stageWidth: metrics?.stageWidth ?? stage.clientWidth,
      stageHeight: metrics?.stageHeight ?? stage.clientHeight,
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
    if (
      (gesture.mode === 'pan' || gesture.mode === 'swipe-candidate') &&
      gesture.pointerId === event.pointerId &&
      Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y) >
        ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX
    )
      gesture.moved = true;
    if (gesture.mode === 'pan' && gesture.pointerId === event.pointerId)
      queueGestureTransform(zoomRef.current, {
        x: gesture.origin.x + point.x - gesture.start.x,
        y: gesture.origin.y + point.y - gesture.start.y,
      });
  };

  const handleTouchTap = (event: ReactPointerEvent<HTMLDivElement>) => {
    const image = imageElementRef.current;
    if (image === null || failedHref === href) return;
    const imageRect = image.getBoundingClientRect();
    if (
      event.clientX < imageRect.left ||
      event.clientX > imageRect.right ||
      event.clientY < imageRect.top ||
      event.clientY > imageRect.bottom
    )
      return;

    const now = Date.now();
    const previous = lastTouchTapRef.current;
    if (
      previous === null ||
      now - previous.at > DOUBLE_TAP_WINDOW_MS ||
      Math.hypot(event.clientX - previous.x, event.clientY - previous.y) >
        DOUBLE_TAP_MAX_DISTANCE_PX
    ) {
      lastTouchTapRef.current = { x: event.clientX, y: event.clientY, at: now };
      return;
    }

    lastTouchTapRef.current = null;
    if (zoomRef.current > ZOOM_MIN) {
      setPreviewZoom(ZOOM_MIN);
      return;
    }
    setPreviewZoom(200, getStagePoint(event));
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch') {
      const gesture = touchGestureRef.current;
      if (
        (gesture.mode === 'pan' || gesture.mode === 'swipe-candidate') &&
        gesture.pointerId === event.pointerId &&
        !gesture.moved
      )
        handleTouchTap(event);
      touchPointsRef.current.delete(event.pointerId);
      const remaining = Array.from(touchPointsRef.current.entries());
      if (remaining.length === 1) {
        const [pointerId, point] = remaining[0]!;
        touchGestureRef.current = {
          mode: 'pan',
          pointerId,
          start: point,
          origin: panRef.current,
          moved: false,
        };
      } else if (remaining.length === 0) {
        touchGestureRef.current = { mode: 'idle' };
        commitGestureTransform();
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
    commitGestureTransform();
    removePointerListeners();
    try {
      releasedPointerIdsRef.current.add(event.pointerId);
      event.currentTarget.releasePointerCapture(event.pointerId);
    } catch {}
  };

  const onPointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType === 'touch' || event.pointerType === 'mouse') {
      commitGestureTransform();
      cleanup();
    }
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
    applyImageTransform(zoomRef.current, panRef.current);
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
