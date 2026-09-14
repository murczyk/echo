import { clamp, type Point } from './message-card-image-utils';

export const ZOOM_MIN = 100;
export const ATTACHMENT_PREVIEW_DRAG_THRESHOLD_PX = 5;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 25;
export const WHEEL_ZOOM_SENSITIVITY = 0.0015;
export const ZOOM_MARKS = [100, 150, 200, 300, 400].map((value) => ({ value, label: `${value}%` }));

export type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  fittedImageWidth: number;
  fittedImageHeight: number;
  stageWidth: number;
  stageHeight: number;
};

export function normalizeWheelDeltaY(deltaY: number, deltaMode: number, pageSize: number): number {
  if (deltaMode === 1) return deltaY * 16;
  if (deltaMode === 2) return deltaY * pageSize;
  return deltaY;
}

export function getNextWheelZoom(
  currentZoom: number,
  deltaY: number,
  deltaMode: number,
  pageSize: number,
): number {
  const normalizedDeltaY = normalizeWheelDeltaY(deltaY, deltaMode, pageSize);
  return clamp(
    currentZoom * Math.exp(-normalizedDeltaY * WHEEL_ZOOM_SENSITIVITY),
    ZOOM_MIN,
    ZOOM_MAX,
  );
}

export function isInteractivePreviewTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '[data-attachment-preview-nav], button, a, input, textarea, select, [role="slider"], [contenteditable="true"]',
    ),
  );
}
