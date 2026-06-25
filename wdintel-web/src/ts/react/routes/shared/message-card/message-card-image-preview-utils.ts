import type { Point } from './message-card-image-utils';

export const ZOOM_MIN = 100;
export const ZOOM_MAX = 400;
export const ZOOM_STEP = 25;
export const ZOOM_MARKS = [100, 150, 200, 300, 400].map((value) => ({ value, label: `${value}%` }));

export type StagePalette = {
  start: string;
  end: string;
};

export type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  origin: Point;
  stageWidth: number;
  stageHeight: number;
};

function rgbaToCssColor([r, g, b, a]: Uint8ClampedArray): string {
  return `rgba(${r}, ${g}, ${b}, ${Math.max(a / 255, 0.08)})`;
}

export function sampleCornerColors(image: HTMLImageElement): StagePalette | null {
  if (image.naturalWidth <= 0 || image.naturalHeight <= 0) return null;

  try {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context == null) return null;
    context.drawImage(image, 0, 0, 1, 1, 0, 0, 1, 1);
    context.drawImage(image, image.naturalWidth - 1, image.naturalHeight - 1, 1, 1, 1, 0, 1, 1);
    const topLeft = context.getImageData(0, 0, 1, 1).data;
    const bottomRight = context.getImageData(1, 0, 1, 1).data;
    return {
      start: rgbaToCssColor(topLeft),
      end: rgbaToCssColor(bottomRight),
    };
  } catch {
    return null;
  }
}

export function isInteractivePreviewTarget(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  return Boolean(target.closest('[data-image-preview-nav], button, a, input, textarea, select, [role="slider"], [contenteditable="true"]'));
}
