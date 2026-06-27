export const DOCUMENT_PREVIEW_ZOOM_MIN = 50;
export const DOCUMENT_PREVIEW_ZOOM_MAX = 300;
export const DOCUMENT_PREVIEW_ZOOM_STEP = 25;

export const DOCUMENT_PREVIEW_ZOOM_MARKS = [
  { value: 50, label: '50%' },
  { value: 100, label: '100%' },
  { value: 150, label: '150%' },
  { value: 200, label: '200%' },
  { value: 300, label: '300%' },
];

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function normalizePreviewIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  return ((index % length) + length) % length;
}

