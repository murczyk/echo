export type ImageEditorBounds = { left: number; top: number; width: number; height: number };

export function imageEditorPointer(
  canvas: import('fabric').Canvas,
  event: { clientX: number; clientY: number },
) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return null;
  return {
    x: Math.max(
      0,
      Math.min(canvas.width, ((event.clientX - rect.left) * canvas.width) / rect.width),
    ),
    y: Math.max(
      0,
      Math.min(canvas.height, ((event.clientY - rect.top) * canvas.height) / rect.height),
    ),
  };
}

export function imageEditorBounds(
  start: { x: number; y: number },
  end: { x: number; y: number },
  square = false,
): ImageEditorBounds {
  const dx = end.x - start.x,
    dy = end.y - start.y,
    size = Math.max(Math.abs(dx), Math.abs(dy));
  const width = square ? size : Math.abs(dx),
    height = square ? size : Math.abs(dy);
  return {
    left: dx < 0 ? start.x - width : start.x,
    top: dy < 0 ? start.y - height : start.y,
    width,
    height,
  };
}

export function minimumGestureSize(canvas: import('fabric').Canvas) {
  const rect = canvas.upperCanvasEl.getBoundingClientRect();
  return rect.width > 0 ? (3 * canvas.width) / rect.width : 3;
}
