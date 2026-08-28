import { ImageEditorObjectRole } from './image-editor.types';

export function createArrow({
  fabric,
  start,
  end,
  stroke,
  strokeWidth,
  dash,
}: {
  fabric: typeof import('fabric');
  start: { x: number; y: number };
  end: { x: number; y: number };
  stroke: string;
  strokeWidth: number;
  dash: boolean;
}) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  if (Math.hypot(dx, dy) < 3) return null;
  const headSize = Math.max(12, strokeWidth * 4);
  const shaftStart = { x: Math.max(headSize, headSize - dx), y: Math.max(headSize, headSize - dy) };
  const shaftEnd = { x: shaftStart.x + dx, y: shaftStart.y + dy };
  const shaft = new fabric.Line([shaftStart.x, shaftStart.y, shaftEnd.x, shaftEnd.y], {
    stroke,
    strokeWidth,
    strokeDashArray: dash ? [strokeWidth * 2, strokeWidth * 2] : undefined,
    originX: 'left',
    originY: 'top',
  });
  const head = new fabric.Triangle({
    left: shaftEnd.x,
    top: shaftEnd.y,
    width: headSize,
    height: headSize,
    fill: stroke,
    angle: (Math.atan2(dy, dx) * 180) / Math.PI + 90,
    originX: 'center',
    originY: 'center',
  });
  const arrow = new fabric.Group([shaft, head], {
    left: start.x - shaftStart.x,
    top: start.y - shaftStart.y,
    originX: 'left',
    originY: 'top',
  });
  const linePoints = (
    shaft as unknown as { calcLinePoints: () => { x1: number; y1: number } }
  ).calcLinePoints();
  const renderedStart = fabric.util.transformPoint(
    new fabric.Point(linePoints.x1, linePoints.y1),
    shaft.calcTransformMatrix(),
  );
  arrow.set({
    left: (arrow.left ?? 0) + start.x - renderedStart.x,
    top: (arrow.top ?? 0) + start.y - renderedStart.y,
  });
  arrow.set({ editorRole: ImageEditorObjectRole.Arrow, selectable: false, evented: false });
  return arrow;
}
