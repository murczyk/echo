import type { Point } from './message-card-image-utils';

export const ZOOM_MIN = 100;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 25;
export const ZOOM_MARKS = [100, 150, 200, 300, 400].map((value) => ({ value, label: `${value}%` }));

export type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  stageWidth: number;
  stageHeight: number;
};

export function isInteractivePreviewTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(
    target.closest(
      '[data-image-preview-nav], button, a, input, textarea, select, [role="slider"], [contenteditable="true"]',
    ),
  );
}
