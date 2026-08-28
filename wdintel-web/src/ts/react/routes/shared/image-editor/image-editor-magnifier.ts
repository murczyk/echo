type Size = { width: number; height: number };

export function calculateMagnifierSample({
  canvasSize,
  displayedSize,
  pointer,
  lensDiameter,
  magnification,
}: {
  canvasSize: Size;
  displayedSize: Size;
  pointer: { x: number; y: number };
  lensDiameter: number;
  magnification: number;
}) {
  if (displayedSize.width <= 0 || displayedSize.height <= 0) return null;
  const nativePerCssX = canvasSize.width / displayedSize.width;
  const nativePerCssY = canvasSize.height / displayedSize.height;
  const width = Math.min(canvasSize.width, (lensDiameter * nativePerCssX) / magnification);
  const height = Math.min(canvasSize.height, (lensDiameter * nativePerCssY) / magnification);
  const nativeX = pointer.x * nativePerCssX;
  const nativeY = pointer.y * nativePerCssY;
  return {
    left: Math.max(0, Math.min(canvasSize.width - width, nativeX - width / 2)),
    top: Math.max(0, Math.min(canvasSize.height - height, nativeY - height / 2)),
    width,
    height,
  };
}
